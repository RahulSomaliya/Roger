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

  it('shows the notice the Copy button copies, with Copy notice and Dismiss', () => {
    const html = render();
    expect(html).toContain('Hi all, I am taking notes with Roger.');
    expect(html).toContain('Copy notice</button>');
    expect(html).toContain('Dismiss</button>');
  });

  it('confirms the copy in place of the buttons', () => {
    const html = render({ copied: true });
    expect(html).toContain('Notice copied. Paste it into the call’s chat.');
    expect(html).not.toContain('<button');
  });

  it('says why a copy failed, so nobody pastes an older clipboard into a call', () => {
    expect(render({ error: 'Roger could not copy the notice: Document is not focused' })).toContain(
      'Roger could not copy the notice: Document is not focused',
    );
  });
});
