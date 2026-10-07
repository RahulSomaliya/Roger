import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RerunStatus } from '../../../../shared/capture';
import { describeRerun, RerunProgress } from './RerunProgress';

const RUNNING: RerunStatus = { meetingId: 'm', state: 'running', gaps: 5, finished: 2 };

describe('describeRerun', () => {
  it('says how many gaps are done, never more than are taken on', () => {
    expect(describeRerun(RUNNING)).toBe('Re-running 5 gaps from the audio backup: 2 of 5 done.');
    expect(describeRerun({ ...RUNNING, gaps: 1, finished: 0 })).toBe(
      'Re-running 1 gap from the audio backup: 0 of 1 done.',
    );
  });

  it('says it waits for a speech-to-text slot, which the open budget limits per minute', () => {
    expect(describeRerun({ ...RUNNING, state: 'waiting' })).toBe(
      'Re-run waiting for a free speech-to-text slot: 2 of 5 gaps done.',
    );
  });
});

describe('RerunProgress', () => {
  const render = (rerun: RerunStatus): string =>
    renderToStaticMarkup(createElement(RerunProgress, { rerun }));

  it('draws a native progress bar with its own label, read out politely', () => {
    const html = render(RUNNING);
    expect(html).toContain('role="status"');
    expect(html).toContain('<progress');
    expect(html).toContain('value="2"');
    expect(html).toContain('max="5"');
    expect(html).toContain('aria-label="Gaps re-run"');
    expect(html).toContain('data-state="running"');
  });

  it('keeps a bar with no gaps drawable: max is never 0', () => {
    expect(render({ ...RUNNING, gaps: 0, finished: 0 })).toContain('max="1"');
  });
});
