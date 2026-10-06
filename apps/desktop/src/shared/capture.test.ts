import { describe, expect, it } from 'vitest';
import {
  BLUETOOTH_MIC_DEAD_WARNING_MS,
  CALL_AUDIO_SILENT_LOUD_MS,
  CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS,
  CALL_AUDIO_SILENT_WARNING_MS,
  HELPER_HANG_KILL_MS,
  idleCaptureStatus,
  isStartSource,
  MIC_DEAD_WARNING_MS,
  NO_AUDIO_WARNING_MS,
  START_SOURCES,
} from './capture';

describe('the capture warning thresholds', () => {
  // M2's done-when: cutting the helper, the mic or the network warns within 10 s. Only the D3
  // (call audio silence) and D4 (Bluetooth mic) rules may take longer, by owner decision.
  it('warn of every cut that stops audio within 10 s', () => {
    for (const threshold of [NO_AUDIO_WARNING_MS, MIC_DEAD_WARNING_MS, HELPER_HANG_KILL_MS]) {
      expect(threshold).toBeLessThanOrEqual(10_000);
    }
  });

  it('give a Bluetooth mic longer than a wired one, and escalate call audio silence', () => {
    expect(BLUETOOTH_MIC_DEAD_WARNING_MS).toBeGreaterThan(MIC_DEAD_WARNING_MS);
    expect(CALL_AUDIO_SILENT_WARNING_MS).toBeLessThan(CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS);
    expect(CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS).toBeLessThan(CALL_AUDIO_SILENT_LOUD_MS);
  });
});

describe('idleCaptureStatus', () => {
  // M2's status fields are optional and filled by main as each feature lands (M2-T4's status
  // contributors). The idle status carries only the landed fields, so a status built from it and
  // CaptureService's recording status (an object literal) keep the same shape until then.
  it('carries exactly the landed fields', () => {
    const status = idleCaptureStatus({
      state: 'idle',
      pending: 0,
      rejected: 0,
      lastError: null,
      nextAttemptAt: null,
    });
    expect(Object.keys(status).sort()).toEqual(
      [
        'phase',
        'meetingId',
        'title',
        'startedAt',
        'sttProvider',
        'sources',
        'streams',
        'streamMessages',
        'segmentsStored',
        'segmentsUnsaved',
        'upload',
        'error',
        'meter',
        'notice',
      ].sort(),
    );
    expect(Object.keys(status.sources.mic).sort()).toEqual(
      ['health', 'chunks', 'lastChunkAt', 'message'].sort(),
    );
  });
});

describe('start sources', () => {
  // The API contract's StartSource, its Postgres check and roger.sqlite's CHECK (migration 5) list
  // the same five; ipc-validation.test.ts compares the contract's line with START_SOURCES.
  it('are the five the API stores, and nothing else passes for one', () => {
    expect([...START_SOURCES]).toEqual(['manual', 'notification', 'home', 'tray', 'call_detected']);
    for (const source of START_SOURCES) expect(isStartSource(source)).toBe(true);
    for (const value of ['calendar', 'Manual', ' manual', '', 'toString', null, undefined, 3]) {
      expect(isStartSource(value)).toBe(false);
    }
  });
});
