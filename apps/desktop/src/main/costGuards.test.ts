import { describe, expect, it } from 'vitest';
import { NO_AUDIO_WARNING_MS } from '../shared/capture';
import {
  COST_GUARD_SETTINGS,
  DEFAULT_COST_GUARDS,
  loadCostGuards,
  settingDefault,
} from './costGuards';

describe('loadCostGuards', () => {
  it('uses the defaults when nothing is set', () => {
    expect(loadCostGuards({}, {})).toEqual({ guards: DEFAULT_COST_GUARDS, errors: [] });
    expect(DEFAULT_COST_GUARDS).toEqual({
      sttStallCloseMs: 30_000,
      sttReopenBufferMs: 3_000,
      sttOpensPerMinute: 4,
      sttOpensPerMeeting: 30,
      sttReopenBackoffMs: 2_000,
      sttReopenBackoffMaxMs: 60_000,
      noSpeechStopMs: 15 * 60_000,
      maxRecordingMs: 4 * 3_600_000,
      quitStopTimeoutMs: 5_000,
      sttVendorIdleTimeoutMs: 120_000,
    });
  });

  it('takes config.json values, and ROGER_* variables over them', () => {
    const { guards, errors } = loadCostGuards(
      { ROGER_STT_STALL_CLOSE_SECONDS: '45', ROGER_STT_OPENS_PER_MEETING: ' 12 ' },
      { sttStallCloseSeconds: 20, noSpeechStopSeconds: 600, sttOpensPerMinute: 3 },
    );
    expect(errors).toEqual([]);
    expect(guards).toMatchObject({
      sttStallCloseMs: 45_000,
      noSpeechStopMs: 600_000,
      sttOpensPerMinute: 3,
      sttOpensPerMeeting: 12,
    });
  });

  it('refuses values that are not whole numbers in range, naming where they came from', () => {
    const { guards, errors } = loadCostGuards(
      { ROGER_STT_OPENS_PER_MINUTE: '1', ROGER_MAX_RECORDING_SECONDS: '4h' },
      { sttStallCloseSeconds: 2.5, quitStopTimeoutSeconds: '5' },
    );
    expect(errors).toEqual([
      'config.json "sttStallCloseSeconds" must be a whole number from 10 to 300 (got 2.5)',
      'ROGER_STT_OPENS_PER_MINUTE must be a whole number from 2 to 100 (got "1")',
      'ROGER_MAX_RECORDING_SECONDS must be a whole number from 60 to 86400 (got "4h")',
      'config.json "quitStopTimeoutSeconds" must be a whole number from 1 to 30 (got "5")',
    ]);
    // A refused value never silently stands: the default holds, and the error blocks Start.
    expect(guards.sttStallCloseMs).toBe(DEFAULT_COST_GUARDS.sttStallCloseMs);
    expect(guards.sttOpensPerMinute).toBe(DEFAULT_COST_GUARDS.sttOpensPerMinute);
  });

  it('refuses a vendor idle timeout at or below the stall close, and a backoff cap below its start', () => {
    const { errors } = loadCostGuards(
      { ROGER_STT_VENDOR_IDLE_TIMEOUT_SECONDS: '30', ROGER_STT_REOPEN_BACKOFF_MAX_SECONDS: '1' },
      { sttReopenBackoffSeconds: 5 },
    );
    expect(errors).toEqual([
      'sttVendorIdleTimeoutSeconds (30) must be above sttStallCloseSeconds (30): the vendor ' +
        'timeout is the net for when Roger cannot close the session itself',
      'sttReopenBackoffMaxSeconds (1) must be at least sttReopenBackoffSeconds (5)',
    ]);
  });

  it('keeps the stall close above the visible no-audio warning', () => {
    const stall = COST_GUARD_SETTINGS.find((setting) => setting.guard === 'sttStallCloseMs');
    expect((stall?.min ?? 0) * 1000).toBeGreaterThan(NO_AUDIO_WARNING_MS);
  });

  it('documents every guard with a config.json key, a ROGER_ variable and a reason', () => {
    expect(COST_GUARD_SETTINGS.map((setting) => setting.guard).sort()).toEqual(
      Object.keys(DEFAULT_COST_GUARDS).sort(),
    );
    for (const setting of COST_GUARD_SETTINGS) {
      expect(setting.env).toMatch(/^ROGER_[A-Z_]+$/);
      expect(setting.why.length).toBeGreaterThan(40);
    }
  });
});

describe('settingDefault', () => {
  it('gives every default in its config unit, inside its own bounds', () => {
    for (const setting of COST_GUARD_SETTINGS) {
      const value = settingDefault(setting);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(setting.min);
      expect(value).toBeLessThanOrEqual(setting.max);
    }
    const stall = COST_GUARD_SETTINGS.find((setting) => setting.guard === 'sttStallCloseMs');
    expect(stall === undefined ? null : settingDefault(stall)).toBe(30);
  });
});
