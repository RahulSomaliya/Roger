import { describe, expect, it } from 'vitest';
import type { TranscriptSegmentChange } from '../../../../shared/capture';
import { applyEchoChange, echoLinesIn, type EchoLineMap, NO_ECHO_LINES } from './echoChanges';

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

const change = (
  segmentId: string,
  kind: TranscriptSegmentChange['change'],
  text = 'so we ship on friday',
  meetingId = MEETING,
): TranscriptSegmentChange => ({
  meetingId,
  segmentId,
  source: 'mic',
  change: kind,
  reason: 'echo',
  echoOf: kind === 'unhidden' ? null : 'call-line',
  text,
});

const apply = (lines: EchoLineMap, ...changes: TranscriptSegmentChange[]): EchoLineMap =>
  changes.reduce((now, next) => applyEchoChange(now, MEETING, next), lines);

describe('applyEchoChange', () => {
  it('keeps a hidden line with the text it now reads, and a trimmed one apart from it', () => {
    const lines = apply(NO_ECHO_LINES, change('a', 'hidden'), change('b', 'trimmed', 'on friday'));
    expect(echoLinesIn(lines)).toEqual([
      { segmentId: 'a', source: 'mic', kind: 'hidden', text: 'so we ship on friday' },
      { segmentId: 'b', source: 'mic', kind: 'trimmed', text: 'on friday' },
    ]);
  });

  it('drops a line once it is unhidden: it uploads and reads as any other line', () => {
    const lines = apply(NO_ECHO_LINES, change('a', 'hidden'), change('a', 'unhidden'));
    expect(echoLinesIn(lines)).toEqual([]);
  });

  it('keeps a hidden line hidden when a trim follows: its Unhide still works in main', () => {
    // Main's store unhides a line only while it is suppressed, and a trim never sets that, so a
    // line that was hidden and then trimmed keeps its Unhide; one that was only trimmed never
    // gets one (TranscriptStore.unhideSegment).
    const lines = apply(NO_ECHO_LINES, change('a', 'hidden'), change('a', 'trimmed', 'friday'));
    expect(echoLinesIn(lines)).toEqual([
      { segmentId: 'a', source: 'mic', kind: 'hidden', text: 'friday' },
    ]);
  });

  it('ignores another meeting’s change, and returns the same map when nothing changed', () => {
    const lines = apply(NO_ECHO_LINES, change('a', 'hidden'));
    expect(applyEchoChange(lines, MEETING, change('x', 'hidden', 'no', 'other'))).toBe(lines);
    expect(applyEchoChange(lines, MEETING, change('never-seen', 'unhidden'))).toBe(lines);
  });

  it('never mutates the map it was given', () => {
    const before = apply(NO_ECHO_LINES, change('a', 'hidden'));
    apply(before, change('a', 'unhidden'));
    expect(echoLinesIn(before)).toHaveLength(1);
  });
});
