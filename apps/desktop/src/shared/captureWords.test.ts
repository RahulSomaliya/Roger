import { describe, expect, it } from 'vitest';
import type { CaptureWarning, CaptureWarningKind } from './capture';
import { warningHeadline, wordsOutsideDetails } from './captureWords';

const EVERY_KIND: Readonly<Record<CaptureWarningKind, true>> = {
  'no-audio': true,
  'source-ended': true,
  'helper-hung': true,
  'mic-dead': true,
  'call-audio-never-heard': true,
  'call-audio-silent': true,
  offline: true,
  'backup-paused': true,
  'keyterms-rejected': true,
};

/** Every kind with every source a warning can carry, null included. */
const EVERY_WARNING: Pick<CaptureWarning, 'kind' | 'source'>[] = (
  Object.keys(EVERY_KIND) as CaptureWarningKind[]
).flatMap((kind) => (['mic', 'system', null] as const).map((source) => ({ kind, source })));

describe('warningHeadline', () => {
  it('says what is wrong in a few plain words, the same on the page and in a notification', () => {
    expect(warningHeadline({ kind: 'no-audio', source: 'mic' })).toBe("Roger can't hear you");
    expect(warningHeadline({ kind: 'no-audio', source: 'system' })).toBe(
      "Roger can't hear the call",
    );
    expect(warningHeadline({ kind: 'mic-dead', source: 'mic' })).toBe("Roger can't hear you");
    expect(warningHeadline({ kind: 'source-ended', source: 'mic' })).toBe(
      'Your microphone stopped',
    );
    expect(warningHeadline({ kind: 'source-ended', source: 'system' })).toBe('Call audio stopped');
    expect(warningHeadline({ kind: 'helper-hung', source: 'system' })).toBe('Call audio stalled');
    expect(warningHeadline({ kind: 'call-audio-never-heard', source: 'system' })).toBe(
      'No call audio yet',
    );
    expect(warningHeadline({ kind: 'call-audio-silent', source: 'system' })).toBe(
      "Roger can't hear the call",
    );
    expect(warningHeadline({ kind: 'backup-paused', source: null })).toBe('Audio backup paused');
    expect(warningHeadline({ kind: 'keyterms-rejected', source: 'mic' })).toBe(
      'The jargon list was refused',
    );
  });

  it('keeps "transcription" out of the offline headline (the naming list keeps it in Details)', () => {
    expect(warningHeadline({ kind: 'offline', source: null })).toBe('The Mac is offline');
  });

  it('heads every kind and source in words a person may read, with no full stop', () => {
    for (const warning of EVERY_WARNING) {
      const headline = warningHeadline(warning);
      expect(headline.length, `${warning.kind}/${String(warning.source)}`).toBeGreaterThan(5);
      expect(headline).not.toMatch(/\.$/);
      expect(wordsOutsideDetails(headline)).toEqual([]);
    }
  });
});

describe('wordsOutsideDetails', () => {
  it('finds what main wrote before the sweep: vendors, codes, routes, errnos and internals', () => {
    expect(wordsOutsideDetails('xAI: rejected with HTTP 401')).toEqual(['xAI', 'HTTP', '401']);
    expect(
      wordsOutsideDetails('POST /v1/stt/token failed: connect ECONNREFUSED 127.0.0.1:8000'),
    ).toEqual(['POST /v1/stt/token', 'ECONNREFUSED', '127.0.0.1']);
    expect(wordsOutsideDetails('12 lines could not be saved on this Mac: SQLITE_BUSY')).toEqual([
      'SQLITE_BUSY',
    ]);
    expect(wordsOutsideDetails('Call audio stopped: the call audio helper quit (exit 1).')).toEqual(
      ['helper', 'exit 1'],
    );
    expect(wordsOutsideDetails('Mic (me) stopped. Press Stop, then Start again.')).toEqual([
      'Mic',
      'Start again',
    ]);
    expect(
      wordsOutsideDetails('Set STT_SAMPLE_RATE=16000 and STT_ENCODING=linear16 on the API.'),
    ).toEqual(['STT_SAMPLE_RATE', 'STT_ENCODING', 'API']);
    expect(wordsOutsideDetails('The Mac is offline, so transcription stopped.')).toEqual([
      'transcription',
    ]);
    expect(wordsOutsideDetails('Meeting 7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f not found')).toEqual([
      '7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f',
    ]);
    expect(wordsOutsideDetails('Error: the stream closed')).toEqual(['Error:', 'stream']);
    expect(wordsOutsideDetails('Jargon list rejected by Soniox')).toEqual(['Soniox']);
  });

  it('passes the plain words the sweep writes', () => {
    for (const plain of [
      'The speech-to-text service refused the connection, so notes did not start.',
      'Roger could not reach its server. Check the Mac is online, then Start notes again.',
      'Your microphone sends only silence. Check its input volume is not at 0.',
      '12 lines could not be saved on this Mac.',
      'Nothing has come from your microphone for 5 seconds.',
      "Roger's server had a problem.",
    ]) {
      expect(wordsOutsideDetails(plain), plain).toEqual([]);
    }
  });
});
