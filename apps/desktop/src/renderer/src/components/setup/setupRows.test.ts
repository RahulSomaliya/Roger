import { describe, expect, it } from 'vitest';
import type { SetupStatus } from '../../../../shared/ipc/setup';
import { setupRows, setupSummary, type SetupRowView } from './setupRows';
import { fine, firstRunMac, readyMac, refusedMac } from './setupTesting';

function row(status: SetupStatus, id: SetupRowView['id']): SetupRowView {
  const found = setupRows(status).find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no ${id} row`);
  return found;
}

const kinds = (view: SetupRowView): string[] => view.actions.map((action) => action.kind);

describe('setupRows', () => {
  it('lists the six checks in the order a person fixes them', () => {
    expect(setupRows(readyMac()).map((view) => view.id)).toEqual([
      'microphone',
      'callAudio',
      'notifications',
      'signing',
      'server',
      'speechToText',
    ]);
  });

  it('shows a ready Mac as ready, with only the tests left to offer', () => {
    const rows = setupRows(readyMac());
    expect(rows.map((view) => [view.id, view.tone, view.stateLabel])).toEqual([
      ['microphone', 'ok', 'Allowed'],
      ['callAudio', 'ok', 'Heard'],
      ['notifications', 'neutral', 'Not tested'],
      ['signing', 'ok', 'Signed on this Mac'],
      ['server', 'ok', 'Reachable'],
      ['speechToText', 'ok', 'Ready'],
    ]);
    expect(kinds(row(readyMac(), 'microphone'))).toEqual([]);
    expect(kinds(row(readyMac(), 'callAudio'))).toEqual(['test-system-audio']);
    expect(kinds(row(readyMac(), 'notifications'))).toEqual(['test-notification']);
    expect(kinds(row(readyMac(), 'server'))).toEqual([]);
  });

  it('offers Allow on a first run, and the test for call audio not yet heard', () => {
    const microphone = row(firstRunMac(), 'microphone');
    expect(microphone).toMatchObject({ tone: 'attention', stateLabel: 'Not asked yet' });
    expect(microphone.actions).toEqual([{ kind: 'request-microphone', label: 'Allow microphone' }]);
    const callAudio = row(firstRunMac(), 'callAudio');
    expect(callAudio).toMatchObject({ tone: 'neutral', stateLabel: 'Not tested' });
    expect(callAudio.actions).toEqual([{ kind: 'test-system-audio', label: 'Test call audio' }]);
  });

  it('sends a refused permission to its pane and offers a relaunch where macOS needs one', () => {
    const microphone = row(refusedMac(), 'microphone');
    expect(microphone).toMatchObject({ tone: 'problem', stateLabel: 'Not allowed' });
    expect(microphone.message).toContain('System Settings > Privacy & Security > Microphone');
    expect(microphone.actions).toEqual([
      { kind: 'open-pane', pane: 'microphone', label: 'Open Microphone settings' },
      { kind: 'relaunch', label: 'Relaunch Roger' },
    ]);
    expect(kinds(row(refusedMac(), 'callAudio'))).toEqual([
      'open-pane',
      'test-system-audio',
      'relaunch',
    ]);
    expect(row(refusedMac(), 'callAudio').actions[0]).toEqual({
      kind: 'open-pane',
      pane: 'systemAudio',
      label: 'Open System Audio settings',
    });
  });

  it('puts I allowed it first while macOS may still be asking', () => {
    const status: SetupStatus = {
      ...readyMac(),
      systemAudio: {
        state: 'pending',
        message: 'Roger heard nothing. If macOS is asking, allow it, then press I allowed it.',
        relaunchNeeded: false,
      },
    };
    const callAudio = row(status, 'callAudio');
    expect(callAudio).toMatchObject({ tone: 'attention', stateLabel: 'Waiting for you' });
    expect(callAudio.actions).toEqual([
      { kind: 'confirm-system-audio', label: 'I allowed it' },
      { kind: 'open-pane', pane: 'systemAudio', label: 'Open System Audio settings' },
      { kind: 'test-system-audio', label: 'Test again' },
    ]);
  });

  it("shows Screen Recording as call audio on Electron's path", () => {
    const status: SetupStatus = {
      ...readyMac(),
      systemCapture: 'electron',
      systemAudio: fine('unknown'),
      screenRecording: {
        state: 'denied',
        message: 'Roger is not allowed to record the screen. Turn on Roger, then relaunch Roger.',
        relaunchNeeded: true,
      },
    };
    const callAudio = row(status, 'callAudio');
    expect(callAudio).toMatchObject({ tone: 'problem', stateLabel: 'Not allowed' });
    expect(callAudio.description).toContain('Screen Recording');
    expect(callAudio.actions).toEqual([
      { kind: 'open-pane', pane: 'screenRecording', label: 'Open Screen Recording settings' },
      { kind: 'relaunch', label: 'Relaunch Roger' },
    ]);
  });

  it('flags a good state that still carries a message, such as a development build', () => {
    const status: SetupStatus = {
      ...readyMac(),
      signing: {
        state: 'developer-id',
        message: 'This is a development build: macOS keeps its permissions for the terminal.',
        relaunchNeeded: false,
      },
    };
    expect(row(status, 'signing')).toMatchObject({
      tone: 'attention',
      stateLabel: 'Signed by a Developer ID',
    });
  });

  it('offers Check again for a server that did not answer, and a failed notification test again', () => {
    expect(row(refusedMac(), 'server').actions).toEqual([
      { kind: 'recheck', label: 'Check again' },
    ]);
    expect(row(refusedMac(), 'speechToText')).toMatchObject({
      tone: 'neutral',
      stateLabel: 'Not checked',
    });
    const failed: SetupStatus = {
      ...readyMac(),
      notifications: { state: 'failed', message: 'macOS did not show it.', relaunchNeeded: false },
    };
    expect(row(failed, 'notifications')).toMatchObject({
      tone: 'problem',
      stateLabel: 'Not shown',
    });
    expect(kinds(row(failed, 'notifications'))).toEqual(['test-notification']);
  });
});

describe('setupSummary', () => {
  it('says all is ready, or how many checks need the person', () => {
    expect(setupSummary(setupRows(readyMac()))).toBe('Roger has what it needs on this Mac.');
    expect(setupSummary(setupRows(firstRunMac()))).toBe('1 check needs you.');
    expect(setupSummary(setupRows(refusedMac()))).toBe('4 checks need you.');
  });
});
