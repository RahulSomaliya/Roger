import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../logger';
import type { SigningIdentity } from '../../signing';
import { InMemoryTranscriptStore } from '../../store/InMemoryTranscriptStore';
import { SYSTEM_AUDIO_VERIFIED_KEY, SystemAudioVerification } from './systemAudioVerification';

const LOCAL: SigningIdentity = {
  kind: 'local-identity',
  requirement: 'identifier "ai.linkt.roger" and certificate leaf = H"b457"',
  requirementHash: 'a'.repeat(64),
};
const NOW = Date.parse('2026-10-07T09:00:00.000Z');

function logged() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'info',
    format: 'json',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, logger };
}

function verification(
  identity: Promise<SigningIdentity>,
  store = new InMemoryTranscriptStore(),
  logger = logged().logger,
) {
  const onChange = vi.fn();
  const verified = new SystemAudioVerification({
    store,
    identity,
    logger,
    clock: () => NOW,
    onChange,
  });
  return { verified, store, onChange };
}

/** A promise settled outside, so a test can hear audio before the identity is read. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SystemAudioVerification', () => {
  it('reads that call audio was heard under this signing identity', async () => {
    const store = new InMemoryTranscriptStore();
    store.setAppState(SYSTEM_AUDIO_VERIFIED_KEY, LOCAL.requirementHash!, '2026-10-01T00:00:00Z');
    const { verified, onChange } = verification(Promise.resolve(LOCAL), store);
    expect(verified.verified).toBe(false);
    await verified.ready;
    expect(verified.verified).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // macOS pins the grant to the designated requirement: a new identity has no grant yet.
  it('is not verified under another identity', async () => {
    const store = new InMemoryTranscriptStore();
    store.setAppState(SYSTEM_AUDIO_VERIFIED_KEY, 'b'.repeat(64), '2026-10-01T00:00:00Z');
    const { verified } = verification(Promise.resolve(LOCAL), store);
    await verified.ready;
    expect(verified.verified).toBe(false);
  });

  it('stores the identity the first time call audio is heard, once', async () => {
    const { verified, store, onChange } = verification(Promise.resolve(LOCAL));
    await verified.ready;
    verified.markHeard('tap');
    verified.markHeard('tap');
    expect(verified.verified).toBe(true);
    expect(store.getAppState(SYSTEM_AUDIO_VERIFIED_KEY)).toEqual({
      value: LOCAL.requirementHash,
      updatedAt: '2026-10-07T09:00:00.000Z',
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stores audio heard before the identity was read once it is', async () => {
    const identity = deferred<SigningIdentity>();
    const { verified, store } = verification(identity.promise);
    verified.markHeard('tap');
    expect(verified.verified).toBe(true);
    expect(store.getAppState(SYSTEM_AUDIO_VERIFIED_KEY)).toBeNull();
    identity.resolve(LOCAL);
    await verified.ready;
    expect(store.getAppState(SYSTEM_AUDIO_VERIFIED_KEY)?.value).toBe(LOCAL.requirementHash);
  });

  it('keeps it for this run only when the identity is unknown or unsigned', async () => {
    for (const identity of [
      Promise.reject(new Error('codesign gave no answer')),
      Promise.resolve<SigningIdentity>({
        kind: 'unsigned',
        requirement: null,
        requirementHash: null,
      }),
    ]) {
      const { lines, logger } = logged();
      const { verified, store } = verification(identity, new InMemoryTranscriptStore(), logger);
      await verified.ready;
      expect(verified.verified).toBe(false);
      verified.markHeard('tap');
      expect(verified.verified).toBe(true);
      expect(store.getAppState(SYSTEM_AUDIO_VERIFIED_KEY)).toBeNull();
      expect(lines.map((line) => line.message)).toContain(
        'system audio verified for this run only: the signing identity is unknown',
      );
    }
  });

  it('logs a store that refuses the write, and stays verified for this run', async () => {
    const store = new InMemoryTranscriptStore();
    vi.spyOn(store, 'setAppState').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const { lines, logger } = logged();
    const { verified } = verification(Promise.resolve(LOCAL), store, logger);
    await verified.ready;
    verified.markHeard('tap');
    expect(verified.verified).toBe(true);
    expect(
      lines.find((line) => line.message === 'system audio verified, but not saved'),
    ).toMatchObject({ level: 'error', error: 'database is locked' });
  });

  it('logs a store that cannot be read, and reads as not verified', async () => {
    const store = new InMemoryTranscriptStore();
    vi.spyOn(store, 'getAppState').mockImplementation(() => {
      throw new Error('database is not open');
    });
    const { lines, logger } = logged();
    const { verified } = verification(Promise.resolve(LOCAL), store, logger);
    await verified.ready;
    expect(verified.verified).toBe(false);
    expect(lines.map((line) => line.message)).toContain('system audio verified state not read');
  });
});
