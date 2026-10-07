import type { WebSocket } from 'ws';
import type { SttStreamSettings } from '../SpeechToText';
import type { FakeVendorConnection } from './fakeVendorServer';

/**
 * Test-only: how each network vendor behaves on the wire, so the conformance suite
 * (stt/conformance.test.ts) can play the vendor from a local fake server. One entry per vendor in
 * the registry (stt/registry.ts); the suite fails for a registered vendor without one.
 */
export interface ConformanceVendor {
  provider: string;
  /** What the API hands out for this vendor (/v1/stt/token `stream`). */
  settings: SttStreamSettings;
  /**
   * What the vendor must hear first, before any audio, for `settings` (Soniox's start request;
   * SttProtocol.openingMessages). [] for a vendor that needs nothing first.
   */
  openingMessages: string[];
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
  /**
   * How the vendor takes a jargon list and how it refuses one it will not take. Null only while
   * the protocol maps no keyterms and declares no `keytermsRejected`; the suite fails a vendor whose
   * protocol and entry disagree.
   */
  keyterms: {
    /** The terms the adapter sent, read from the connect request. */
    sent(connection: FakeVendorConnection): string[];
    /** The refusal: an HTTP status at the handshake, or a close before the ready message. */
    refusal: { httpStatus: number } | { closeBeforeReady: { code: number; reason: string } };
  } | null;
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
    // Everything is in the URL's query.
    openingMessages: [],
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
    keyterms: {
      // One `keyterms_prompt` parameter holding a JSON array (AssemblyAI's streaming API reference).
      sent: (connection) => {
        const prompt = new URL(connection.url, 'ws://vendor').searchParams.get('keyterms_prompt');
        return prompt === null ? [] : (JSON.parse(prompt) as string[]);
      },
      // AssemblyAI documents no close for a list it will not take. The protocol blames any close
      // before Begin on the list except 1008 (token, account) and 3009 (session limit), so the
      // fake refuses with its catch-all, 3005, in the vendor's own words.
      refusal: { closeBeforeReady: { code: 3005, reason: 'Session Cancelled: An error occurred' } },
    },
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
    openingMessages: [],
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
    keyterms: {
      sent: (connection) => new URL(connection.url, 'ws://vendor').searchParams.getAll('keyterm'),
      // Past its 500 tokens Deepgram refuses the whole request at the handshake.
      refusal: { httpStatus: 400 },
    },
  },
];
