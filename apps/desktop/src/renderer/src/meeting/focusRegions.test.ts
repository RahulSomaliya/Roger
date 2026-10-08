import { describe, expect, it } from 'vitest';
import { cssDeclarations } from '../theme/cssDeclarations';
import { rendererSource } from '../theme/rendererSources';

/**
 * R13 (redesign sweep; Rahul, 2026-10-08, on the orange box around the transcript: "that weird
 * highlight ring, lets remove it"). The three large reading and writing regions never draw a box
 * when focused (docs/design.md, Focus): the transcript log and the chat log show a 2 px --ring
 * line along their left edge for keyboard focus, and My notes shows its caret and nothing else.
 *
 * A click, the jump to live (LiveTranscript.tsx `jump`) and a citation (transcriptNavigator.ts)
 * all reach the log through `focus()`, so any rule that styles the log's focus is what a person
 * sees; this test reads those rules. The browser check (the QA run) clicks, jumps and cites, and
 * asserts the computed outline there.
 */

interface Rule {
  selector: string;
  declarations: Map<string, string>;
}

/** Every flat rule of a sheet whose selector mentions `region` and a focus state. */
function focusRules(file: string, region: string): Rule[] {
  const css = rendererSource(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  for (const [, selector = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.includes(region) || !selector.includes(':focus')) continue;
    rules.push({
      selector: selector.trim(),
      declarations: new Map(cssDeclarations(`x{${body}}`).map((d) => [d.property, d.value])),
    });
  }
  return rules;
}

/** Whatever a focus rule sets, it must not be a box. */
function boxProperties(rule: Rule): string[] {
  return [...rule.declarations].flatMap(([property, value]) => {
    const isBox =
      (property === 'outline' && value !== 'none') ||
      property.startsWith('outline-') ||
      property.startsWith('border') ||
      (property === 'box-shadow' && !/^inset 2px 0 0 var\(--ring\)$/.test(value));
    return isBox ? [`${property}: ${value}`] : [];
  });
}

describe('the large regions never draw a focus box (R13)', () => {
  for (const [file, region] of [
    ['src/transcript/transcript.css', '.live-transcript-lines'],
    ['src/chat/chat.css', '.meeting-chat-log'],
  ] as const) {
    it(`${region}: no outline or border, a 2 px --ring line at the left edge for the keyboard`, () => {
      const rules = focusRules(file, region);
      for (const rule of rules) expect(boxProperties(rule), rule.selector).toEqual([]);
      const keyboard = rules.find((rule) => rule.selector.endsWith(':focus-visible'));
      expect(keyboard?.declarations.get('box-shadow')).toBe('inset 2px 0 0 var(--ring)');
      // The global `:focus-visible` outline (styles.css) must lose to this region's `none`.
      const mouse = rules.find((rule) => rule.selector.endsWith(':focus'));
      expect(mouse?.declarations.get('outline')).toBe('none');
    });
  }

  it('My notes: focus changes nothing but the caret', () => {
    expect(focusRules('src/notes/notes.css', '.note-editor-content')).toEqual([]);
  });
});
