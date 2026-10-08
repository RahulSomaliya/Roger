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
import {
  parseSonioxMessage,
  SONIOX_END_OF_AUDIO,
  SONIOX_FINALIZE,
  SONIOX_KEEP_ALIVE,
  SonioxLineAssembler,
} from './messages';

/**
 * Soniox real-time adapter (`stt-rt-v5`, the API's preset `soniox`): the optional third vendor
 * (M3 decision D1). Docs relied on, read 2026-10-07:
 * - https://soniox.com/docs/api-reference/stt/websocket-api (the endpoint; the start request, a
 *   JSON text message before any audio: `model`, `audio_format`, and `sample_rate` and
 *   `num_channels` for raw PCM, `context`, `enable_endpoint_detection`; no answer to it; binary
 *   audio; the empty text frame that ends a stream, answered by `finished: true` and the close;
 *   an error response, then the close; `api_key` in the start request is deprecated)
 * - https://soniox.com/docs/guides/websocket-authentication (the key in `Authorization: Bearer`,
 *   temporary keys included; a refused key never fails the handshake: an error response comes
 *   after it, at the start request, then the close)
 * - https://soniox.com/docs/stt/rt/connection-keepalive (`keepalive` at least every 20 s while no
 *   audio is sent, or the connection may close; billed for the whole stream, not the audio)
 * - https://soniox.com/docs/stt/rt/error-handling (403 `temp_api_key_session_expired`, 413
 *   `max_duration_reached` and 503 `service_unavailable` mean open a new session; "send audio in
 *   real time or near real-time ... brief buffering or network jitter are tolerated, but prolonged
 *   bursts or lags may result in disconnection")
 * - https://soniox.com/docs/stt/rt/limits-and-quotas (300 minutes per stream, fixed; 10 concurrent
 *   streams and 100 a minute by default)
 * - https://soniox.com/docs/stt/concepts/context (`context.terms`; the whole context at most 8,000
 *   tokens)
 * - https://soniox.com/docs/stt/rt/endpoint-detection (`<end>` ends an utterance; it finalizes a
 *   little earlier, so it can cost a little accuracy: the bake-off measures it)
 *
 * This file only describes the protocol: the key in a header, the start request as the opening
 * message (the core sends it on the handshake, ahead of everything), the handshake as the ready
 * signal (Soniox answers nothing to the start request), binary PCM framed by the core's
 * AudioFrameSizer and sent as it comes, a keepalive, and Stop as `finalize` then the empty text
 * frame, answered by the finished response. Lines come from SonioxLineAssembler (messages.ts).
 * The socket lifecycle, its timeouts and the forced close are SttConnection's
 * (core/SttConnection.ts). A Soniox error response becomes one fatal error, and CaptureSession
 * decides whether to reopen, through its open budget.
 *
 * Errors come after the handshake, never as a refused one: Soniox checks the key and the start
 * request only once the socket is open. So a bad key, a model it does not know or an exhausted
 * balance is a stream that fails right after it opened (CaptureSession's reopen path, its backoff
 * and its per-meeting cap), never a failed connect; and no refusal can be put down to the jargon
 * list (keytermsRejected is left out). The list cannot be refused anyway: the shared limits
 * (keyterms.ts, 800 characters, about 240 tokens) sit far under Soniox's 8,000-token context.
 *
 * The session cap: the API's key caps each session at Soniox's 5 hours
 * (`max_session_duration_seconds` 18000, M3-T14), which a 4-hour recording never reaches. At it
 * Soniox sends 403 `temp_api_key_session_expired` and closes normally: one fatal error, and
 * CaptureSession reopens a fresh session with a fresh key, as on AssemblyAI's 3008.
 */

export const SONIOX_DEFAULT_BASE_URL = 'wss://stt-rt.soniox.com';
/**
 * Soniox documents no frame size (its examples send 120 ms). Frames stay inside the band the core's
 * sizer keeps for AssemblyAI: a pipe read that merged a stall's writes goes as frames of at most
 * 1 s, never as one, and a split write waits for its rest instead of going as a sliver.
 */
const MIN_FRAME_MS = 50;
const MAX_FRAME_MS = 1000;
/**
 * Inside the 20 s Soniox allows without audio. The core sends it only while the source sent audio
 * within the stall window (SttConnection keepAliveForMs), so it only bridges a stall until Roger's
 * own stall close, and a source with no audio is never kept open for long.
 */
const KEEP_ALIVE_INTERVAL_MS = 10_000;
/** For a close that carries no reason text (the vendor's text wins when there is one). */
const SONIOX_CLOSE_MEANINGS: Readonly<Record<number, string>> = {
  1001: 'closed as idle: no audio or keepalive in time',
};

export interface SonioxProtocolOptions {
  baseUrl?: string;
}

export type SonioxOptions = WebSocketSttOptions & SonioxProtocolOptions;

/**
 * The start request: Soniox's whole configuration for one stream, sent as its opening message.
 * It never carries the key (sent with the connection; `api_key` here is deprecated, and the wire
 * tap records every text message). No `language_hints`: M3 sends Soniox no language (M3 plan,
 * vendor facts). Endpoint detection is on because its `<end>` token is the only line boundary
 * Soniox gives (messages.ts).
 */
export function buildStartRequest(settings: SttStreamSettings): string {
  if (settings.encoding !== PCM_ENCODING) {
    throw new SttConnectError(
      `Soniox cannot be sent ${settings.encoding} audio; Roger sends ${PCM_ENCODING}`,
    );
  }
  // Never sent empty: no list, no context. The core has already cut it to the shared limits.
  const keyterms = settings.keyterms ?? [];
  return JSON.stringify({
    model: settings.model,
    // Our `linear16` (16-bit signed little-endian mono PCM) under Soniox's name.
    audio_format: 'pcm_s16le',
    sample_rate: settings.sampleRate,
    num_channels: 1,
    enable_endpoint_detection: true,
    ...(keyterms.length > 0 ? { context: { terms: keyterms } } : {}),
  });
}

export function sonioxProtocol(options: SonioxProtocolOptions = {}): SttProtocol {
  const baseUrl = options.baseUrl ?? SONIOX_DEFAULT_BASE_URL;
  return {
    provider: 'soniox',
    vendorName: 'Soniox',
    // The API asks for every key with `single_use: false` (stt_tokens.py): one key opens any number
    // of streams until it expires.
    credentialUse: 'reusable',
    // A temporary key from the API (house rule 3). In the header, not the protocols list: an older
    // `temp:` key is not a valid protocols entry, and the header works for both kinds.
    target: ({ accessToken }) => ({
      url: new URL('/transcribe-websocket', baseUrl).toString(),
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    // Soniox refuses a session whose first message is not the start request ("Start request must
    // be a text message"), so it goes through the core, ahead of any audio, keepalive or ping.
    openingMessages: (settings) => [buildStartRequest(settings)],
    // Soniox answers nothing to the start request: the handshake is all the ready signal there is.
    readyOn: 'socket-open',
    // The finished response is the completion signal: the core closes on it, whatever close code
    // Soniox then sends.
    finishedOn: 'finished-message',
    keepAlive: { message: SONIOX_KEEP_ALIVE, intervalMs: KEEP_ALIVE_INTERVAL_MS },
    // Soniox tolerates "brief buffering" but not "prolonged bursts" (file header). The one burst
    // Roger sends is a reopen's held audio (sttReopenBufferSeconds in costGuards.ts: 3 s by
    // default, 10 at most; M3-T20's silence gate adds its pre-roll): sent at once, it adds no lag.
    // If the bake-off sees Soniox close a session right after a reopen, declare 'realtime' here
    // and in its conformance entry (rejectsAudioFasterThanRealTime).
    audioPacing: 'none',
    session: (context) => new SonioxSession(context),
    describeClose: (code, reason) => describeCloseWith(SONIOX_CLOSE_MEANINGS, code, reason),
    connectAdvice: () => null,
  };
}

export class SonioxSpeechToText extends WebSocketSpeechToText {
  constructor(options: SonioxOptions) {
    super(sonioxProtocol(options), options);
  }
}

/** One stream's protocol state: the frame sizer and the line in progress. */
class SonioxSession implements SttProtocolSession {
  private readonly frames: AudioFrameSizer;
  private readonly lines = new SonioxLineAssembler();

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

  /** The held audio, then `finalize` (the last tokens final) and the empty frame (the end). */
  finishSequence(): (string | Uint8Array)[] {
    const tail = this.frames.flush();
    const control = [SONIOX_FINALIZE, SONIOX_END_OF_AUDIO];
    return tail === null ? control : [tail, ...control];
  }

  read(raw: string): SttProtocolMessage {
    const parsed = parseSonioxMessage(raw, this.context.audioSentMs());
    switch (parsed.kind) {
      case 'invalid':
        return parsed;
      case 'error':
        return { kind: 'vendor-error', message: parsed.message };
      case 'tokens': {
        const events = this.lines.accept(parsed.tokens);
        if (parsed.finished) {
          if (parsed.warning !== undefined) {
            this.context.logger.warn('soniox finished response partly understood', {
              warning: parsed.warning,
            });
          }
          // The stream is over: no interim after its last line, and the held finals are that line.
          return {
            kind: 'finished',
            events: [...events.filter((event) => event.type === 'final'), ...this.release()],
          };
        }
        return parsed.warning === undefined
          ? { kind: 'transcript', events }
          : { kind: 'transcript', events, warning: parsed.warning };
      }
    }
  }

  /**
   * The socket closed (a vendor error, a dead socket, the finish deadline): the held finals are
   * the stream's last line, and Soniox never sends them again.
   */
  release(): TranscriptEvent[] {
    const last = this.lines.flush();
    return last === null ? [] : [last];
  }
}
