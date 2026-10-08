import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Slots } from '../app/slotRegistry';
import type { HeaderAction } from './headerAction';
import { MeetingHeader } from './MeetingHeader';
import { ReplaceNotesDialog } from './MeetingProblems';
import { cssDeclarations } from '../theme/cssDeclarations';
import { rendererSource } from '../theme/rendererSources';

// No slot files: the header's own markup is under test, not what the capture slots draw in it.
vi.mock('../app/slots', () => {
  const slots: Slots = {
    banner: [],
    settings: [],
    setup: [],
    meetingBanner: [],
    meetingCaptureStatus: [],
    meetingAudioNote: [],
    meetingCaptureReport: [],
    meetingTranscript: [],
    meetingMyNotes: [],
    meetingAiNotes: [],
    meetingChat: [],
  };
  return { slots };
});

const header = (
  action: HeaderAction,
  overrides: Partial<Parameters<typeof MeetingHeader>[0]> = {},
): string =>
  renderToStaticMarkup(
    createElement(MeetingHeader, {
      meetingId: 'm1',
      title: 'Northwind renewal',
      pending: false,
      time: 'Today, 9:30 am to 9:41 am',
      live: false,
      copied: null,
      action,
      onStop: vi.fn(),
      onWrite: vi.fn(),
      onCancelWrite: vi.fn(),
      menu: [],
      details: true,
      ...overrides,
    }),
  );

/** The primary buttons: Roger shows at most one per view. */
const primaries = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*data-variant="primary"[^>]*>([^<]*)<\/button>/g)].map(
    (match) => match[1] ?? '',
  );

describe('the meeting header: one primary per moment (docs/design.md)', () => {
  it('says Stop while recording', () => {
    expect(primaries(header({ kind: 'stop', busy: false }))).toEqual(['Stop']);
  });

  it('says Stopping… as a busy button: aria-disabled, never disabled', () => {
    const html = header({ kind: 'stop', busy: true });
    expect(primaries(html)).toEqual(['Stopping…']);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Stopping…/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled/);
  });

  it('says Starting… while the meeting starts', () => {
    const html = header({ kind: 'start' });
    expect(primaries(html)).toEqual(['Starting…']);
    expect(html).toMatch(/aria-disabled="true"/);
  });

  it('says Write notes after Stop, when there are no AI notes', () => {
    expect(primaries(header({ kind: 'write' }))).toEqual(['Write notes']);
  });

  it('says Writing notes… with a ghost Cancel while main can drop the generate', () => {
    const html = header({ kind: 'writing', cancellable: true, cancelling: false });
    expect(primaries(html)).toEqual(['Writing notes…']);
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*>Cancel<\/button>/);
  });

  it('puts Cancel to the LEFT of the primary, every header button sm (R3)', () => {
    const html = header({ kind: 'writing', cancellable: true, cancelling: false });
    expect(html.indexOf('>Cancel<')).toBeGreaterThan(-1);
    expect(html.indexOf('>Cancel<')).toBeLessThan(html.indexOf('>Writing notes…<'));
    const sizes = [...html.matchAll(/<button[^>]*data-size="(\w+)"/g)].map((m) => m[1]);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sizes)).toEqual(new Set(['sm']));
  });

  it('shows Cancelling… as busy, and no Cancel before main has a generate to drop', () => {
    const cancelling = header({ kind: 'writing', cancellable: true, cancelling: true });
    expect(cancelling).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Cancelling…<\/button>/);
    const pressed = header({ kind: 'writing', cancellable: false, cancelling: false });
    expect(pressed).not.toContain('Cancel');
  });

  it('has no primary when the notes are the loud thing', () => {
    expect(primaries(header({ kind: 'none' }))).toEqual([]);
  });

  it('never shows two primaries, whatever the moment', () => {
    const actions: HeaderAction[] = [
      { kind: 'start' },
      { kind: 'stop', busy: false },
      { kind: 'stop', busy: true },
      { kind: 'write' },
      { kind: 'writing', cancellable: true, cancelling: false },
      { kind: 'none' },
    ];
    for (const action of actions) expect(primaries(header(action)).length).toBeLessThanOrEqual(1);
  });
});

describe('the meeting header: title, time, menu and Details', () => {
  it('shows the title and the time line, 12-hour', () => {
    const html = header({ kind: 'none' });
    expect(html).toMatch(/<h1 class="meeting-title">Northwind renewal<\/h1>/);
    expect(html).toContain('Today, 9:30 am to 9:41 am');
  });

  it('keeps a blank line for the time until it is known, so the header never grows', () => {
    const html = header({ kind: 'none' }, { time: null });
    expect(html).toMatch(/<p class="meeting-time" aria-hidden="true">\u00a0<\/p>/);
  });

  it('has no time line while the meeting is live: the status line says Recording (R9)', () => {
    const html = header({ kind: 'stop', busy: false }, { live: true });
    expect(html).not.toContain('meeting-time');
    expect(html).not.toContain('Started');
  });

  it('says what Copy notes did in a status region that is always mounted', () => {
    expect(header({ kind: 'none' })).toMatch(/<p class="meeting-copied" role="status"><\/p>/);
    expect(header({ kind: 'none' }, { copied: 'Notes copied' })).toMatch(
      /<p class="meeting-copied" role="status">Notes copied<\/p>/,
    );
  });

  it('draws the ⋯ menu only when it has entries, as a ghost button', () => {
    expect(header({ kind: 'none' })).not.toContain('More actions');
    const html = header(
      { kind: 'none' },
      { menu: [{ id: 'restore', label: 'Restore previous notes', onSelect: vi.fn() }] },
    );
    expect(html).toMatch(/<button[^>]*data-variant="ghost"[^>]*aria-label="More actions"/);
  });

  it('puts Details in the header as a ghost button, and its dialog closed', () => {
    const html = header({ kind: 'none' });
    expect(html).toMatch(
      /<button[^>]*data-variant="ghost"[^>]*aria-haspopup="dialog"[^>]*>Details/,
    );
    expect(html).toMatch(/<dialog[^>]*class="dialog"[^>]*><\/dialog>/);
  });

  it('draws no Details for a meeting with nothing to detail', () => {
    expect(header({ kind: 'none' }, { details: false })).not.toContain('Details');
  });
});

describe('the replace notes question', () => {
  const dialog = (confirm: Parameters<typeof ReplaceNotesDialog>[0]['confirm']): string =>
    renderToStaticMarkup(
      createElement(ReplaceNotesDialog, { confirm, onConfirm: vi.fn(), onKeep: vi.fn() }),
    );

  it('is closed with nothing to ask, and mounts no content', () => {
    expect(dialog(null)).toMatch(/<dialog[^>]*><\/dialog>/);
  });

  it('asks to write again or to restore, with Keep my edits, and draws no primary', () => {
    const again = dialog({ action: 'regenerate', templateId: 'general' });
    expect(again).toContain('Replace your edited AI notes?');
    expect(again).toMatch(/<button[^>]*>Write again<\/button>/);
    expect(again).toMatch(/<button[^>]*>Keep my edits<\/button>/);
    const restore = dialog({ action: 'restore' });
    expect(restore).toMatch(/<button[^>]*>Restore<\/button>/);
    expect(primaries(again)).toEqual([]);
    expect(primaries(restore)).toEqual([]);
  });
});

describe('the Copy notes message never widens the action row', () => {
  // At 420 px "No notes to copy yet" beside Cancel, Writing notes... and Details pushed the row to
  // 493 px in a 404 px column. It must stay out of the row's flow.
  it('is absolutely placed, so the buttons neither overflow nor move when it shows', () => {
    const css = rendererSource('src/meeting/meeting.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const body = /\.meeting-copied \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const declared = new Map(cssDeclarations(`x{${body}}`).map((d) => [d.property, d.value]));
    expect(declared.get('position')).toBe('absolute');
  });
});
