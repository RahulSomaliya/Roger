import { describe, expect, it } from 'vitest';
import { activeTab, meetingTabs, tabSpecs } from './panes';

describe('meetingTabs', () => {
  it('is the transcript alone while nothing else is mounted on the page', () => {
    expect(meetingTabs({ mine: false, ai: false, chat: false })).toEqual(['transcript']);
  });

  it('is one row in a fixed order: My notes, AI notes, Transcript, Chat', () => {
    expect(meetingTabs({ mine: true, ai: true, chat: true })).toEqual([
      'mine',
      'ai',
      'transcript',
      'chat',
    ]);
  });

  it('leaves out the AI notes until there are some, so no tab opens onto nothing', () => {
    expect(meetingTabs({ mine: true, ai: false, chat: true })).toEqual([
      'mine',
      'transcript',
      'chat',
    ]);
  });
});

describe('activeTab', () => {
  it('opens on the first tab (your notes) until one is picked', () => {
    expect(activeTab(null, ['mine', 'ai', 'transcript', 'chat'])).toBe('mine');
    expect(activeTab('chat', ['mine', 'ai', 'transcript', 'chat'])).toBe('chat');
  });

  it('falls back to the first tab when the picked one is not on the page', () => {
    // The AI notes tab is gone (a generate was cancelled before any notes existed).
    expect(activeTab('ai', ['mine', 'transcript'])).toBe('mine');
  });
});

describe('tabSpecs', () => {
  it('names each tab for the tab row, in order', () => {
    expect(tabSpecs(['mine', 'transcript'])).toEqual([
      { id: 'mine', label: 'My notes' },
      { id: 'transcript', label: 'Transcript' },
    ]);
  });

  it('refuses none or more than four: the row never holds a fifth tab', () => {
    expect(() => tabSpecs([])).toThrow(/1 to 4/);
    expect(() => tabSpecs(['mine', 'ai', 'transcript', 'chat', 'mine'])).toThrow(/1 to 4/);
  });
});
