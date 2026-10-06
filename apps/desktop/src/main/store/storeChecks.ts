import { isAbsolute } from 'node:path';
import type { SegmentTrim } from './TranscriptStore';

/**
 * Checks both stores run before a write, so the in-memory store refuses what SQLite refuses and
 * the tests of the services around the store see the same errors.
 */

/** An audio path is relative to userData and never climbs out of it (see `NewAudioFile.path`). */
export function checkAudioPath(path: string): string {
  if (path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error(`audio file path must be relative to userData, without "..": ${path}`);
  }
  return path;
}

/**
 * An ISO 8601 instant in the one form `toISOString` writes. A hold is compared as text in SQL,
 * and "10:02:00Z" sorts after "10:02:00.000Z", so a cap written without milliseconds would hold
 * a line past it.
 */
export function canonicalInstant(iso: string, what: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) throw new Error(`${what} is not an ISO 8601 instant: ${iso}`);
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
