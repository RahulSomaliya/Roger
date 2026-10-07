import { describe, expect, it } from 'vitest';
import { DEFAULT_NOTICE_TEXT } from '../../../shared/calendarPrefs';
import { noticeToSave } from './noticeDraft';

describe('noticeToSave', () => {
  it('saves the text on blur when it differs from the stored one', () => {
    expect(noticeToSave('Recording this call.', 'Hi all.')).toBe('Recording this call.');
  });

  it('saves nothing when the text is as stored: a click through the box is no change', () => {
    expect(noticeToSave('Hi all.', 'Hi all.')).toBeNull();
  });

  // main refuses a blank notice (notice.text is blank): the box keeps what was typed, the page
  // says why, and the stored text stays what the other people on the call will be told.
  it('saves nothing for a blank text', () => {
    expect(noticeToSave('', 'Hi all.')).toBeNull();
    expect(noticeToSave('  \n ', 'Hi all.')).toBeNull();
  });

  it('keeps the text exactly as typed, spaces and all', () => {
    expect(noticeToSave(' Hi all. ', 'Hi all.')).toBe(' Hi all. ');
  });

  it('saves the default text when the stored one is custom', () => {
    expect(noticeToSave(DEFAULT_NOTICE_TEXT, 'Mine')).toBe(DEFAULT_NOTICE_TEXT);
  });
});
