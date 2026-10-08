import { describe, expect, it } from 'vitest';
import { aboutPanelOptions, fatalStartText } from './startupText';

describe('aboutPanelOptions', () => {
  it('names Roger, the version and the copyright, nothing else', () => {
    expect(aboutPanelOptions('0.3.1')).toEqual({
      applicationName: 'Roger',
      applicationVersion: '0.3.1',
      version: '0.3.1',
      copyright: '\u00a9 2026 Linkt',
    });
  });
});

describe('fatalStartText', () => {
  it('says what happened and the next step, then the detail', () => {
    const text = fatalStartText('ENOENT: no such file');
    expect(text.split('\n')[0]).toBe('Roger could not start. Quit it and open it again.');
    expect(text).toContain('send the text below to the Roger team');
    expect(text.endsWith('ENOENT: no such file')).toBe(true);
  });
});
