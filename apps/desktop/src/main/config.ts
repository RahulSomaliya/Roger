import { readFileSync } from 'node:fs';
import { BACKUP_KEEP_FOR_RERUN_MAX_DAYS, type SystemCaptureMode } from '../shared/capture';
import { COST_GUARD_SETTINGS, type CostGuards, loadCostGuards } from './costGuards';
import { isLogLevel, type LogLevel } from './logger';

/**
 * Desktop configuration. Environment variables win over the JSON file in the user data dir.
 * The desktop only ever holds the Roger API token: vendor keys live on the API (house rule 3).
 */
export interface DesktopConfig {
  apiUrl: string;
  apiToken: string | null;
  /** Force an STT adapter regardless of what the API hands out. Development only. */
  sttProviderOverride: string | null;
  logLevel: LogLevel;
  /** Bounds on billed speech-to-text time (costGuards.ts). */
  costGuards: CostGuards;
  /** M2's capture settings (config.json only). */
  capture: CaptureSettings;
  /** Settings that were refused. Start stays blocked until they are fixed. */
  errors: string[];
}

/** How call audio is captured. `auto`: the helper's tap when its binary exists, else Electron's. */
export type SystemAudioCaptureSetting = 'auto' | SystemCaptureMode;

const SYSTEM_AUDIO_CAPTURE_SETTINGS: readonly SystemAudioCaptureSetting[] = [
  'auto',
  'tap',
  'electron',
];

/**
 * M2's capture settings, read from config.json like the cost guards: a refused value keeps its
 * default and blocks Start. No setting names the helper binary, here or anywhere in config.json: a
 * config file must never pick the program that records call audio (src/main/native/helperPath.ts,
 * M2-T9, reads only the app bundle or the dev build).
 */
export interface CaptureSettings {
  systemAudioCapture: SystemAudioCaptureSetting;
  /** Keep each call's audio on this Mac (never uploaded, M2 D5). False when retention is 0 days. */
  audioBackup: boolean;
  /** Days a call's audio is kept; 0 turns the backup off. */
  audioRetentionDays: number;
  /** Offer to take notes when a call app uses the mic, and stop when the call ends (M2-T17b). */
  callDetection: boolean;
  /** Hide mic lines that repeat call audio (M2 D2); known headphones turn it off on their own. */
  echoFilter: boolean;
}

export const DEFAULT_CAPTURE_SETTINGS: Readonly<CaptureSettings> = Object.freeze({
  systemAudioCapture: 'auto',
  audioBackup: true,
  audioRetentionDays: 7,
  callDetection: true,
  echoFilter: true,
});

/**
 * The config.json keys readConfigFile keeps for loadCaptureSettings. Taken from the defaults, which
 * the type makes complete: a hand-written list missing a new setting would drop it from the file
 * silently, and Roger would run on the default the user had changed.
 */
// Object.keys types its answer as string[]; these are exactly CaptureSettings' keys.
const CAPTURE_SETTING_KEYS = Object.keys(DEFAULT_CAPTURE_SETTINGS) as (keyof CaptureSettings)[];

/**
 * Audio on disk is sensitive, and audio waiting for a gap re-run is kept at most this long anyway
 * (BACKUP_KEEP_FOR_RERUN_MAX_DAYS): a longer retention would make that cap meaningless.
 */
const MAX_AUDIO_RETENTION_DAYS = BACKUP_KEEP_FOR_RERUN_MAX_DAYS;

export interface ConfigFile {
  apiUrl?: string;
  apiToken?: string;
  sttProvider?: string;
  logLevel?: string;
  /** The cost guard keys present in config.json, unchecked: loadCostGuards validates them. */
  costGuards?: Record<string, unknown>;
  /** M2's capture keys present in config.json, unchecked: loadCaptureSettings validates them. */
  capture?: Record<string, unknown>;
}

export const DEFAULT_API_URL = 'http://127.0.0.1:8000';

export function loadConfig(env: NodeJS.ProcessEnv, file: ConfigFile = {}): DesktopConfig {
  const apiUrl = firstNonEmpty(env.ROGER_API_URL, file.apiUrl) ?? DEFAULT_API_URL;
  const logLevelRaw = firstNonEmpty(env.ROGER_LOG_LEVEL, file.logLevel);
  const { guards, errors: guardErrors } = loadCostGuards(env, file.costGuards ?? {});
  const { settings, errors: captureErrors } = loadCaptureSettings(file.capture ?? {});
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiToken: firstNonEmpty(env.ROGER_DESKTOP_API_TOKEN, file.apiToken) ?? null,
    sttProviderOverride: firstNonEmpty(env.ROGER_STT_PROVIDER, file.sttProvider) ?? null,
    logLevel: isLogLevel(logLevelRaw) ? logLevelRaw : 'info',
    costGuards: guards,
    capture: settings,
    errors: [...guardErrors, ...captureErrors],
  };
}

/** Reads M2's capture settings from config.json's values; each refused value is an error. */
export function loadCaptureSettings(file: Readonly<Record<string, unknown>>): {
  settings: CaptureSettings;
  errors: string[];
} {
  const errors: string[] = [];
  const read = <K extends keyof CaptureSettings>(
    key: K,
    accepts: (value: unknown) => value is CaptureSettings[K],
    rule: string,
  ): CaptureSettings[K] => {
    const raw = file[key];
    if (raw === undefined) return DEFAULT_CAPTURE_SETTINGS[key];
    if (accepts(raw)) return raw;
    errors.push(`config.json "${key}" must be ${rule} (got ${JSON.stringify(raw)})`);
    return DEFAULT_CAPTURE_SETTINGS[key];
  };
  const isFlag = (value: unknown): value is boolean => typeof value === 'boolean';
  const isRetentionDays = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_AUDIO_RETENTION_DAYS;

  const systemAudioCapture = read(
    'systemAudioCapture',
    (value): value is SystemAudioCaptureSetting =>
      SYSTEM_AUDIO_CAPTURE_SETTINGS.some((setting) => setting === value),
    `one of ${SYSTEM_AUDIO_CAPTURE_SETTINGS.map((setting) => `"${setting}"`).join(', ')}`,
  );
  const audioBackup = read('audioBackup', isFlag, 'true or false');
  const audioRetentionDays = read(
    'audioRetentionDays',
    isRetentionDays,
    `a whole number from 0 to ${MAX_AUDIO_RETENTION_DAYS}`,
  );
  const callDetection = read('callDetection', isFlag, 'true or false');
  const echoFilter = read('echoFilter', isFlag, 'true or false');
  return {
    settings: {
      systemAudioCapture,
      // 0 days keeps nothing, which is no backup: one answer for "is audio kept", read by M2-T15.
      audioBackup: audioBackup && audioRetentionDays > 0,
      audioRetentionDays,
      callDetection,
      echoFilter,
    },
    errors,
  };
}

/**
 * Read `config.json` from the user data dir. A missing file is an empty config; a file that cannot
 * be read or parsed is an empty config plus an error saying why. `read` is injectable for tests.
 */
export function readConfigFile(
  path: string,
  read: (path: string) => string = (file) => readFileSync(file, 'utf8'),
): { config: ConfigFile; error: string | null } {
  let raw: string;
  try {
    raw = read(path);
  } catch (error) {
    // Only ENOENT means "no config". EACCES or EISDIR is a file someone meant Roger to use, and
    // treating it as absent turned a permissions problem into a baffling "No API token".
    const code = errnoCode(error);
    if (code === 'ENOENT') return { config: {}, error: null };
    // The code, not the message: keep what reaches logs and the UI short and free of file data.
    return { config: {}, error: `${path} could not be read (${code ?? 'unknown error'})` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { config: {}, error: `${path} must contain a JSON object` };
    }
    return { config: pickKnownKeys(parsed as Record<string, unknown>), error: null };
  } catch {
    // V8 quotes the offending input in some parse errors; the file may hold the API token.
    return { config: {}, error: `${path} is not valid JSON` };
  }
}

function pickKnownKeys(source: Record<string, unknown>): ConfigFile {
  const result: ConfigFile = {};
  for (const key of ['apiUrl', 'apiToken', 'sttProvider', 'logLevel'] as const) {
    const value = source[key];
    if (typeof value === 'string') result[key] = value;
  }
  // Kept whatever their type: a guard given as "30" must be reported, not silently dropped.
  const guards: Record<string, unknown> = {};
  for (const { file } of COST_GUARD_SETTINGS) {
    if (file in source) guards[file] = source[file];
  }
  if (Object.keys(guards).length > 0) result.costGuards = guards;
  // The same for M2's keys: "audioBackup": "no" dropped would keep audio the user did not want
  // kept. Only listed keys are copied, so no key can name the helper binary (CaptureSettings).
  const capture: Record<string, unknown> = {};
  for (const key of CAPTURE_SETTING_KEYS) {
    if (key in source) capture[key] = source[key];
  }
  if (Object.keys(capture).length > 0) result.capture = capture;
  return result;
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim();
}
