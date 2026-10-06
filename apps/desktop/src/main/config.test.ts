import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, loadConfig, readConfigFile } from './config';
import { DEFAULT_COST_GUARDS } from './costGuards';

describe('loadConfig', () => {
  it('falls back to defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      apiUrl: DEFAULT_API_URL,
      apiToken: null,
      sttProviderOverride: null,
      logLevel: 'info',
      costGuards: DEFAULT_COST_GUARDS,
      errors: [],
    });
  });

  it('reads the cost guards and reports the ones it refuses', () => {
    const config = loadConfig(
      { ROGER_NO_SPEECH_STOP_SECONDS: 'soon' },
      { costGuards: { sttStallCloseSeconds: 60 } },
    );
    expect(config.costGuards.sttStallCloseMs).toBe(60_000);
    expect(config.errors).toEqual([
      'ROGER_NO_SPEECH_STOP_SECONDS must be a whole number from 60 to 14400 (got "soon")',
    ]);
  });

  it('prefers environment variables over the config file and trims trailing slashes', () => {
    const config = loadConfig(
      { ROGER_API_URL: 'https://api.example.com/', ROGER_DESKTOP_API_TOKEN: ' env-token ' },
      { apiUrl: 'http://file', apiToken: 'file-token', logLevel: 'debug' },
    );
    expect(config.apiUrl).toBe('https://api.example.com');
    expect(config.apiToken).toBe('env-token');
    expect(config.logLevel).toBe('debug');
  });

  it('ignores an unknown log level', () => {
    expect(loadConfig({ ROGER_LOG_LEVEL: 'loud' }).logLevel).toBe('info');
  });
});

describe('readConfigFile', () => {
  it('returns an empty config for a missing file', () => {
    expect(readConfigFile('/definitely/missing/config.json')).toEqual({ config: {}, error: null });
  });

  it('reports a config file that exists but cannot be read, naming the error code only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roger-config-'));
    expect(readConfigFile(dir)).toEqual({
      config: {},
      error: `${dir} could not be read (EISDIR)`,
    });
    const denied = Object.assign(new Error("EACCES: permission denied, open 'x'"), {
      code: 'EACCES',
    });
    const result = readConfigFile('/x/config.json', () => {
      throw denied;
    });
    expect(result).toEqual({ config: {}, error: '/x/config.json could not be read (EACCES)' });
  });

  it('reports malformed JSON instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roger-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ not json');
    const result = readConfigFile(path);
    expect(result.config).toEqual({});
    expect(result.error).toBe(`${path} is not valid JSON`);
  });

  it('keeps only known string keys, and the cost guard keys for loadConfig to check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roger-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({ apiToken: 'abc', apiUrl: 42, extra: true, sttOpensPerMinute: 'x' }),
    );
    expect(readConfigFile(path).config).toEqual({
      apiToken: 'abc',
      costGuards: { sttOpensPerMinute: 'x' },
    });
  });
});
