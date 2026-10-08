import { describe, expect, it } from 'vitest';
import { UnsupportedSttProviderError } from '../../src/main/stt/createSpeechToText';
import { SttConnectError } from '../../src/main/stt/SpeechToText';
import type { AudioSource } from '../../src/shared/transcript';
import { BenchCredentialSource, RunStoppedError } from './credentials';
import type { BenchItem } from './items';
import { BenchOpener } from './opens';
import { REPLAY_CHUNK_MS, type ReplayGate, replayItemAttempt } from './replay';
import { FakeVendor, ScriptedTokenApi, freshTokens, tokenResponse } from './testing/fakes';
import { tone } from './testing/benchFolder';
import { ManualTimers } from './testing/manualTimers';

const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);
const SAMPLES_PER_MS = 16;

function item(sources: AudioSource[] = ['mic', 'system']): BenchItem {
  return {
    id: 'standup-1006',
    dir: '/bench/items/standup-1006',
    origin: 'backup',
    setup: 'speakers',
    sources,
  };
}

function setup(
  options: {
    vendor?: ConstructorParameters<typeof FakeVendor>[1];
    api?: ScriptedTokenApi;
    keyterms?: boolean;
    gate?: ReplayGate | null;
  } = {},
): {
  timers: ManualTimers;
  vendor: FakeVendor;
  api: ScriptedTokenApi;
  opener: BenchOpener;
  attempt: (
    audio: Map<AudioSource, Int16Array>,
    abort?: AbortController,
  ) => ReturnType<typeof replayItemAttempt>;
} {
  const timers = new ManualTimers(T0);
  const vendor = new FakeVendor(timers, options.vendor);
  const api = options.api ?? new ScriptedTokenApi(freshTokens({ pricePerHourUsd: 0.19 }));
  const credentials = new BenchCredentialSource(api, { keyterms: options.keyterms ?? true });
  const opener = new BenchOpener({ opensPerMinute: 4 }, timers);
  return {
    timers,
    vendor,
    api,
    opener,
    attempt: (audio, abort = new AbortController()) =>
      timers.settle(
        replayItemAttempt({
          item: item([...audio.keys()]),
          audio,
          credentials,
          opener,
          adapters: vendor.adapters,
          timers,
          signal: abort.signal,
          gate: options.gate ?? null,
        }),
      ),
  };
}

describe('replayItemAttempt', () => {
  it('paces 100 ms chunks at 1x, both streams of the item at once', async () => {
    const { vendor, attempt } = setup();

    const result = await attempt(
      new Map([
        ['mic', tone(1_000)],
        ['system', tone(1_000)],
      ]),
    );

    expect(REPLAY_CHUNK_MS).toBe(100);
    const [mic, system] = vendor.streams;
    const started = result.record.streams[0]?.replayStartedAtMs ?? Number.NaN;
    // A chunk goes out once its last sample would have been captured: 100 ms after the first.
    const due = Array.from({ length: 10 }, (_, index) => started + (index + 1) * 100);
    expect(mic?.sentAtMs).toEqual(due);
    expect(system?.sentAtMs).toEqual(due);
    expect(mic?.sentBytes).toBe(1_000 * SAMPLES_PER_MS * 2);
    expect(result.record.streams.map((stream) => stream.replayStartedAtMs)).toEqual([
      started,
      started,
    ]);
  });

  it('sends a short last chunk as soon as its audio ends', async () => {
    const { vendor, attempt } = setup();

    const result = await attempt(new Map([['system', tone(250)]]));

    const started = result.record.streams[0]?.replayStartedAtMs ?? Number.NaN;
    expect(vendor.streams[0]?.sentAtMs).toEqual([started + 100, started + 200, started + 250]);
  });

  it('keeps every event with its arrival time, and records the attempt', async () => {
    const { attempt } = setup({
      vendor: {
        connectMs: 300,
        onAudio: (stream, endMs) => {
          if (stream.label !== 'mic') return;
          if (endMs === 300)
            stream.emit({ type: 'interim', text: 'we ship', startMs: 0, endMs: 280 });
          if (endMs === 800) {
            stream.emit({
              type: 'final',
              text: 'We ship Friday.',
              startMs: 0,
              endMs: 760,
              confidence: 0.9,
              words: [],
            });
          }
        },
      },
    });

    const result = await attempt(
      new Map([
        ['mic', tone(1_000)],
        ['system', tone(1_000)],
      ]),
    );

    const started = T0 + 300;
    const mic = result.events.get('mic') ?? [];
    expect(mic.map((record) => [record.arrivedAtMs, record.session, record.event.type])).toEqual([
      [started + 300, 0, 'interim'],
      [started + 800, 0, 'final'],
      [started + 1_000, 0, 'closed'],
    ]);
    expect(mic[1]?.event).toMatchObject({ text: 'We ship Friday.', endMs: 760 });
    expect(result.record).toEqual({
      tokenRequestedAtMs: T0,
      tokenReceivedAtMs: T0,
      pricePerHourUsd: 0.19,
      error: null,
      streams: (['mic', 'system'] as const).map((source) => ({
        source,
        replayStartedAtMs: started,
        sessions: [
          {
            cause: 'start',
            itemOffsetMs: 0,
            openedAtMs: T0,
            readyAtMs: started,
            closedAtMs: started + 1_000,
            connectedMs: 1_000,
            backlogMs: 0,
          },
        ],
      })),
    });
  });

  it('opens with the fresh token, and with no keyterms under --no-keyterms', async () => {
    const { vendor, attempt } = setup({ keyterms: false });

    await attempt(new Map([['mic', tone(100)]]));

    expect(vendor.streams[0]?.options).toMatchObject({
      accessToken: 'tok-1',
      label: 'mic',
      settings: { keyterms: [], pricePerHourUsd: 0.19 },
    });
  });

  /**
   * xAI's client secret opens one websocket, ever (SttCredentialUse, the 2026-10-08 probe): both
   * streams of an item on one token would get the second refused with HTTP 401.
   */
  it('opens each stream with a token of its own for a single-connection vendor, both on one otherwise', async () => {
    const single = setup({ vendor: { credentialUse: 'single-connection' } });
    const result = await single.attempt(
      new Map([
        ['mic', tone(100)],
        ['system', tone(100)],
      ]),
    );
    expect(result.record.error).toBeNull();
    expect(single.vendor.streams.map((s) => [s.label, s.options.accessToken])).toEqual([
      ['mic', 'tok-1'],
      ['system', 'tok-2'],
    ]);
    expect(single.api.calls).toBe(2);

    const reusable = setup();
    await reusable.attempt(
      new Map([
        ['mic', tone(100)],
        ['system', tone(100)],
      ]),
    );
    expect(reusable.vendor.streams.map((s) => s.options.accessToken)).toEqual(['tok-1', 'tok-1']);
    expect(reusable.api.calls).toBe(1);
  });

  it("records a failed request for the second stream's token without opening anything", async () => {
    const { vendor, attempt } = setup({
      vendor: { credentialUse: 'single-connection' },
      api: new ScriptedTokenApi(tokenResponse(), new Error('POST /v1/stt/token failed: 503')),
    });

    const result = await attempt(
      new Map([
        ['mic', tone(100)],
        ['system', tone(100)],
      ]),
    );

    expect(result.record).toMatchObject({
      tokenReceivedAtMs: null,
      error: 'token request failed: POST /v1/stt/token failed: 503',
      streams: [],
    });
    expect(vendor.opens).toBe(0);
  });

  it("stops the run when the second stream's connect query holds that stream's own token", async () => {
    const { attempt } = setup({
      vendor: {
        credentialUse: 'single-connection',
        connectQuery: (options) =>
          options.label === 'system' ? `token=${options.accessToken}` : 'sample_rate=16000',
      },
    });

    await expect(
      attempt(
        new Map([
          ['mic', tone(100)],
          ['system', tone(100)],
        ]),
      ),
    ).rejects.toThrow(RunStoppedError);
  });

  it('fails the attempt on a refused connect, closes the other stream and sends no audio', async () => {
    const { vendor, attempt } = setup({
      vendor: {
        onOpen: (options) => {
          if (options.label === 'system') {
            throw new SttConnectError('AssemblyAI: Too many concurrent sessions (3009)');
          }
        },
      },
    });

    const result = await attempt(
      new Map([
        ['mic', tone(1_000)],
        ['system', tone(1_000)],
      ]),
    );

    expect(result.record.error).toBe('system: AssemblyAI: Too many concurrent sessions (3009)');
    expect(vendor.streams.map((stream) => [stream.label, stream.closed, stream.sentBytes])).toEqual(
      [['mic', true, 0]],
    );
    expect(
      result.record.streams.find((stream) => stream.source === 'system')?.sessions[0],
    ).toMatchObject({
      readyAtMs: null,
      connectedMs: 0,
    });
  });

  it('ends the attempt at a fatal vendor error and stops sending to both streams', async () => {
    const { vendor, attempt } = setup({
      vendor: {
        onAudio: (stream, endMs) => {
          if (stream.label === 'system' && endMs === 400) {
            stream.emit({ type: 'error', message: 'AssemblyAI: server error (3005)', fatal: true });
          }
        },
      },
    });

    const result = await attempt(
      new Map([
        ['mic', tone(2_000)],
        ['system', tone(2_000)],
      ]),
    );

    expect(result.record.error).toBe('system: AssemblyAI: server error (3005)');
    expect(vendor.streams.every((stream) => stream.closed)).toBe(true);
    expect(vendor.streams.map((stream) => stream.sentAtMs.length)).toEqual([4, 4]);
  });

  it('fails the attempt when the vendor closes a session the bench did not close', async () => {
    const { attempt } = setup({
      vendor: {
        onAudio: (stream, endMs) => {
          if (stream.label === 'mic' && endMs === 300) {
            stream.emit({ type: 'closed', code: 3008, reason: 'Session expired' });
          }
        },
      },
    });

    const result = await attempt(new Map([['mic', tone(1_000)]]));

    expect(result.record.error).toBe(
      'mic: the vendor closed the session (code 3008, Session expired)',
    );
  });

  it('records a failed token request without opening anything', async () => {
    const { vendor, attempt } = setup({
      api: new ScriptedTokenApi(new Error('POST /v1/stt/token failed: connection refused')),
    });

    const result = await attempt(new Map([['mic', tone(1_000)]]));

    expect(result.record).toEqual({
      tokenRequestedAtMs: T0,
      tokenReceivedAtMs: null,
      pricePerHourUsd: null,
      error: 'token request failed: POST /v1/stt/token failed: connection refused',
      streams: [],
    });
    expect(vendor.opens).toBe(0);
  });

  it("keeps the adapter's connect query, which the core gives without the token", async () => {
    const { attempt } = setup({
      vendor: { connectQuery: () => 'sample_rate=16000&encoding=pcm_s16le' },
    });

    const result = await attempt(new Map([['mic', tone(100)]]));

    expect(result.adapterQuery).toBe('sample_rate=16000&encoding=pcm_s16le');
  });

  it('stops the run, sessions closed, when a connect query holds the token', async () => {
    const { vendor, attempt } = setup({
      api: new ScriptedTokenApi(tokenResponse({ token: 'secret-tok' })),
      vendor: { connectQuery: (options) => `token=${encodeURIComponent(options.accessToken)}` },
    });

    await expect(attempt(new Map([['mic', tone(100)]]))).rejects.toThrow(RunStoppedError);
    expect(vendor.streams.every((stream) => stream.closed && stream.sentBytes === 0)).toBe(true);
  });

  it('stops the run when the API names a provider the desktop has no adapter for', async () => {
    const timers = new ManualTimers(T0);
    const credentials = new BenchCredentialSource(
      new ScriptedTokenApi(tokenResponse({ provider: 'soniox', model: 'stt-rt-v5' })),
      { keyterms: true },
    );

    const attempt = replayItemAttempt({
      item: item(['mic']),
      audio: new Map([['mic', tone(100)]]),
      credentials,
      opener: new BenchOpener({ opensPerMinute: 4 }, timers),
      adapters: (provider) => {
        throw new UnsupportedSttProviderError(provider);
      },
      timers,
      signal: new AbortController().signal,
      gate: null,
    });

    await expect(timers.settle(attempt)).rejects.toThrow(RunStoppedError);
  });

  it('stops the run when the open budget can never fit an item, before asking for a token', async () => {
    const timers = new ManualTimers(T0);
    const api = new ScriptedTokenApi(tokenResponse());

    const attempt = replayItemAttempt({
      item: item(['mic', 'system']),
      audio: new Map([
        ['mic', tone(100)],
        ['system', tone(100)],
      ]),
      credentials: new BenchCredentialSource(api, { keyterms: true }),
      opener: new BenchOpener({ opensPerMinute: 1 }, timers),
      adapters: new FakeVendor(timers).adapters,
      timers,
      signal: new AbortController().signal,
      gate: null,
    });

    await expect(timers.settle(attempt)).rejects.toThrow(RunStoppedError);
    expect(api.calls).toBe(0);
  });

  it('asks for no token and opens nothing when the run stops while the item waits for slots', async () => {
    const abort = new AbortController();
    const { vendor, api, timers, opener, attempt } = setup();
    // Another item's four opens fill the minute, so this item waits until T0 + 60 s.
    await timers.settle(opener.reserve(4, () => Promise.resolve(null)));
    void timers.sleep(5_000).then(() => {
      abort.abort('events write failed: ENOSPC');
    });

    const stopped = attempt(
      new Map([
        ['mic', tone(1_000)],
        ['system', tone(1_000)],
      ]),
      abort,
    );

    await expect(stopped).rejects.toThrow(RunStoppedError);
    await expect(stopped).rejects.toThrow('run stopped: events write failed: ENOSPC');
    expect(api.calls).toBe(0);
    expect(vendor.opens).toBe(0);
    expect(timers.now()).toBe(T0 + 5_000);
  });

  it('opens nothing when the run stops while the token is on its way', async () => {
    const abort = new AbortController();
    const { vendor, api, attempt } = setup({
      api: new ScriptedTokenApi((call) => {
        abort.abort('the API now serves deepgram nova-3');
        return tokenResponse({ token: `tok-${call + 1}` });
      }),
    });

    const stopped = attempt(new Map([['mic', tone(1_000)]]), abort);

    await expect(stopped).rejects.toThrow('run stopped: the API now serves deepgram nova-3');
    expect(api.calls).toBe(1);
    expect(vendor.opens).toBe(0);
  });

  it('ends early and says so when the run is stopped mid-replay', async () => {
    const abort = new AbortController();
    const { vendor, attempt } = setup({
      vendor: {
        onAudio: (_stream, endMs) => {
          if (endMs === 500) abort.abort('the API now serves deepgram nova-3');
        },
      },
    });

    const result = await attempt(new Map([['mic', tone(2_000)]]), abort);

    expect(result.record.error).toBe('run stopped: the API now serves deepgram nova-3');
    expect(vendor.streams[0]?.sentAtMs).toHaveLength(5);
    expect(vendor.streams[0]?.closed).toBe(true);
  });
});

describe('replayItemAttempt with --gate (M3-T20)', () => {
  const GATE: ReplayGate = {
    closeAfterMs: 30_000,
    preRollMs: 1_000,
    reopensPerMeeting: 120,
    reopenBufferMs: 3_000,
    tokenExpiresAtMs: () => null,
  };
  const silence = (ms: number): Int16Array => new Int16Array(ms * SAMPLES_PER_MS);

  function joined(...parts: Int16Array[]): Int16Array {
    const all = new Int16Array(parts.reduce((length, part) => length + part.length, 0));
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    return all;
  }

  it('closes a stream through silence and reopens it on speech with the pre-roll and the prefetched token', async () => {
    const { vendor, api, attempt } = setup({ gate: GATE });

    // Talk, a silence past the hang-over (closed once the session is a minute old), talk again.
    const result = await attempt(
      new Map([['mic', joined(tone(1_000), silence(70_000), tone(2_000))]]),
    );

    expect(result.record.error).toBeNull();
    // Start's token, then the one prefetched at the close: none at the onset.
    expect(api.calls).toBe(2);
    expect(vendor.streams.map((stream) => [stream.label, stream.options.accessToken])).toEqual([
      ['mic', 'tok-1'],
      ['mic#1', 'tok-2'],
    ]);
    expect(result.record.streams[0]?.sessions).toEqual([
      {
        cause: 'start',
        itemOffsetMs: 0,
        openedAtMs: T0,
        readyAtMs: T0,
        closedAtMs: T0 + 60_000,
        connectedMs: 60_000,
        backlogMs: 0,
      },
      {
        cause: 'gate',
        // Its stream time 0 is the pre-roll's first sample, a second before the speech.
        itemOffsetMs: 70_000,
        openedAtMs: T0 + 71_100,
        readyAtMs: T0 + 71_100,
        closedAtMs: T0 + 73_000,
        connectedMs: 1_900,
        // The pre-roll and the chunk that woke it, held until the ready signal.
        backlogMs: 1_100,
      },
    ]);
    const reopened = vendor.streams[1];
    expect(reopened?.sentBytes).toBe(3_000 * SAMPLES_PER_MS * 2);
    // Its own close is no failure; each event names its session.
    expect(
      (result.events.get('mic') ?? []).map((record) => [record.session, record.event.type]),
    ).toEqual([
      [0, 'closed'],
      [1, 'closed'],
    ]);
  });

  it('prefetches a token per gated stream for a single-connection vendor, each spent on one reopen', async () => {
    const { vendor, api, attempt } = setup({
      gate: GATE,
      vendor: { credentialUse: 'single-connection' },
    });
    const talk = joined(tone(1_000), silence(70_000), tone(2_000));

    const result = await attempt(
      new Map([
        ['mic', talk],
        ['system', talk],
      ]),
    );

    expect(result.record.error).toBeNull();
    // Start's two, then one prefetched at each stream's close: none at the onset.
    expect(api.calls).toBe(4);
    expect(vendor.streams.map((s) => [s.label, s.options.accessToken])).toEqual([
      ['mic', 'tok-1'],
      ['system', 'tok-2'],
      ['mic#1', 'tok-3'],
      ['system#1', 'tok-4'],
    ]);
  });

  it('counts the time a reopen spent connecting in its backlog', async () => {
    const { attempt } = setup({ gate: GATE, vendor: { connectMs: 300 } });

    const result = await attempt(
      new Map([['mic', joined(tone(1_000), silence(70_000), tone(2_000))]]),
    );

    // 300 ms of connect on top of the pre-roll and the chunk that woke it.
    expect(result.record.streams[0]?.sessions[1]).toMatchObject({
      itemOffsetMs: 70_000,
      backlogMs: 1_300,
    });
  });

  it('keeps the prefetched token fresh while gated, from what the run knows of its lifetime', async () => {
    const timers = new ManualTimers(T0);
    const vendor = new FakeVendor(timers);
    const api = new ScriptedTokenApi(freshTokens());
    // run.ts notes each token's expires_in when it arrives; here every token lives 30 s.
    const fetchedAt = new Map<string, number>();
    const credentials = new BenchCredentialSource(
      {
        getSttToken: async () => {
          const token = await api.getSttToken();
          fetchedAt.set(token.access_token, timers.now());
          return token;
        },
      },
      { keyterms: true },
    );
    const result = await timers.settle(
      replayItemAttempt({
        item: item(['mic']),
        audio: new Map([['mic', joined(tone(1_000), silence(100_000), tone(1_000))]]),
        credentials,
        opener: new BenchOpener({ opensPerMinute: 4 }, timers),
        adapters: vendor.adapters,
        timers,
        signal: new AbortController().signal,
        gate: {
          ...GATE,
          tokenExpiresAtMs: (token) => (fetchedAt.get(token) ?? Number.NaN) + 30_000,
        },
      }),
    );

    expect(result.record.error).toBeNull();
    // Start's, the prefetch at the close (60 s), its refreshes at 80 s and 100 s; none at onset.
    expect([...fetchedAt.values()]).toEqual([T0, T0 + 60_000, T0 + 80_000, T0 + 100_000]);
    expect(vendor.streams[1]?.options.accessToken).toBe('tok-4');
  });

  it('never reopens on silence, and stops closing once its own reopens are spent', async () => {
    const { vendor, attempt } = setup({ gate: { ...GATE, reopensPerMeeting: 1 } });

    const result = await attempt(
      new Map([['mic', joined(tone(1_000), silence(70_000), tone(1_000), silence(90_000))]]),
    );

    expect(result.record.error).toBeNull();
    // One close and its reopen; the second silence keeps the reopened session open.
    expect(vendor.streams.map((stream) => stream.label)).toEqual(['mic', 'mic#1']);
    expect(result.record.streams[0]?.sessions.map((session) => session.closedAtMs)).toEqual([
      T0 + 60_000,
      T0 + 162_000,
    ]);
  });

  it('opens every reopen through the bench open budget', async () => {
    const { vendor, opener, timers, attempt } = setup({ gate: GATE });
    // Another item's opens fill the minute just before the speech: the reopen waits for a slot.
    void timers.sleep(70_500).then(() => opener.reserve(4, () => Promise.resolve(null)));

    const result = await attempt(
      new Map([['mic', joined(tone(1_000), silence(70_000), tone(62_000))]]),
    );

    expect(result.record.error).toBeNull();
    expect(vendor.streams[1]?.label).toBe('mic#1');
    expect(result.record.streams[0]?.sessions[1]?.openedAtMs).toBe(T0 + 130_500);
  });
});
