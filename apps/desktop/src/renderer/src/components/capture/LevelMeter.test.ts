import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { describeLevel, LEVEL_FLOOR_DB, LevelMeter, levelPercent } from './LevelMeter';

const meter = (levelDb: number | null, signal: Parameters<typeof describeLevel>[1]): string =>
  renderToStaticMarkup(createElement(LevelMeter, { label: 'Mic (me)', levelDb, signal }));

describe('levelPercent', () => {
  it('fills from the floor to full scale, and never past either end', () => {
    expect(levelPercent(0)).toBe(100);
    expect(levelPercent(LEVEL_FLOOR_DB / 2)).toBe(50);
    expect(levelPercent(LEVEL_FLOOR_DB)).toBe(0);
    expect(levelPercent(-90)).toBe(0);
    expect(levelPercent(3)).toBe(100);
  });

  it('is empty with no level: digital silence, or no chunk in the last second', () => {
    expect(levelPercent(null)).toBe(0);
  });
});

describe('describeLevel', () => {
  it('gives a measured level in whole dB', () => {
    expect(describeLevel(-18.4, 'signal')).toBe('-18 dB');
    // Full scale rounds to 0, never "-0 dB".
    expect(describeLevel(-0.2, 'signal')).toBe('0 dB');
  });

  it('tells a pause from a dead signal and from a source that sends nothing', () => {
    expect(describeLevel(null, 'quiet')).toBe('silent');
    expect(describeLevel(null, 'dead')).toBe('no signal');
    // A flat level under the floor is dead too (the flat-level rule), however loud it measures.
    expect(describeLevel(-72, 'dead')).toBe('no signal');
    expect(describeLevel(null, 'unknown')).toBe('no audio yet');
    // It carried sound, and no chunk came in the last second: the source stopped sending.
    expect(describeLevel(null, 'signal')).toBe('no audio');
  });
});

describe('LevelMeter', () => {
  it('is a meter people and screen readers can read, filled to the level', () => {
    const html = meter(-18.4, 'signal');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-label="Mic (me) level"');
    expect(html).toContain(`aria-valuemin="${LEVEL_FLOOR_DB}"`);
    expect(html).toContain('aria-valuemax="0"');
    expect(html).toContain('aria-valuenow="-18"');
    expect(html).toContain('aria-valuetext="-18 dB"');
    expect(html).toContain('data-signal="signal"');
    expect(html).toContain(`style="width:${levelPercent(-18.4)}%"`);
    expect(html).toContain('>-18 dB<');
  });

  it('keeps its value inside its range when there is no level', () => {
    const html = meter(null, 'dead');
    expect(html).toContain(`aria-valuenow="${LEVEL_FLOOR_DB}"`);
    expect(html).toContain('aria-valuetext="no signal"');
    expect(html).toContain('data-signal="dead"');
    expect(html).toContain('style="width:0%"');
  });
});
