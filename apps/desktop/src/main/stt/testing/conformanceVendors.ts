import type { WebSocket } from 'ws';
import type { SttStreamSettings } from '../SpeechToText';

/**
 * Test-only: how each network vendor behaves on the wire, so the conformance suite
 * (stt/conformance.test.ts) can play the vendor from a local fake server. One entry per vendor in
 * the registry (stt/registry.ts); the suite fails for a registered vendor without one.
 */
export interface ConformanceVendor {
  provider: string;
  /** What the API hands out for this vendor (/v1/stt/token `stream`). */
  settings: SttStreamSettings;
  /** Sent on connect when the ready signal is a message (AssemblyAI Begin); null: the handshake. */
  readyMessage: string | null;
  /** The text messages Stop sends, in order. */
  finishMessages: string[];
  /** How the vendor answers the last finish message. */
  answerFinish(socket: WebSocket): void;
  /** A message carrying one final line that says `text`. */
  finalMessage(text: string): string;
  /** A close the vendor sends mid-call. */
  midCallClose: { code: number; reason: string };
  /** The error frame the vendor sends right before such a close, or null if it sends none. */
  errorFrame: string | null;
  /** The keep-alive the adapter sends while open, or null. */
  keepAliveMessage: string | null;
  /**
   * The vendor closes a session sent audio faster than real time, so the adapter must declare
   * `audioPacing: 'realtime'`. False: a burst must go at once, or it would lag for nothing.
   */
  rejectsAudioFasterThanRealTime: boolean;
}

export const CONFORMANCE_VENDORS: readonly ConformanceVendor[] = [
  {
    provider: 'assemblyai',
    settings: {
      model: 'universal-streaming-english',
      language: 'en',
      sampleRate: 16000,
      encoding: 'linear16',
      pricePerHourUsd: 0.15,
    },
    readyMessage: JSON.stringify({ type: 'Begin', id: 'session-1', expires_at: 1772570132 }),
    finishMessages: [JSON.stringify({ type: 'Terminate' })],
    answerFinish: (socket) => {
      socket.send(
        JSON.stringify({
          type: 'Termination',
          audio_duration_seconds: 1,
          session_duration_seconds: 1,
        }),
      );
    },
    finalMessage: (text) =>
      JSON.stringify({
        type: 'Turn',
        turn_order: 0,
        turn_is_formatted: true,
        end_of_turn: true,
        transcript: text,
        end_of_turn_confidence: 0.9,
        words: [{ text, start: 0, end: 500, confidence: 0.9, word_is_final: true }],
      }),
    midCallClose: { code: 3008, reason: 'Session Expired: Maximum session duration exceeded' },
    errorFrame: JSON.stringify({
      type: 'Error',
      error_code: 3008,
      error: 'Session Expired: Maximum session duration exceeded',
    }),
    keepAliveMessage: null,
    // Close code 3007, "Audio Transmission Rate Exceeded: Received <x> sec. audio in <y> sec";
    // the API reference says to pace chunks at about real time and documents no tolerance.
    rejectsAudioFasterThanRealTime: true,
  },
  {
    provider: 'deepgram',
    settings: {
      model: 'nova-3',
      language: 'en',
      sampleRate: 16000,
      encoding: 'linear16',
      pricePerHourUsd: 0.462,
    },
    readyMessage: null,
    finishMessages: [JSON.stringify({ type: 'Finalize' }), JSON.stringify({ type: 'CloseStream' })],
    answerFinish: (socket) => {
      socket.send(JSON.stringify({ type: 'Metadata', request_id: 'r' }));
      socket.close(1000);
    },
    finalMessage: (text) =>
      JSON.stringify({
        type: 'Results',
        start: 0,
        duration: 0.5,
        is_final: true,
        channel: { alternatives: [{ transcript: text, confidence: 0.9, words: [] }] },
      }),
    midCallClose: { code: 1011, reason: 'NET-0001' },
    errorFrame: null,
    keepAliveMessage: JSON.stringify({ type: 'KeepAlive' }),
    // No rate rule documented: a burst must go at once.
    rejectsAudioFasterThanRealTime: false,
  },
];
