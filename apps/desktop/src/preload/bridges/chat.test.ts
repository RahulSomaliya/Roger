import { describe, expect, it, vi } from 'vitest';
import { chatChannels } from '../../shared/ipc/chat';
import { chatBridge } from './chat';

// Electron's ipcRenderer, as far as the bridge helpers use it (see ../bridge.test.ts). Hoisted,
// because vi.mock runs before the imports.
const ipc = vi.hoisted(() => {
  const listeners = new Map<string, ((event: object, payload: unknown) => void)[]>();
  const calls: { how: 'invoke' | 'on'; channel: string; payload?: unknown }[] = [];
  return {
    calls,
    renderer: {
      invoke: (channel: string, payload: unknown): Promise<unknown> => {
        calls.push({ how: 'invoke', channel, payload });
        return Promise.resolve(null);
      },
      on: (channel: string, listener: (event: object, payload: unknown) => void): void => {
        calls.push({ how: 'on', channel });
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      removeListener: (channel: string, listener: (event: object, payload: unknown) => void) => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((each) => each !== listener),
        );
      },
    },
    emit: (channel: string, payload: unknown): void => {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

const MEETING = '2f6a7d0e-58d4-4c4b-9a0e-0d6f1f7a3c11';
const MESSAGE = '6e2b9f14-3c5d-4a7e-8b1f-2d4c6e8a0b13';

describe('the chat bridge', () => {
  it('sends each request on its own channel with its one payload', async () => {
    ipc.calls.length = 0;
    await chatBridge.getChatThread(MEETING);
    await chatBridge.sendChatMessage({ meetingId: MEETING, messageId: MESSAGE, text: 'Why?' });
    await chatBridge.cancelChatAnswer({ meetingId: MEETING, messageId: MESSAGE });

    expect(ipc.calls).toEqual([
      { how: 'invoke', channel: chatChannels.ChatGetThread, payload: MEETING },
      {
        how: 'invoke',
        channel: chatChannels.ChatSend,
        payload: { meetingId: MEETING, messageId: MESSAGE, text: 'Why?' },
      },
      {
        how: 'invoke',
        channel: chatChannels.ChatCancel,
        payload: { meetingId: MEETING, messageId: MESSAGE },
      },
    ]);
  });

  it('hands each listener its own event until it unsubscribes', () => {
    ipc.calls.length = 0;
    const heard: [string, unknown][] = [];
    const stops = [
      chatBridge.onChatEvent((message) => heard.push(['event', message])),
      chatBridge.onChatThreadChanged((thread) => heard.push(['thread', thread])),
    ];
    ipc.emit(chatChannels.ChatEvent, 'an answer event');
    ipc.emit(chatChannels.ChatThreadChanged, 'a thread');
    for (const stop of stops) stop();
    ipc.emit(chatChannels.ChatEvent, 'after unsubscribe');

    expect(heard).toEqual([
      ['event', 'an answer event'],
      ['thread', 'a thread'],
    ]);
    // Every channel is used, each by one member.
    const used = ipc.calls.map((call) => call.channel);
    expect(used).toEqual([chatChannels.ChatEvent, chatChannels.ChatThreadChanged]);
    expect(
      [chatChannels.ChatGetThread, chatChannels.ChatSend, chatChannels.ChatCancel, ...used].sort(),
    ).toEqual(Object.values(chatChannels).sort());
    expect(Object.keys(chatBridge)).toHaveLength(Object.values(chatChannels).length);
  });
});
