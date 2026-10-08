import { describe, expect, it } from 'vitest';
import type { SetupStatus } from '../../../../shared/ipc/setup';
import {
  leadingFix,
  needsYou,
  passingLine,
  setupRows,
  splitRows,
  type SetupRowView,
} from './setupRows';
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

  it('flags a check main could not run when it says why, such as a missing helper', () => {
    // PermissionService's `unknown` checks that carry a message (main/setup/PermissionService.ts).
    const helperMissing: SetupStatus = {
      ...readyMac(),
      systemAudio: {
        state: 'unknown',
        message:
          "Roger's call audio helper is missing from this copy of Roger, so it cannot record call audio. Reinstall Roger with make install-desktop.",
        relaunchNeeded: false,
      },
    };
    expect(row(helperMissing, 'callAudio')).toMatchObject({
      tone: 'attention',
      stateLabel: 'Not tested',
    });
    const unread: SetupStatus = {
      ...readyMac(),
      microphone: {
        state: 'unknown',
        message:
          'macOS did not say whether Roger may use the microphone. Check that Roger is on under System Settings > Privacy & Security > Microphone.',
        relaunchNeeded: false,
      },
      signing: {
        state: 'unknown',
        message:
          'Roger could not read its own signature, so it cannot tell whether macOS will keep its permissions.',
        relaunchNeeded: false,
      },
    };
    expect(row(unread, 'microphone').tone).toBe('attention');
    expect(row(unread, 'signing').tone).toBe('attention');
    // Not tested with nothing to say is still just not tested.
    expect(row(readyMac(), 'notifications').tone).toBe('neutral');
  });

  it('keeps speech-to-text grey when it was not checked because the server row is already red', () => {
    expect(row(refusedMac(), 'speechToText')).toMatchObject({
      tone: 'neutral',
      stateLabel: 'Not checked',
      message: "Not checked: Roger can't reach its server.",
    });
    const serverUp: SetupStatus = {
      ...readyMac(),
      stt: { state: 'unknown', message: 'Not checked: something else.', relaunchNeeded: false },
    };
    expect(row(serverUp, 'speechToText').tone).toBe('attention');
  });

  it('never calls a server that answered "not reachable"', () => {
    // connectionChecks.ts: GET /health answers 503 while Postgres is down (docs/api-contract.md).
    const databaseDown: SetupStatus = {
      ...readyMac(),
      api: {
        state: 'failed',
        message: "Roger's server is running but cannot reach its database.",
        relaunchNeeded: false,
      },
    };
    expect(row(databaseDown, 'server')).toMatchObject({
      tone: 'problem',
      stateLabel: 'Not working',
    });
    expect(row(refusedMac(), 'server').stateLabel).toBe('Not working');
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

const helperMissing: SetupStatus = {
  ...readyMac(),
  systemAudio: {
    state: 'unknown',
    message:
      "Roger's call audio helper is missing from this copy of Roger, so it cannot record call audio. Reinstall Roger with make install-desktop.",
    relaunchNeeded: false,
  },
};

describe('splitRows', () => {
  it('keeps only what is not fine in the default view, and counts the rest as passing', () => {
    const { open, passing } = splitRows(setupRows(readyMac()));
    // Notifications are not tested yet: not a pass, so the person can still send the test.
    expect(open.map((view) => view.id)).toEqual(['notifications']);
    expect(passing.map((view) => view.id)).toEqual([
      'microphone',
      'callAudio',
      'signing',
      'server',
      'speechToText',
    ]);
  });

  it('puts every failing check in the default view, in the order a person fixes them', () => {
    const { open, passing } = splitRows(setupRows(refusedMac()));
    expect(open.map((view) => view.id)).toEqual([
      'microphone',
      'callAudio',
      'notifications',
      'signing',
      'server',
      'speechToText',
    ]);
    expect(passing).toEqual([]);
  });

  it('never folds a row that says it cannot record into the passing ones', () => {
    // A grey row with a message is tone attention (fromCheck): hiding it under "5 checks pass"
    // would say Roger can record call audio while main says it cannot.
    expect(splitRows(setupRows(helperMissing)).open.map((view) => view.id)).toContain('callAudio');
  });
});

describe('passingLine', () => {
  it('counts the checks that pass', () => {
    expect(passingLine(1)).toBe('1 check passes');
    expect(passingLine(4)).toBe('4 checks pass');
  });
});

describe('leadingFix', () => {
  it('is the first failing check that has a fix, so a screen has one main button', () => {
    expect(leadingFix(setupRows(refusedMac()))).toBe('microphone');
    expect(leadingFix(setupRows(firstRunMac()))).toBe('microphone');
  });

  it('skips a failing check with nothing to press', () => {
    // An ad hoc signature has no button (only its message); the server's Check again leads.
    const status: SetupStatus = {
      ...readyMac(),
      signing: refusedMac().signing,
      api: refusedMac().api,
    };
    expect(leadingFix(setupRows(status))).toBe('server');
  });

  it('is none when every check passes or is only untested', () => {
    expect(leadingFix(setupRows(readyMac()))).toBeNull();
  });
});

describe('needsYou', () => {
  it('is true while any check fails or says it needs a look, false once only tests are left', () => {
    expect(needsYou(setupRows(readyMac()))).toBe(false);
    expect(needsYou(setupRows(firstRunMac()))).toBe(true);
    expect(needsYou(setupRows(refusedMac()))).toBe(true);
    expect(needsYou(setupRows(helperMissing))).toBe(true);
  });
});
