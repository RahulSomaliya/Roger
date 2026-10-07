import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FAKE_HELPER_PATH,
  HELPER_BUNDLE_PATH,
  HELPER_DEV_BUILD_PATH,
  type HelperLookup,
  type HelperPathContext,
} from '../../native/helperPath';
import { selectSystemAudio } from './selectSystemAudio';

/** An app folder and a resources folder; `helpers` are the helper files that exist in them. */
function machine(
  helpers: ('bundle' | 'dev-build' | 'e2e-fake')[],
  overrides: Partial<HelperPathContext> = {},
): HelperPathContext {
  const root = mkdtempSync(join(tmpdir(), 'roger-select-'));
  const appPath = join(root, 'apps/desktop');
  const resourcesPath = join(root, 'Roger.app/Contents/Resources');
  const files = {
    bundle: join(resourcesPath, HELPER_BUNDLE_PATH),
    'dev-build': join(appPath, HELPER_DEV_BUILD_PATH),
    'e2e-fake': join(appPath, FAKE_HELPER_PATH),
  };
  for (const helper of helpers) {
    mkdirSync(dirname(files[helper]), { recursive: true });
    writeFileSync(files[helper], '#!/bin/sh\n');
    chmodSync(files[helper], 0o755);
  }
  return { isPackaged: false, resourcesPath, appPath, env: {}, ...overrides };
}

describe('selectSystemAudio', () => {
  it('takes the helper tap when its binary is there', () => {
    const context = machine(['dev-build']);
    expect(selectSystemAudio('auto', context)).toEqual({
      mode: 'tap',
      helper: { origin: 'dev-build', path: join(context.appPath, HELPER_DEV_BUILD_PATH) },
    });
  });

  // M2 D1: Electron's desktopCapturer stays as the fallback.
  it('falls back to Electron when the helper is missing, saying why', () => {
    const context = machine([]);
    expect(selectSystemAudio('auto', context)).toEqual({
      mode: 'electron',
      reason: `no audio helper at ${join(context.appPath, HELPER_DEV_BUILD_PATH)}`,
    });
  });

  it('takes Electron when config.json says so, without looking for the helper', () => {
    const find = vi.fn<(context: HelperPathContext) => HelperLookup>();
    expect(selectSystemAudio('electron', machine(['dev-build']), find)).toEqual({
      mode: 'electron',
      reason: 'config.json "systemAudioCapture" is "electron"',
    });
    expect(find).not.toHaveBeenCalled();
  });

  it('keeps the tap that config.json forces even when the helper is missing', () => {
    const context = machine([]);
    expect(selectSystemAudio('tap', context)).toEqual({
      mode: 'tap',
      helper: null,
      missing: `no audio helper at ${join(context.appPath, HELPER_DEV_BUILD_PATH)}`,
    });
    const found = machine(['dev-build']);
    expect(selectSystemAudio('tap', found)).toEqual({
      mode: 'tap',
      helper: { origin: 'dev-build', path: join(found.appPath, HELPER_DEV_BUILD_PATH) },
    });
  });

  it('falls back to Electron when the helper cannot be looked for', () => {
    const context = machine([], { appPath: 'apps/desktop' });
    expect(selectSystemAudio('auto', context)).toEqual({
      mode: 'electron',
      reason: 'the app path must be absolute to find the audio helper (got "apps/desktop")',
    });
    expect(selectSystemAudio('tap', context)).toEqual({
      mode: 'tap',
      helper: null,
      missing: 'the app path must be absolute to find the audio helper (got "apps/desktop")',
    });
  });

  it('runs the fake helper only for an unpackaged smoke test', () => {
    const e2e = machine(['e2e-fake', 'dev-build'], { env: { ROGER_E2E: '1' } });
    expect(selectSystemAudio('auto', e2e)).toEqual({
      mode: 'tap',
      helper: { origin: 'e2e-fake', path: join(e2e.appPath, FAKE_HELPER_PATH) },
    });
  });

  // An installed Roger.app always records with the helper it was signed with.
  it('ignores ROGER_E2E in a packaged build', () => {
    const packaged = machine(['bundle', 'e2e-fake'], { isPackaged: true, env: { ROGER_E2E: '1' } });
    expect(selectSystemAudio('auto', packaged)).toEqual({
      mode: 'tap',
      helper: { origin: 'bundle', path: join(packaged.resourcesPath, HELPER_BUNDLE_PATH) },
    });
  });
});
