import { readFileSync } from 'node:fs';
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
  /** Settings that were refused. Start stays blocked until they are fixed. */
  errors: string[];
}

export interface ConfigFile {
  apiUrl?: string;
  apiToken?: string;
  sttProvider?: string;
  logLevel?: string;
  /** The cost guard keys present in config.json, unchecked: loadCostGuards validates them. */
  costGuards?: Record<string, unknown>;
}

export const DEFAULT_API_URL = 'http://127.0.0.1:8000';

export function loadConfig(env: NodeJS.ProcessEnv, file: ConfigFile = {}): DesktopConfig {
  const apiUrl = firstNonEmpty(env.ROGER_API_URL, file.apiUrl) ?? DEFAULT_API_URL;
  const logLevelRaw = firstNonEmpty(env.ROGER_LOG_LEVEL, file.logLevel);
  const { guards, errors } = loadCostGuards(env, file.costGuards ?? {});
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiToken: firstNonEmpty(env.ROGER_DESKTOP_API_TOKEN, file.apiToken) ?? null,
    sttProviderOverride: firstNonEmpty(env.ROGER_STT_PROVIDER, file.sttProvider) ?? null,
    logLevel: isLogLevel(logLevelRaw) ? logLevelRaw : 'info',
    costGuards: guards,
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
