import { readFileSync } from 'node:fs';
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
}

export interface ConfigFile {
  apiUrl?: string;
  apiToken?: string;
  sttProvider?: string;
  logLevel?: string;
}

export const DEFAULT_API_URL = 'http://127.0.0.1:8000';

export function loadConfig(env: NodeJS.ProcessEnv, file: ConfigFile = {}): DesktopConfig {
  const apiUrl = firstNonEmpty(env.ROGER_API_URL, file.apiUrl) ?? DEFAULT_API_URL;
  const logLevelRaw = firstNonEmpty(env.ROGER_LOG_LEVEL, file.logLevel);
  return {
    apiUrl: apiUrl.replace(/\/+$/, ''),
    apiToken: firstNonEmpty(env.ROGER_DESKTOP_API_TOKEN, file.apiToken) ?? null,
    sttProviderOverride: firstNonEmpty(env.ROGER_STT_PROVIDER, file.sttProvider) ?? null,
    logLevel: isLogLevel(logLevelRaw) ? logLevelRaw : 'info',
  };
}

/** Read `config.json` from the user data dir. A missing or malformed file is treated as empty. */
export function readConfigFile(path: string): { config: ConfigFile; error: string | null } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { config: {}, error: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { config: {}, error: `${path} must contain a JSON object` };
    }
    return { config: pickStrings(parsed as Record<string, unknown>), error: null };
  } catch (error) {
    return { config: {}, error: `${path} is not valid JSON: ${(error as Error).message}` };
  }
}

function pickStrings(source: Record<string, unknown>): ConfigFile {
  const result: ConfigFile = {};
  for (const key of ['apiUrl', 'apiToken', 'sttProvider', 'logLevel'] as const) {
    const value = source[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim();
}
