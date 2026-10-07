import { describe, expect, it } from 'vitest';
import type { OpenAtLogin } from '../../shared/calendarPrefs';
import type { LoginItemState } from '../../shared/ipc/loginItem';
import { createLogger } from '../logger';
import { LoginItemController } from './loginItem';
import type { MacLoginStatus } from './loginItemPolicy';

/** Electron's `app`, as far as the login item uses it: macOS's answer follows what was set. */
function fakeApp(initial: MacLoginStatus = 'not-registered') {
  const app = {
    status: initial,
    /** What macOS answers after a registration: `enabled`, or `requires-approval` when asked to. */
    answerToRegister: 'enabled' as MacLoginStatus,
    sets: [] as boolean[],
    reads: 0,
    failSet: null as Error | null,
    getLoginItemSettings: () => {
      app.reads += 1;
      return { status: app.status, wasOpenedAtLogin: false };
    },
    setLoginItemSettings: (settings: { openAtLogin: boolean }) => {
      if (app.failSet !== null) throw app.failSet;
      app.sets.push(settings.openAtLogin);
      app.status = settings.openAtLogin ? app.answerToRegister : 'not-registered';
    },
  };
  return app;
}

function harness(
  options: {
    isPackaged?: boolean;
    e2eOn?: boolean;
    preference?: OpenAtLogin;
    status?: MacLoginStatus;
  } = {},
) {
  const app = fakeApp(options.status);
  const lines: string[] = [];
  const choice = { value: options.preference ?? 'off' };
  const controller = new LoginItemController({
    app,
    build: { isPackaged: options.isPackaged ?? true, e2eOn: options.e2eOn ?? false },
    preference: () => choice.value,
    logger: createLogger({ level: 'info', format: 'json', sink: (line) => lines.push(line) }),
  });
  const heard: LoginItemState[] = [];
  controller.onChange((state) => heard.push(state));
  return { app, controller, choice, heard, lines };
}

describe('LoginItemController', () => {
  it('never asks macOS about, or changes, the login item of a build that is not packaged', () => {
    const h = harness({ isPackaged: false, preference: 'on' });
    h.controller.start({ openedAtLogin: false });
    h.controller.setCalendarConnected(true);
    expect(h.controller.getState()).toEqual({ status: 'unavailable' });
    expect(h.app.sets).toEqual([]);
    expect(h.app.reads).toBe(0);
  });

  it('does the same in the e2e run', () => {
    const h = harness({ e2eOn: true, preference: 'on' });
    h.controller.start({ openedAtLogin: false });
    expect(h.controller.getState()).toEqual({ status: 'unavailable' });
    expect(h.app.sets).toEqual([]);
  });

  it('registers at launch when the user chose on, and tells the page', () => {
    const h = harness({ preference: 'on' });
    h.controller.start({ openedAtLogin: false });
    expect(h.app.sets).toEqual([true]);
    expect(h.controller.getState()).toEqual({ status: 'enabled' });
    expect(h.heard).toEqual([{ status: 'enabled' }]);
  });

  it('does nothing at launch while the preference is off (the default until real-Mac check 1)', () => {
    const h = harness({ preference: 'off' });
    h.controller.start({ openedAtLogin: false });
    expect(h.app.sets).toEqual([]);
    expect(h.heard).toEqual([]);
    expect(h.controller.getState()).toEqual({ status: 'disabled' });
  });

  it('follows a change of the preference: on registers, off removes', () => {
    const h = harness({ preference: 'off' });
    h.controller.start({ openedAtLogin: false });
    h.choice.value = 'on';
    h.controller.preferenceChanged();
    h.choice.value = 'off';
    h.controller.preferenceChanged();
    expect(h.app.sets).toEqual([true, false]);
    expect(h.heard.map((state) => state.status)).toEqual(['enabled', 'disabled']);
  });

  it('logs at startup what macOS says and whether this launch was a login launch', () => {
    // Real-Mac check 1 (docs/plans/M5-calendar.md) reads this line after a reboot: it is the only
    // place `status: enabled` and `wasOpenedAtLogin: true` show up.
    const h = harness({ status: 'enabled' });
    h.controller.start({ openedAtLogin: true });
    const entries = h.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry.message === 'login item at startup')).toMatchObject({
      status: 'enabled',
      wasOpenedAtLogin: true,
    });
  });

  it('logs the startup line before it changes anything, so it shows what the reboot left', () => {
    const h = harness({ preference: 'on', status: 'not-registered' });
    h.controller.start({ openedAtLogin: false });
    const messages = h.lines.map((line) => (JSON.parse(line) as { message: string }).message);
    expect(messages).toEqual(['login item at startup', 'login item changed']);
    expect(h.lines[0]).toContain('"status":"not-registered"');
  });

  it('logs no startup line for a build that is not packaged', () => {
    const h = harness({ isPackaged: false });
    h.controller.start({ openedAtLogin: false });
    expect(h.lines).toEqual([]);
  });

  it('turns on at the first connect when the preference is auto, and not when it is off', () => {
    const auto = harness({ preference: 'auto' });
    auto.controller.start({ openedAtLogin: false });
    expect(auto.app.sets).toEqual([]);
    auto.controller.setCalendarConnected(true);
    expect(auto.app.sets).toEqual([true]);

    const off = harness({ preference: 'off' });
    off.controller.start({ openedAtLogin: false });
    off.controller.setCalendarConnected(true);
    expect(off.app.sets).toEqual([]);
  });

  it('reports requires-approval, which is registered but not yet allowed', () => {
    const h = harness({ preference: 'on' });
    h.app.answerToRegister = 'requires-approval';
    h.controller.start({ openedAtLogin: false });
    expect(h.controller.getState()).toEqual({ status: 'requires-approval' });
    // Not asked again at the next change: the registration is made.
    h.controller.preferenceChanged();
    expect(h.app.sets).toEqual([true]);
  });

  it('says nothing when a check finds the same state', () => {
    const h = harness({ preference: 'on', status: 'enabled' });
    h.controller.start({ openedAtLogin: false });
    h.controller.preferenceChanged();
    expect(h.heard).toEqual([]);
    expect(h.app.sets).toEqual([]);
  });

  it('logs a registration macOS refuses, with what was asked, and keeps running', () => {
    const h = harness({ preference: 'on' });
    h.app.failSet = new Error('SMAppService refused');
    h.controller.start({ openedAtLogin: false });
    expect(
      h.lines.some((line) => line.includes('SMAppService refused') && line.includes('register')),
    ).toBe(true);
    expect(h.controller.getState()).toEqual({ status: 'disabled' });
  });

  it('stops telling a listener that unsubscribed', () => {
    const h = harness({ preference: 'off' });
    const late: string[] = [];
    const stop = h.controller.onChange((state) => late.push(state.status));
    stop();
    h.choice.value = 'on';
    h.controller.preferenceChanged();
    expect(late).toEqual([]);
  });
});
