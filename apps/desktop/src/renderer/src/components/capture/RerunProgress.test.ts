import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RerunStatus } from '../../../../shared/capture';
import { describeRerun, RerunProgress } from './RerunProgress';

const RUNNING: RerunStatus = { meetingId: 'm', state: 'running', gaps: 5, finished: 2 };

describe('describeRerun', () => {
  it('says how many parts are done, in the naming list’s words', () => {
    expect(describeRerun(RUNNING)).toBe('Transcribing again: 2 of 5 parts done.');
    expect(describeRerun({ ...RUNNING, gaps: 1, finished: 0 })).toBe(
      'Transcribing again: 0 of 1 part done.',
    );
  });

  it('says it waits for a speech-to-text slot, which the open budget limits per minute', () => {
    expect(describeRerun({ ...RUNNING, state: 'waiting' })).toBe(
      'Waiting for a free speech-to-text slot to transcribe again: 2 of 5 parts done.',
    );
  });
});

describe('RerunProgress', () => {
  it('is a polite status line with no bar: the count says it', () => {
    const html = renderToStaticMarkup(createElement(RerunProgress, { rerun: RUNNING }));
    expect(html).toContain('role="status"');
    expect(html).toContain('Transcribing again: 2 of 5 parts done.');
    expect(html).not.toContain('<progress');
  });
});
