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

/** The query string Deepgram's `/v1/listen` websocket expects for raw PCM. */
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
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
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
    session: () => ({
      encodeAudio: (pcm) => [pcm],
      // Finalize flushes buffered audio into final results; CloseStream then ends the session.
      finishSequence: () => [DEEPGRAM_FINALIZE, DEEPGRAM_CLOSE_STREAM],
      read: readDeepgramMessage,
      release: () => [],
    }),
    describeClose: describeDeepgramClose,
    connectAdvice: () => null,
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
