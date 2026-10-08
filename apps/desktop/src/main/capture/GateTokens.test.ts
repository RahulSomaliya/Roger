import { describe, expect, it } from 'vitest';
import type { SttCredentialUse } from '../stt/SpeechToText';
import { GateTokens } from './GateTokens';

interface Token {
  id: string;
  expiresAtMs: number;
}

/** Lets every pending promise callback run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Tokens numbered as the API hands them out, each good for `ttlMs` from when it came. */
function tokens(credentialUse: SttCredentialUse, ttlMs = 30_000) {
  let now = 0;
  let fetched = 0;
  let failing = 0;
  const failures: [unknown, number][] = [];
  const gate = new GateTokens<Token>({
    credentialUse,
    fetch: () => {
      fetched += 1;
      if (failing > 0) {
        failing -= 1;
        return Promise.reject(new Error('API unreachable'));
      }
      return Promise.resolve({ id: `token-${fetched}`, expiresAtMs: now + ttlMs });
    },
    leftMs: (token) => token.expiresAtMs - now,
    now: () => now,
    onPrefetchFailed: (error, retryInMs) => {
      failures.push([error, retryInMs]);
    },
  });
  return {
    gate,
    failures,
    fetched: () => fetched,
    failNext: (count: number) => {
      failing = count;
    },
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe('GateTokens', () => {
  describe('for a reusable token (AssemblyAI)', () => {
    it('keeps one token for every gated source and hands it to each reopen', async () => {
      const t = tokens('reusable');
      t.gate.keepFresh(['mic', 'system']);
      await flush();
      expect(t.fetched()).toBe(1);

      expect((await t.gate.take('mic')).id).toBe('token-1');
      expect((await t.gate.take('system')).id).toBe('token-1');
      expect(t.fetched()).toBe(1);
    });

    it('refreshes it 10 s before it expires, at most every 10 s', async () => {
      const t = tokens('reusable');
      t.gate.keepFresh(['mic']);
      await flush();
      t.at(19_000);
      t.gate.keepFresh(['mic']);
      await flush();
      expect(t.fetched()).toBe(1);
      t.at(20_000); // 10 s left
      t.gate.keepFresh(['mic']);
      await flush();
      expect(t.fetched()).toBe(2);
      expect((await t.gate.take('mic')).id).toBe('token-2');
    });
  });

  describe('for a single-connection token (xAI)', () => {
    it('keeps one token per gated source, and none reaches two reopens', async () => {
      const t = tokens('single-connection');
      t.gate.keepFresh(['mic', 'system']);
      await flush();
      expect(t.fetched()).toBe(2);

      const mic = await t.gate.take('mic');
      const system = await t.gate.take('system');
      expect([mic.id, system.id].sort()).toEqual(['token-1', 'token-2']);
      // Spent: the next reopen of the mic fetches its own at the onset.
      expect((await t.gate.take('mic')).id).toBe('token-3');
    });

    it('hands a prefetch still on its way to one reopen only', async () => {
      const t = tokens('single-connection');
      t.gate.keepFresh(['mic']);
      const first = t.gate.take('mic');
      const second = t.gate.take('mic');
      const ids = [(await first).id, (await second).id];
      expect(ids).toEqual(['token-1', 'token-2']);
    });

    it('prefetches again for a source gated again after its token was spent', async () => {
      const t = tokens('single-connection');
      t.gate.keepFresh(['mic']);
      await flush();
      expect((await t.gate.take('mic')).id).toBe('token-1');
      t.at(70_000);
      t.gate.keepFresh(['mic']);
      await flush();
      expect(t.fetched()).toBe(2);
      expect((await t.gate.take('mic')).id).toBe('token-2');
    });
  });

  it('fetches at the onset when the prefetched token has under 5 s left', async () => {
    const t = tokens('reusable');
    t.gate.keepFresh(['mic']);
    await flush();
    t.at(25_001);
    expect((await t.gate.take('mic')).id).toBe('token-2');
  });

  it('reports a failed prefetch with when it is tried again, and the onset fetches', async () => {
    const t = tokens('single-connection');
    t.failNext(1);
    t.at(1_000);
    t.gate.keepFresh(['mic']);
    await flush();
    expect(t.failures).toEqual([[new Error('API unreachable'), 10_000]]);
    t.gate.keepFresh(['mic']);
    await flush();
    expect(t.fetched()).toBe(1);
    expect((await t.gate.take('mic')).id).toBe('token-2');
  });
});
