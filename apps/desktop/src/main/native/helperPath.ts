import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Where Roger finds `roger-audio`, its Swift audio helper (call audio, the mic monitor, the probe).
 *
 * The helper records call audio, so only the app itself names it: the bundle when packaged, the dev
 * build when not. Never config.json, an environment variable or the renderer (M2 design row
 * "Delete-audio and helper path safety"): a setting that picked the binary would let any file Roger
 * reads choose the program that hears every call. `config.test.ts` checks config.json has no such
 * key; the tests here check the environment cannot name one either.
 *
 * - `bundle`: `Roger.app/Contents/Resources/bin/roger-audio`, signed by install-mac.sh with the
 *   identifier `ai.linkt.roger.audio` and the app's own identity.
 * - `dev-build`: `apps/desktop/native/bin/roger-audio`, from `make native` (`make dev-desktop`).
 * - `e2e-fake`: M2-T10's fake helper for the Electron smoke test (M2-T13). A Node script: run it
 *   with Node (Electron's own binary under `ELECTRON_RUN_AS_NODE=1`), never exec it directly.
 */
export type HelperOrigin = 'bundle' | 'dev-build' | 'e2e-fake';

export interface HelperLocation {
  origin: HelperOrigin;
  /** Absolute. */
  path: string;
}

export interface HelperPathContext {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.resourcesPath`: `Roger.app/Contents/Resources` in a packaged build. */
  resourcesPath: string;
  /**
   * `app.getAppPath()`: `apps/desktop` when unpackaged, because `make dev-desktop` runs Electron on
   * that folder (`loadDevEnv` in index.ts relies on the same). The smoke test (M2-T13) must launch
   * it on the same folder: with any other app path, neither the dev build nor the fake helper is
   * found.
   */
  appPath: string;
  /** `process.env`. Only `ROGER_E2E` is read, and only when unpackaged. */
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Under `process.resourcesPath`. electron-builder.yml's `extraResources` copies the dev build here,
 * and install-mac.sh signs and checks it here; `helperPath.test.ts` fails if either file disagrees.
 */
export const HELPER_BUNDLE_PATH = 'bin/roger-audio';
/** Under `apps/desktop`: where scripts/build-native.sh writes the helper (`out` there). */
export const HELPER_DEV_BUILD_PATH = 'native/bin/roger-audio';
/** Under `apps/desktop`: M2-T10's fake helper (`test/fixtures/fake-roger-audio.mjs`). */
export const FAKE_HELPER_PATH = 'test/fixtures/fake-roger-audio.mjs';

export class HelperPathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HelperPathError';
  }
}

/**
 * Where the helper must be for this build. Pure: it does not look at the disk (`findHelper` does).
 *
 * `ROGER_E2E=1` (exactly "1") is honoured only when unpackaged: an installed Roger.app always runs
 * the helper it was signed with, whatever its environment says. M2-T13's `e2eMode.ts` keeps the
 * same rule for the rest of the smoke-test switches; keep the two in step.
 */
export function helperLocation(context: HelperPathContext): HelperLocation {
  if (context.isPackaged) {
    return {
      origin: 'bundle',
      path: join(absolute(context.resourcesPath, 'resources path'), HELPER_BUNDLE_PATH),
    };
  }
  const appPath = absolute(context.appPath, 'app path');
  if (context.env.ROGER_E2E === '1') {
    return { origin: 'e2e-fake', path: join(appPath, FAKE_HELPER_PATH) };
  }
  return { origin: 'dev-build', path: join(appPath, HELPER_DEV_BUILD_PATH) };
}

export type HelperLookup =
  | { found: true; location: HelperLocation }
  /** `reason` is for the log: call audio then goes through Electron's path (M2 D1). */
  | { found: false; location: HelperLocation; reason: string };

/** Whether the helper for this build is on disk and can be run. */
export function findHelper(context: HelperPathContext): HelperLookup {
  const location = helperLocation(context);
  const { path } = location;
  // Undefined for a missing file or a missing folder on the way (ENOENT, ENOTDIR).
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return { found: false, location, reason: `no audio helper at ${path}` };
  if (!stats.isFile()) {
    return { found: false, location, reason: `the audio helper at ${path} is not a file` };
  }
  // Node runs the fake helper, so it only has to be readable.
  if (!canAccess(path, location.origin === 'e2e-fake' ? constants.R_OK : constants.X_OK)) {
    const not = location.origin === 'e2e-fake' ? 'readable' : 'executable';
    return { found: false, location, reason: `the audio helper at ${path} is not ${not}` };
  }
  return { found: true, location };
}

/** A relative path would be resolved against whatever folder Roger was started from. */
function absolute(path: string, name: string): string {
  if (!isAbsolute(path)) {
    throw new HelperPathError(
      `the ${name} must be absolute to find the audio helper (got ${JSON.stringify(path)})`,
    );
  }
  return path;
}

/** False only for a permission refusal; any other failure is not an answer, so it is thrown. */
function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EACCES') return false;
    throw new HelperPathError(`could not check the audio helper at ${path}`, { cause: error });
  }
}
