import type { CaptureWarning, CaptureWarningKind } from './capture';
import type { AudioSource } from './transcript';

/*
 * Capture's words that both main and the page read (docs/design.md, "Words from main"): one
 * headline per warning kind, and the rule for what never reaches a sentence a person reads.
 * Main writes the long form itself: a warning's message (capture/warnings.ts, and the kinds
 * TapSystemAudio raises) and an error's sentence (capture/errorWords.ts).
 */

type Headline = string | Readonly<Record<AudioSource | 'none', string>>;

/**
 * The headlines, by kind. `satisfies` a record of every `CaptureWarningKind`: a kind added in
 * shared/capture.ts fails the type check here until it has its words.
 */
const HEADLINES = {
  'no-audio': {
    mic: "Roger can't hear you",
    system: "Roger can't hear the call",
    none: "Roger can't hear any audio",
  },
  'source-ended': {
    mic: 'Your microphone stopped',
    system: 'Call audio stopped',
    none: 'Audio stopped',
  },
  'helper-hung': 'Call audio stalled',
  'mic-dead': "Roger can't hear you",
  'call-audio-never-heard': 'No call audio yet',
  'call-audio-silent': "Roger can't hear the call",
  // Not "transcription": the naming list keeps Transcribing inside Details (sweep W12). The
  // message says what being offline costs.
  offline: 'The Mac is offline',
  'backup-paused': 'Audio backup paused',
  'keyterms-rejected': 'The jargon list was refused',
} as const satisfies Readonly<Record<CaptureWarningKind, Headline>>;

/**
 * A few words for what a warning means: the meeting header's status line and the Details row on
 * the page ("Roger can't hear the call · since 4:59 pm"), and the title of the macOS notification
 * the Notifier posts for a loud one (main/capture/warnings.ts `warningTitle`). One list for both,
 * so a person never reads two names for one warning (sweep N1); macOS shows "Roger" above it.
 */
export function warningHeadline({ kind, source }: Pick<CaptureWarning, 'kind' | 'source'>): string {
  const headline: Headline = HEADLINES[kind];
  return typeof headline === 'string' ? headline : headline[source ?? 'none'];
}

/**
 * What never belongs in a sentence a person reads outside Details (docs/design.md, "Words from
 * main"; the naming list): a vendor's name, an HTTP status, a route, an address, an errno, a
 * SQLite code, a setting's variable, an id, an exit code, "Error:", the internal words, "mic",
 * "transcription", and the retired "Start again" (it is Start notes). The vendor names are the
 * desktop's adapters' `vendorName`s: main/capture/errorWords.test.ts fails when one is missing.
 */
const OUTSIDE_DETAILS: readonly RegExp[] = [
  /\b(?:AssemblyAI|Deepgram|Soniox|xAI)\b/gi,
  /\bHTTP\b/gi,
  /\b[1-5]\d\d\b/g,
  /\b(?:GET|POST|PUT|PATCH|DELETE) \/\S*/g,
  /\/v\d+\/\S*/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\bE[A-Z]{3,}\b/g,
  /\bSQLITE\w*/gi,
  /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\bexit (?:code )?-?\d+/gi,
  /\bError:/g,
  /\b(?:helpers?|streams?|worklets?|postgres|api|sqlite|tokens?|sockets?|websockets?|ipc|renderer|vendors?|config\.json)\b/gi,
  /\bmic\b/gi,
  /\btranscription\b/gi,
  /\bStart again\b/g,
  /\b(?:undefined|null|NaN)\b/g,
];

/**
 * The pieces of `text` that only Details and the log may show, in the order they appear; empty
 * for a sentence fit for the page, a banner, the prompt panel or a notification. A piece inside a
 * longer one ("SQLITE" in "SQLITE_BUSY") is reported once, as the longer one.
 */
export function wordsOutsideDetails(text: string): string[] {
  const found = OUTSIDE_DETAILS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({ at: match.index, piece: match[0] })),
  ).sort((a, b) => a.at - b.at || b.piece.length - a.piece.length);
  const pieces: string[] = [];
  let end = 0;
  for (const { at, piece } of found) {
    if (at < end) continue;
    pieces.push(piece);
    end = at + piece.length;
  }
  return pieces;
}
