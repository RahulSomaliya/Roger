import { randomUUID } from 'node:crypto';
import {
  notesChannels,
  type NotesStreamMessage,
  type PendingGenerateChange,
} from '../../shared/ipc/notes';
import type {
  LlmRun,
  LlmRunStatus,
  LocalNote,
  Note,
  NotesStreamEvent,
  PendingGenerateState,
  PendingGenerateStatus,
} from '../../shared/notes';
import { templateTitleKey } from '../../shared/suggestTemplate';
import { ApiError } from '../api/http';
import type { LlmRunSummary, NotesClient } from '../api/notesClient';
import type { CaptureService, RecordingEnded } from '../capture/CaptureService';
import { errorMessage, type Logger } from '../logger';
import type { TranscriptStore } from '../store/TranscriptStore';
import { Emitter } from '../util/emitter';
import type { LlmStreams, StreamEnd, StreamWindow } from './LlmStreams';
import type { NotesStore, StoredPendingGenerate } from './NotesStore';
import type { NotesSync } from './NotesSync';

/** Every waiting generate is checked again this often, whatever else happened (M4). */
export const NOTES_RECHECK_MS = 30_000;
/** After a lost stream the run is read every 2 s for 10 s, then every 5 s (M4 "Streaming"). */
const RUN_POLL_FAST_MS = 2_000;
const RUN_POLL_FAST_FOR_MS = 10_000;
const RUN_POLL_SLOW_MS = 5_000;
/**
 * How long a lost run may read `running` before the poll stops. The API fails a run whose
 * heartbeat is 2 minutes old, but the run it answers carries no heartbeat, so the poll cannot tell
 * a long run from a dead one. Past this, the next re-check re-sends the run id: the API attaches
 * to a live run, or its stale sweep has failed a dead one and the failure is replayed.
 */
const RUN_POLL_LIMIT_MS = 120_000;
/** `listUnsyncedSegments` takes a limit: a meeting with more lines waiting reports this many. */
const WAITING_LINES_LIMIT = 10_000;

const OFFLINE: PendingGenerateStatus = { phase: 'waiting_for_notes', cause: 'offline' };

export interface NotesGeneratorOptions {
  store: NotesStore;
  sync: Pick<NotesSync, 'flushMeeting' | 'pullMeeting'>;
  streams: Pick<LlmStreams, 'streamNotes' | 'cancelNotes'>;
  /** The notes client's run routes, for the poll after a lost stream and a cancel during it. */
  api: Pick<NotesClient, 'getRun' | 'cancelRun'>;
  /** roger.sqlite: the meeting's title and upload state, and its lines still to upload. */
  transcripts: Pick<TranscriptStore, 'getMeeting' | 'listUnsyncedSegments' | 'listHeldSegments'>;
  /** The uploader's status events: a line went up, or a meeting was created. */
  uploads: { onStatus(listener: () => void): () => void };
  /** Stop, through M2-T4's session listeners. */
  recordings: Pick<CaptureService, 'onRecording'>;
  /** The window whose page shows notes runs; null while none is open. */
  window: () => StreamWindow | null;
  logger: Logger;
  clock?: () => Date;
  newRunId?: () => string;
}

/**
 * Why a generate whose template is known is not running, and what may end the wait:
 * - `uploads`: an uploader status event (a line went up, the meeting was created).
 * - `notes`: a note change NotesSync made, never one this generator's own flush caused.
 * - `timer`: only the 30 s re-check, or a Generate press. The API was not reached, or a lost run
 *   was polled to its limit: re-sending on every uploader tick would hammer an API that is away.
 */
interface Waiting {
  status: PendingGenerateStatus;
  wakeOn: 'uploads' | 'notes' | 'timer';
}

/**
 * One attempt at a pending generate's run: flush, stream, and the poll if the stream is lost. A
 * cancel of a run the API may hold while nothing here streams or polls it runs as one too, so
 * that no re-check sends the run meanwhile (`cancel`).
 */
interface Attempt {
  readonly runId: string;
  stage: 'flushing' | 'streaming' | 'polling';
  cancelRequested: boolean;
  /** The API's answer to that cancel; the attempt settles by it and sends nothing (`settleStop`). */
  stopping: Promise<LlmRunSummary> | null;
}

interface GeneratorEvents extends Record<string, unknown> {
  changed: PendingGenerateChange;
}

/**
 * What an error end does to the pending generate (M4 "Generate after Stop"): `fail` keeps it for
 * Retry, `retry` keeps it for the next re-check with the same run id, `end` deletes it.
 */
type ErrorOutcome = 'fail' | 'retry' | 'end';

/**
 * Notes generates, in main (M4-T23). A generate is a stored intent, a `pending_generate` row in
 * notes.sqlite with a run id made up front, so it survives a reload, a quit and an offline API.
 * Only the header's Write notes (and "Write again as", and Retry) write a row (`generate`). Stop
 * writes none and asks nothing: the person presses Write notes, and the page sends its own best
 * guess of the template, General when unsure (redesign calls 5 and 6, docs/plans/redesign.md).
 *
 * A row runs once the meeting has stopped and its lines are all uploaded,
 * the meeting is in Postgres, and NotesSync has flushed its notes. It is checked again at Stop, on
 * every uploader status event and NotesSync change that may unblock it, at launch and every 30 s.
 * The run streams through LlmStreams to the page; `done` goes into notes.sqlite through
 * `applyServerNote`, and a stream lost before `done` or `error` is followed by polling the run,
 * whose saved notes are then loaded (`pullMeeting`). The row is deleted on `done`, on `cancelled`
 * and on an error a retry would only repeat (`errorOutcome`); `llm_provider_error` keeps it,
 * failed, for Retry.
 *
 * Trap: every attempt re-sends the row's run id. The API attaches a re-sent id to its running run
 * or replays its stored result, so a retry after a crash, a lost stream or an unreachable API
 * never pays for a second run. A new id is made only for Retry after a stored failure (the API
 * would replay the failure to the old id) and for a new generate. Never make one anywhere else.
 */
export class NotesGenerator {
  private readonly events = new Emitter<GeneratorEvents>();
  private readonly clock: () => Date;
  private readonly newRunId: () => string;
  private readonly attempts = new Map<string, Attempt>();
  private readonly waiting = new Map<string, Waiting>();
  /** The state last told per meeting, as JSON, so each change is told once. */
  private readonly told = new Map<string, string>();
  /**
   * Run ids this launch made (`newRow`) and has not sent yet: with a row still asking for its
   * template, the only runs sure not to be in the API (`mayBeInApi`). An earlier launch leaves no
   * record of what it sent, so its rows count as sent.
   */
  private readonly unsent = new Set<string>();
  /** The poll's waits; stop() ends them. */
  private readonly sleeps = new Set<() => void>();
  private readonly unsubscribes: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly options: NotesGeneratorOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.newRunId = options.newRunId ?? randomUUID;
  }

  /** Follows Stop, uploads and notes, and runs the generates a previous launch left. */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    const { recordings, uploads, store } = this.options;
    this.unsubscribes.push(
      recordings.onRecording({
        ended: (recording) => {
          this.recordingEnded(recording);
        },
      }),
      uploads.onStatus(() => {
        this.wake('uploads');
      }),
      store.onNoteChanged((note) => {
        this.noteChanged(note);
      }),
    );
    this.timer = setInterval(() => {
      this.checkAll();
    }, NOTES_RECHECK_MS);
    this.checkAll();
  }

  /**
   * At quit, before notes.sqlite closes. A run streaming now goes on in the API and saves its
   * notes; the row stays, and the next launch re-sends its id, which replays them. Nothing here
   * touches the store once stopped.
   */
  stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    for (const wake of [...this.sleeps]) wake();
  }

  /**
   * Write notes, Write again as, or Retry (`notes:generate`). A pending generate that has not failed takes this template and keeps its
   * run id and reason; a failed one, or none, gets a new run id with reason `button`. The pick is
   * remembered under the meeting's title. Throws while an attempt runs, and for another template
   * on a run the API may hold.
   */
  generate(meetingId: string, templateId: string): PendingGenerateState {
    if (templateId.trim() === '') throw new Error(`notes of meeting ${meetingId} need a template`);
    if (this.attempts.has(meetingId)) {
      throw new Error(`a notes run is already running for meeting ${meetingId}`);
    }
    const { store } = this.options;
    const current = store.getPendingGenerate(meetingId);
    // Trap: the API answers a re-sent run id with the run it holds, in that run's template, and
    // never reads the template the request names. A 5xx or an unreachable API after the claim, a
    // poll stopped at its limit, or a failed pull leaves such a row waiting with no attempt: a
    // swapped template there would replay the old notes while the row, the panel and the
    // remembered pick all say the new one.
    const held = current?.templateId ?? null;
    if (current !== null && held !== null && held !== templateId && this.mayBeInApi(current)) {
      throw new Error(
        `the notes of meeting ${meetingId} may already be generating as ${held}: ` +
          'cancel them before picking another template',
      );
    }
    const row: StoredPendingGenerate =
      current !== null && current.lastError === null
        ? // An attempt may already have reached the API: a new id would start a second paid run.
          { ...current, templateId }
        : this.newRow(meetingId, templateId, 'button');
    this.rememberPick(meetingId, templateId);
    store.putPendingGenerate(row);
    this.waiting.delete(meetingId);
    this.check(meetingId);
    return this.stateFor(row, templateId);
  }

  /**
   * Stops the meeting's run or drops a waiting generate (`notes:cancel-generate`). A streaming
   * run's end decides what follows (see `settle`); a run being polled is asked to stop, and the
   * poll reads what the cancel did. With neither, a run the API may hold is asked to stop too, and
   * the generate ends as its answer says (`settleStop`). Rejects when the API's cancel failed.
   */
  async cancel(meetingId: string): Promise<void> {
    const { store, streams, api, logger } = this.options;
    const attempt = this.attempts.get(meetingId);
    const row = store.getPendingGenerate(meetingId);
    logger.info('notes generate cancel', {
      meetingId,
      runId: attempt?.runId ?? row?.runId ?? null,
      stage: attempt?.stage ?? null,
    });
    if (attempt !== undefined) attempt.cancelRequested = true;
    if (attempt?.stage === 'streaming') {
      await streams.cancelNotes(meetingId);
      return;
    }
    if (attempt?.stage === 'polling') {
      await api.cancelRun(meetingId, attempt.runId);
      return;
    }
    // Trap: no stream or poll does not mean no run. The poll stops at its limit, an unreachable
    // API or a refusal before the stream leaves the row for the next re-check, and an earlier
    // launch may have sent it: the API runs on, bills, and saves notes nothing here would load if
    // the row were only dropped, and the next edit of the AI notes would land on a stale base.
    if (row === null || !this.mayBeInApi(row)) {
      // An attempt still flushing finds the row gone once its flush returns.
      this.drop(meetingId);
      return;
    }
    const stopping = api.cancelRun(meetingId, row.runId);
    if (attempt === undefined) {
      const stopper: Attempt = {
        runId: row.runId,
        stage: 'polling',
        cancelRequested: true,
        stopping,
      };
      this.waiting.delete(meetingId);
      this.attempts.set(meetingId, stopper);
      void this.runAttempt(meetingId, stopper, (log) =>
        this.settleStop(meetingId, stopper, stopping, log),
      );
      this.tell(meetingId);
    } else {
      // Flushing: the attempt settles by the answer once its flush returns.
      attempt.stopping = stopping;
    }
    try {
      await stopping;
    } catch (error) {
      // The API never held the run: nothing to stop, and settleStop drops the row.
      if (error instanceof ApiError && error.isNotFound) return;
      throw error;
    }
  }

  /** The meeting's pending generate and where it stands, or null (`notes:get-pending-generate`). */
  getPending(meetingId: string): PendingGenerateState | null {
    const row = this.options.store.getPendingGenerate(meetingId);
    if (row === null) return null;
    // A row an earlier build left asking for its template has no state: `check` drops it.
    return row.templateId === null ? null : this.stateFor(row, row.templateId);
  }

  /** Every change of a meeting's pending generate, once (`notes:pending-generate-changed`). */
  onPendingChanged(listener: (change: PendingGenerateChange) => void): () => void {
    return this.events.on('changed', listener);
  }

  // triggers -------------------------------------------------------------------------------------

  /**
   * Runs inside CaptureService's listener call, after Stop ended or discarded the meeting and
   * before the upload flush. It writes no row (Stop never writes notes by itself); it drops a
   * discarded meeting's row and re-checks one pressed during the recording. KeptSilentMeetings (notesQuitGuard.ts) hears the same event and reads
   * `discarded` and `stopFailed` the same way: keep the two in step.
   */
  private recordingEnded(recording: RecordingEnded): void {
    const { meetingId } = recording;
    const { logger } = this.options;
    try {
      // Deleted for having no line and no notes: a row for it (the Generate button pressed during
      // the recording) would wait for a meeting that never comes.
      if (recording.discarded) {
        this.drop(meetingId);
        return;
      }
      // Stop threw first, so the meeting may still be open (`ended_at` NULL): CrashRecovery
      // decides at the next launch. Nothing is written up for a meeting that may go on.
      if (recording.stopFailed) return;
      // Write notes pressed during the recording left a row, which `waitFor` held until now. Stop
      // writes none of its own.
      this.check(meetingId);
    } catch (error) {
      logger.error('notes generate after stop failed', { meetingId, error: errorMessage(error) });
    }
  }

  /**
   * Trap: NotesSync writes the sync state on every attempt at a note (`syncing`, then `synced`,
   * `offline` or `refused`), this generator's own flush included, and each write is a note
   * change. A re-check on those flushes again, which writes again: see the trap on
   * `NotesSync.flushMeeting`. Two rules keep this listener off that loop. Only a generate that
   * waits for its notes re-checks, and while an attempt runs (its flush and pull included)
   * nothing waits and `check` starts no second attempt, so the flush's own changes do nothing.
   * And only a change that can unblock a run re-checks: a stored note (`synced`), or
   * `saved_locally`, which a save by the user writes (it also ends a conflict with "Use mine").
   * A retry the API refused (a `401`, a `422`, a `409` its copy did not explain) writes `refused`
   * or `refused_access`, which never re-check, like `syncing` and `offline`: a waiting generate
   * wakes on the `synced` that the NotesSync backoff's next accepted attempt writes.
   */
  private noteChanged(note: LocalNote): void {
    if (note.sync !== 'synced' && note.sync !== 'saved_locally') return;
    if (this.waiting.get(note.meetingId)?.wakeOn !== 'notes') return;
    this.check(note.meetingId);
  }

  private wake(trigger: Waiting['wakeOn']): void {
    for (const [meetingId, wait] of [...this.waiting]) {
      if (wait.wakeOn === trigger) this.check(meetingId);
    }
  }

  private checkAll(): void {
    let rows: StoredPendingGenerate[];
    try {
      rows = this.options.store.listPendingGenerates();
    } catch (error) {
      this.options.logger.error('pending generates not read', { error: errorMessage(error) });
      return;
    }
    for (const row of rows) this.check(row.meetingId);
  }

  // the check ------------------------------------------------------------------------------------

  /** Starts the meeting's run if its row is ready, else records why it waits. Never throws. */
  private check(meetingId: string): void {
    if (!this.running || this.attempts.has(meetingId)) return;
    try {
      const row = this.options.store.getPendingGenerate(meetingId);
      if (row !== null && row.templateId === null) {
        // An earlier build left this row asking "Which kind of call was this?" (redesign call 6
        // deleted the question). Nothing answers it any more, and it never ran: drop it.
        this.drop(meetingId);
        return;
      }
      // Gone or failed (`?.` is undefined for none; a failed one waits for Retry).
      if (row?.lastError !== null) {
        this.waiting.delete(meetingId);
      } else {
        const wait = this.waitFor(meetingId);
        if (wait === null) this.begin(meetingId, row.runId);
        else this.waiting.set(meetingId, wait);
      }
    } catch (error) {
      this.options.logger.error('pending generate not checked', {
        meetingId,
        error: errorMessage(error),
      });
    }
    this.tell(meetingId);
  }

  /**
   * Lines first, then the meeting: ended (Stop wrote its `ended_at`) and in Postgres. A meeting
   * roger.sqlite does not know is left to the API, which answers `404` for one it lacks too
   * (ending the generate).
   *
   * Trap: never run while the meeting records (the Generate button during a call). Between two
   * upload batches no line waits, so the run would write up part of the call; Stop then keeps the
   * row (its run id may have reached the API), and no run ever covers the rest. Stop ends the
   * meeting before it tells `recordingEnded`, which checks the row again.
   */
  private waitFor(meetingId: string): Waiting | null {
    const waitingLines = this.waitingLines(meetingId);
    if (waitingLines > 0) {
      return { status: { phase: 'waiting_for_lines', waitingLines }, wakeOn: 'uploads' };
    }
    const meeting = this.options.transcripts.getMeeting(meetingId);
    if (meeting !== null && (meeting.endedAt === null || meeting.remoteState === 'pending')) {
      return { status: { phase: 'waiting_for_notes', cause: 'meeting' }, wakeOn: 'uploads' };
    }
    return null;
  }

  /**
   * The meeting's lines still to reach Postgres: those that can upload now (M2-T3's query, which
   * never counts a line hidden as an echo or a rejected one) and those held for their call-audio
   * twin (M2-T14b). Stop releases the holds, so the second set is empty unless the echo sink is
   * still deciding; then the run waits rather than be written without those lines. A held line
   * past its cap is in both lists, so the two are counted as one set.
   */
  private waitingLines(meetingId: string): number {
    const { transcripts } = this.options;
    const ids = new Set(
      transcripts.listUnsyncedSegments(meetingId, WAITING_LINES_LIMIT).map((line) => line.id),
    );
    for (const line of transcripts.listHeldSegments(meetingId)) ids.add(line.id);
    return ids.size;
  }

  private begin(meetingId: string, runId: string): void {
    this.waiting.delete(meetingId);
    const attempt: Attempt = { runId, stage: 'flushing', cancelRequested: false, stopping: null };
    this.attempts.set(meetingId, attempt);
    void this.runAttempt(meetingId, attempt, (log) => this.attempt(meetingId, attempt, log));
  }

  // one attempt ----------------------------------------------------------------------------------

  /** Never rejects: logs every failure and records it as the state. */
  private async runAttempt(
    meetingId: string,
    attempt: Attempt,
    body: (log: Logger) => Promise<void>,
  ): Promise<void> {
    const log = this.options.logger.child({ meetingId, runId: attempt.runId });
    try {
      await body(log);
    } catch (error) {
      // A bug or a store failure, not an answer from the API. The row stays as it was: the next
      // re-check, or Retry, re-sends its run id.
      log.error('notes generate attempt failed', {
        stage: attempt.stage,
        error: errorMessage(error),
      });
      if (!this.halted()) {
        this.waiting.set(meetingId, {
          status: {
            phase: 'failed',
            code: 'internal_error',
            message: 'Roger could not write the notes. It will try again.',
          },
          wakeOn: 'timer',
        });
      }
    } finally {
      if (this.attempts.get(meetingId) === attempt) this.attempts.delete(meetingId);
      if (!this.halted()) this.tell(meetingId);
    }
  }

  private async attempt(meetingId: string, attempt: Attempt, log: Logger): Promise<void> {
    const { store, sync, streams } = this.options;
    for (let pulled = false; ; pulled = true) {
      attempt.stage = 'flushing';
      // M4 "Generate inputs": notes typed in the last seconds of a call drive the 2-minute target.
      const flushed = await sync.flushMeeting(meetingId);
      if (this.halted()) return;
      // Cancelled during the flush: a row nothing sent is gone already; a run the API may hold
      // ends as the API's answer to its cancel says. Nothing is sent either way.
      if (this.cancelRequested(attempt)) {
        if (attempt.stopping !== null) {
          await this.settleStop(meetingId, attempt, attempt.stopping, log);
        }
        return;
      }
      if (!flushed.ok) {
        const status: PendingGenerateStatus = { phase: 'waiting_for_notes', cause: flushed.cause };
        this.waiting.set(meetingId, {
          status,
          wakeOn: flushed.cause === 'meeting' ? 'uploads' : 'notes',
        });
        log.info('notes generate waits for its notes', { cause: flushed.cause });
        return;
      }
      // Gone or replaced during the flush: not this attempt's run any more.
      const row = store.getPendingGenerate(meetingId);
      if (row?.runId !== attempt.runId || row.templateId === null) return;
      attempt.stage = 'streaming';
      // From here the API may hold the run, whatever the stream does (`mayBeInApi`).
      this.unsent.delete(row.runId);
      log.info('notes run starting', { templateId: row.templateId });
      const end = await streams.streamNotes(
        {
          meetingId,
          runId: row.runId,
          templateId: row.templateId,
          userNotesVersion: flushed.userNotesVersion,
          aiBaseVersion: flushed.aiBaseVersion,
        },
        this.options.window(),
      );
      if (this.halted()) return;
      // A stale version: flushMeeting answers aiBaseVersion 0 for AI notes this Mac never pulled.
      // Pull, flush again and retry once, with the same run id (the API stored nothing). The page
      // first gets the conflict's `error` event, then the retry's `run`.
      if (end.kind === 'error' && end.status === 409 && !pulled && !attempt.cancelRequested) {
        log.info('notes run refused as stale, pulling the notes and retrying once');
        attempt.stage = 'flushing';
        if (!(await this.pull(meetingId))) return;
        continue;
      }
      await this.settle(meetingId, attempt, end, log);
      return;
    }
  }

  /**
   * How the stream ended. After a cancel, a stream can still end `done`, or `dropped` with cause
   * `cancel_unconfirmed` (LlmStreams' StreamEnd): the run beat the cancel, or the cancel request
   * failed, and the run may have saved its notes. Both are handled as without a cancel, never as
   * `cancelled`, or notes.sqlite keeps an older AI doc than Postgres; the page, already told
   * `cancelled`, gets the loaded notes as a note change.
   */
  private async settle(
    meetingId: string,
    attempt: Attempt,
    end: StreamEnd<Note>,
    log: Logger,
  ): Promise<void> {
    switch (end.kind) {
      case 'done':
        this.options.store.applyServerNote(meetingId, end.result);
        this.finish(meetingId, attempt, log, 'done');
        return;
      case 'dropped':
        log.info('notes stream lost, polling the run', { cause: end.cause });
        await this.poll(meetingId, attempt, log);
        return;
      case 'error':
        this.failed(meetingId, attempt, end, log);
        return;
    }
  }

  /**
   * After a lost stream: read the run until it ends, then load its notes. The run goes on in the
   * API and saves what it writes ("Closing the laptop mid-run must not throw away paid output").
   */
  private async poll(meetingId: string, attempt: Attempt, log: Logger): Promise<void> {
    attempt.stage = 'polling';
    const startedMs = this.nowMs();
    for (;;) {
      const elapsedMs = this.nowMs() - startedMs;
      await this.sleep(elapsedMs < RUN_POLL_FAST_FOR_MS ? RUN_POLL_FAST_MS : RUN_POLL_SLOW_MS);
      if (this.halted()) return;
      let run: LlmRun | null = null;
      try {
        run = await this.options.api.getRun(meetingId, attempt.runId);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.isNotFound) {
          // Not a run the API holds: the next re-check re-sends the id and the API answers.
          log.warn('polled notes run not found');
          this.waiting.set(meetingId, { status: { phase: 'running' }, wakeOn: 'timer' });
          return;
        }
        log.debug('notes run poll failed', { status: error.status, code: error.code });
      }
      if (this.halted()) return;
      if (run !== null && run.status !== 'running') {
        await this.runEnded(meetingId, attempt, run, run.status, log);
        return;
      }
      if (this.nowMs() - startedMs >= RUN_POLL_LIMIT_MS) {
        log.warn('notes run still not ended, polling stopped', { reachable: run !== null });
        this.waiting.set(meetingId, {
          status: run === null ? OFFLINE : { phase: 'running' },
          wakeOn: 'timer',
        });
        return;
      }
    }
  }

  private async runEnded(
    meetingId: string,
    attempt: Attempt,
    run: LlmRunSummary,
    status: Exclude<LlmRunStatus, 'running'>,
    log: Logger,
  ): Promise<void> {
    switch (status) {
      case 'succeeded':
        // The page hears the loaded notes as a note change, and the generate's end.
        if (await this.pull(meetingId)) this.finish(meetingId, attempt, log, 'succeeded');
        return;
      case 'cancelled':
        // Cancelled elsewhere: the page was not told by a stream.
        if (!attempt.cancelRequested) {
          this.announce(meetingId, attempt.runId, {
            type: 'error',
            code: 'cancelled',
            message: run.error ?? 'Notes generation was cancelled.',
          });
        }
        this.finish(meetingId, attempt, log, 'cancelled');
        return;
      case 'failed': {
        const code = run.errorCode ?? 'internal_error';
        const message = run.error ?? 'Notes generation failed.';
        // The `error` event the lost stream would have carried: without it the page sees the
        // generate end with no word of why.
        this.announce(meetingId, attempt.runId, { type: 'error', code, message });
        this.failed(meetingId, attempt, { code, message, status: null }, log);
        return;
      }
    }
  }

  /**
   * A cancel of a run the API may hold, sent while nothing here streamed or polled it (`cancel`).
   * The API answers the run as the cancel left it: `cancelled`, or an end the run reached first,
   * settled as any other (a `succeeded` run's notes are loaded, never taken as cancelled), or
   * `running` while the cancel takes hold, which the poll follows. A `404`: the API never held it.
   */
  private async settleStop(
    meetingId: string,
    attempt: Attempt,
    stopping: Promise<LlmRunSummary>,
    log: Logger,
  ): Promise<void> {
    attempt.stage = 'polling';
    let run: LlmRunSummary;
    try {
      run = await stopping;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (this.halted()) return;
      if (error.isNotFound) {
        this.finish(meetingId, attempt, log, 'cancelled');
        return;
      }
      // cancel() rejects with it: the generate goes on, and the next re-check re-sends its id.
      log.warn('notes run cancel failed', { status: error.status, code: error.code });
      this.waiting.set(meetingId, { status: OFFLINE, wakeOn: 'timer' });
      return;
    }
    if (this.halted()) return;
    if (run.status === 'running') await this.poll(meetingId, attempt, log);
    else await this.runEnded(meetingId, attempt, run, run.status, log);
  }

  /**
   * Load the meeting's notes from Postgres into notes.sqlite. False when the API is away: the
   * generate waits for the next re-check, whose re-sent run id replays a finished run's `done`.
   */
  private async pull(meetingId: string): Promise<boolean> {
    try {
      await this.options.sync.pullMeeting(meetingId);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (!this.halted()) this.waiting.set(meetingId, { status: OFFLINE, wakeOn: 'timer' });
      return false;
    }
    return !this.halted();
  }

  /** An `error` end, from the stream or found by the poll. */
  private failed(
    meetingId: string,
    attempt: Attempt,
    error: { code: string; message: string; status: number | null },
    log: Logger,
  ): void {
    // The user asked to stop: whatever the error, there is nothing to retry.
    const outcome = attempt.cancelRequested ? 'end' : errorOutcome(error.code, error.status);
    log.info('notes run ended with an error', {
      code: error.code,
      status: error.status,
      outcome,
    });
    switch (outcome) {
      case 'fail': {
        const { store } = this.options;
        const row = store.getPendingGenerate(meetingId);
        if (row?.runId !== attempt.runId) return;
        store.putPendingGenerate({
          ...row,
          lastError: { code: error.code, message: error.message },
        });
        return;
      }
      case 'retry':
        this.waiting.set(meetingId, { status: OFFLINE, wakeOn: 'timer' });
        return;
      case 'end':
        this.finish(meetingId, attempt, log, error.code);
        return;
    }
  }

  /** The run is over: its row goes, unless a newer one (Retry) replaced it. */
  private finish(meetingId: string, attempt: Attempt, log: Logger, outcome: string): void {
    this.options.store.deletePendingGenerate(meetingId, attempt.runId);
    this.waiting.delete(meetingId);
    log.info('notes generate ended', { outcome });
  }

  // helpers --------------------------------------------------------------------------------------

  private newRow(
    meetingId: string,
    templateId: string | null,
    reason: StoredPendingGenerate['reason'],
  ): StoredPendingGenerate {
    const runId = this.newRunId();
    this.unsent.add(runId);
    return {
      meetingId,
      runId,
      templateId,
      reason,
      createdAt: this.clock().toISOString(),
      lastError: null,
    };
  }

  /** Never for a title that says nothing about the call (`templateTitleKey`). */
  private rememberPick(meetingId: string, templateId: string): void {
    const meeting = this.options.transcripts.getMeeting(meetingId);
    const titleKey = meeting === null ? null : templateTitleKey(meeting.title);
    if (titleKey !== null) this.options.store.rememberTemplateChoice(titleKey, templateId);
  }

  /** Deletes the meeting's pending generate, whatever its run. */
  private drop(meetingId: string): void {
    const row = this.options.store.getPendingGenerate(meetingId);
    if (row !== null) {
      this.options.store.deletePendingGenerate(meetingId, row.runId);
      this.unsent.delete(row.runId);
    }
    this.waiting.delete(meetingId);
    this.tell(meetingId);
  }

  /**
   * Whether the API may hold the row's run, so that dropping the row, or giving it another
   * template, here alone would go unheard there. A run needs a template, and a failed row's run
   * has ended; any other run id not in `unsent` may have been sent.
   */
  private mayBeInApi(row: StoredPendingGenerate): boolean {
    return row.templateId !== null && row.lastError === null && !this.unsent.has(row.runId);
  }

  private stateFor(row: StoredPendingGenerate, templateId: string): PendingGenerateState {
    return {
      meetingId: row.meetingId,
      runId: row.runId,
      templateId,
      reason: row.reason,
      createdAt: row.createdAt,
      status: this.statusOf(row),
    };
  }

  private statusOf(row: StoredPendingGenerate): PendingGenerateStatus {
    if (row.lastError !== null) return { phase: 'failed', ...row.lastError };
    if (this.attempts.get(row.meetingId)?.runId === row.runId) return { phase: 'running' };
    const wait = this.waiting.get(row.meetingId) ?? this.waitFor(row.meetingId);
    // Ready, so the next check starts it (it has not run since start, or this was not started).
    return wait?.status ?? { phase: 'running' };
  }

  /** Tells listeners the meeting's state if it changed. Never throws. */
  private tell(meetingId: string): void {
    try {
      const state = this.getPending(meetingId);
      const json = state === null ? null : JSON.stringify(state);
      if (json === (this.told.get(meetingId) ?? null)) return;
      if (json === null) this.told.delete(meetingId);
      else this.told.set(meetingId, json);
      this.events.emit('changed', { meetingId, pending: state });
    } catch (error) {
      this.options.logger.error('pending generate change not told', {
        meetingId,
        error: errorMessage(error),
      });
    }
  }

  /** Sends one notes event to the page, as LlmStreams would have. */
  private announce(
    meetingId: string,
    runId: string,
    event: Extract<NotesStreamEvent, { type: 'error' }>,
  ): void {
    const target = this.options.window();
    if (target === null || target.isDestroyed()) return;
    const message: NotesStreamMessage = { meetingId, runId, event };
    target.send(notesChannels.NotesEvent, message);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleeps.add(wake);
    });
  }

  /**
   * Whether stop() ran. A method, not the field: TypeScript would keep a field narrowed across
   * the awaits after a first check, and the lint would call the later checks unnecessary. They
   * are not: stop() runs while a request is out, and the store may then be closed.
   */
  private halted(): boolean {
    return this.stopped;
  }

  /** Whether a cancel came for the attempt: a method for the reason `halted` is one. */
  private cancelRequested(attempt: Attempt): boolean {
    return attempt.cancelRequested;
  }

  private nowMs(): number {
    return this.clock().getTime();
  }
}

function errorOutcome(code: string, status: number | null): ErrorOutcome {
  // Retry takes a new run id: the API replays a finished run's stored failure to the old one.
  if (code === 'llm_provider_error') return 'fail';
  // The run's own end (`cancelled`, `cut_off`, `internal_error`: no status), or a refusal a retry
  // would only repeat: an empty meeting (`422`), an unknown template or meeting (`404`), a second
  // stale-version `409` or another run holding the meeting.
  if (status === null || status === 404 || status === 409 || status === 422) return 'end';
  // Anything else keeps the row and its run id for the next re-check: the API was not reached
  // (`0`) or failed before the run (`5xx`), so the run may exist; or it refused what a later try
  // may fix, as NotesSync's `refused` reads it (`401` for a token it no longer takes, `429`).
  // Trap: never end on those. The token is read at launch, so the user fixes it and relaunches,
  // and a deleted row would leave that call with no notes and no word of why.
  return 'retry';
}
