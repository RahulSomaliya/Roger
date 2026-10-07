import { describe, expect, it } from 'vitest';
import type { PromptApi, PromptPanelState } from '../../../shared/ipc/prompt';
import { followPromptState, type PromptFeed } from './promptState';
import { callDetectedCard } from './promptTesting';

const state = (ids: string[]): PromptPanelState => ({
  cards: ids.map((id) => callDetectedCard({ id })),
  recording: false,
  recordingTitle: null,
});

/** A panel API whose read answers when the test says so. */
function fakeApi() {
  const listeners = new Set<(state: PromptPanelState) => void>();
  let answer: { resolve: (value: PromptPanelState) => void; reject: (error: Error) => void };
  const calls: string[] = [];
  const api: Pick<PromptApi, 'getState' | 'onStateChanged'> = {
    getState: () => {
      calls.push('read');
      return new Promise((resolve, reject) => {
        answer = { resolve, reject };
      });
    },
    onStateChanged: (listener) => {
      calls.push('subscribe');
      listeners.add(listener);
      return () => {
        calls.push('unsubscribe');
        listeners.delete(listener);
      };
    },
  };
  return {
    api,
    calls,
    answer: (value: PromptPanelState) => {
      answer.resolve(value);
    },
    fail: (error: Error) => {
      answer.reject(error);
    },
    push: (value: PromptPanelState) => {
      for (const listener of listeners) listener(value);
    },
  };
}

function record() {
  const feed: PromptFeed[] = [];
  return { feed, onFeed: (next: PromptFeed) => feed.push(next) };
}

describe('followPromptState', () => {
  it('subscribes before it reads, so a change between the two is not missed', () => {
    const fake = fakeApi();
    followPromptState(fake.api, record().onFeed);
    expect(fake.calls).toEqual(['subscribe', 'read']);
  });

  it('shows the state main answers, then every change', async () => {
    const fake = fakeApi();
    const { feed, onFeed } = record();
    followPromptState(fake.api, onFeed);
    fake.answer(state(['a']));
    await Promise.resolve();
    fake.push(state(['a', 'b']));
    expect(feed.map((each) => each.state?.cards.map((card) => card.id))).toEqual([
      ['a'],
      ['a', 'b'],
    ]);
  });

  it('drops a read that answers after a change: the change is newer', async () => {
    const fake = fakeApi();
    const { feed, onFeed } = record();
    followPromptState(fake.api, onFeed);
    fake.push(state(['new']));
    fake.answer(state(['old']));
    await Promise.resolve();
    expect(feed.map((each) => each.state?.cards.map((card) => card.id))).toEqual([['new']]);
  });

  it('drops a read that answers after the stop, and stops listening', async () => {
    const fake = fakeApi();
    const { feed, onFeed } = record();
    const stop = followPromptState(fake.api, onFeed);
    stop();
    fake.answer(state(['late']));
    await Promise.resolve();
    expect(feed).toEqual([]);
    expect(fake.calls).toContain('unsubscribe');
  });

  it('reports a failed read with the reason, and keeps listening for changes', async () => {
    const fake = fakeApi();
    const { feed, onFeed } = record();
    followPromptState(fake.api, onFeed);
    fake.fail(new Error('untrusted sender'));
    await Promise.resolve();
    expect(feed).toEqual([
      { state: null, error: 'Could not read the prompt panel: untrusted sender' },
    ]);
    fake.push(state(['a']));
    expect(feed[1]?.error).toBeNull();
    expect(feed[1]?.state?.cards).toHaveLength(1);
  });
});
