import { describe, expect, it } from 'vitest';
import { wordsOutsideDetails } from '../../../shared/captureWords';
import { describeMediaError, describeMicrophoneFailure } from './sources';

const media = (name: string, message = 'raw browser text') => new DOMException(message, name);

describe('describeMicrophoneFailure', () => {
  it('says what stopped the microphone and what to do, for the banner', () => {
    expect(describeMicrophoneFailure(media('NotAllowedError'))).toBe(
      'Roger may not use the microphone. Allow Roger under System Settings, Privacy & Security, Microphone, then Start notes again.',
    );
    expect(describeMicrophoneFailure(media('NotFoundError'))).toBe(
      'Roger found no microphone. Connect one, then Start notes again.',
    );
    expect(describeMicrophoneFailure(media('NotReadableError'))).toContain(
      'another app may be using it',
    );
  });

  it('never prints the browser\'s own text, which the old "Microphone: NotSupportedError: ..." did', () => {
    for (const error of [
      media('NotSupportedError', 'Only secure origins are allowed'),
      media('AbortError', 'Timeout starting video source'),
      media('OverconstrainedError'),
      media('SecurityError'),
      new Error('Chromium returned no system audio track'),
      'a string',
      undefined,
    ]) {
      const sentence = describeMicrophoneFailure(error);
      expect(wordsOutsideDetails(sentence)).toEqual([]);
      expect(sentence).not.toContain('raw browser text');
      expect(sentence).not.toContain('NotSupportedError');
      expect(sentence).toContain('Start notes again');
    }
  });

  it("leaves describeMediaError's raw text for main's Details row, as before", () => {
    expect(describeMediaError(media('NotSupportedError', 'nope'))).toBe('NotSupportedError: nope');
  });
});
