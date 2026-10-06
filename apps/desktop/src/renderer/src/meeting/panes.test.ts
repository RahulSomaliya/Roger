import { describe, expect, it } from 'vitest';
import { activePane, meetingPanes } from './panes';

describe('meetingPanes', () => {
  it('is the transcript alone while nothing else is mounted on the page', () => {
    expect(meetingPanes({ notes: false, chat: false })).toEqual(['transcript']);
  });

  it('puts the notes first, then the transcript, then chat', () => {
    expect(meetingPanes({ notes: true, chat: true })).toEqual(['notes', 'transcript', 'chat']);
    expect(meetingPanes({ notes: false, chat: true })).toEqual(['transcript', 'chat']);
  });
});

describe('activePane', () => {
  it('opens on the first pane until one is picked', () => {
    expect(activePane(null, ['notes', 'transcript', 'chat'])).toBe('notes');
    expect(activePane('chat', ['notes', 'transcript', 'chat'])).toBe('chat');
  });

  it('falls back to the first pane when the picked one is not on the page', () => {
    expect(activePane('chat', ['transcript'])).toBe('transcript');
  });
});
