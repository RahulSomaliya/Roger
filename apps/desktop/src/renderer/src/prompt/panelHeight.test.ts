import { describe, expect, it } from 'vitest';
import { panelHeightTitle } from './panelHeight';

describe('panelHeightTitle', () => {
  // main/prompt/PromptWindow.ts parses exactly this text (parsePanelHeight): the two tests spell
  // it out separately, so changing one side fails the other's.
  it('is the text PromptWindow reads the height from', () => {
    expect(panelHeightTitle(140)).toBe('roger-prompt-height:140');
    expect(panelHeightTitle(0)).toBe('roger-prompt-height:0');
  });

  it('rounds a fractional height up, so the last line is never clipped', () => {
    expect(panelHeightTitle(140.2)).toBe('roger-prompt-height:141');
  });
});
