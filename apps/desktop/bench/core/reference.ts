import type { SpeakerLabel } from '../../src/shared/transcript';

/**
 * The hand-fixed reference of a bench item, `reference.txt`: one line per turn,
 * `[mm:ss] Me: text` or `[mm:ss] Them: text`, the time counted from the item's start. Me is
 * scored against the mic stream, Them against the system stream. `bench draft` (M3-T12) writes
 * `reference.draft.txt` with `formatReferenceLine`; `bench check` lists `parseReference`'s
 * problems; scoring takes only a clean file (`requireCleanReference`).
 *
 * Problem messages name the line and never repeat its text: the reference is a transcript of real
 * people, and these messages reach the terminal and logs.
 */

export interface ReferenceLine {
  /** 1-based, as an editor shows it. */
  lineNumber: number;
  atMs: number;
  speaker: SpeakerLabel;
  text: string;
}

export type ReferenceProblemKind = 'format' | 'speaker' | 'brace' | 'empty';

export interface ReferenceProblem {
  lineNumber: number;
  kind: ReferenceProblemKind;
  message: string;
}

export interface ParsedReference {
  /** The lines that parsed cleanly, in file order. */
  lines: ReferenceLine[];
  problems: ReferenceProblem[];
}

/** A reference that cannot be scored. The message lists every problem under the file's label. */
export class ReferenceFileError extends Error {
  constructor(
    label: string,
    readonly problems: readonly ReferenceProblem[],
  ) {
    const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
    super(`${label}: ${count}\n${problems.map((problem) => `  ${problem.message}`).join('\n')}`);
    this.name = 'ReferenceFileError';
  }
}

const LINE = /^\[(\d{1,3}):([0-5]\d)\]\s*([^:]+?)\s*:\s*(.*)$/;
const LABELS: Readonly<Record<SpeakerLabel, string>> = { me: 'Me', them: 'Them' };

/** Every clean line and every problem, by line number. Blank lines are skipped. */
export function parseReference(text: string): ParsedReference {
  const lines: ReferenceLine[] = [];
  const problems: ReferenceProblem[] = [];
  // Split on CRLF too: a file saved on another system would otherwise keep a "\r" on every text.
  text
    .replace(/^\ufeff/, '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const lineNumber = index + 1;
      const trimmed = raw.trim();
      if (trimmed === '') return;
      const problem = (kind: ReferenceProblemKind, message: string): void => {
        problems.push({ lineNumber, kind, message });
      };

      const match = LINE.exec(trimmed);
      if (match === null) {
        problem(
          'format',
          `line ${lineNumber}: expected "[mm:ss] Me: text" or "[mm:ss] Them: text"`,
        );
        return;
      }
      const [, minutes = '', seconds = '', label = '', body = ''] = match;
      const speaker = speakerOf(label);
      if (speaker === null) {
        problem('speaker', `line ${lineNumber}: unknown speaker; use Me or Them`);
        return;
      }
      if (body.trim() === '') {
        problem('empty', `line ${lineNumber}: no text after the speaker; delete the line`);
        return;
      }
      const brace = raw.search(/[{}]/);
      if (brace !== -1) {
        problem(
          'brace',
          `line ${lineNumber}, column ${brace + 1}: unresolved brace from the draft; keep the ` +
            'right words and remove the braces',
        );
        return;
      }
      lines.push({
        lineNumber,
        atMs: (Number(minutes) * 60 + Number(seconds)) * 1000,
        speaker,
        text: body.trim(),
      });
    });
  return { lines, problems };
}

/** The lines of a reference that has no problems; throws ReferenceFileError otherwise. */
export function requireCleanReference(text: string, label: string): ReferenceLine[] {
  const { lines, problems } = parseReference(text);
  if (problems.length > 0) throw new ReferenceFileError(label, problems);
  return lines;
}

/**
 * One reference line, `[mm:ss] Me: text`, the time cut to whole seconds. Whitespace in the text,
 * newlines included, becomes single spaces, so one line is always one line of the file.
 */
export function formatReferenceLine(
  line: Pick<ReferenceLine, 'atMs' | 'speaker' | 'text'>,
): string {
  if (!Number.isFinite(line.atMs) || line.atMs < 0) {
    throw new RangeError(
      `reference line time must be a finite number of ms at or after 0, got ${line.atMs}`,
    );
  }
  const totalSeconds = Math.floor(line.atMs / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const text = line.text.replace(/\s+/g, ' ').trim();
  return `[${minutes}:${seconds}] ${LABELS[line.speaker]}: ${text}`;
}

/**
 * One speaker's line texts, in file order. Kept apart, never joined: scoring normalises each line on
 * its own (`normaliseEach`), so a number never reads across two turns.
 */
export function speakerTexts(lines: readonly ReferenceLine[], speaker: SpeakerLabel): string[] {
  return lines.filter((line) => line.speaker === speaker).map((line) => line.text);
}

function speakerOf(label: string): SpeakerLabel | null {
  const lower = label.toLowerCase();
  return lower === 'me' || lower === 'them' ? lower : null;
}
