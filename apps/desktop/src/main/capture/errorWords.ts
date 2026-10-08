import { AUDIO_SOURCE_LABEL } from '../../shared/capture';
import type { AudioSource } from '../../shared/transcript';
import { ApiError } from '../api/http';
import { errorMessage } from '../logger';
import { UnsupportedSttProviderError } from '../stt/createSpeechToText';
import { SttConnectError } from '../stt/SpeechToText';

/*
 * Every capture failure a person reads, as one plain sentence with what to do next, and the raw
 * text it came from (docs/design.md, "Words from main"). CaptureService puts the sentence in
 * `CaptureStatus.error`, which the banner, the prompt panel (PromptService reads it as it is) and
 * Set up Roger's redirect read, and the raw text in `CaptureStatus.errorDetail`, which only
 * Details (CaptureFacts) and the log show. A sentence never holds a vendor's name, an HTTP code,
 * a route, an errno or an internal word (`wordsOutsideDetails`, errorWords.test.ts): before the
 * sweep a failed Start printed "xAI: rejected with HTTP 401" above every page.
 *
 * A new failure gets its sentence here, where it is told apart; anything not told apart reads
 * START_FAILURE_SENTENCES.unknown, never its raw text.
 */

/** A failure as a person reads it and as Details and the log keep it. */
export interface CaptureErrorWords {
  /** One plain sentence: what happened, then what to do. */
  sentence: string;
  /** The raw text (a vendor's reason, an API route, a store error): Details and the log only. */
  detail: string;
}

/** Start was refused because macOS denies Roger the microphone. */
export class MicrophoneDeniedError extends Error {
  constructor() {
    super(
      'Microphone access is denied. Allow Roger under System Settings, Privacy & Security, Microphone.',
    );
    this.name = 'MicrophoneDeniedError';
  }
}

/** A resume (M2 D7) of a meeting that cannot be continued. */
export class ResumeRefusedError extends Error {
  constructor(meetingId: string, why: string) {
    super(`Meeting ${meetingId} cannot be resumed: ${why}`);
    this.name = 'ResumeRefusedError';
  }
}

/** The API asked for audio the renderer does not send (streamSettingsMismatch's text). */
export class StreamFormatError extends Error {
  constructor(mismatch: string) {
    super(mismatch);
    this.name = 'StreamFormatError';
  }
}

/** A fresh token named another vendor than the meeting started with. */
export class SttProviderChangedError extends Error {
  constructor(started: string, issued: string) {
    super(
      `the API now names speech-to-text provider "${issued}", not "${started}"; the meeting ` +
        'keeps the one it started with',
    );
    this.name = 'SttProviderChangedError';
  }
}

/** The sentence for each kind of failed Start, by name (errorWords.test.ts checks every one). */
export const START_FAILURE_SENTENCES = {
  microphone:
    'Roger may not use the microphone. Allow Roger under System Settings, Privacy & Security, Microphone, then Start notes again.',
  serverAway:
    'Roger could not reach its server, so notes did not start. Check the Mac is online, then Start notes again.',
  serverRefusedMac:
    "Roger's server did not accept this Mac, so notes did not start. Ask the Roger team to check this Mac's access.",
  serverRefusedStart:
    "Roger's server turned the start down. Start notes again; if it keeps happening, tell the Roger team.",
  serverProblem:
    "Roger's server had a problem, so notes did not start. Wait a moment, then Start notes again.",
  serviceAway:
    "Roger's server could not reach the speech-to-text service, so notes did not start. Wait a moment, then Start notes again.",
  serviceRefused:
    'The speech-to-text service refused the connection, so notes did not start. Start notes again; if it keeps happening, tell the Roger team.',
  serviceBusy:
    'The speech-to-text service is busy, so notes did not start. Wait a minute, then Start notes again.',
  serviceProblem:
    'The speech-to-text service had a problem, so notes did not start. Wait a moment, then Start notes again.',
  serviceUnreachable:
    'Roger could not reach the speech-to-text service, so notes did not start. Check the Mac is online, then Start notes again.',
  serviceNotReady:
    'The speech-to-text service did not get ready, so notes did not start. Wait a moment, then Start notes again; if it keeps happening, tell the Roger team.',
  tooManyStarts:
    'Notes were started too many times in the last minute. Wait a minute, then Start notes again.',
  jargonListRefused:
    'The speech-to-text service refused the jargon list, and Roger could not start without it just now. Wait a minute, then Start notes again.',
  updateRoger:
    "This copy of Roger does not work with the speech-to-text service Roger's server picked. Update Roger, then Start notes again.",
  serviceSwitched:
    "Roger's server switched speech-to-text services while notes were starting. Start notes again.",
  notSavedOnMac:
    'Roger could not save on this Mac, so notes did not start. Free some disk space, then Start notes again.',
  resume:
    'Roger could not pick up the meeting it was recording before it closed. Start notes to begin a new one.',
  badRequest: 'Roger could not start notes from that request. Start notes again.',
  unknown:
    'Roger could not start notes. Start notes again; if it keeps happening, tell the Roger team.',
} as const;

type StartFailure = keyof typeof START_FAILURE_SENTENCES;

/*
 * Trap: three refusals reach a Start as plain Errors, told apart by their text, which each throw
 * names in a comment. CaptureService.test.ts runs the budget's and the start request's through the
 * real throws, so a reworded one fails there before a person reads the fallback sentence; the
 * jargon list's is copied into errorWords.test.ts.
 */
/** CaptureSession.open, when the open budget refuses Start's opens: the message's start. */
const BUDGET_REFUSED = 'Speech-to-text was not started: ';
/** CaptureSession.openStream, when the budget refuses the open without the jargon list. */
const JARGON_LIST_REOPEN_REFUSED = '; not opened again without the jargon list: ';
/** ipc-validation.ts `refuse`, for a start request that does not check: the message's start. */
const INVALID_START_REQUEST = 'invalid start request: ';

/** A socket that never reached the vendor: an errno ("ENOTFOUND"), or the core's connect timeout. */
const UNREACHABLE = /\bE[A-Z]{3,}\b|\btimed out\b/;

/** Why Start failed, in words: `CaptureService.doStart`'s catch. */
export function startFailureWords(error: unknown): CaptureErrorWords {
  return {
    sentence: START_FAILURE_SENTENCES[startFailure(error)],
    detail: detailOf(error),
  };
}

function startFailure(error: unknown): StartFailure {
  if (error instanceof MicrophoneDeniedError) return 'microphone';
  if (error instanceof ResumeRefusedError) return 'resume';
  if (error instanceof StreamFormatError || error instanceof UnsupportedSttProviderError) {
    return 'updateRoger';
  }
  if (error instanceof SttProviderChangedError) return 'serviceSwitched';
  if (error instanceof ApiError) return apiFailure(error);
  if (error instanceof SttConnectError) return connectFailure(error);
  if (!(error instanceof Error)) return 'unknown';
  // node:sqlite throws a plain Error with this code (the store's createMeeting).
  if ('code' in error && error.code === 'ERR_SQLITE_ERROR') return 'notSavedOnMac';
  // Before the budget's own pattern: this text quotes the budget's refusal too.
  if (error.message.includes(JARGON_LIST_REOPEN_REFUSED)) return 'jargonListRefused';
  if (error.message.startsWith(BUDGET_REFUSED)) return 'tooManyStarts';
  if (error.message.startsWith(INVALID_START_REQUEST)) return 'badRequest';
  // CaptureSession.connect joins two failures and keeps the second as the cause.
  return error.cause === undefined ? 'unknown' : startFailure(error.cause);
}

/** The token request to Roger's server failed (main/api/http.ts's ApiError). */
function apiFailure({ status, code }: ApiError): StartFailure {
  if (status === 0) return 'serverAway';
  if (status === 401 || status === 403) return 'serverRefusedMac';
  if (code === 'stt_provider_error') return 'serviceAway';
  if (status >= 400 && status < 500) return 'serverRefusedStart';
  return 'serverProblem';
}

/** The vendor's socket failed to open (stt/core/SttConnection.ts's SttConnectError). */
function connectFailure({ statusCode, message }: SttConnectError): StartFailure {
  if (statusCode === 429) return 'serviceBusy';
  if (statusCode !== null) return statusCode >= 500 ? 'serviceProblem' : 'serviceRefused';
  return UNREACHABLE.test(message) ? 'serviceUnreachable' : 'serviceNotReady';
}

/**
 * Why Stop failed: a store write refused (a full disk, SQLite busy) after the sessions closed.
 * The meeting may still be open, and CrashRecovery decides at the next launch (RecordingEnded's
 * `stopFailed`), so the next step is only to open Roger again.
 */
export function stopFailureWords(error: unknown): CaptureErrorWords {
  return {
    sentence:
      'Roger could not finish stopping these notes. What it saved stays on this Mac, and Roger finishes the meeting the next time it opens.',
    detail: detailOf(error),
  };
}

/**
 * A configuration problem found at launch (a missing Roger token, a refused cost guard): Start
 * fails with it until it is fixed. Only someone who set Roger up can fix it, so it says so; the
 * setting it names (an environment variable, config.json) is the detail.
 */
export function configurationWords(startupError: string): CaptureErrorWords {
  return {
    sentence:
      'Roger is not set up correctly on this Mac, so notes cannot start. Ask the Roger team to check its settings, then open Roger again.',
    detail: startupError,
  };
}

/**
 * A source's vendor stream failed mid-call (CaptureSession's onStreamFailure). `reopens`: it
 * reconnects with that source's next audio after a wait; false when the meeting's opens are spent
 * and nothing reopens until the next Start.
 *
 * No countdown: the old "Reconnecting when its audio flows, in 12 s" rewrote the banner every
 * second, and a time that ticks never rides in a message (docs/design.md, Words from main).
 */
export function streamFailureWords(
  source: AudioSource,
  reason: string,
  reopens: boolean,
): CaptureErrorWords {
  const lost = `The speech-to-text service dropped the connection for the ${AUDIO_SOURCE_LABEL[source]}`;
  return {
    sentence: reopens
      ? `${lost}. Roger reconnects on its own.`
      : `${lost}, and Roger cannot reconnect it in this meeting. Press Stop, then Start notes again.`,
    detail: `${AUDIO_SOURCE_LABEL[source]}: ${reason}`,
  };
}

/**
 * Lines the local store refused (CaptureSession's onSaveFailure): house rule 1, the person must
 * see that lines are not being saved, how many, and the way out. No meeting id or source label:
 * the log line 'line not saved locally' has both.
 */
export function unsavedLinesWords(count: number, reason: string): CaptureErrorWords {
  const lines = count === 1 ? '1 line' : `${count} lines`;
  return {
    sentence: `${lines} could not be saved on this Mac. Recording continues; free some disk space, or press Stop if this keeps happening.`,
    detail: reason,
  };
}

/** The raw text, whatever was thrown: an Error's message, a string, or its JSON. */
function detailOf(error: unknown): string {
  return error === undefined ? 'undefined' : errorMessage(error);
}
