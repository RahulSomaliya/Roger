import { describe, expect, it, vi } from 'vitest';
import { meetingsChannels } from '../../shared/ipc/meetings';
import { meetingsBridge } from './meetings';

// Electron's ipcRenderer, as far as the bridge helpers use it (see ../bridge.test.ts). Hoisted,
// because vi.mock runs before the imports.
const ipc = vi.hoisted(() => {
  const calls: { channel: string; payload: unknown }[] = [];
  return {
    calls,
    renderer: {
      invoke: (channel: string, payload: unknown): Promise<unknown> => {
        calls.push({ channel, payload });
        return Promise.resolve(null);
      },
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

describe('the meetings bridge', () => {
  it('sends each read on its own channel with its one payload', async () => {
    ipc.calls.length = 0;
    await meetingsBridge.listMeetings({ limit: 30 });
    await meetingsBridge.getMeeting({ meetingId: MEETING });
    expect(ipc.calls).toEqual([
      { channel: meetingsChannels.MeetingsList, payload: { limit: 30 } },
      { channel: meetingsChannels.MeetingsGet, payload: { meetingId: MEETING } },
    ]);
  });

  it('uses the channel names main registers', () => {
    expect(meetingsChannels).toEqual({
      MeetingsList: 'meetings:list',
      MeetingsGet: 'meetings:get',
    });
  });
});
