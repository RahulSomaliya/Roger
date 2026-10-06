import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, DEFAULT_CAPTURE_SETTINGS, loadConfig, readConfigFile } from './config';
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
      capture: DEFAULT_CAPTURE_SETTINGS,
      errors: [],
    });
  });

  it('keeps call audio on automatic, a 7-day backup, call detection and the echo filter on', () => {
    expect(DEFAULT_CAPTURE_SETTINGS).toEqual({
      systemAudioCapture: 'auto',
      audioBackup: true,
      audioRetentionDays: 7,
      callDetection: true,
      echoFilter: true,
    });
  });

  it("reads M2's capture settings from config.json", () => {
    const config = loadConfig(
      {},
      {
        capture: {
          systemAudioCapture: 'electron',
          audioBackup: true,
          audioRetentionDays: 30,
          callDetection: false,
          echoFilter: false,
        },
      },
    );
    expect(config.capture).toEqual({
      systemAudioCapture: 'electron',
      audioBackup: true,
      audioRetentionDays: 30,
      callDetection: false,
      echoFilter: false,
    });
    expect(config.errors).toEqual([]);
  });

  it('turns the audio backup off with 0 retention days, as with audioBackup false', () => {
    expect(loadConfig({}, { capture: { audioRetentionDays: 0 } }).capture).toMatchObject({
      audioBackup: false,
      audioRetentionDays: 0,
    });
    expect(loadConfig({}, { capture: { audioBackup: false } }).capture.audioBackup).toBe(false);
  });

  // As with the cost guards, a refused value blocks Start (index.ts): "audioBackup": "no" read as
  // the default would keep call audio the user asked Roger not to keep.
  it('names every refused capture setting and keeps its default', () => {
    const config = loadConfig(
      {},
      {
        capture: {
          systemAudioCapture: 'helper',
          audioBackup: 'no',
          audioRetentionDays: 7.5,
          callDetection: 1,
          echoFilter: null,
        },
      },
    );
    expect(config.capture).toEqual(DEFAULT_CAPTURE_SETTINGS);
    expect(config.errors).toEqual([
      'config.json "systemAudioCapture" must be one of "auto", "tap", "electron" (got "helper")',
      'config.json "audioBackup" must be true or false (got "no")',
      'config.json "audioRetentionDays" must be a whole number from 0 to 30 (got 7.5)',
      'config.json "callDetection" must be true or false (got 1)',
      'config.json "echoFilter" must be true or false (got null)',
    ]);
    expect(loadConfig({}, { capture: { audioRetentionDays: 31 } }).errors).toEqual([
      'config.json "audioRetentionDays" must be a whole number from 0 to 30 (got 31)',
    ]);
  });

  // The helper records call audio: only the app bundle or the dev build may name it (M2-T9).
  it('has no setting that picks the helper binary', () => {
    const config = loadConfig({}, { capture: { helperPath: '/tmp/evil' } });
    for (const key of [...Object.keys(config), ...Object.keys(config.capture)]) {
      expect(key).not.toMatch(/helper|binary|path|executable/i);
    }
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

  it("keeps M2's capture keys whatever their type, and never a helper path", () => {
    const dir = mkdtempSync(join(tmpdir(), 'roger-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        audioBackup: 'no',
        audioRetentionDays: 3,
        systemAudioCapture: 'tap',
        helperPath: '/tmp/evil',
        rogerAudioPath: '/tmp/evil',
      }),
    );
    expect(readConfigFile(path).config).toEqual({
      capture: { audioBackup: 'no', audioRetentionDays: 3, systemAudioCapture: 'tap' },
    });
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
