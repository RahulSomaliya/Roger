import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAKE_HELPER_PATH,
  findHelper,
  HELPER_BUNDLE_PATH,
  HELPER_DEV_BUILD_PATH,
  HelperPathError,
  helperLocation,
  type HelperPathContext,
} from './helperPath';

const RESOURCES = '/Applications/Roger.app/Contents/Resources';
const APP = '/Users/someone/Roger/apps/desktop';

function context(overrides: Partial<HelperPathContext> = {}): HelperPathContext {
  return { isPackaged: false, resourcesPath: RESOURCES, appPath: APP, env: {}, ...overrides };
}

describe('helperLocation', () => {
  it('runs the helper inside the app bundle when packaged', () => {
    expect(helperLocation(context({ isPackaged: true }))).toEqual({
      origin: 'bundle',
      path: '/Applications/Roger.app/Contents/Resources/bin/roger-audio',
    });
  });

  it('ignores ROGER_E2E in a packaged build', () => {
    const location = helperLocation(context({ isPackaged: true, env: { ROGER_E2E: '1' } }));
    expect(location).toEqual({
      origin: 'bundle',
      path: '/Applications/Roger.app/Contents/Resources/bin/roger-audio',
    });
  });

  it('runs the dev build from native/bin when unpackaged', () => {
    expect(helperLocation(context())).toEqual({
      origin: 'dev-build',
      path: '/Users/someone/Roger/apps/desktop/native/bin/roger-audio',
    });
  });

  it('runs the fake helper only under ROGER_E2E=1 when unpackaged', () => {
    expect(helperLocation(context({ env: { ROGER_E2E: '1' } }))).toEqual({
      origin: 'e2e-fake',
      path: '/Users/someone/Roger/apps/desktop/test/fixtures/fake-roger-audio.mjs',
    });
  });

  it.each(['0', 'true', 'yes', '', ' 1'])('treats ROGER_E2E=%j as not set', (value) => {
    expect(helperLocation(context({ env: { ROGER_E2E: value } })).origin).toBe('dev-build');
  });

  // The helper records call audio: no setting, variable or file may point Roger at another binary.
  it('takes no path from the environment', () => {
    const env = {
      ROGER_AUDIO_HELPER: '/tmp/evil',
      ROGER_HELPER_PATH: '/tmp/evil',
      ROGER_AUDIO_PATH: '/tmp/evil',
      RESOURCES_PATH: '/tmp/evil',
    };
    expect(helperLocation(context({ env })).path).toBe(join(APP, HELPER_DEV_BUILD_PATH));
    expect(helperLocation(context({ isPackaged: true, env })).path).toBe(
      join(RESOURCES, HELPER_BUNDLE_PATH),
    );
  });

  // A relative path would be resolved against whatever folder Roger was started from.
  it('refuses a relative resources or app path', () => {
    expect(() => helperLocation(context({ isPackaged: true, resourcesPath: 'Resources' }))).toThrow(
      new HelperPathError(
        'the resources path must be absolute to find the audio helper (got "Resources")',
      ),
    );
    expect(() => helperLocation(context({ appPath: './apps/desktop' }))).toThrow(
      new HelperPathError(
        'the app path must be absolute to find the audio helper (got "./apps/desktop")',
      ),
    );
  });

  it('checks only the path it uses: an empty app path is fine in a packaged build', () => {
    expect(helperLocation(context({ isPackaged: true, appPath: '' })).origin).toBe('bundle');
  });
});

describe('findHelper', () => {
  function bundleWith(file: { mode: number } | 'dir' | null): HelperPathContext {
    const resources = mkdtempSync(join(tmpdir(), 'roger-helper-'));
    const path = join(resources, HELPER_BUNDLE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    if (file === 'dir') mkdirSync(path);
    else if (file !== null) {
      writeFileSync(path, '#!/bin/sh\n');
      chmodSync(path, file.mode);
    }
    return context({ isPackaged: true, resourcesPath: resources });
  }

  it('finds an executable helper', () => {
    const found = bundleWith({ mode: 0o755 });
    expect(findHelper(found)).toEqual({ found: true, location: helperLocation(found) });
  });

  it('reports a missing helper, so call audio falls back to Electron', () => {
    const missing = bundleWith(null);
    const { path } = helperLocation(missing);
    expect(findHelper(missing)).toEqual({
      found: false,
      location: helperLocation(missing),
      reason: `no audio helper at ${path}`,
    });
  });

  it('reports a helper that is not executable', () => {
    const notExecutable = bundleWith({ mode: 0o644 });
    const { path } = helperLocation(notExecutable);
    expect(findHelper(notExecutable)).toEqual({
      found: false,
      location: helperLocation(notExecutable),
      reason: `the audio helper at ${path} is not executable`,
    });
  });

  it('reports a folder where the helper should be', () => {
    const folder = bundleWith('dir');
    const { path } = helperLocation(folder);
    expect(findHelper(folder)).toEqual({
      found: false,
      location: helperLocation(folder),
      reason: `the audio helper at ${path} is not a file`,
    });
  });

  function fakeHelperWithMode(mode: number): { e2e: HelperPathContext; path: string } {
    const app = mkdtempSync(join(tmpdir(), 'roger-app-'));
    const path = join(app, FAKE_HELPER_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'process.exit(0);\n');
    chmodSync(path, mode);
    return { e2e: context({ appPath: app, env: { ROGER_E2E: '1' } }), path };
  }

  // The fake helper is a Node script that Node runs, so it needs no execute bit.
  it('finds a readable fake helper under ROGER_E2E=1', () => {
    const { e2e, path } = fakeHelperWithMode(0o644);
    expect(findHelper(e2e)).toEqual({ found: true, location: { origin: 'e2e-fake', path } });
  });

  it('reports a fake helper Node cannot read', () => {
    const { e2e, path } = fakeHelperWithMode(0o200);
    expect(findHelper(e2e)).toEqual({
      found: false,
      location: { origin: 'e2e-fake', path },
      reason: `the audio helper at ${path} is not readable`,
    });
  });
});

// The same two paths are written in three more files. A rename in one alone would ship an app
// whose helper is missing (electron-builder only warns when an extraResources source is absent)
// or an install that checks the wrong place.
describe('the helper paths other files use', () => {
  const read = (relative: string): string =>
    readFileSync(new URL(relative, import.meta.url), 'utf8');

  it('match what electron-builder.yml bundles', () => {
    const builder = read('../../../electron-builder.yml');
    expect(builder).toMatch(
      new RegExp(`- from: ${HELPER_DEV_BUILD_PATH}\\n\\s+to: ${HELPER_BUNDLE_PATH}\\n`),
    );
  });

  it('match the bundle path install-mac.sh signs and checks', () => {
    expect(read('../../../scripts/install-mac.sh')).toContain(
      `readonly helper="$built/Contents/Resources/${HELPER_BUNDLE_PATH}"`,
    );
  });

  it('match where build-native.sh writes the dev build', () => {
    expect(read('../../../scripts/build-native.sh')).toContain(
      `readonly out="${HELPER_DEV_BUILD_PATH}"`,
    );
  });
});
