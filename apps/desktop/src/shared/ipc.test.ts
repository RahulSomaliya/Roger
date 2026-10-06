import { describe, expect, it } from 'vitest';
import { featureChannels, IpcChannel } from './ipc';

type ChannelMaps = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Each key (or channel name) that more than one feature uses, with the features that use it. */
function sharedAcross(features: ChannelMaps, part: 'key' | 'name'): [string, string[]][] {
  const users = new Map<string, string[]>();
  for (const [feature, channels] of Object.entries(features)) {
    for (const [key, name] of Object.entries(channels)) {
      const id = part === 'key' ? key : name;
      users.set(id, [...(users.get(id) ?? []), feature]);
    }
  }
  return [...users].filter(([, features]) => features.length > 1);
}

describe('the IPC contract', () => {
  it('finds a key or a name two features share (the check below can fail)', () => {
    const clash = {
      notes: { NotesGet: 'notes:get' },
      chat: { NotesGet: 'chat:get', ChatSend: 'notes:get' },
    };
    expect(sharedAcross(clash, 'key')).toEqual([['NotesGet', ['notes', 'chat']]]);
    expect(sharedAcross(clash, 'name')).toEqual([['notes:get', ['notes', 'chat']]]);
  });

  // A key two features share is not a type error: the later spread in IpcChannel silently
  // replaces the earlier feature's channel, and its handler or bridge talks to the wrong one.
  it('gives every channel a key no other feature uses', () => {
    expect(sharedAcross(featureChannels, 'key')).toEqual([]);
  });

  // Two handlers on one name throw at startup (ipcMain.handle) or both run (ipcMain.on).
  it('gives every channel a name no other feature uses', () => {
    expect(sharedAcross(featureChannels, 'name')).toEqual([]);
  });

  it('puts every feature channel into IpcChannel unchanged, and nothing else', () => {
    const fromFeatures = Object.values(featureChannels).flatMap((channels) =>
      Object.entries(channels),
    );
    expect(Object.entries(IpcChannel).sort()).toEqual(fromFeatures.sort());
  });

  it('keeps the capture channels the M1 renderer and main already use', () => {
    expect(IpcChannel).toMatchObject({
      CaptureStart: 'capture:start',
      CaptureStop: 'capture:stop',
      CaptureGetStatus: 'capture:get-status',
      AudioGetSystemSource: 'audio:get-system-source',
      AudioChunk: 'audio:chunk',
      AudioSourceState: 'audio:source-state',
      CaptureStatusChanged: 'capture:status-changed',
      TranscriptSegment: 'transcript:segment',
      TranscriptInterim: 'transcript:interim',
    });
  });
});
