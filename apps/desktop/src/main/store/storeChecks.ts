import { isAbsolute } from 'node:path';
import type { SegmentTrim } from './TranscriptStore';

/**
 * Checks both stores run before a write or a list, so the in-memory store refuses what SQLite
 * refuses and the tests of the services around the store see the same errors.
 */

/**
 * A list's limit is a whole number from 1. SQLite reads a negative LIMIT as no limit at all and
 * `Array.slice(0, -1)` drops the last row, so without this check the two stores disagree.
 */
export function checkListLimit(limit: number, what: string): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `could not list ${what}: the limit must be a whole number from 1 (got ${limit})`,
    );
  }
}

/** An audio path is relative to userData and never climbs out of it (see `NewAudioFile.path`). */
export function checkAudioPath(path: string): string {
  if (path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error(`audio file path must be relative to userData, without "..": ${path}`);
  }
  return path;
}

/** Date and time with a `Z` or `±hh:mm` offset; seconds and fractions optional. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An ISO 8601 instant in the one form `toISOString` writes. A hold is compared as text in SQL,
 * and "10:02:00Z" sorts after "10:02:00.000Z", so a cap written without milliseconds would hold
 * a line past it. The shape is checked before `Date.parse`, which reads a time with no offset as
 * local time and guesses at other text ("Oct 6 2026", "1"): on a Mac in IST a cap of
 * "10:02:00" would land at 04:32Z, already past, and the line would upload unchecked.
 */
export function canonicalInstant(iso: string, what: string): string {
  const time = ISO_INSTANT.test(iso) ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) {
    throw new Error(`${what} is not an ISO 8601 instant with a Z or ±hh:mm offset: ${iso}`);
  }
  return new Date(time).toISOString();
}

export function checkTrim(id: string, trim: SegmentTrim): void {
  if (trim.text.trim() === '') {
    throw new Error(`segment ${id} trimmed to nothing: hide it (suppressSegment) instead`);
  }
}

export function checkGapWindow(id: string, startMs: number, endMs: number): void {
  if (!(endMs > startMs)) {
    throw new Error(`gap ${id} must end after it starts (start ${startMs}, end ${endMs})`);
  }
}
