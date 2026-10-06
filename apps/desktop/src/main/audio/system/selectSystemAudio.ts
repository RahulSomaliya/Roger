import type { SystemAudioCaptureSetting } from '../../config';
import { errorMessage } from '../../logger';
import {
  findHelper,
  type HelperLocation,
  type HelperLookup,
  type HelperPathContext,
} from '../../native/helperPath';

/**
 * How call audio is captured for as long as Roger runs (M2 D1), chosen once at startup:
 * - tap: the `roger-audio` helper's Core Audio tap. It needs only System Audio Recording.
 * - electron: Electron's `desktopCapturer` in the renderer, the fallback. It needs Screen
 *   Recording, the permission the helper removes.
 */
export type SystemAudioSelection =
  | { mode: 'tap'; helper: HelperLocation }
  /**
   * config.json forces the tap and the helper is not there: every Start reports call audio failed,
   * with `missing`, rather than turning to Screen Recording against the person's setting.
   */
  | { mode: 'tap'; helper: null; missing: string }
  /** `reason` is for the log: why not the tap. */
  | { mode: 'electron'; reason: string };

/**
 * `systemAudioCapture` from config.json, and where the helper is: `auto` takes the tap when the
 * helper is there, `tap` and `electron` force one. The helper's place comes only from the build
 * (helperPath.ts), never from config.json or the environment: a setting that picked the binary
 * would choose the program that hears every call.
 */
export function selectSystemAudio(
  setting: SystemAudioCaptureSetting,
  context: HelperPathContext,
  find: (context: HelperPathContext) => HelperLookup = findHelper,
): SystemAudioSelection {
  if (setting === 'electron') {
    return { mode: 'electron', reason: 'config.json "systemAudioCapture" is "electron"' };
  }
  let missing: string;
  try {
    const lookup = find(context);
    if (lookup.found) return { mode: 'tap', helper: lookup.location };
    missing = lookup.reason;
  } catch (error) {
    // A relative app path or a failed access check: no helper to run, so the same as a missing one.
    missing = errorMessage(error);
  }
  return setting === 'tap'
    ? { mode: 'tap', helper: null, missing }
    : { mode: 'electron', reason: missing };
}
