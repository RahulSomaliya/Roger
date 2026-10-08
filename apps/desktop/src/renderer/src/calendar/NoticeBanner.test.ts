import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { settingsState, plain } from './calendarTesting';
import { noticeBannerVisible, NoticeBannerView } from './NoticeBanner';

describe('noticeBannerVisible', () => {
  const ready = settingsState();
  const input = { meetingId: 'm1', recordingHere: true, settings: ready };

  it('shows while this meeting is recorded and the notice is on', () => {
    expect(noticeBannerVisible(input)).toBe(true);
  });

  it('does not show on a meeting that is not being recorded here', () => {
    expect(noticeBannerVisible({ ...input, recordingHere: false })).toBe(false);
  });

  it('does not show with the notice off', () => {
    expect(
      noticeBannerVisible({ ...input, settings: settingsState({ noticeEnabled: false }) }),
    ).toBe(false);
  });

  it('does not show before the settings are read, or when they could not be', () => {
    for (const status of ['loading', 'failed'] as const) {
      expect(noticeBannerVisible({ ...input, settings: settingsState({ status }) })).toBe(false);
    }
  });

  it('is done for a meeting once its notice was copied or dismissed, and not for the next one', () => {
    const settings = settingsState({ noticeDone: ['m1'] });
    expect(noticeBannerVisible({ ...input, settings })).toBe(false);
    expect(noticeBannerVisible({ ...input, meetingId: 'm2', settings })).toBe(true);
  });
});

describe('NoticeBannerView', () => {
  const render = (fields: { copied?: boolean; error?: string | null } = {}): string =>
    plain(
      renderToStaticMarkup(
        createElement(NoticeBannerView, {
          text: 'Hi all, I am taking notes with Roger.',
          copied: fields.copied ?? false,
          error: fields.error ?? null,
          onCopy: vi.fn(),
          onDismiss: vi.fn(),
        }),
      ),
    );

  it('is one line with Copy notice (secondary) and Dismiss (ghost), and no tinted box', () => {
    const html = render();
    expect(html).toContain('Tell the others on the call you are recording');
    expect(html).toMatch(/data-variant="secondary"[^>]*>Copy notice<\/button>/);
    expect(html).toMatch(/data-variant="ghost"[^>]*>Dismiss<\/button>/);
    expect(html).toContain('role="status"');
    // The old tinted box and its heading and paragraph are gone (docs/plans/redesign.md).
    expect(html).not.toMatch(/class="(?:[^"]* )?notice[" ]/);
    expect(html).not.toContain('calendar-notice-title');
  });

  it('keeps the notice text in the page for hover and focus, tied to Copy notice', () => {
    // The text shows in a popover over the page (calendarNotice.css), never in the flow: a line
    // that grew on hover would move the notes under the cursor.
    const html = render();
    expect(html).toContain('id="calendar-notice-text"');
    expect(html).toContain('Hi all, I am taking notes with Roger.');
    expect(html).toContain('aria-describedby="calendar-notice-text"');
  });

  it('says Copied on the button once copied, and stays until Dismiss', () => {
    const html = render({ copied: true });
    expect(html).toContain('Copied</button>');
    expect(html).not.toContain('Copy notice</button>');
    expect(html).toContain('Dismiss</button>');
  });

  it('says why a copy failed as a loud problem line, so nobody pastes an older clipboard into a call', () => {
    const html = render({ error: 'Roger could not copy the notice: Document is not focused' });
    expect(html).toContain('Roger could not copy the notice: Document is not focused');
    expect(html).toMatch(/class="problem"[^>]*role="alert"|role="alert"[^>]*class="problem"/);
  });
});
