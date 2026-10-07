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
  /** What the row checks, for someone who has never heard of it. */
  description: string;
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
  failed: { label: 'Not reachable', tone: 'problem' },
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
  // A good state that still says something (a development build) needs a look, not a green dot.
  const tone = look.tone === 'ok' && check.message !== null ? 'attention' : look.tone;
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
    description: 'Your side of the call, from the microphone Roger records.',
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
      description:
        'The other side of the call. On this Mac Roger records it through Screen Recording.',
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
    description:
      'The other side of the call: what your Mac plays. The test plays a short sound and listens for it.',
    ...fromCheck(check, SYSTEM_AUDIO),
    actions: withRelaunch(check, actions),
  };
}

function notificationsRow(check: SetupCheck<NotificationSetupState>): SetupRowView {
  return {
    id: 'notifications',
    title: 'Notifications',
    description:
      'How Roger warns you, while its window is in the background, that a recording stopped hearing you.',
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
    description: 'macOS ties every permission to how Roger is signed.',
    ...fromCheck(check, SIGNING),
    actions: withRelaunch(check, []),
  };
}

function connectionRow(
  id: 'server' | 'speechToText',
  check: SetupCheck<ConnectionSetupState>,
): SetupRowView {
  const text =
    id === 'server'
      ? {
          title: "Roger's server",
          description: 'Where your transcripts are kept, and what lets Roger use speech-to-text.',
          looks: SERVER,
        }
      : {
          title: 'Speech-to-text',
          description:
            'Turns the call into text as it happens. The check opens no session: sessions are billed.',
          looks: SPEECH_TO_TEXT,
        };
  return {
    id,
    title: text.title,
    description: text.description,
    ...fromCheck(check, text.looks),
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
    connectionRow('speechToText', status.stt),
  ];
}

/** One line above the rows: all ready, or how many need the person. */
export function setupSummary(rows: readonly SetupRowView[]): string {
  const open = rows.filter((view) => view.tone === 'problem' || view.tone === 'attention').length;
  if (open === 0) return 'Roger has what it needs on this Mac.';
  return open === 1 ? '1 check needs you.' : `${open} checks need you.`;
}
