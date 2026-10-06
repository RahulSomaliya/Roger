import { describe, expect, it } from 'vitest';
import { KEYTERM_LIMITS } from '../main/stt/keyterms';
import {
  isTermList,
  sameTerm,
  termLength,
  termProblem,
  VOCABULARY_LIMITS,
  vocabularyProblem,
} from './vocabulary';

/**
 * A file of the API, read as text. This folder is type-checked without Node's types too
 * (tsconfig.web.json), so `node:fs` cannot be imported; the test runs under Node, so it asks Node
 * for the module at run time, as renderer/src/theme/rendererSources.ts does.
 */
function apiSource(path: string): string {
  const { process } = globalThis as {
    process?: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, e: 'utf8'): string } };
  };
  if (!process) throw new Error('apiSource reads files and runs only under Node (Vitest)');
  const url = new URL(`../../../api/src/roger_api/${path}`, import.meta.url);
  return process.getBuiltinModule('node:fs').readFileSync(url, 'utf8');
}

/** `NAME = 123` at the start of a line of Python; fails loudly when it is gone or renamed. */
function pythonNumber(source: string, name: string): number {
  const value = new RegExp(`^${name} = (\\d+)$`, 'm').exec(source)?.[1];
  if (value === undefined) throw new Error(`no "${name} = <number>" line in the API source`);
  return Number(value);
}

const tab = String.fromCharCode(9);
const del = String.fromCharCode(0x7f);
const nextLine = String.fromCharCode(0x85);
const grinning = String.fromCodePoint(0x1f600);

/** `count` distinct terms of `length` characters each. */
function terms(count: number, length = 6): string[] {
  return Array.from({ length: count }, (_, index) =>
    `t${String(index).padStart(4, '0')}`.padEnd(length, 'x'),
  );
}

describe('the jargon list limits', () => {
  it('equal the API schema and the STT core cut, so the editor refuses what the API would', () => {
    const schema = apiSource('schemas/vocabulary.py');
    const model = apiSource('db/models_vocabulary.py');
    expect(VOCABULARY_LIMITS).toEqual({
      maxTerms: pythonNumber(schema, 'MAX_TERMS'),
      maxTermChars: pythonNumber(model, 'MAX_TERM_LENGTH'),
      maxTotalChars: pythonNumber(schema, 'MAX_TERMS_TOTAL_LENGTH'),
    });
    expect(VOCABULARY_LIMITS).toEqual(KEYTERM_LIMITS);
  });
});

describe('termLength', () => {
  it('counts code points as the API does (Python len), so an emoji counts once', () => {
    expect(termLength('Linkt')).toBe(5);
    expect(termLength(`${'a'.repeat(49)}${grinning}`)).toBe(50);
    expect(`${'a'.repeat(49)}${grinning}`.length).toBe(51);
  });
});

describe('termProblem', () => {
  it('takes a term of 1 to 50 characters after trimming', () => {
    expect(termProblem('Linkt')).toBeNull();
    expect(termProblem('  Linkt\n')).toBeNull();
    expect(termProblem(`  ${'x'.repeat(VOCABULARY_LIMITS.maxTermChars)}  `)).toBeNull();
    expect(termProblem(`${'a'.repeat(49)}${grinning}`)).toBeNull();
  });

  it('refuses a blank term and one over 50 characters, with its length', () => {
    expect(termProblem('')).toEqual({ kind: 'blank' });
    expect(termProblem('   ')).toEqual({ kind: 'blank' });
    expect(termProblem('x'.repeat(57))).toEqual({ kind: 'too-long', length: 57 });
  });

  it('refuses a control character inside a term (Unicode Cc), as the API does', () => {
    for (const term of [`Ro${tab}ger`, `Ro${del}ger`, `Ro${nextLine}ger`]) {
      expect(termProblem(term)).toEqual({ kind: 'control-character' });
    }
  });
});

describe('vocabularyProblem', () => {
  it('passes the largest lists the API takes', () => {
    expect(vocabularyProblem([])).toBeNull();
    expect(vocabularyProblem(terms(VOCABULARY_LIMITS.maxTerms))).toBeNull();
    // 16 terms of 50 characters: exactly 800.
    expect(vocabularyProblem(terms(16, 50))).toBeNull();
    // Measured after trimming, as the API measures.
    expect(vocabularyProblem(terms(16, 50).map((term) => `  ${term}  `))).toBeNull();
  });

  it('counts the terms as sent, before the API drops case repeats', () => {
    expect(vocabularyProblem(['Linkt', 'LINKT', 'linkt'])).toBeNull();
    expect(vocabularyProblem([...terms(100), 'T0000X'])).toBe(
      'the list has 101 terms; at most 100',
    );
  });

  it('names the term that breaks a limit by its index, as the API names body.terms[i]', () => {
    expect(vocabularyProblem(['Roger', '  ', 'Linkt'])).toBe('terms[1] is blank');
    expect(vocabularyProblem(['Roger', 'Linkt', 'x'.repeat(51)])).toBe(
      'terms[2] is 51 characters long; at most 50',
    );
    expect(vocabularyProblem(['Roger', `Lin${tab}kt`])).toBe('terms[1] has a control character');
    expect(vocabularyProblem([...terms(16, 50), 'y'])).toBe(
      'the terms add up to 801 characters; at most 800 in all',
    );
  });

  it('never repeats a term in its answer: main logs it, and terms name clients', () => {
    const secret = `Acme Secret Client ${'x'.repeat(40)}`;
    expect(vocabularyProblem([secret])).not.toContain('Acme');
  });
});

describe('sameTerm', () => {
  it('is the API rule for one term: trimmed, ignoring case', () => {
    expect(sameTerm('Linkt', ' LINKT ')).toBe(true);
    expect(sameTerm('Linkt', 'Linked')).toBe(false);
  });
});

describe('isTermList', () => {
  it('is true only for an array of strings', () => {
    expect(isTermList([])).toBe(true);
    expect(isTermList(['Linkt', 'Roger'])).toBe(true);
    for (const value of [undefined, null, 'Linkt', { terms: [] }, ['Linkt', 3], [null]]) {
      expect(isTermList(value)).toBe(false);
    }
  });
});
