// Stub from M4-S1; owned by M2-T19.
import { createElement, useEffect, useState } from 'react';
import { Icon } from '../../components/ui/icons';
import { SetupScreen } from '../../components/setup/SetupScreen';
import { SetupRedirect } from '../../components/setup/setupRedirect';
import { describeError } from '../describeError';
import { HOME, type Route } from '../router';
import { useShell } from '../ShellContext';
import type { SlotContributions } from '../slotRegistry';

const SETUP: Route = { name: 'setup' };

let redirect: SetupRedirect | null = null;

/**
 * The setup slot's mount: the screen with Done going Home. The header's Home leaves at any time
 * (D6); Done is the screen's own and shows only once nothing fails (SetupScreen.tsx).
 */
function SetupSlot() {
  const { navigate } = useShell();
  return createElement(SetupScreen, {
    onDone: () => {
      navigate(HOME);
    },
  });
}

/** The page's one redirect: made at first use, so "once per page load" holds across routes. */
function pageSetupRedirect(): SetupRedirect {
  redirect ??= new SetupRedirect(() => window.roger.getSetupStatus());
  return redirect;
}

/**
 * Sends the person to the setup screen on a first run and when a Start is refused for the
 * microphone (components/setup/setupRedirect.ts says when). Mounted in the banner, which every
 * page shows and keeps across routes, and draws nothing unless main could not say: then the
 * banner shows why, rather than the redirect failing unseen.
 *
 * Trap: the watch reads `busy` too, not the error alone. A second Start refused in the same words
 * leaves the error string unchanged across renders (setupRedirect.ts, captureChanged), so an
 * effect keyed on the error never runs again and the person stays Home.
 */
function OpenSetupWhenNeeded() {
  const { capture, navigate } = useShell();
  const error = capture.status?.error ?? null;
  const phase = capture.status?.phase ?? null;
  const { busy } = capture;
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    pageSetupRedirect()
      .firstRun(() => {
        navigate(SETUP);
      })
      .catch((reason: unknown) => {
        setFailure(
          `Roger could not check whether it may use the microphone: ${describeError(reason)}`,
        );
      });
  }, [navigate]);
  useEffect(() => {
    pageSetupRedirect()
      .captureChanged({ error, busy, phase }, () => {
        navigate(SETUP);
      })
      .catch((reason: unknown) => {
        setFailure(`Roger could not check why recording failed: ${describeError(reason)}`);
      });
  }, [error, busy, phase, navigate]);
  return failure === null
    ? null
    : createElement(
        'div',
        { role: 'alert', className: 'problem' },
        createElement(Icon, { name: 'circle-alert' }),
        createElement('span', { className: 'problem-text' }, failure),
      );
}

/**
 * What M2-T19 mounts: the permission setup screen (setup), and in the banner the watch that opens
 * it. Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  setup: [{ id: 'm2-setup', order: 0, component: SetupSlot }],
  banner: [{ id: 'm2-open-setup', order: 0, component: OpenSetupWhenNeeded }],
};
