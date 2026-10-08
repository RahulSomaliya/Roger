import type { WebSocket } from 'ws';
import type { SttCredentialUse, SttStreamSettings } from '../SpeechToText';
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
   * What one of its tokens may open (SttCredentialUse); the protocol must declare the same. For
   * `single-connection` the fake refuses a token it has seen with HTTP 401
   * (FakeVendorServer.singleUseCredentials), so every open in the suite gets a token of its own.
   */
  credentialUse: SttCredentialUse;
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
   * the protocol maps no keyterms; the suite fails a vendor whose protocol and entry disagree.
   */
  keyterms: {
    /** The terms the adapter sent, read from the connect request or the opening messages. */
    sent(connection: FakeVendorConnection): string[];
    /**
     * The refusal: an HTTP status at the handshake, or a close before the ready message; the
     * protocol then declares `keytermsRejected`. Null for a vendor that refuses no list while it
     * connects (Soniox reads its start request only once the stream is open), whose protocol
     * declares none.
     */
    refusal: { httpStatus: number } | { closeBeforeReady: { code: number; reason: string } } | null;
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
    // "One token may open several sessions" within its window (the API's stt_tokens.py).
    credentialUse: 'reusable',
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
    // A grant is checked at each handshake within its 30 s.
    credentialUse: 'reusable',
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
  {
    provider: 'soniox',
    settings: {
      model: 'stt-rt-v5',
      language: 'en',
      sampleRate: 16000,
      encoding: 'linear16',
      pricePerHourUsd: 0.12,
    },
    // The API asks for every key with `single_use: false`.
    credentialUse: 'reusable',
    // The start request: Soniox refuses a session whose first message is not this one.
    openingMessages: [
      JSON.stringify({
        model: 'stt-rt-v5',
        audio_format: 'pcm_s16le',
        sample_rate: 16000,
        num_channels: 1,
        enable_endpoint_detection: true,
      }),
    ],
    // Soniox answers nothing to the start request: the handshake is the ready signal.
    readyMessage: null,
    // `finalize`, then the empty text frame that ends the stream.
    finishMessages: [JSON.stringify({ type: 'finalize' }), ''],
    // The finished response. Soniox closes the socket after it as well; the fake leaves that to
    // the core, as AssemblyAI's does, so the suite proves the core closes on the message.
    answerFinish: (socket) => {
      socket.send(
        JSON.stringify({
          tokens: [],
          final_audio_proc_ms: 500,
          total_audio_proc_ms: 500,
          finished: true,
        }),
      );
    },
    // One utterance: its final tokens, then the endpoint marker that ends the line.
    finalMessage: (text) =>
      JSON.stringify({
        tokens: [
          { text, start_ms: 0, end_ms: 500, confidence: 0.9, is_final: true },
          { text: '<end>', start_ms: 500, end_ms: 500, confidence: 1, is_final: true },
        ],
        final_audio_proc_ms: 500,
        total_audio_proc_ms: 500,
      }),
    // Soniox documents 1001 for a connection closed as idle, not its reason text: this one is ours.
    midCallClose: { code: 1001, reason: 'idle' },
    // The 5-hour cap the API's key asks for (M3-T14): Soniox's words, then a normal close.
    errorFrame: JSON.stringify({
      tokens: [],
      error_code: 403,
      error_type: 'temp_api_key_session_expired',
      error_message:
        'Temporary API key session duration limit exceeded. Create a new temporary API key to ' +
        'start a new session.',
    }),
    keepAliveMessage: JSON.stringify({ type: 'keepalive' }),
    // No hard rate rule: "brief buffering" is tolerated (SonioxSpeechToText.ts, audioPacing).
    rejectsAudioFasterThanRealTime: false,
    keyterms: {
      // `context.terms` in the start request, the first text message.
      sent: (connection) => {
        const start = JSON.parse(connection.texts[0] ?? '{}') as { context?: { terms?: string[] } };
        return start.context?.terms ?? [];
      },
      // Soniox reads the start request once the stream is open, and its refusals arrive there as
      // error responses: none can be put down to the list at connect.
      refusal: null,
    },
  },
  {
    provider: 'xai',
    settings: {
      model: 'grok-voice-transcribe-2.0',
      language: 'en',
      sampleRate: 16000,
      encoding: 'linear16',
      pricePerHourUsd: 0.2,
    },
    // A client secret opens one websocket, ever: the 2026-10-08 probe (XaiSpeechToText.ts header).
    credentialUse: 'single-connection',
    // Everything is in the URL's query.
    openingMessages: [],
    // xAI's ready signal: "wait for this before sending audio".
    readyMessage: JSON.stringify({ type: 'transcript.created' }),
    // `Finalize` (xAI accepts `finalize` too), then `audio.done`.
    finishMessages: [JSON.stringify({ type: 'Finalize' }), JSON.stringify({ type: 'audio.done' })],
    // transcript.done ends the stream. xAI closes the socket after it as well; the fake leaves
    // that to the core, as AssemblyAI's and Soniox's do, so the suite proves the core closes on
    // the message.
    answerFinish: (socket) => {
      socket.send(JSON.stringify({ type: 'transcript.done', text: '', duration: 1 }));
    },
    // An utterance-final partial: the one state that is a line.
    finalMessage: (text) =>
      JSON.stringify({
        type: 'transcript.partial',
        text,
        words: [{ text, start: 0, end: 0.5 }],
        is_final: true,
        speech_final: true,
        start: 0,
        duration: 0.5,
      }),
    // xAI documents no close codes: this one is ours (1011, the standard server error).
    midCallClose: { code: 1011, reason: 'internal error' },
    errorFrame: JSON.stringify({ type: 'error', message: 'internal error' }),
    // xAI documents no keep-alive message.
    keepAliveMessage: null,
    // "real-time-paced" in its examples, but no close for a burst is documented, so a burst must
    // go at once (XaiSpeechToText.ts, audioPacing).
    rejectsAudioFasterThanRealTime: false,
    keyterms: {
      // One `keyterm` parameter per term in the URL's query.
      sent: (connection) => new URL(connection.url, 'ws://vendor').searchParams.getAll('keyterm'),
      // xAI documents no refusal of a list, and its limits equal the shared ones (keyterms.ts):
      // none is put down to the list at connect.
      refusal: null,
    },
  },
];
