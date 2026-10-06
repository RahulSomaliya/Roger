import { describe, expect, it } from 'vitest';
import { parseHelperEvent } from './helperEvents';

// The lines as native/roger-audio/Protocol.swift writes them ("event" first, whole numbers bare).
const READY =
  '{"event":"ready","format":{"encoding":"linear16","sampleRate":16000,"channels":1,"chunkMs":100},"tapFormat":{"sampleRate":48000,"channels":2}}';

describe('parseHelperEvent', () => {
  it('reads ready with the format stdout carries and the tap format', () => {
    expect(parseHelperEvent(READY)).toEqual({
      kind: 'event',
      event: {
        event: 'ready',
        format: { encoding: 'linear16', sampleRate: 16_000, channels: 1, chunkMs: 100 },
        tapFormat: { sampleRate: 48_000, channels: 2 },
      },
    });
  });

  it('reads restarted, stats, warning and error', () => {
    expect(
      parseHelperEvent(
        '{"event":"restarted","reason":"output_device_changed","tapFormat":{"sampleRate":24000,"channels":1}}',
      ),
    ).toEqual({
      kind: 'event',
      event: {
        event: 'restarted',
        reason: 'output_device_changed',
        tapFormat: { sampleRate: 24_000, channels: 1 },
      },
    });
    expect(parseHelperEvent('{"event":"stats","peak":0,"frames":10,"dropped":0}')).toEqual({
      kind: 'event',
      event: { event: 'stats', peak: 0, frames: 10, dropped: 0 },
    });
    expect(
      parseHelperEvent('{"event":"warning","code":"no_audio","message":"the tap sent nothing"}'),
    ).toEqual({
      kind: 'event',
      event: { event: 'warning', code: 'no_audio', message: 'the tap sent nothing' },
    });
    expect(
      parseHelperEvent(
        '{"event":"error","code":"tap_create_failed","message":"no tap","status":560947818}',
      ),
    ).toEqual({
      kind: 'event',
      event: { event: 'error', code: 'tap_create_failed', message: 'no tap', status: 560_947_818 },
    });
    expect(parseHelperEvent('{"event":"error","code":"usage","message":"bad"}')).toEqual({
      kind: 'event',
      event: { event: 'error', code: 'usage', message: 'bad', status: null },
    });
  });

  // A newer helper may say more than this main knows: that is not a broken helper.
  it('passes over an event it does not know', () => {
    expect(parseHelperEvent('{"event":"route","output":null}')).toEqual({
      kind: 'unknown',
      name: 'route',
    });
  });

  it.each([
    ['not JSON', 'roger-audio: something went wrong', 'not a JSON object'],
    ['an array', '[1,2]', 'not a JSON object'],
    ['no event name', '{"peak":1}', 'no "event" name'],
    [
      'stats without numbers',
      '{"event":"stats","peak":"loud","frames":1,"dropped":0}',
      'stats: "peak" is not a number',
    ],
    [
      'ready without a format',
      '{"event":"ready","tapFormat":{"sampleRate":48000,"channels":2}}',
      'ready: "format" is not an object',
    ],
    [
      'a format without its encoding',
      '{"event":"ready","format":{"sampleRate":16000,"channels":1,"chunkMs":100},"tapFormat":{"sampleRate":48000,"channels":2}}',
      'ready: "format.encoding" is not a string',
    ],
    ['an error without a code', '{"event":"error","message":"x"}', 'error: "code" is not a string'],
    [
      'restarted without a reason',
      '{"event":"restarted","tapFormat":{"sampleRate":48000,"channels":2}}',
      'restarted: "reason" is not a string',
    ],
  ])('refuses %s', (_name, line, reason) => {
    expect(parseHelperEvent(line)).toEqual({ kind: 'malformed', reason });
  });
});
