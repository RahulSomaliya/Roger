import { describe, expect, it } from 'vitest';
import type { OpenAtLogin } from '../../shared/calendarPrefs';
import { decideLoginItem, loginItemStatusFor, type LoginItemWorld } from './loginItemPolicy';

const packaged: LoginItemWorld = {
  isPackaged: true,
  e2eOn: false,
  preference: 'on',
  calendarConnected: false,
  macStatus: 'not-registered',
};

describe('decideLoginItem', () => {
  it('never registers when the build is not packaged: a dev run would list Electron.app at login', () => {
    for (const preference of ['auto', 'on', 'off'] as const) {
      for (const calendarConnected of [true, false]) {
        const world = { ...packaged, isPackaged: false, preference, calendarConnected };
        expect(decideLoginItem(world)).toBe('leave');
      }
    }
  });

  it('never touches the login item in the e2e run, even to remove it (macOS posts a notice)', () => {
    expect(decideLoginItem({ ...packaged, e2eOn: true, preference: 'on' })).toBe('leave');
    expect(
      decideLoginItem({ ...packaged, e2eOn: true, macStatus: 'enabled', preference: 'off' }),
    ).toBe('leave');
  });

  it('registers when the user chose on', () => {
    expect(decideLoginItem({ ...packaged, preference: 'on' })).toBe('register');
  });

  it('turns on at the first connect unless the user turned it off', () => {
    const auto = { ...packaged, preference: 'auto' as const };
    expect(decideLoginItem({ ...auto, calendarConnected: true })).toBe('register');
    expect(decideLoginItem({ ...auto, calendarConnected: false })).toBe('leave');
    expect(decideLoginItem({ ...auto, calendarConnected: true, preference: 'off' })).toBe('leave');
  });

  it('removes a login item the user turned off', () => {
    expect(decideLoginItem({ ...packaged, preference: 'off', macStatus: 'enabled' })).toBe(
      'unregister',
    );
    expect(
      decideLoginItem({ ...packaged, preference: 'off', macStatus: 'requires-approval' }),
    ).toBe('unregister');
  });

  it('removes the one a disconnected calendar no longer needs, when the user never chose it', () => {
    const world = { ...packaged, preference: 'auto' as const, macStatus: 'enabled' as const };
    expect(decideLoginItem({ ...world, calendarConnected: false })).toBe('unregister');
    expect(decideLoginItem({ ...world, calendarConnected: true })).toBe('leave');
  });

  it('leaves a login item that is already as wanted: no repeated registration', () => {
    for (const macStatus of ['enabled', 'requires-approval'] as const) {
      expect(decideLoginItem({ ...packaged, preference: 'on', macStatus })).toBe('leave');
    }
    expect(decideLoginItem({ ...packaged, preference: 'off', macStatus: 'not-registered' })).toBe(
      'leave',
    );
  });

  it('tries again when macOS cannot find the app, which is what a moved app reads as', () => {
    expect(decideLoginItem({ ...packaged, preference: 'on', macStatus: 'not-found' })).toBe(
      'register',
    );
  });

  it('covers every preference', () => {
    const choices: OpenAtLogin[] = ['auto', 'on', 'off'];
    for (const preference of choices) {
      expect(['register', 'unregister', 'leave']).toContain(
        decideLoginItem({ ...packaged, preference }),
      );
    }
  });
});

describe('loginItemStatusFor', () => {
  it('reports unavailable for a build that never registers one', () => {
    expect(loginItemStatusFor({ isPackaged: false, e2eOn: false }, 'enabled')).toBe('unavailable');
    expect(loginItemStatusFor({ isPackaged: true, e2eOn: true }, 'enabled')).toBe('unavailable');
  });

  it('reports what macOS says, and requires-approval as its own state', () => {
    const real = { isPackaged: true, e2eOn: false };
    expect(loginItemStatusFor(real, 'enabled')).toBe('enabled');
    expect(loginItemStatusFor(real, 'not-registered')).toBe('disabled');
    expect(loginItemStatusFor(real, 'requires-approval')).toBe('requires-approval');
    expect(loginItemStatusFor(real, 'not-found')).toBe('unavailable');
  });
});
