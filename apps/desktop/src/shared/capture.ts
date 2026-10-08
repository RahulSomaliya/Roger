import type { CallApp, MeetingCalendarEvent } from './calendar';
import type { AudioSource } from './transcript';
import { trimTerm } from './vocabulary';

/** The capture state machine owned by the main process. */
export type CapturePhase = 'idle' | 'starting' | 'recording' | 'stopping';

/** What the renderer reports about a MediaStream track. */
export type AudioSourceState = 'active' | 'ended' | 'error';

/**
 * `stalled`: recording, but no PCM chunk at all from this source for NO_AUDIO_WARNING_MS (the
 * renderer, its worklet or the IPC path stopped). A live track of silence still sends chunks and
 * stays `active`; whether those chunks carry sound is `SourceStatus.signal` (M2-T11). Main sets it
 * and clears it on the next chunk.
 */
export type SourceHealth = 'pending' | 'active' | 'stalled' | 'ended' | 'error';

// Warning thresholds (M2 design, "Silence and no-audio warnings"). They live here once, so main's
// SignalMonitor and Notifier (M2-T11), the helper's watchdog (M2-T10) and the words the renderer
// shows can never disagree. capture.test.ts holds the done-when line: every cut that stops audio
// warns within 10 s; only the owner's D3 and D4 rules take longer.

/** How long a recording source may go without a single chunk before it is shown as stalled. */
export const NO_AUDIO_WARNING_MS = 5_000;

/**
 * A chunk whose peak is at most this many Int16 steps (LSB) is digital silence. Real mics never
 * produce it (anarlog's `DropoutMonitor`); call audio from the global tap is exact zeros whenever
 * nothing plays, which is why call audio has rules of its own below.
 */
export const DIGITAL_SILENCE_PEAK = 1;

/** Mic digital silence this long is a dead mic: a loud warning. */
export const MIC_DEAD_WARNING_MS = 8_000;

/**
 * The same on a Bluetooth input (owner decision D4): AirPods gate the mic between words and can
 * give a minute or more of silence at the start of a call, so 8 s would warn on most AirPods calls.
 */
export const BLUETOOTH_MIC_DEAD_WARNING_MS = 30_000;

/**
 * The flat-level rule, applied only if M2-T11's Mac check finds that input volume 0 is not digital
 * zero: a mic level this far under its running floor for MIC_DEAD_WARNING_MS is dead too.
 */
export const FLAT_LEVEL_UNDER_FLOOR_DB = 40;

/**
 * Call audio never above digital silence this long after Start: loud while system audio is not
 * verified for this signing identity (a refused or still-pending tap is silent, with no error), on
 * screen only once it is (an early join or a waiting room is silent too).
 */
export const CALL_AUDIO_NEVER_HEARD_WARNING_MS = 20_000;

/** Call audio digital silence mid-call: on screen at this (D3; a quiet call looks the same). */
export const CALL_AUDIO_SILENT_WARNING_MS = 8_000;

/** The same silence turns loud at this while the mic hears speech (D3)... */
export const CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS = 60_000;

/** ...and at this whatever the mic hears (D3). */
export const CALL_AUDIO_SILENT_LOUD_MS = 180_000;

/**
 * Notifier: one macOS notification per warning kind and source in this window. A different kind
 * or source always notifies: one global limit would hide a second, different cut.
 */
export const WARNING_NOTIFY_INTERVAL_MS = 120_000;

/** The helper gave no stdout byte and no event this long: hung, so killed and restarted. */
export const HELPER_HANG_KILL_MS = 3_000;

/** Helper restarts (after a crash or a hang) before call audio is reported failed, loudly. */
export const HELPER_MAX_RESTARTS = 5;

/** The audio backup pauses below this much free disk; the text goes on (M2 D5). */
export const BACKUP_MIN_FREE_BYTES = 2 * 1024 ** 3;

/**
 * Audio of a meeting whose gap is not re-run yet outlives its retention, at most this many days
 * after the meeting (M2 D5): deleting it while a re-run is pending defeats the backup.
 */
export const BACKUP_KEEP_FOR_RERUN_MAX_DAYS = 30;

/**
 * How main's sentences name each stream inside a sentence ("the call audio"), per the naming list:
 * never "mic" or "(them)". The page's Details rows have their own capitalised labels
 * (renderer/src/format.ts SOURCE_NAME), and the transcript's speakers are Me and Them.
 */
export const AUDIO_SOURCE_LABEL: Readonly<Record<AudioSource, string>> = {
  mic: 'microphone',
  system: 'call audio',
};

/**
 * Whether a source's chunks carry sound (M2-T11's SignalMonitor):
 * - unknown: no chunk measured yet
 * - signal: its last chunks carried sound
 * - quiet: digital silence (DIGITAL_SILENCE_PEAK) shorter than the source's dead window, an
 *   ordinary pause
 * - dead: digital silence for the source's dead window or longer (MIC_DEAD_WARNING_MS,
 *   BLUETOOTH_MIC_DEAD_WARNING_MS, CALL_AUDIO_SILENT_WARNING_MS), or the flat-level rule
 */
export type SignalState = 'unknown' | 'signal' | 'quiet' | 'dead';

export interface SourceStatus {
  health: SourceHealth;
  /** PCM chunks received from the renderer in this session. */
  chunks: number;
  /** Epoch ms of the last chunk, or null. */
  lastChunkAt: number | null;
  message: string | null;
  // M2's fields are optional for the same reason as CaptureStatus's (see there): missing reads as
  // `unknown` and null.
  signal?: SignalState;
  /**
   * Peak of the last second in dBFS (0 is full scale), or null before any chunk. Digital silence
   * has no finite level and reads as null too; `signal` tells the two apart.
   */
  levelDb?: number | null;
  /** The device it captures: the input for the mic, the output for call audio; null if unknown. */
  device?: string | null;
}

/**
 * A source's speech-to-text session. Only `connecting` and `open` hold a socket the vendor bills.
 * - closed: none (before Start, after Stop, or the source failed or ended)
 * - paused: closed while the source needs none: it sent no audio for the stall window, and its next
 *   chunk reopens it; or its chunks held no speech for the silence gate's hang-over (M3-T20), and
 *   only its next speech chunk reopens it; or the Mac sleeps (M2-T18). `streamMessages` says which,
 *   and the source's health tells the gate (chunks still `active`) from a stall
 * - retrying: the vendor ended it, or the open budget is full; reopens with audio after a wait
 * - offline: the Mac lost the network (main polls `net.isOnline()`, M2-T6): the socket was
 *   terminated at once, audio is held as for `paused`, and no token is fetched and nothing reopens
 *   until it is back online; then its next chunk reopens it with no backoff wait
 * - error: ended and will not reopen this meeting; `streamMessages` says why
 *
 * renderer/src/format.ts `describeStream` switches over every state with no default case: a state
 * added here without its case fails the type check (TS2366).
 */
export type SttStreamState =
  'closed' | 'connecting' | 'open' | 'paused' | 'retrying' | 'offline' | 'error';

export interface UploadStatus {
  state: 'idle' | 'uploading' | 'backoff';
  /** Segments saved locally that are not yet in Postgres. */
  pending: number;
  /** Segments the API rejected as invalid. They stay local and never block the queue. */
  rejected: number;
  lastError: string | null;
  /** Epoch ms of the next attempt while backing off. */
  nextAttemptAt: number | null;
}

/** Speech-to-text use as the vendor bills it: the time sessions are open, silent or not. */
export interface SttMeter {
  sessionsOpened: number;
  connectedMs: number;
  audioSentMs: number;
  /** Open time at the API's price per stream-hour; null when the price is unknown. */
  estimatedCostUsd: number | null;
  /**
   * Time the silence gate kept the session closed (M3-T20), summed over sources in `total`.
   * Optional, and missing reads as 0: the meters other tasks' tests, shots and fixtures build
   * (M2-T20a, M4-S3) predate the gate and must stay valid.
   */
  gatedMs?: number;
  /**
   * `gatedMs` at the price of the session the gate closed: what it saved. Null when that price is
   * unknown; missing reads as 0, as `gatedMs` does.
   */
  estimatedSavedUsd?: number | null;
}

/**
 * The silence gate in this meeting (M3-T20): `on`, `off` (sttSilenceCloseSeconds 0), or `spent`:
 * its own reopens (sttSilenceReopensPerMeeting) are used, so it is off until Stop and sessions stay
 * open through silence.
 */
export type SilenceGateState = 'on' | 'off' | 'spent';

export interface SttMeterStatus {
  /** For people, e.g. "AssemblyAI". */
  vendorName: string;
  total: SttMeter;
  sources: Record<AudioSource, SttMeter>;
  /** Optional, as SttMeter's gate fields are: a meter without it says nothing of the gate. */
  silenceGate?: SilenceGateState;
}

/**
 * What a warning is about (M2 design, "Silence and no-audio warnings"):
 * - no-audio: no chunk at all for NO_AUDIO_WARNING_MS (renderer, helper, device or IPC stopped)
 * - source-ended: the track or the helper ended or failed, out of restarts included
 * - helper-hung: the helper's watchdog killed it (HELPER_HANG_KILL_MS)
 * - mic-dead: the mic sends digital silence (MIC_DEAD_WARNING_MS, Bluetooth longer)
 * - call-audio-never-heard: no call audio since Start (CALL_AUDIO_NEVER_HEARD_WARNING_MS)
 * - call-audio-silent: call audio went silent mid-call (CALL_AUDIO_SILENT_WARNING_MS and on)
 * - offline: the Mac lost the network, so transcription stopped
 * - backup-paused: the audio backup stopped, below BACKUP_MIN_FREE_BYTES of free disk
 * - keyterms-rejected: the vendor refused the jargon list, so that stream runs without it for the
 *   rest of the meeting (M3-T4b; always quiet)
 */
export type CaptureWarningKind =
  | 'no-audio'
  | 'source-ended'
  | 'helper-hung'
  | 'mic-dead'
  | 'call-audio-never-heard'
  | 'call-audio-silent'
  | 'offline'
  | 'backup-paused'
  | 'keyterms-rejected';

/** Something wrong now. It stays in `CaptureStatus.warnings` until the condition clears. */
export interface CaptureWarning {
  kind: CaptureWarningKind;
  /** The stream it is about; null when it concerns both or neither (offline, backup). */
  source: AudioSource | null;
  /** ISO 8601 instant, UTC: when this spell began. */
  since: string;
  /** For people: what is wrong and what to do about it. Never transcript text. */
  message: string;
  /**
   * Loud: the banner's loud style, plus a macOS notification while Roger is not focused (rate
   * limited by WARNING_NOTIFY_INTERVAL_MS). Quiet: on screen only.
   */
  loud: boolean;
}

/**
 * Something Roger recovered from on its own: shown on screen, never as a warning.
 * - device-switched: the mic followed a new default input ("Switched to <device>")
 * - helper-restarted: the call audio helper was restarted, or rebuilt its tap
 * - resumed-after-crash: Roger was relaunched and kept taking notes in the same meeting (D7)
 */
export type CaptureNoticeKind = 'device-switched' | 'helper-restarted' | 'resumed-after-crash';

export interface CaptureNotice {
  kind: CaptureNoticeKind;
  /** The stream it is about; null for the whole recording (a resume). */
  source: AudioSource | null;
  /** ISO 8601 instant, UTC. */
  at: string;
  /** For people, e.g. "Switched to AirPods Pro". */
  message: string;
}

/** How call audio reaches main: the `roger-audio` helper's Core Audio tap, or Electron's path. */
export type SystemCaptureMode = 'tap' | 'electron';

/**
 * Where call audio plays. Only known headphones turn the echo filter off: an unknown output may be
 * the laptop speakers, which leak call audio into the mic. The same values as `EchoOutputRoute` in
 * main/capture/echo/EchoFilter.ts.
 */
export type OutputRoute = 'speakers' | 'headphones' | 'unknown';

/** The Mac's default audio devices, as the helper's monitor reports them (M2-T17a). */
export interface AudioRouteStatus {
  output: OutputRoute;
  /** Device names for people; null when unknown. */
  outputDevice: string | null;
  inputDevice: string | null;
}

/**
 * Why the whole recording is paused, not one stream: `asleep` while the Mac sleeps (M2-T18), when
 * both sessions are closed and nothing reopens until wake. Not the per-stream `paused` state.
 */
export type CapturePauseReason = 'asleep';

/**
 * The local audio backup of one meeting (M2 D5), never uploaded:
 * - off: turned off in config.json (`audioBackup` false or `audioRetentionDays` 0); nothing kept
 * - writing: recording, and its audio is kept as it comes
 * - paused: less than BACKUP_MIN_FREE_BYTES free; the text goes on, the audio is not kept
 * - error: a write failed; `message` says why
 * - kept: the recording is over; its audio is on disk until `keepUntil`
 * - deleted: deleted by the user or by retention
 */
export type BackupState = 'off' | 'writing' | 'paused' | 'error' | 'kept' | 'deleted';

export interface BackupStatus {
  state: BackupState;
  /** Bytes of this meeting's audio on disk. */
  bytes: number;
  /** ISO 8601 instant, UTC, when the audio is deleted; null while recording or if none is kept. */
  keepUntil: string | null;
  /**
   * True while a gap of this meeting waits for its re-run: the audio stays past retention until the
   * gap is recovered, the user deletes it, or BACKUP_KEEP_FOR_RERUN_MAX_DAYS pass.
   */
  keptForRerun: boolean;
  message: string | null;
}

/** One meeting's echo filter counts (M2 D2). */
export interface EchoStatus {
  /** Mic lines hidden as a repeat of call audio: kept locally, never uploaded until unhidden. */
  hidden: number;
  /** Mic lines with repeated words cut out; the vendor's text is kept locally. */
  trimmed: number;
  /** Mic lines waiting for the call-audio stream to catch up before they may upload. */
  held: number;
}

/**
 * A gap re-run in progress (M2-T16): after Stop, at startup or on demand, never while recording.
 * Null in the status when none runs; the results are in the meeting's `CaptureReport`.
 */
export interface RerunStatus {
  meetingId: string;
  /** Waiting for a slot in the open budget's per-minute window, or streaming a gap's audio. */
  state: 'waiting' | 'running';
  /** Gaps this run takes on, and how many are done (recovered, or given up with a reason). */
  gaps: number;
  finished: number;
}

/**
 * What the echo filter did to a stored line, sent as `transcript:segment-changed` (M2-T14b emits
 * it, M3-T7's live transcript applies it; one event for all three changes):
 * - hidden: the line repeats call audio and is hidden (never uploaded)
 * - trimmed: its repeated words were cut out; `text` is what is left
 * - unhidden: the user showed it again; it uploads
 * A change can arrive before the line it names (a held line): the receiver keeps it until then.
 */
export interface TranscriptSegmentChange {
  meetingId: string;
  segmentId: string;
  source: AudioSource;
  change: 'hidden' | 'trimmed' | 'unhidden';
  reason: 'echo';
  /** The call-audio line it repeated; null once unhidden. */
  echoOf: string | null;
  /** The line's text as it now reads. */
  text: string;
}

/**
 * Why audio reached main but not the vendor, or was lost in a crash: a gap the re-run fills from
 * the backup. The same values as `GapReason` in main/store/TranscriptStore.ts.
 */
export type CaptureGapReason = 'stt_failed' | 'offline' | 'asleep' | 'budget' | 'crash';

export interface CaptureReportGap {
  id: string;
  source: AudioSource;
  /** Offsets from the meeting start. */
  startMs: number;
  endMs: number;
  reason: CaptureGapReason;
  /** ISO 8601 instant, UTC, when a re-run filled it; null until then. */
  recoveredAt: string | null;
  /** Why the last re-run did not fill it; null otherwise. */
  recoverError: string | null;
}

/** A JSON value, as a capture event's details hold it (the store's `JsonValue`). */
export type CaptureEventValue =
  string | number | boolean | null | CaptureEventValue[] | { [key: string]: CaptureEventValue };

/** Something capture did or saw (a pause, a reopen, a device switch, a warning), in time order. */
export interface CaptureReportEvent {
  /** ISO 8601 instant, UTC. */
  at: string;
  offsetMs: number;
  source: AudioSource | null;
  /** Free text, so the tasks that add kinds need not edit this file. */
  kind: string;
  /** Codes, counts and timings; never transcript text. */
  detail: Readonly<Record<string, CaptureEventValue>>;
}

/** What happened to one meeting's capture (M2-T20b's report; the exit check reads it per call). */
export interface CaptureReport {
  meetingId: string;
  /** The stop that ended the recording (capture/stopReasons.ts), `crash`, or null while it runs. */
  stopReason: string | null;
  gaps: CaptureReportGap[];
  events: CaptureReportEvent[];
  echo: EchoStatus;
  backup: BackupStatus;
}

/**
 * How a recording was started, stored with its meeting (`meetings.start_source` in roger.sqlite and
 * Postgres; the API contract's `StartSource`, whose line ipc-validation.test.ts compares with this
 * list). The CHECK of roger.sqlite's migration 5 and the API's `0004_calendar` list the same five,
 * and a migration is never edited: a sixth value needs a new migration on both sides.
 * - manual: a Start that names nothing else, the default
 * - notification: a click on the calendar prompt (M5); the exit check's streak counts only these
 * - home: a start from Home (M5-T12)
 * - tray: a start from the menu bar (M5-T11)
 * - call_detected: Start notes on the call-detected card (M2's detection, on M5's panel)
 */
export const START_SOURCES = ['manual', 'notification', 'home', 'tray', 'call_detected'] as const;

export type StartSource = (typeof START_SOURCES)[number];

export function isStartSource(value: unknown): value is StartSource {
  return START_SOURCES.some((source) => source === value);
}

/**
 * The longest meeting title the API stores, in characters (code points, as Python counts) of its
 * storedMeetingText: `MeetingTitle` in apps/api/src/roger_api/schemas/meetings.py. Change the two
 * together; ipc-validation.test.ts reads the API's source and fails when they differ.
 */
export const MAX_MEETING_TITLE_LENGTH = 500;

/**
 * Meeting text (the title, each text field of a calendar link) as the API stores it: U+0000
 * dropped (Postgres refuses it; `storable_input` in apps/api/src/roger_api/schemas/common.py), then
 * trimmed as pydantic's `strip_whitespace` trims (trimTerm, the API's whitespace list). The API's
 * `max_length` counts the result's code points (`Array.from`, never `.length`).
 *
 * Trap: never JavaScript's trim() for this. It also trims U+FEFF, which the API keeps and counts,
 * and keeps U+0085, which the API trims: 500 characters and a byte order mark would pass a trim()
 * measure and draw the API's 422, which keeps the meeting and its transcript off the server.
 * Nor is its '' the API's blank: that is isApiBlank.
 */
export function storedMeetingText(value: string): string {
  return trimTerm(value.replaceAll('\u0000', ''));
}

/**
 * Blank as the API reads a title or an optional calendar text before it stores one: nothing left
 * once U+0000 is dropped and Python's `str.strip()` has trimmed (`_title_or_default` and
 * `_blank_is_none` in apps/api/src/roger_api/schemas/meetings.py). The API names a blank title
 * "Untitled meeting" and stores a blank optional text as null, at any length.
 *
 * Trap: never `storedMeetingText(value) === ''` for this. Python's `strip()` also trims U+001C to
 * U+001F, which pydantic's `strip_whitespace` (and so storedMeetingText) keeps: a title of only
 * those was an invisible title here and "Untitled meeting" on the server, for good, since nothing
 * reads the server's title back. Checked against Python 3.12's `str.isspace()`.
 */
export function isApiBlank(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    // U+0000 is dropped; U+001C to U+001F are whitespace to Python alone.
    if (code === 0 || (code >= 0x1c && code <= 0x1f)) continue;
    // Anything else is whitespace to Python exactly when it is White_Space, all of which trimTerm
    // trims: of one character, it leaves nothing only for that.
    if (trimTerm(character) !== '') return false;
  }
  return true;
}

/**
 * `title` as the API stores it (storedMeetingText), cut to MAX_MEETING_TITLE_LENGTH characters. A
 * calendar event's title has no length limit (a pasted agenda), while a start request with a
 * longer title is refused, so a request built from one is cut with this first: main cuts its own
 * (CaptureService.requestStart, the enricher's answer), and a page that starts a note from an
 * event (Home, M5-T12) cuts its title before it sends the request.
 */
export function fitMeetingTitle(title: string): string {
  const stored = storedMeetingText(title);
  const characters = Array.from(stored);
  if (characters.length <= MAX_MEETING_TITLE_LENGTH) return stored;
  // Cut by code points, so no emoji is cut in half; trimmed again, so a cut just after a space
  // leaves none at the end.
  return trimTerm(characters.slice(0, MAX_MEETING_TITLE_LENGTH).join(''));
}

/**
 * What a Start asks for beyond "record" (M5): how it was started, the title and the calendar event
 * the note is for. Every field is optional; an empty request is a plain manual Start. Main checks a
 * request field by field before it runs (main/ipc-validation.ts, parseStartCaptureRequest), the
 * window's and its own (CaptureService.requestStart) alike, against what `POST /v1/meetings`
 * accepts: the uploader sends these fields with the meeting's create, and a create the API refuses
 * keeps the whole meeting, its transcript included, off the server.
 */
export interface StartCaptureRequest {
  /** Default `manual`. */
  source?: StartSource;
  /**
   * At most MAX_MEETING_TITLE_LENGTH characters of its storedMeetingText, or the window's start is
   * refused. A calendar event's title has no such limit: main cuts the title of its own requests to
   * fit (fitMeetingTitle), and a page that builds a request from an event cuts it first. Blank as
   * the API reads it (isApiBlank, at any length) or left out, main names the meeting after its
   * start, "Meeting at 9:30 am" (defaultMeetingTitle in main/capture/CaptureService.ts).
   */
  title?: string;
  /**
   * The calendar event the note is for (`toMeetingCalendarEvent`, which keeps the API's 200
   * attendees). Left out or null: none, unless main's enricher links one (M5-T9c, "Manual start
   * near a meeting").
   */
  calendarEvent?: MeetingCalendarEvent | null;
}

export interface CaptureStatus {
  phase: CapturePhase;
  meetingId: string | null;
  /**
   * The recording meeting's title: the start request's, or main's "Meeting 6 Oct 2026 09:30".
   * Null whenever `meetingId` is.
   */
  title: string | null;
  /** ISO 8601 instant, UTC. */
  startedAt: string | null;
  sttProvider: string | null;
  sources: Record<AudioSource, SourceStatus>;
  streams: Record<AudioSource, SttStreamState>;
  /** Why a source's session is not open (paused, failed), or null. */
  streamMessages: Record<AudioSource, string | null>;
  /** Final segments stored locally in this session. */
  segmentsStored: number;
  /** Final segments this session that the local store refused (shown live, not saved). */
  segmentsUnsaved: number;
  upload: UploadStatus;
  /**
   * The last error worth showing the person, as one plain sentence with what to do next
   * (main/capture/errorWords.ts), or null. The banner, the prompt panel and Set up Roger's redirect
   * read it as it is: it never holds a vendor's name, an HTTP code, a route or an internal word.
   */
  error: string | null;
  /**
   * The raw text behind `error` (a vendor's reason, an API route, a store error), for Details and
   * the log only; null exactly when `error` is. Never on the page outside Details.
   */
  errorDetail: string | null;
  /** This meeting's speech-to-text use while recording; the last meeting's after Stop. */
  meter: SttMeterStatus | null;
  /**
   * Why Roger stopped the last recording on its own (no speech, the length cap, sleep, a window
   * that could not reload), or null: capture/stopReasons.ts, stopNotice. Cleared by the next Start.
   */
  notice: string | null;

  // M2's fields (M2-T2). Every one is optional on purpose: main fills each through M2-T4's status
  // contributors as its feature lands (T10, T11, T14b, T15, T16, T17a, T18, T23), and a status
  // built without them stays valid meanwhile: CaptureService's recording status (an object
  // literal), every test's, and the preview fixtures that M4-S3 writes in the same wave. A
  // required field would fail the type check in all of those, files other tasks own. A missing
  // field reads as its empty value: no warnings, no notices, nothing known.

  /** What is wrong now, loud or quiet (M2-T11). */
  warnings?: CaptureWarning[];
  /** What Roger recovered from on its own this recording, a crash resume included. */
  notices?: CaptureNotice[];
  /** How call audio is captured this recording (M2-T10); null when idle. */
  systemCapture?: SystemCaptureMode | null;
  /**
   * True once call audio was heard (a probe, or tap audio above silence) for this signing identity
   * (M2-T1, M2-T10). While false, CALL_AUDIO_NEVER_HEARD_WARNING_MS is a loud warning.
   */
  systemAudioVerified?: boolean;
  /** The Mac's default devices (M2-T17a); null until the monitor reports. */
  route?: AudioRouteStatus | null;
  /** The call app seen using the mic during this recording, which auto-stop follows (M2-T17b). */
  trigger?: CallApp | null;
  /** The whole recording is paused (M2-T18); null otherwise. */
  paused?: CapturePauseReason | null;
  /** This meeting's audio backup while recording; the last meeting's after Stop (M2-T15). */
  backup?: BackupStatus | null;
  /** This meeting's echo filter counts (M2-T14b). */
  echo?: EchoStatus | null;
  /** The gap re-run in progress, of any meeting (M2-T16); null when none runs. */
  rerun?: RerunStatus | null;
}

export function emptySourceStatus(): SourceStatus {
  return { health: 'pending', chunks: 0, lastChunkAt: null, message: null };
}

export function idleCaptureStatus(upload: UploadStatus): CaptureStatus {
  return {
    phase: 'idle',
    meetingId: null,
    title: null,
    startedAt: null,
    sttProvider: null,
    sources: { mic: emptySourceStatus(), system: emptySourceStatus() },
    streams: { mic: 'closed', system: 'closed' },
    streamMessages: { mic: null, system: null },
    segmentsStored: 0,
    segmentsUnsaved: 0,
    upload,
    error: null,
    errorDetail: null,
    meter: null,
    notice: null,
  };
}
