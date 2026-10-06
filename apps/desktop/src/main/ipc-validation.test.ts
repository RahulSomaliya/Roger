import { describe, expect, it } from 'vitest';
import { SETTINGS_PANE_IDS } from '../shared/ipc/setup';
import {
  isUuidV4,
  isSourceStateMessage,
  MAX_AUDIO_CHUNK_BYTES,
  MAX_CAPTURE_TIME_SKEW_MS,
  parseAudioChunk,
  parseMeetingRequest,
  parseSegmentRequest,
  parseSettingsPaneRequest,
} from './ipc-validation';
import { SETTINGS_PANES } from './settingsPanes';

const MEETING = '2f1d9c4e-8a3b-4c5d-9e6f-7a8b9c0d1e2f';
const SEGMENT = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';
const NOW = 1_791_000_000_000;

describe('parseAudioChunk', () => {
  it('accepts an ArrayBuffer or a view of even length from a known source', () => {
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(3200) })?.pcm.byteLength).toBe(
      3200,
    );
    const view = new Uint8Array(new ArrayBuffer(10), 2, 4);
    expect(parseAudioChunk({ source: 'system', pcm: view })?.pcm.byteLength).toBe(4);
  });

  it('rejects odd lengths, empty chunks, oversized chunks, unknown sources and junk', () => {
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(3201) })).toBeNull();
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(0) })).toBeNull();
    expect(
      parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(MAX_AUDIO_CHUNK_BYTES + 2) }),
    ).toBeNull();
    expect(parseAudioChunk({ source: 'speaker', pcm: new ArrayBuffer(2) })).toBeNull();
    expect(parseAudioChunk({ source: 'mic', pcm: 'nope' })).toBeNull();
    expect(parseAudioChunk(null)).toBeNull();
  });

  it('keeps the capture time, or null when the renderer sent none', () => {
    const pcm = new ArrayBuffer(3200);
    expect(parseAudioChunk({ source: 'mic', pcm, capturedAtMs: NOW - 40 }, NOW)).toMatchObject({
      source: 'mic',
      capturedAtMs: NOW - 40,
    });
    // M1's renderer sends none until M2-T12: main then uses the arrival time.
    expect(parseAudioChunk({ source: 'mic', pcm }, NOW)?.capturedAtMs).toBeNull();
    // A day either way is still accepted: the bound catches junk. It does not absorb a renderer
    // clock that stops through sleeps (AudioChunkMessage.capturedAtMs says how to avoid one).
    expect(
      parseAudioChunk({ source: 'system', pcm, capturedAtMs: NOW + MAX_CAPTURE_TIME_SKEW_MS }, NOW)
        ?.capturedAtMs,
    ).toBe(NOW + MAX_CAPTURE_TIME_SKEW_MS);
  });

  it('refuses a chunk whose capture time is not a finite number or is far from now', () => {
    const pcm = new ArrayBuffer(3200);
    for (const capturedAtMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      String(NOW),
      null,
      0,
      NOW - MAX_CAPTURE_TIME_SKEW_MS - 1,
      NOW + MAX_CAPTURE_TIME_SKEW_MS + 1,
    ]) {
      expect(parseAudioChunk({ source: 'mic', pcm, capturedAtMs }, NOW)).toBeNull();
    }
  });
});

describe('isSourceStateMessage', () => {
  it('checks source, state and the optional message', () => {
    expect(isSourceStateMessage({ source: 'mic', state: 'active' })).toBe(true);
    expect(isSourceStateMessage({ source: 'system', state: 'error', message: 'denied' })).toBe(
      true,
    );
    expect(
      isSourceStateMessage({ source: 'mic', state: 'ended', message: 'device unplugged' }),
    ).toBe(true);
    expect(isSourceStateMessage({ source: 'system', state: 'paused' })).toBe(false);
    expect(isSourceStateMessage({ source: 'speaker', state: 'ended' })).toBe(false);
    expect(isSourceStateMessage({ source: 'mic', state: 'active', message: 5 })).toBe(false);
  });
});

describe('isUuidV4', () => {
  it('accepts a lowercase UUIDv4, as randomUUID() makes them', () => {
    expect(isUuidV4(MEETING)).toBe(true);
    expect(isUuidV4(crypto.randomUUID())).toBe(true);
  });

  // Meeting ids name folders on disk (userData/audio/<id>): anything else could climb out of it.
  it('refuses paths, other UUID versions, other spellings and non-strings', () => {
    for (const id of [
      '../x',
      `../${MEETING}`,
      `${MEETING}/..`,
      '/etc/passwd',
      `/Users/me/Library/Application Support/Roger/audio/${MEETING}`,
      '.',
      '',
      MEETING.toUpperCase(),
      `${MEETING}\n`,
      ` ${MEETING}`,
      MEETING.replaceAll('-', ''),
      '2f1d9c4e-8a3b-1c5d-9e6f-7a8b9c0d1e2f', // version 1
      '2f1d9c4e-8a3b-4c5d-7e6f-7a8b9c0d1e2f', // not the RFC 4122 variant
      42,
      null,
      undefined,
      { meetingId: MEETING },
    ]) {
      expect(isUuidV4(id)).toBe(false);
    }
  });
});

describe('parseMeetingRequest', () => {
  it('passes on only the meeting id', () => {
    expect(parseMeetingRequest({ meetingId: MEETING, extra: '../../x' })).toEqual({
      meetingId: MEETING,
    });
  });

  it('refuses a meeting id that is not a UUIDv4, a path included', () => {
    expect(parseMeetingRequest({ meetingId: '../x' })).toBeNull();
    expect(parseMeetingRequest({ meetingId: '/tmp' })).toBeNull();
    expect(parseMeetingRequest({})).toBeNull();
    expect(parseMeetingRequest(MEETING)).toBeNull();
    expect(parseMeetingRequest(null)).toBeNull();
  });
});

describe('parseSegmentRequest', () => {
  it('passes on only the meeting and segment ids', () => {
    expect(parseSegmentRequest({ meetingId: MEETING, segmentId: SEGMENT, text: 'x' })).toEqual({
      meetingId: MEETING,
      segmentId: SEGMENT,
    });
  });

  it('refuses either id when it is not a UUIDv4', () => {
    expect(parseSegmentRequest({ meetingId: MEETING, segmentId: '../x' })).toBeNull();
    expect(parseSegmentRequest({ meetingId: '../x', segmentId: SEGMENT })).toBeNull();
    expect(parseSegmentRequest({ meetingId: MEETING })).toBeNull();
    expect(parseSegmentRequest(undefined)).toBeNull();
  });
});

describe('parseSettingsPaneRequest', () => {
  it('accepts every pane main has a link for', () => {
    for (const pane of SETTINGS_PANE_IDS) {
      expect(parseSettingsPaneRequest({ pane })).toEqual({ pane });
    }
  });

  it('names the same panes as main', () => {
    expect([...SETTINGS_PANE_IDS].sort()).toEqual(Object.keys(SETTINGS_PANES).sort());
  });

  // The pane picks the URL main opens: never a URL or a key from the object's prototype.
  it('refuses unknown panes, prototype keys and URLs', () => {
    for (const pane of [
      'camera',
      'toString',
      '__proto__',
      'constructor',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
      'https://example.com',
      '',
      3,
    ]) {
      expect(parseSettingsPaneRequest({ pane })).toBeNull();
    }
    expect(parseSettingsPaneRequest('microphone')).toBeNull();
    expect(parseSettingsPaneRequest(null)).toBeNull();
  });
});
