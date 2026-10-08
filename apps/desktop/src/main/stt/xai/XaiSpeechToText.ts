import { PCM_ENCODING } from '../../../shared/ipc';
import { AudioFrameSizer } from '../core/AudioFrameSizer';
import {
  describeCloseWith,
  type SttProtocol,
  type SttProtocolContext,
  type SttProtocolMessage,
  type SttProtocolSession,
  type TranscriptEvent,
} from '../core/SttProtocol';
import { WebSocketSpeechToText, type WebSocketSttOptions } from '../core/WebSocketSpeechToText';
import { SttConnectError, type SttStreamSettings } from '../SpeechToText';
import { parseXaiMessage, XAI_AUDIO_DONE, XAI_FINALIZE, XaiLineAssembler } from './messages';

/**
 * xAI streaming speech-to-text adapter (`wss://api.x.ai/v1/stt`, Grok Voice Transcribe 2.0, the
 * API's preset `xai`): added to compare Grok with AssemblyAI on the same audio. Docs relied on,
 * read 2026-10-07:
 * - https://docs.x.ai/developers/model-capabilities/audio/speech-to-text (the endpoint; query
 *   parameters `model`, `sample_rate`, `encoding` pcm|mulaw|alaw|opus, `interim_results`,
 *   `endpointing`, `language`, `format` (needs `language`), `diarize`, `keyterm` (repeatable, at
 *   most 100 terms of 50 characters), `smart_turn`, `vad_threshold`; the key in an
 *   `Authorization: Bearer` header and "always proxy WebSocket connections through your backend";
 *   `transcript.created` before any audio; `transcript.partial` in three states; the client
 *   messages `Finalize` and `audio.done`, answered by `transcript.done`; `error` before a close;
 *   100 ms audio chunks "streamed real-time-paced")
 * - https://docs.x.ai/developers/rest-api-reference/inference/voice and
 *   https://docs.x.ai/developers/model-capabilities/audio/voice-agent (`client_secrets`: the
 *   "ephemeral token ... Use as a Bearer token in the WebSocket `Authorization` header"; shown for
 *   `/v1/realtime` only)
 * - https://docs.x.ai/developers/models ($0.20 an hour streaming)
 *
 * Live check 2026-10-07 (the vendor log in docs/research/stt-benchmark.md): `/v1/stt` accepts the
 * API's client secret (the API's XaiSttTokenIssuer) as `Authorization: Bearer`; a refusal would show
 * as "xAI: rejected with HTTP 401" at connect. Still UNCONFIRMED, and listed there as open points:
 * (1) the exact reading of the three partial states (messages.ts XaiLineAssembler); (2) what
 * `start` and `duration` span.
 *
 * A client secret opens exactly ONE websocket, ever (live probe 2026-10-08 through the API's
 * XaiSttTokenIssuer, in the same vendor log): one secret, two connections at once: one opens, the
 * other is refused with HTTP 401; two secrets, two at once: both open; one secret, open, close,
 * open again: the second is HTTP 401. The key was fine. Hence `credentialUse: 'single-connection'`:
 * Start, every reopen, the silence gate's prefetch, the gap re-run and the bench each give every
 * open a secret of its own (SttCredentialUse). Before it, Roger shared Start's one token between
 * mic and call audio, as it does for AssemblyAI, and every Start failed on one of the two.
 *
 * What xAI documents nothing about, and what this file therefore assumes:
 * - Billing: open time (the conservative reading; the API's price table says the same), so the core
 *   closes a source with no audio like any vendor's.
 * - An idle timeout, a session cap and a sessions-per-minute limit: none is documented. There is no
 *   idle parameter to pass `vendorIdleTimeoutMs` to and no keep-alive message, so a quiet session
 *   is closed by Roger's own stall and silence guards (costGuards.ts), never by xAI.
 * - A rate rule for audio: the docs say "real-time-paced" but name no close for a burst, so
 *   `audioPacing` is `none` like Soniox's, and a reopen's held audio goes at once. If the bake-off
 *   sees xAI close a session right after a reopen, declare 'realtime' here and in its conformance
 *   entry (rejectsAudioFasterThanRealTime).
 *
 * This file only describes the protocol; the socket lifecycle, its timeouts and the forced close
 * are SttConnection's (core/SttConnection.ts). Lines come from XaiLineAssembler (messages.ts).
 * An xAI `error` becomes one fatal error, and CaptureSession decides whether to reopen, through its
 * open budget. A refused jargon list is never put down to the list (`keytermsRejected` is left
 * out): xAI's limits (100 terms, 50 characters each) equal the shared ones (keyterms.ts), so the
 * core's cut already keeps every list inside them.
 *
 * Speaker labels: none are asked for (`diarize` stays off). Roger keeps the mic ("me") and the call
 * audio ("them") as two streams and never mixes them (house rule 6), so the source already says who
 * spoke, as with every other adapter.
 */

export const XAI_DEFAULT_BASE_URL = 'wss://api.x.ai';
/**
 * xAI documents no frame size (its examples send 100 ms). Frames stay inside the band the core's
 * sizer keeps for AssemblyAI and Soniox: a pipe read that merged a stall's writes goes as frames of
 * at most 1 s, never as one, and a split write waits for its rest instead of going as a sliver.
 */
const MIN_FRAME_MS = 50;
const MAX_FRAME_MS = 1000;

export interface XaiProtocolOptions {
  baseUrl?: string;
}

export type XaiOptions = WebSocketSttOptions & XaiProtocolOptions;

/**
 * The URL and query string xAI's `/v1/stt` websocket expects for raw PCM. Never carries the
 * credential (the wire tap records the URL's query, and only the header is kept out of it).
 * `format=true` needs `language`, and Roger's notes want punctuated, numeral-formatted text as the
 * other adapters ask for. No `diarize` (file header). `endpointing`, `smart_turn` and
 * `vad_threshold` stay at xAI's defaults: the bake-off judges the defaults first. Keyterms go in as
 * given; the core has already cut them to the shared limits (keyterms.ts).
 */
export function buildStreamUrl(baseUrl: string, settings: SttStreamSettings): string {
  if (settings.encoding !== PCM_ENCODING) {
    throw new SttConnectError(
      `xAI cannot be sent ${settings.encoding} audio; Roger sends ${PCM_ENCODING}`,
    );
  }
  const url = new URL('/v1/stt', baseUrl);
  const params: Record<string, string> = {
    model: settings.model,
    // Our `linear16` (16-bit signed little-endian mono PCM) under xAI's name.
    encoding: 'pcm',
    sample_rate: String(settings.sampleRate),
    interim_results: 'true',
    language: settings.language,
    format: 'true',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  // Spaces as %20, not URLSearchParams' '+': only a form decoder reads '+' as a space, so a
  // multi-word term could reach the vendor as "order+number". encodeURIComponent never writes '+'.
  const keyterms = (settings.keyterms ?? []).map((term) => `keyterm=${encodeURIComponent(term)}`);
  if (keyterms.length > 0) url.search = [url.searchParams.toString(), ...keyterms].join('&');
  return url.toString();
}

export function xaiProtocol(options: XaiProtocolOptions = {}): SttProtocol {
  const baseUrl = options.baseUrl ?? XAI_DEFAULT_BASE_URL;
  return {
    provider: 'xai',
    vendorName: 'xAI',
    // A client secret opens ONE websocket, ever (file header, the 2026-10-08 probe): a second with
    // it, at once or after the first closed, is HTTP 401. Every open gets its own token
    // (SttCredentialUse).
    credentialUse: 'single-connection',
    // The API's client secret as a bearer header, the way xAI documents a key on this socket. In
    // the header, never the URL: the wire tap records the query. A raw API key never reaches the
    // desktop (house rule 3).
    target: ({ accessToken, settings }) => ({
      url: buildStreamUrl(baseUrl, settings),
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    // "Server ready: wait for this before sending audio." Until it arrives the core holds audio.
    readyOn: 'ready-message',
    // `transcript.done` answers `audio.done`; the core closes on it. xAI documents the connection
    // as closing after it, but the core does not wait for that: its hard finish timeout covers a
    // socket xAI leaves open.
    finishedOn: 'finished-message',
    // Nothing documented to send (file header).
    keepAlive: null,
    audioPacing: 'none',
    session: (context) => new XaiSession(context),
    describeClose: (code, reason) => describeCloseWith({}, code, reason),
    connectAdvice: () => null,
  };
}

export class XaiSpeechToText extends WebSocketSpeechToText {
  constructor(options: XaiOptions) {
    super(xaiProtocol(options), options);
  }
}

/** One stream's protocol state: the frame sizer and the utterance in progress. */
class XaiSession implements SttProtocolSession {
  private readonly frames: AudioFrameSizer;
  private readonly lines = new XaiLineAssembler();

  constructor(private readonly context: SttProtocolContext) {
    this.frames = new AudioFrameSizer({
      sampleRate: context.settings.sampleRate,
      minMs: MIN_FRAME_MS,
      maxMs: MAX_FRAME_MS,
    });
  }

  encodeAudio(pcm: Uint8Array): Uint8Array[] {
    return this.frames.push(pcm);
  }

  /**
   * The held audio, then `Finalize` (the utterance in progress becomes a final line, which is
   * documented for push-to-talk but is what Stop wants too) and `audio.done` (the end).
   */
  finishSequence(): (string | Uint8Array)[] {
    const tail = this.frames.flush();
    const control = [XAI_FINALIZE, XAI_AUDIO_DONE];
    return tail === null ? control : [tail, ...control];
  }

  read(raw: string): SttProtocolMessage {
    const parsed = parseXaiMessage(raw);
    switch (parsed.kind) {
      case 'created':
        return { kind: 'ready', sessionId: null };
      case 'partial': {
        const events = this.lines.accept(parsed.partial);
        return parsed.warning === undefined
          ? { kind: 'transcript', events }
          : { kind: 'transcript', events, warning: parsed.warning };
      }
      case 'done':
        // The stream is over: a line still held is its last, and `transcript.done` repeats the
        // whole text, which the lines already carry, so none of it is saved again.
        return { kind: 'finished', events: this.release() };
      case 'error':
        return { kind: 'vendor-error', message: parsed.message };
      case 'ignored':
      case 'invalid':
        return parsed;
    }
  }

  /**
   * The socket closed (a vendor error, a dead socket, the finish deadline): the utterance in
   * progress is the stream's last line, and xAI never sends it again.
   */
  release(): TranscriptEvent[] {
    const last = this.lines.flush();
    return last === null ? [] : [last];
  }
}
