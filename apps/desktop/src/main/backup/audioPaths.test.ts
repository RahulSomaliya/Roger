import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  audioRoot,
  ensureMeetingAudioDir,
  meetingAudioDir,
  removeEmptyMeetingAudioDir,
  removeMeetingAudioDir,
  resolveStoredAudioPath,
  storedAudioPath,
} from './audioPaths';

const MEETING = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';

describe('audio paths', () => {
  let userData = '';

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'roger-audio-paths-'));
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  it('keeps each meeting in userData/audio/<meeting>, stored relative to userData', () => {
    expect(audioRoot(userData)).toBe(join(userData, 'audio'));
    expect(meetingAudioDir(userData, MEETING)).toBe(join(userData, 'audio', MEETING));
    expect(storedAudioPath(MEETING, 'mic-000003000-2f6a8c1d.wav')).toBe(
      `audio/${MEETING}/mic-000003000-2f6a8c1d.wav`,
    );
    expect(resolveStoredAudioPath(userData, `audio/${MEETING}/mic.wav`)).toBe(
      join(userData, 'audio', MEETING, 'mic.wav'),
    );
  });

  it.each([
    ['a parent folder', '../x'],
    ['an absolute path', '/Users/someone'],
    ['a path inside the root', `${MEETING}/x`],
    ['an upper-case id', MEETING.toUpperCase()],
    ['nothing', ''],
  ])('refuses %s as a meeting id', (_what, meetingId) => {
    expect(() => meetingAudioDir(userData, meetingId)).toThrow(/not a meeting id/);
  });

  it.each([
    ['climbs out with ..', `audio/${MEETING}/../../roger.sqlite`],
    ['is absolute', '/etc/hosts'],
    ['is outside the audio folder', 'roger.sqlite'],
    ['names the audio folder itself', 'audio'],
  ])('refuses a stored path that %s', (_what, stored) => {
    expect(() => resolveStoredAudioPath(userData, stored)).toThrow(/outside the audio folder/);
  });

  it('makes the audio folder and each meeting folder readable by their owner only', () => {
    const dir = ensureMeetingAudioDir(userData, MEETING);

    expect(dir).toBe(meetingAudioDir(userData, MEETING));
    expect(statSync(audioRoot(userData)).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Again: an existing folder is fine.
    expect(ensureMeetingAudioDir(userData, MEETING)).toBe(dir);
  });

  it('removes a meeting folder with its files, and says when there was none', () => {
    const dir = ensureMeetingAudioDir(userData, MEETING);
    writeFileSync(join(dir, 'mic.wav'), 'x');

    expect(removeMeetingAudioDir(userData, MEETING)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(removeMeetingAudioDir(userData, MEETING)).toBe(false);
  });

  it('removes a meeting folder that holds nothing, and never one that holds a file', () => {
    const dir = ensureMeetingAudioDir(userData, MEETING);

    expect(removeEmptyMeetingAudioDir(userData, MEETING)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(removeEmptyMeetingAudioDir(userData, MEETING)).toBe(false);

    ensureMeetingAudioDir(userData, MEETING);
    writeFileSync(join(dir, 'mic.wav'), 'x');
    expect(removeEmptyMeetingAudioDir(userData, MEETING)).toBe(false);
    expect(existsSync(join(dir, 'mic.wav'))).toBe(true);
  });

  it('refuses to delete through a meeting folder that links outside the audio root', () => {
    const outside = join(userData, 'Documents');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'mine');
    mkdirSync(audioRoot(userData), { recursive: true });
    symlinkSync(outside, meetingAudioDir(userData, MEETING));

    expect(() => removeMeetingAudioDir(userData, MEETING)).toThrow(/not a folder/);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(() => ensureMeetingAudioDir(userData, MEETING)).toThrow(/not a folder/);
    rmSync(join(outside, 'keep.txt'));
    // Empty behind the link now: still refused, so the link and its folder both stay.
    expect(() => removeEmptyMeetingAudioDir(userData, MEETING)).toThrow(/not a folder/);
    expect(existsSync(outside)).toBe(true);
  });

  it('refuses to delete through an audio root that links outside userData', () => {
    const outside = join(userData, 'Elsewhere');
    mkdirSync(join(outside, MEETING), { recursive: true });
    writeFileSync(join(outside, MEETING, 'keep.txt'), 'mine');
    symlinkSync(outside, audioRoot(userData));

    expect(() => removeMeetingAudioDir(userData, MEETING)).toThrow(/not a folder/);
    expect(existsSync(join(outside, MEETING, 'keep.txt'))).toBe(true);
    expect(() => ensureMeetingAudioDir(userData, MEETING)).toThrow(/not a folder/);
  });
});
