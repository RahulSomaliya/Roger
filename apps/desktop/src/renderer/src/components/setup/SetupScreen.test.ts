import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SetupScreenState } from './setupModel';
import { SetupView } from './SetupScreen';
import { firstRunMac, readyMac, refusedMac } from './setupTesting';

function state(change: Partial<SetupScreenState> = {}): SetupScreenState {
  return { status: readyMac(), loadError: null, running: null, failure: null, ...change };
}

/**
 * The view's markup, without the empty comments React's server output puts between adjacent text
 * pieces (apps/desktop/CLAUDE.md), so text reads as the page shows it.
 */
function render(screen: SetupScreenState): string {
  return renderToString(
    createElement(SetupView, { state: screen, onAction: vi.fn(), onRetry: vi.fn() }),
  ).replaceAll('<!-- -->', '');
}

/** One row's markup, by its id. */
function rowOf(html: string, id: string): string {
  const match = new RegExp(`<li[^>]*data-row="${id}"[\\s\\S]*?</li>`).exec(html);
  if (match === null) throw new Error(`no ${id} row`);
  return match[0];
}

const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1] ?? '');

describe('the setup screen', () => {
  it('says it is checking before main answers, with nothing to press', () => {
    const html = render(state({ status: null }));
    expect(html).toMatch(/role="status"[^>]*>Checking this Mac…</);
    expect(buttons(html)).toEqual([]);
  });

  it('shows why the first read failed, with Try again', () => {
    const html = render(state({ status: null, loadError: 'codesign gave no answer' }));
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain('Roger could not check this Mac: codesign gave no answer');
    expect(buttons(html)).toEqual(['Try again']);
  });

  it('shows every row with its state, under a summary', () => {
    const html = render(state());
    expect(html).toContain('Roger has what it needs on this Mac.');
    for (const [id, label] of [
      ['microphone', 'Allowed'],
      ['callAudio', 'Heard'],
      ['notifications', 'Not tested'],
      ['signing', 'Signed on this Mac'],
      ['server', 'Reachable'],
      ['speechToText', 'Ready'],
    ]) {
      expect(rowOf(html, id ?? '')).toContain(label);
    }
    expect(rowOf(html, 'microphone')).toContain('data-tone="ok"');
  });

  it("puts main's message and the row's fixes on a refused Mac, the first fix as the main button", () => {
    const html = render(state({ status: refusedMac() }));
    expect(html).toContain('4 checks need you.');
    const microphone = rowOf(html, 'microphone');
    expect(microphone).toContain('data-tone="problem"');
    expect(microphone).toContain(
      'Turn on Roger under System Settings &gt; Privacy &amp; Security &gt; Microphone, then relaunch Roger.',
    );
    expect(buttons(microphone)).toEqual(['Open Microphone settings', 'Relaunch Roger']);
    expect(microphone).toMatch(
      /<button[^>]*class="btn"[^>]*data-variant="primary"[^>]*>Open Microphone settings/,
    );
    expect(rowOf(html, 'server')).toContain(
      'Roger can&#x27;t reach its server at http://127.0.0.1:8000.',
    );
  });

  it('offers Allow on a first run', () => {
    expect(buttons(rowOf(render(state({ status: firstRunMac() })), 'microphone'))).toEqual([
      'Allow microphone',
    ]);
  });

  it('says what the running action is doing, and holds every button until it ends', () => {
    const html = render(state({ running: { row: 'callAudio', action: 'test-system-audio' } }));
    expect(rowOf(html, 'callAudio')).toMatch(
      /role="status"[^>]*>Playing a test sound and listening for it…</,
    );
    expect(rowOf(html, 'callAudio')).toContain('aria-busy="true"');
    const tags = [...html.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toContain('disabled');
  });

  it("shows a failed action's reason on its own row only", () => {
    const html = render(
      state({
        failure: { row: 'notifications', message: 'Roger could not post the notification.' },
      }),
    );
    expect(rowOf(html, 'notifications')).toMatch(
      /role="alert"[^>]*>Roger could not post the notification\.</,
    );
    expect(rowOf(html, 'microphone')).not.toContain('role="alert"');
  });

  it('keeps the last status when a later read fails, and says so', () => {
    const html = render(state({ loadError: 'the window lost main' }));
    expect(html).toContain('Roger could not check again: the window lost main');
    expect(rowOf(html, 'microphone')).toContain('Allowed');
  });

  it('says where the audio backup stays', () => {
    expect(render(state())).toContain('It is never uploaded.');
  });
});
