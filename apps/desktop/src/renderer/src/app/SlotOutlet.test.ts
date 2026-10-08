import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SlotBoundary } from './SlotOutlet';

describe('SlotBoundary', () => {
  it('shows its entry until it fails', () => {
    const boundary = new SlotBoundary({ slot: 'settings', id: 'm3-jargon', children: 'entry' });
    expect(boundary.render()).toBe('entry');
  });

  it('says it in plain words with a way out, and keeps the ids for the log only', () => {
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    const boundary = new SlotBoundary({ slot: 'settings', id: 'm3-jargon', children: 'entry' });
    boundary.state = { failed: true };
    const html = renderToString(createElement('div', null, boundary.render()));
    expect(html).toContain('Roger could not show this part of the page.');
    expect(html).toContain('>Try again</button>');
    expect(html).not.toContain('settings');
    expect(html).not.toContain('m3-jargon');
    boundary.componentDidCatch(new Error('boom'));
    expect(report).toHaveBeenCalledOnce();
    expect(String(report.mock.calls[0]?.[0])).toContain('settings entry m3-jargon');
    vi.unstubAllGlobals();
  });
});
