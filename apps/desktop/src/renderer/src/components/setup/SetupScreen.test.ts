import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SetupScreenState } from './setupModel';
import { SetupView } from './SetupScreen';
import { firstRunMac, readyMac, refusedMac } from './setupTesting';

function state(change: Partial<SetupScreenState> = {}): SetupScreenState {
  return { status: readyMac(), loadError: null, running: null, failure: null, ...change };
}

interface Shown {
  showPassing?: boolean;
  onDone?: () => void;
}

/**
 * The view's markup, without the empty comments React's server output puts between adjacent text
 * pieces (apps/desktop/CLAUDE.md), so text reads as the page shows it.
 */
function render(screen: SetupScreenState, shown: Shown = {}): string {
  return renderToString(
    createElement(SetupView, {
      state: screen,
      showPassing: shown.showPassing ?? false,
      onTogglePassing: vi.fn(),
      onAction: vi.fn(),
      onRetry: vi.fn(),
      onDone: shown.onDone ?? vi.fn(),
    }),
  ).replaceAll('<!-- -->', '');
}

/** One row's markup, by its id. */
function rowOf(html: string, id: string): string {
  const match = new RegExp(`<li[^>]*data-row="${id}"[\\s\\S]*?</li>`).exec(html);
  if (match === null) throw new Error(`no ${id} row`);
  return match[0];
}

const hasRow = (html: string, id: string): boolean => html.includes(`data-row="${id}"`);

const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1] ?? '');

const primaries = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*data-variant="primary"[^>]*>([^<]*)<\/button>/g)].map(
    (match) => match[1] ?? '',
  );

describe('the setup screen', () => {
  it('says it is checking before main answers, with nothing to press', () => {
    const html = render(state({ status: null }));
    expect(html).toMatch(/role="status"[^>]*>Checking this Mac…</);
    expect(buttons(html)).toEqual([]);
  });

  it('shows why the first read failed as a problem line, with Try again', () => {
    const html = render(state({ status: null, loadError: 'codesign gave no answer' }));
    expect(html).toMatch(/class="problem"[^>]*role="alert"|role="alert"[^>]*class="problem"/);
    expect(html).toContain('Roger could not check this Mac: codesign gave no answer');
    expect(buttons(html)).toEqual(['Try again']);
    expect(primaries(html)).toEqual([]);
  });

  it('says what Roger records in one line', () => {
    const html = render(state());
    expect(html).toContain('Roger records your microphone and the call audio your Mac plays.');
    expect(html).not.toContain('Each check below');
  });

  it('folds the passing checks and the untested notification into one line', () => {
    const html = render(state());
    expect(html).toContain('5 checks pass, 1 not tested');
    expect(buttons(html)).toContain('Show');
    for (const id of [
      'microphone',
      'callAudio',
      'signing',
      'server',
      'speechToText',
      'notifications',
    ]) {
      expect(hasRow(html, id)).toBe(false);
    }
  });

  it('lists the untested notification, with its test, once Show is pressed', () => {
    const html = render(state(), { showPassing: true });
    expect(rowOf(html, 'notifications')).toContain('Not tested');
    expect(buttons(rowOf(html, 'notifications'))).toEqual(['Send a test notification']);
  });

  it('shows every passing row with its state once Show is pressed', () => {
    const html = render(state(), { showPassing: true });
    expect(buttons(html)).toContain('Hide');
    for (const [id, label] of [
      ['microphone', 'Allowed'],
      ['callAudio', 'Heard'],
      ['signing', 'Signed on this Mac'],
      ['server', 'Reachable'],
      ['speechToText', 'Ready'],
    ]) {
      expect(rowOf(html, id ?? '')).toContain(label);
    }
    expect(rowOf(html, 'microphone')).toContain('data-tone="ok"');
  });

  it('claims no pass when nothing passes yet, only what is not tested', () => {
    const html = render(state({ status: refusedMac() }));
    expect(html).not.toMatch(/check(s)? pass/);
    expect(html).toContain('1 check not tested');
  });

  it("puts main's message and the row's fixes on a refused Mac, only the first fix as the main button", () => {
    const html = render(state({ status: refusedMac() }));
    const microphone = rowOf(html, 'microphone');
    expect(microphone).toContain('data-tone="problem"');
    expect(microphone).toContain(
      'Turn on Roger under System Settings &gt; Privacy &amp; Security &gt; Microphone, then relaunch Roger.',
    );
    expect(buttons(microphone)).toEqual(['Open Microphone settings', 'Relaunch Roger']);
    expect(microphone).toMatch(
      /<button[^>]*class="btn"[^>]*data-variant="primary"[^>]*>Open Microphone settings/,
    );
    // Four checks fail and each has fixes, yet the screen has one primary.
    expect(primaries(html)).toEqual(['Open Microphone settings']);
    expect(rowOf(html, 'server')).toContain(
      'Roger can&#x27;t reach its server at http://127.0.0.1:8000.',
    );
  });

  it('marks each state by words with an icon, never a tinted pill', () => {
    const html = render(state({ status: refusedMac() }), { showPassing: true });
    expect(rowOf(html, 'microphone')).toMatch(/class="setup-state"[^>]*><svg/);
    expect(html).not.toContain('setup-row-description');
  });

  it('offers Allow on a first run as the main button', () => {
    const html = render(state({ status: firstRunMac() }));
    expect(buttons(rowOf(html, 'microphone'))).toEqual(['Allow microphone']);
    expect(primaries(html)).toEqual(['Allow microphone']);
  });

  it('shows Done only once nothing fails, and then as the one main button', () => {
    const ready = render(state());
    expect(buttons(ready)).toContain('Done');
    expect(primaries(ready)).toEqual(['Done']);
    for (const status of [firstRunMac(), refusedMac()]) {
      expect(buttons(render(state({ status })))).not.toContain('Done');
    }
  });

  // D6: the page has the header's Home button like every page, so the foot holds no Later.
  // A person who cannot pass a check yet leaves by the header; the foot is Done or nothing.
  it('has no Later: the header is the way out while a check needs you', () => {
    for (const status of [firstRunMac(), refusedMac()]) {
      const html = render(state({ status }));
      expect(buttons(html)).not.toContain('Later');
      expect(buttons(html)).not.toContain('Done');
      expect(primaries(html)).toHaveLength(1);
    }
    expect(buttons(render(state()))).not.toContain('Later');
  });

  it('keeps Done off a ready Mac whose check could not run, and while the status is unknown', () => {
    expect(buttons(render(state({ status: null })))).not.toContain('Done');
    const helperMissing = {
      ...readyMac(),
      systemAudio: {
        state: 'unknown' as const,
        message: "Roger's call audio helper is missing from this copy of Roger.",
        relaunchNeeded: false,
      },
    };
    expect(buttons(render(state({ status: helperMissing })))).not.toContain('Done');
  });

  it('says what the running action is doing, keeps its button at full colour and holds the rest', () => {
    const html = render(
      state({
        status: refusedMac(),
        running: { row: 'callAudio', action: 'test-system-audio' },
      }),
    );
    expect(rowOf(html, 'callAudio')).toMatch(
      /role="status"[^>]*>Playing a test sound and listening for it…</,
    );
    expect(rowOf(html, 'callAudio')).toContain('aria-busy="true"');
    const running = /<button[^>]*data-action="test-system-audio"[^>]*>/.exec(
      rowOf(html, 'callAudio'),
    );
    // Busy is not disabled (docs/design.md): the button keeps its colour and takes no clicks.
    expect(running?.[0]).toContain('aria-disabled="true"');
    expect(running?.[0]).not.toMatch(/\sdisabled/);
    const others = [...html.matchAll(/<button[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => !tag.includes('data-action="test-system-audio"'));
    expect(others.length).toBeGreaterThan(0);
    for (const tag of others) {
      if (tag.includes('data-variant="ghost"')) expect(tag).not.toMatch(/\sdisabled/);
      else expect(tag).toMatch(/\sdisabled/);
    }
  });

  it("shows a failed action's reason as a problem line on its own row only", () => {
    const html = render(
      state({
        failure: { row: 'notifications', message: 'Roger could not post the notification.' },
      }),
      { showPassing: true },
    );
    expect(rowOf(html, 'notifications')).toMatch(
      /class="problem"[^>]*role="alert"[\s\S]*Roger could not post the notification\./,
    );
    expect(rowOf(html, 'microphone')).not.toContain('role="alert"');
  });

  it('keeps the last status when a later read fails, and says so', () => {
    const html = render(state({ loadError: 'the window lost main' }), { showPassing: true });
    expect(html).toContain('Roger could not check again: the window lost main');
    expect(rowOf(html, 'microphone')).toContain('Allowed');
  });

  it('says in one plain sentence where the audio stays', () => {
    const html = render(state());
    expect(html).toContain('never uploaded');
    expect(html).not.toContain('audioRetentionDays');
  });
});
