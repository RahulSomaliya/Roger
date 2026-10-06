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
import type { NotesWhenUnsure } from '../../shared/preferences';
import {
  suggestTemplate,
  templateTitleKey,
  type TemplateAttendee,
} from '../../shared/suggestTemplate';
import { ApiError } from '../api/http';
import type { NotesClient } from '../api/notesClient';
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

/** The two notes preferences (`notes.autoGenerate`, `notes.whenUnsure`), read when needed. */
export interface NotesGeneratorPreferences {
  autoGenerate(): boolean;
  whenUnsure(): NotesWhenUnsure;
}

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
  /** From the PreferencesStore of `[slot M4-S2]`; read through getters so a change applies. */
  preferences: NotesGeneratorPreferences;
  /** The window whose page shows notes runs; null while none is open. */
  window: () => StreamWindow | null;
  /** The invitees of the event a meeting was started for (M5); none until M5 stores them. */
  attendees?: (meetingId: string) => readonly TemplateAttendee[];
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

/** One attempt at a pending generate's run: flush, stream, and the poll if the stream is lost. */
interface Attempt {
  readonly runId: string;
  stage: 'flushing' | 'streaming' | 'polling';
  cancelRequested: boolean;
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
 * Generate after Stop, in main (M4-T23). A generate is a stored intent, a `pending_generate` row in
 * notes.sqlite with a run id made up front, so it survives a reload, a quit and an offline API. On
 * Stop, with `notes.autoGenerate` on, the row is written with the template `suggestTemplate` picks
 * (or none, when Roger must ask); the Generate button and the answer to "Which kind of call was
 * this?" write the same row (`generate`).
 *
 * A row runs once its template is known, the meeting's lines are all uploaded, the meeting is in
 * Postgres, and NotesSync has flushed its notes. It is checked again on every uploader status
 * event and NotesSync change that may unblock it, at launch and every 30 s. The run streams
 * through LlmStreams to the page; `done` goes into notes.sqlite through `applyServerNote`, and a
 * stream lost before `done` or `error` is followed by polling the run, whose saved notes are then
 * loaded (`pullMeeting`). The row is deleted on `done`, on `cancelled` and on an error a retry
 * would only repeat (`errorOutcome`); `llm_provider_error` keeps it, failed, for Retry.
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
   * The Generate button, Retry, or the answer to "Which kind of call was this?"
   * (`notes:generate`). A pending generate that has not failed takes this template and keeps its
   * run id and reason; a failed one, or none, gets a new run id with reason `button`. The pick is
   * remembered under the meeting's title. Throws while an attempt runs.
   */
  generate(meetingId: string, templateId: string): PendingGenerateState {
    if (templateId.trim() === '') throw new Error(`notes of meeting ${meetingId} need a template`);
    if (this.attempts.has(meetingId)) {
      throw new Error(`a notes run is already running for meeting ${meetingId}`);
    }
    const { store } = this.options;
    const current = store.getPendingGenerate(meetingId);
    const row: StoredPendingGenerate =
      current !== null && current.lastError === null
        ? // An attempt may already have reached the API: a new id would start a second paid run.
          { ...current, templateId }
        : this.newRow(meetingId, templateId, 'button');
    this.rememberPick(meetingId, templateId);
    store.putPendingGenerate(row);
    this.waiting.delete(meetingId);
    this.check(meetingId);
    return this.stateFor(row);
  }

  /**
   * Stops the meeting's run or drops a waiting generate (`notes:cancel-generate`). A streaming
   * run's end decides what follows (see `settle`); a run being polled is asked to stop, and the
   * poll reads what the cancel did. Rejects when the API's cancel failed.
   */
  async cancel(meetingId: string): Promise<void> {
    const attempt = this.attempts.get(meetingId);
    if (attempt === undefined) {
      this.drop(meetingId);
      return;
    }
    attempt.cancelRequested = true;
    this.options.logger.info('notes generate cancel', {
      meetingId,
      runId: attempt.runId,
      stage: attempt.stage,
    });
    switch (attempt.stage) {
      case 'flushing':
        // Nothing has reached the API: the attempt finds the row gone once its flush returns.
        this.drop(meetingId);
        return;
      case 'streaming':
        await this.options.streams.cancelNotes(meetingId);
        return;
      case 'polling':
        await this.options.api.cancelRun(meetingId, attempt.runId);
        return;
    }
  }

  /** The meeting's pending generate and where it stands, or null (`notes:get-pending-generate`). */
  getPending(meetingId: string): PendingGenerateState | null {
    const row = this.options.store.getPendingGenerate(meetingId);
    return row === null ? null : this.stateFor(row);
  }

  /** Every change of a meeting's pending generate, once (`notes:pending-generate-changed`). */
  onPendingChanged(listener: (change: PendingGenerateChange) => void): () => void {
    return this.events.on('changed', listener);
  }

  // triggers -------------------------------------------------------------------------------------

  /**
   * Runs inside CaptureService's listener call, after Stop ended or discarded the meeting and
   * before the upload flush.
   */
  private recordingEnded(recording: RecordingEnded): void {
    const { meetingId } = recording;
    const { store, preferences, logger } = this.options;
    try {
      // Deleted for having no line and no notes: a row for it (the Generate button pressed during
      // the recording) would wait for a meeting that never comes.
      if (recording.discarded) {
        this.drop(meetingId);
        return;
      }
      // Stop threw first, so the meeting may still be open (`ended_at` NULL): CrashRecovery
      // decides at the next launch. Nothing is written up for a meeting that may go on.
      if (recording.stopFailed || !preferences.autoGenerate()) return;
      const current = store.getPendingGenerate(meetingId);
      // None, or a failed one (Retry's): a new row. A row that has not failed keeps its run id
      // (an attempt may have reached the API).
      if (current?.lastError !== null) {
        const row = this.newRow(meetingId, this.templateAtStop(meetingId), 'after_stop');
        store.putPendingGenerate(row);
        this.waiting.delete(meetingId);
        logger.info('notes generate pending after stop', {
          meetingId,
          runId: row.runId,
          templateId: row.templateId,
        });
      }
      this.check(meetingId);
    } catch (error) {
      logger.error('notes generate after stop failed', { meetingId, error: errorMessage(error) });
    }
  }

  /**
   * Trap: NotesSync writes the sync state on every attempt at a note (`syncing`, then `synced`,
   * `offline` or `saved_locally`), this generator's own flush included, and each write is a note
   * change. A re-check on those flushes again, which writes again: see the trap on
   * `NotesSync.flushMeeting`. Two rules keep this listener off that loop. Only a generate that
   * waits for its notes re-checks, and while an attempt runs (its flush and pull included)
   * nothing waits and `check` starts no second attempt, so the flush's own changes do nothing.
   * And only a change that can unblock a run re-checks: a stored note, or a save by the user
   * (which also ends a conflict with "Use mine"); NotesSync's failing retries write `syncing` and
   * `offline`, which never do.
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
      // Gone or failed (`?.` is undefined for none; a failed one waits for Retry), or asking.
      if (row?.lastError !== null || row.templateId === null) {
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
   * Lines first, then the meeting. A meeting roger.sqlite does not know is left to the API, which
   * answers `404` for one it lacks too (ending the generate).
   */
  private waitFor(meetingId: string): Waiting | null {
    const waitingLines = this.waitingLines(meetingId);
    if (waitingLines > 0) {
      return { status: { phase: 'waiting_for_lines', waitingLines }, wakeOn: 'uploads' };
    }
    if (this.options.transcripts.getMeeting(meetingId)?.remoteState === 'pending') {
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
    const attempt: Attempt = { runId, stage: 'flushing', cancelRequested: false };
    this.attempts.set(meetingId, attempt);
    // Never rejects: runAttempt logs every failure and records it as the state.
    void this.runAttempt(meetingId, attempt);
  }

  // one attempt ----------------------------------------------------------------------------------

  private async runAttempt(meetingId: string, attempt: Attempt): Promise<void> {
    const log = this.options.logger.child({ meetingId, runId: attempt.runId });
    try {
      await this.attempt(meetingId, attempt, log);
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
            message: 'Roger could not generate the notes. It will try again.',
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
      if (!flushed.ok) {
        const status: PendingGenerateStatus = { phase: 'waiting_for_notes', cause: flushed.cause };
        this.waiting.set(meetingId, {
          status,
          wakeOn: flushed.cause === 'meeting' ? 'uploads' : 'notes',
        });
        log.info('notes generate waits for its notes', { cause: flushed.cause });
        return;
      }
      // Cancelled during the flush.
      const row = store.getPendingGenerate(meetingId);
      if (row?.runId !== attempt.runId || row.templateId === null) return;
      attempt.stage = 'streaming';
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
    run: LlmRun,
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
    return {
      meetingId,
      runId: this.newRunId(),
      templateId,
      reason,
      createdAt: this.clock().toISOString(),
      lastError: null,
    };
  }

  /** The rule in shared/suggestTemplate.ts, then the `notes.whenUnsure` preference. */
  private templateAtStop(meetingId: string): string | null {
    const { store, transcripts, preferences, attendees } = this.options;
    const suggestion = suggestTemplate({
      title: transcripts.getMeeting(meetingId)?.title ?? '',
      lastPick: (titleKey) => store.getTemplateChoice(titleKey),
      attendees: attendees?.(meetingId) ?? [],
    });
    if (suggestion.templateId !== null) return suggestion.templateId;
    return preferences.whenUnsure() === 'general' ? 'general' : null;
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
    if (row !== null) this.options.store.deletePendingGenerate(meetingId, row.runId);
    this.waiting.delete(meetingId);
    this.tell(meetingId);
  }

  private stateFor(row: StoredPendingGenerate): PendingGenerateState {
    return {
      meetingId: row.meetingId,
      runId: row.runId,
      templateId: row.templateId,
      reason: row.reason,
      createdAt: row.createdAt,
      status: this.statusOf(row),
    };
  }

  private statusOf(row: StoredPendingGenerate): PendingGenerateStatus {
    if (row.lastError !== null) return { phase: 'failed', ...row.lastError };
    if (row.templateId === null) return { phase: 'needs_template' };
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
