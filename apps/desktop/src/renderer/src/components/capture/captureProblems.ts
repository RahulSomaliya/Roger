import type { CaptureWarning, UploadStatus } from '../../../../shared/capture';
import { warningHeadline } from '../../../../shared/captureWords';
import type { AudioSource } from '../../../../shared/transcript';

/*
 * What capture must tell the person, as plain sentences. House rule 1 holds through every
 * removal in docs/plans/redesign.md: a call that is not being saved is always on screen.
 */

/**
 * The line for lines the server refused for good (`UploadStatus.rejected`: the API answered 4xx
 * and the uploader set them aside), or null when none was. They stay in roger.sqlite and never
 * reach Postgres, so the person must hear it, and no warning in `CaptureStatus.warnings` says it:
 * the capture panel's "Postgres" row was the only place, and that row is Details-only now.
 *
 * A retry in progress (`backoff`) is not a refusal: its lines upload once the server answers, and
 * Details counts them. `rejected` counts every refused line on this Mac, not this meeting's, so the
 * sentence names no meeting.
 */
export function refusedLinesProblem(upload: UploadStatus): string | null {
  const count = upload.rejected;
  if (count <= 0) return null;
  const refused = `Roger's server refused ${count} line${count === 1 ? '' : 's'} for good.`;
  return `${refused} ${count === 1 ? 'It stays' : 'They stay'} saved on this Mac only.`;
}

/**
 * A few words for what a warning means, for the meeting header's one-line status
 * ("Roger can't hear the call · since 4:59 pm"). Main's message (what is wrong and what to do) is
 * the long form, which the banner and Details show. The words live in shared/captureWords.ts, which
 * main's notifications read too (warnings.ts `warningTitle`): one name per warning on every surface.
 */
export { warningHeadline };

/** One stream's warnings of one loudness, as the banner, the status line and Details show them. */
export interface WarningGroup {
  /** The stream they are about; null for the ones about neither (offline, the backup). */
  source: AudioSource | null;
  /** The earliest spell's start, ISO 8601. */
  since: string;
  /** The first warning's `warningHeadline`. */
  headline: string;
  /** Main's messages, each text once, in the order main sent them. */
  messages: string[];
}

/**
 * The warnings of `CaptureStatus.warnings` that are `loud` (or, with `false`, the quiet ones), a
 * group per stream in the order main sent them (offline first, then the mic, then call audio).
 * Main joins every contributor's warnings (M2-T4's status seam), so one stream can hold two at
 * once: while the call audio helper is down, M2-T10's `helper-hung` (or `source-ended` after a
 * crash) and, past 5 s, M2-T11's `no-audio` are both loud and both true. They are different kinds,
 * not a duplicate: the group keeps both messages, and the same text twice is said once.
 *
 * Loud and quiet are asked for apart on purpose: the banner and the status line take the loud
 * ones, Details the quiet ones, and a quiet message must never ride along in a loud group.
 */
export function groupWarnings(warnings: readonly CaptureWarning[], loud: boolean): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const warning of warnings) {
    if (warning.loud !== loud) continue;
    const key = warning.source ?? 'none';
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        source: warning.source,
        since: warning.since,
        headline: warningHeadline(warning),
        messages: [warning.message],
      });
      continue;
    }
    if (Date.parse(warning.since) < Date.parse(group.since)) group.since = warning.since;
    if (!group.messages.includes(warning.message)) group.messages.push(warning.message);
  }
  return [...groups.values()];
}
