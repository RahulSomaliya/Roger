import type {
  ConnectionSetupState,
  MediaAccessState,
  NotificationSetupState,
  SettingsPaneId,
  SetupCheck,
  SetupStatus,
  SigningSetupState,
  SystemAudioSetupState,
} from '../../../../shared/ipc/setup';

/** The setup screen's rows, in the order a person fixes them: capture first, then the rest. */
export type SetupRowId =
  'microphone' | 'callAudio' | 'notifications' | 'signing' | 'server' | 'speechToText';

/** How a row reads at a glance: fine, needs the person, broken, or not known yet. */
export type SetupTone = 'ok' | 'attention' | 'problem' | 'neutral';

/** A button on a row; each calls one `SetupApi` method (setupModel.ts). */
export type SetupAction =
  | { kind: 'request-microphone'; label: string }
  | { kind: 'test-system-audio'; label: string }
  | { kind: 'confirm-system-audio'; label: string }
  | { kind: 'test-notification'; label: string }
  | { kind: 'open-pane'; pane: SettingsPaneId; label: string }
  | { kind: 'relaunch'; label: string }
  | { kind: 'recheck'; label: string };

export type SetupActionKind = SetupAction['kind'];

export interface SetupRowView {
  id: SetupRowId;
  title: string;
  stateLabel: string;
  tone: SetupTone;
  /** Main's words: what is wrong and how to fix it (shared/ipc/setup.ts), or null. */
  message: string | null;
  /** The buttons, the one most likely to fix it first. */
  actions: SetupAction[];
}

const RELAUNCH: SetupAction = { kind: 'relaunch', label: 'Relaunch Roger' };
const RECHECK: SetupAction = { kind: 'recheck', label: 'Check again' };

const PANE_LABEL: Record<SettingsPaneId, string> = {
  microphone: 'Open Microphone settings',
  systemAudio: 'Open System Audio settings',
  screenRecording: 'Open Screen Recording settings',
};

const openPane = (pane: SettingsPaneId): SetupAction => ({
  kind: 'open-pane',
  pane,
  label: PANE_LABEL[pane],
});

interface StateLook {
  label: string;
  tone: SetupTone;
}

const MEDIA_ACCESS: Record<MediaAccessState, StateLook> = {
  granted: { label: 'Allowed', tone: 'ok' },
  'not-determined': { label: 'Not asked yet', tone: 'attention' },
  denied: { label: 'Not allowed', tone: 'problem' },
  restricted: { label: 'Blocked', tone: 'problem' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const SYSTEM_AUDIO: Record<SystemAudioSetupState, StateLook> = {
  verified: { label: 'Heard', tone: 'ok' },
  unknown: { label: 'Not tested', tone: 'neutral' },
  pending: { label: 'Waiting for you', tone: 'attention' },
  'not-heard': { label: 'Not heard', tone: 'problem' },
};

const NOTIFICATIONS: Record<NotificationSetupState, StateLook> = {
  shown: { label: 'Shown', tone: 'ok' },
  unknown: { label: 'Not tested', tone: 'neutral' },
  failed: { label: 'Not shown', tone: 'problem' },
};

const SIGNING: Record<SigningSetupState, StateLook> = {
  'local-identity': { label: 'Signed on this Mac', tone: 'ok' },
  'developer-id': { label: 'Signed by a Developer ID', tone: 'ok' },
  adhoc: { label: 'Signed ad hoc', tone: 'problem' },
  unsigned: { label: 'Not signed', tone: 'problem' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

const SERVER: Record<ConnectionSetupState, StateLook> = {
  ok: { label: 'Reachable', tone: 'ok' },
  // Not "Not reachable": most failures are a server that answered (503 for its database, 401 for
  // the token, 404 when it is older), and main's message beside the label says which.
  failed: { label: 'Not working', tone: 'problem' },
  unknown: { label: 'Not checked', tone: 'neutral' },
};

const SPEECH_TO_TEXT: Record<ConnectionSetupState, StateLook> = {
  ok: { label: 'Ready', tone: 'ok' },
  failed: { label: 'Not ready', tone: 'problem' },
  unknown: { label: 'Not checked', tone: 'neutral' },
};

/** The parts every row reads the same way from its check. */
function fromCheck<State extends string>(
  check: SetupCheck<State>,
  looks: Record<State, StateLook>,
): Pick<SetupRowView, 'stateLabel' | 'tone' | 'message'> {
  const look = looks[check.state];
  // A good or not-yet-known state that still says something needs a look, not a pass or a grey
  // "not tested": a development build, a missing helper, codesign or macOS giving no answer.
  // splitRows and needsYou count only attention and problem rows as open, so a grey row with a
  // message would be folded under "5 checks pass" and let Done show while saying Roger cannot
  // record call audio.
  const quiet = look.tone === 'ok' || look.tone === 'neutral';
  const tone = quiet && check.message !== null ? 'attention' : look.tone;
  return { stateLabel: look.label, tone, message: check.message };
}

/** "Relaunch Roger" last, only where main says macOS applies the fix to a new process alone. */
function withRelaunch(check: SetupCheck<string>, actions: SetupAction[]): SetupAction[] {
  return check.relaunchNeeded ? [...actions, RELAUNCH] : actions;
}

function microphoneRow(check: SetupCheck<MediaAccessState>): SetupRowView {
  const actions: SetupAction[] =
    check.state === 'not-determined'
      ? [{ kind: 'request-microphone', label: 'Allow microphone' }]
      : check.state === 'denied' || check.state === 'unknown'
        ? [openPane('microphone')]
        : [];
  return {
    id: 'microphone',
    title: 'Microphone',
    ...fromCheck(check, MEDIA_ACCESS),
    actions: withRelaunch(check, actions),
  };
}

function callAudioRow(status: SetupStatus): SetupRowView {
  const screen = status.screenRecording;
  if (status.systemCapture === 'electron' && screen !== null) {
    return {
      id: 'callAudio',
      title: 'Call audio',
      ...fromCheck(screen, MEDIA_ACCESS),
      actions: withRelaunch(
        screen,
        screen.state === 'granted' ? [] : [openPane('screenRecording')],
      ),
    };
  }
  const check = status.systemAudio;
  const test: SetupAction = {
    kind: 'test-system-audio',
    label: check.state === 'unknown' ? 'Test call audio' : 'Test again',
  };
  const actions: SetupAction[] =
    check.state === 'pending'
      ? [{ kind: 'confirm-system-audio', label: 'I allowed it' }, openPane('systemAudio'), test]
      : check.state === 'not-heard'
        ? [openPane('systemAudio'), test]
        : [test];
  return {
    id: 'callAudio',
    title: 'Call audio',
    ...fromCheck(check, SYSTEM_AUDIO),
    actions: withRelaunch(check, actions),
  };
}

function notificationsRow(check: SetupCheck<NotificationSetupState>): SetupRowView {
  return {
    id: 'notifications',
    title: 'Notifications',
    ...fromCheck(check, NOTIFICATIONS),
    actions: withRelaunch(check, [
      { kind: 'test-notification', label: 'Send a test notification' },
    ]),
  };
}

function signingRow(check: SetupCheck<SigningSetupState>): SetupRowView {
  return {
    id: 'signing',
    title: 'This copy of Roger',
    ...fromCheck(check, SIGNING),
    actions: withRelaunch(check, []),
  };
}

/**
 * `serverFailed`: the server row is red. connectionChecks.ts then leaves speech-to-text unchecked
 * with a message ("Not checked: Roger can't reach its server"), which stays grey: one cause, one
 * flagged row, counted once by setupSummary.
 */
function connectionRow(
  id: 'server' | 'speechToText',
  check: SetupCheck<ConnectionSetupState>,
  serverFailed = false,
): SetupRowView {
  const text =
    id === 'server'
      ? {
          title: "Roger's server",
          looks: SERVER,
        }
      : {
          title: 'Speech-to-text',
          looks: SPEECH_TO_TEXT,
        };
  const read = fromCheck(check, text.looks);
  const waitsOnServer = serverFailed && check.state === 'unknown';
  return {
    id,
    title: text.title,
    ...read,
    tone: waitsOnServer ? 'neutral' : read.tone,
    actions: withRelaunch(check, check.state === 'ok' ? [] : [RECHECK]),
  };
}

/** The setup screen's rows for one status. */
export function setupRows(status: SetupStatus): SetupRowView[] {
  return [
    microphoneRow(status.microphone),
    callAudioRow(status),
    notificationsRow(status.notifications),
    signingRow(status.signing),
    connectionRow('server', status.api),
    connectionRow('speechToText', status.stt, status.api.state === 'failed'),
  ];
}

/** A row that is not a pass: broken, needs the person, or not known yet. */
const isOpen = (view: SetupRowView): boolean => view.tone !== 'ok';

/** A row that needs the person: the ones that count against Done and can lead with a fix. */
const failing = (view: SetupRowView): boolean =>
  view.tone === 'problem' || view.tone === 'attention';

/**
 * The rows for the default view and the ones folded under "N checks pass". A row not yet tested
 * stays in view (its test is the fix); only a confirmed pass is folded away.
 */
export function splitRows(rows: readonly SetupRowView[]): {
  open: SetupRowView[];
  passing: SetupRowView[];
} {
  return { open: rows.filter(isOpen), passing: rows.filter((view) => !isOpen(view)) };
}

/** The line that folds the passing rows away. */
export function passingLine(count: number): string {
  return count === 1 ? '1 check passes' : `${count} checks pass`;
}

/**
 * The one row whose first fix is the screen's primary button: the first failing check that has
 * a button (an ad hoc signature has none, only its message). Null when nothing fails; Done leads
 * then. Setup never has two primaries (docs/design.md, The one primary).
 */
export function leadingFix(rows: readonly SetupRowView[]): SetupRowId | null {
  return rows.find((view) => failing(view) && view.actions.length > 0)?.id ?? null;
}

/** True while any check fails or says it needs a look; Done shows once this is false. */
export function needsYou(rows: readonly SetupRowView[]): boolean {
  return rows.some(failing);
}
