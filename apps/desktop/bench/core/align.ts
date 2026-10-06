/**
 * Word-by-word alignment with the fewest edits (Levenshtein over words). WER counts its steps
 * (`wer.ts`); `bench draft` (M3-T12) aligns two vendors' runs with it and puts every step that is
 * not a match in braces.
 */

export type AlignStep =
  | { op: 'match' | 'substitute'; reference: number; hypothesis: number }
  | { op: 'delete'; reference: number; hypothesis: null }
  | { op: 'insert'; reference: null; hypothesis: number };

/**
 * Most cells (reference words times hypothesis words) one alignment may take: one byte each, so
 * about 50 MB, or roughly 7,000 words a side. A bench item is 2 to 3 minutes (about 450 words a
 * stream), so only a wrong input gets near it, and it is refused instead of exhausting memory.
 */
export const MAX_ALIGN_CELLS = 50_000_000;

const MATCH = 0;
const SUBSTITUTE = 1;
const DELETE = 2;
const INSERT = 3;

/**
 * The steps that turn `reference` into `hypothesis`, in order; every word of each side appears in
 * exactly one step. On a tie a substitution wins over a deletion plus an insertion, then a
 * deletion over an insertion, so the result is the same on every run.
 */
export function align<T>(
  reference: readonly T[],
  hypothesis: readonly T[],
  same: (a: T, b: T) => boolean = (a, b) => a === b,
): AlignStep[] {
  const columns = hypothesis.length + 1;
  const cells = (reference.length + 1) * columns;
  if (cells > MAX_ALIGN_CELLS) {
    throw new RangeError(
      `cannot align ${reference.length} reference words with ${hypothesis.length} hypothesis ` +
        `words: over ${MAX_ALIGN_CELLS} cells. Bench items are 2 to 3 minutes; cut a shorter item.`,
    );
  }

  // The best move into each cell. Only two rows of costs are kept; the moves alone rebuild the path.
  const moves = new Uint8Array(cells);
  let previous = new Uint32Array(columns);
  let current = new Uint32Array(columns);
  for (let column = 0; column < columns; column += 1) {
    previous[column] = column;
    moves[column] = INSERT;
  }
  reference.forEach((referenceWord, row) => {
    const base = (row + 1) * columns;
    current[0] = row + 1;
    moves[base] = DELETE;
    hypothesis.forEach((hypothesisWord, column) => {
      const equal = same(referenceWord, hypothesisWord);
      const diagonal = (previous[column] ?? 0) + (equal ? 0 : 1);
      const up = (previous[column + 1] ?? 0) + 1;
      const left = (current[column] ?? 0) + 1;
      if (diagonal <= up && diagonal <= left) {
        current[column + 1] = diagonal;
        moves[base + column + 1] = equal ? MATCH : SUBSTITUTE;
      } else if (up <= left) {
        current[column + 1] = up;
        moves[base + column + 1] = DELETE;
      } else {
        current[column + 1] = left;
        moves[base + column + 1] = INSERT;
      }
    });
    [previous, current] = [current, previous];
  });

  const steps: AlignStep[] = [];
  let row = reference.length;
  let column = hypothesis.length;
  while (row > 0 || column > 0) {
    const move = moves[row * columns + column];
    if (move === MATCH || move === SUBSTITUTE) {
      row -= 1;
      column -= 1;
      steps.push({
        op: move === MATCH ? 'match' : 'substitute',
        reference: row,
        hypothesis: column,
      });
    } else if (move === DELETE) {
      row -= 1;
      steps.push({ op: 'delete', reference: row, hypothesis: null });
    } else {
      column -= 1;
      steps.push({ op: 'insert', reference: null, hypothesis: column });
    }
  }
  return steps.reverse();
}
