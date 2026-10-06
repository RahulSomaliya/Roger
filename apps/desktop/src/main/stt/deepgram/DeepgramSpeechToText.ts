import { WebSocketSpeechToText, type WebSocketSttOptions } from '../core/WebSocketSpeechToText';
import { describeCloseWith, type SttProtocol, type SttProtocolMessage } from '../core/SttProtocol';
import type { SttStreamSettings } from '../SpeechToText';
import {
  DEEPGRAM_CLOSE_STREAM,
  DEEPGRAM_FINALIZE,
  DEEPGRAM_KEEP_ALIVE,
  parseDeepgramMessage,
} from './messages';

/**
 * Deepgram streaming (`/v1/listen`). The second adapter, kept for the M3 bake-off. This file only
 * describes the protocol; the socket lifecycle is SttConnection's (core/SttConnection.ts).
 *
 * Close reasons, per https://developers.deepgram.com/docs/stt-troubleshooting-websocket-data-and-net-errors
 * (read 2026-10-06): 1008 DATA-0000 (audio not decodable), 1011 NET-0000 (no result sent in
 * time), NET-0001 (nothing received in time), NET-0002 (no audio within the no-audio timeout).
 *
 * Jargon, per https://developers.deepgram.com/docs/keyterm (read 2026-10-06): one `keyterm`
 * parameter per term, URL-encoded, 500 tokens at most across all of them; past that Deepgram
 * refuses the whole request with HTTP 400 at the handshake (keytermsRejected).
 *
 * Training, per https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program
 * (read 2026-10-06): pay-as-you-go audio joins the Model Improvement Program unless each request
 * sends `mip_opt_out=true`. Roger promises it never trains on calls, so every URL carries it.
 */

export const DEEPGRAM_DEFAULT_BASE_URL = 'wss://api.deepgram.com';

const DEEPGRAM_CLOSE_REASONS: Readonly<Record<string, string>> = {
  'DATA-0000': 'Deepgram could not decode the audio',
  'NET-0000': 'Deepgram sent no result in time',
  'NET-0001': 'no audio or KeepAlive reached Deepgram in time',
  'NET-0002': 'no audio reached Deepgram within its no-audio timeout',
};

export interface DeepgramProtocolOptions {
  baseUrl?: string;
}

export type DeepgramOptions = WebSocketSttOptions & DeepgramProtocolOptions;

/**
 * The query string Deepgram's `/v1/listen` websocket expects for raw PCM. `mip_opt_out=true` is not
 * a setting: without it Deepgram may train on the call (file header). Keyterms go in as given; the
 * core has already cut them to the shared limits (keyterms.ts).
 */
export function buildListenUrl(baseUrl: string, settings: SttStreamSettings): string {
  const url = new URL('/v1/listen', baseUrl);
  const params: Record<string, string> = {
    model: settings.model,
    language: settings.language,
    encoding: settings.encoding,
    sample_rate: String(settings.sampleRate),
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    mip_opt_out: 'true',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // Spaces as %20, not URLSearchParams' '+': only a form decoder reads '+' as a space, so a
  // multi-word term could reach the vendor as "order+number". encodeURIComponent never writes '+'.
  const keyterms = (settings.keyterms ?? []).map((term) => `keyterm=${encodeURIComponent(term)}`);
  if (keyterms.length > 0) url.search = [url.searchParams.toString(), ...keyterms].join('&');
  return url.toString();
}

export function deepgramProtocol(options: DeepgramProtocolOptions = {}): SttProtocol {
  const baseUrl = options.baseUrl ?? DEEPGRAM_DEFAULT_BASE_URL;
  return {
    provider: 'deepgram',
    vendorName: 'Deepgram',
    // A backend-minted grant is a bearer token. A raw API key would be `Token ...`, but raw keys
    // never reach the desktop (house rule 3).
    target: ({ accessToken, settings }) => ({
      url: buildListenUrl(baseUrl, settings),
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    readyOn: 'socket-open',
    // After CloseStream Deepgram sends its last results and Metadata, then closes the socket.
    finishedOn: 'vendor-close',
    // Deepgram closes a socket that receives nothing for about 10 s (NET-0001); a KeepAlive every
    // 5 s keeps a quiet stream open. That is a billed session held open on purpose, so the core
    // sends it only while the stream is open and its source sent audio within the stall window
    // (SttConnection keepAliveForMs): never once Stop or a failure began, never for a stalled
    // source, which Deepgram then closes itself.
    keepAlive: { message: DEEPGRAM_KEEP_ALIVE, intervalMs: 5_000 },
    // No rate rule documented, so a reopen's held audio goes at once instead of lagging.
    audioPacing: 'none',
    session: () => ({
      encodeAudio: (pcm) => [pcm],
      // Finalize flushes buffered audio into final results; CloseStream then ends the session.
      finishSequence: () => [DEEPGRAM_FINALIZE, DEEPGRAM_CLOSE_STREAM],
      read: readDeepgramMessage,
      release: () => [],
    }),
    describeClose: describeDeepgramClose,
    connectAdvice: () => null,
    // A list past Deepgram's 500 tokens fails the whole handshake with HTTP 400 (file header). A
    // 400 for another reason (a model name it does not know) fails again on the one reopen without
    // the list, and that error carries both reasons (M3-T4b). Any other status (401 bad grant, 402
    // out of credit, 429) is not the list's fault: a reopen without it would fail the same way.
    keytermsRejected: (refusal) => refusal.kind === 'http-status' && refusal.status === 400,
  };
}

export class DeepgramSpeechToText extends WebSocketSpeechToText {
  constructor(options: DeepgramOptions) {
    super(deepgramProtocol(options), options);
  }
}

function readDeepgramMessage(raw: string): SttProtocolMessage {
  const parsed = parseDeepgramMessage(raw);
  if (parsed.kind !== 'event') return parsed;
  const { event, warning } = parsed;
  if (event.type === 'error') return { kind: 'vendor-error', message: event.message };
  return warning === undefined
    ? { kind: 'transcript', events: [event] }
    : { kind: 'transcript', events: [event], warning };
}

/** Deepgram's reasons are codes like NET-0001; say what they mean next to them. */
function describeDeepgramClose(code: number, reason: string | null): string {
  const described = describeCloseWith({}, code, reason);
  const known = reason === null ? undefined : /^(?:DATA|NET)-\d{4}/.exec(reason)?.[0];
  const meaning = known === undefined ? undefined : DEEPGRAM_CLOSE_REASONS[known];
  return meaning === undefined ? described : `${described}, ${meaning}`;
}
