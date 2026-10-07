import {
  type BackupStatus,
  type CaptureEventValue,
  type CaptureGapReason,
  type CaptureReportEvent,
  type CaptureReportGap,
  type CaptureWarningKind,
} from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { formatDuration, formatOffset, SOURCE_NAME } from '../../format';

/*
 * The words of M2-T20b's audio note and capture report, pure so each rule is tested under Node.
 * A capture event's `detail` is stored JSON (main/store), never a promise about its shape: every
 * read below checks its type, and an event this file has no words for shows its kind and its codes
 * and numbers as they are (never transcript text: main keeps none in an event).
 */

/** `900 bytes`, `1.5 KB`, `12.4 MB`, `2 GB`: binary steps, as main's own "2 GB" free-space text. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 12.0 reads as 12; one decimal otherwise.
  return `${value.toFixed(1).replace(/\.0$/, '')} ${units[unit] ?? 'TB'}`;
}

/** A day as the Mac's own locale writes it, with the year only when it is not this one. */
export function formatKeepDate(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export interface AudioNoteView {
  text: string;
  /** Transcribing again needs audio kept for it; main refuses while any recording runs (the UI says so). */
  canRerun: boolean;
  /** Main refuses a delete for the meeting being recorded, so none is offered while it writes. */
  canDelete: boolean;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The words about a meeting's kept audio, in Details (BackupStatus, `window.roger.getCaptureReport`
 * after Stop or the live status while recording): until when it stays, how many parts are not
 * transcribed yet, or that it is gone. `unfilledGaps` is the report's gaps with no `recoveredAt`. Null when no audio is kept
 * at all (`off`: the backup is turned off in config.json).
 */
export function audioNote(
  backup: BackupStatus,
  unfilledGaps: number,
  now: Date,
): AudioNoteView | null {
  const size = formatBytes(backup.bytes);
  const until = backup.keepUntil === null ? null : formatKeepDate(backup.keepUntil, now);
  switch (backup.state) {
    case 'off':
      return null;
    case 'writing':
      return {
        text: 'Roger is keeping this meeting’s audio on this Mac as it records.',
        canRerun: false,
        canDelete: false,
      };
    case 'paused':
      return {
        text:
          backup.message ??
          'The audio backup is paused because the disk is nearly full. The transcript goes on.',
        canRerun: false,
        canDelete: backup.bytes > 0,
      };
    case 'error':
      return {
        text: backup.message ?? 'Roger could not keep this meeting’s audio.',
        canRerun: false,
        canDelete: backup.bytes > 0,
      };
    case 'kept': {
      const where = until === null ? '' : ` until ${until}`;
      return backup.keptForRerun
        ? {
            text: `Audio kept on this Mac${where} (${size}). ${plural(unfilledGaps, 'part')} ${unfilledGaps === 1 ? 'is' : 'are'} not transcribed yet.`,
            canRerun: true,
            canDelete: true,
          }
        : {
            text: `Audio kept on this Mac${where} (${size}).`,
            canRerun: false,
            canDelete: true,
          };
    }
    case 'deleted':
      return {
        text:
          unfilledGaps > 0
            ? `This meeting’s audio is deleted. Its lines stay, and its ${plural(unfilledGaps, 'untranscribed part')} cannot be transcribed again.`
            : 'This meeting’s audio is deleted. Its lines stay.',
        canRerun: false,
        canDelete: false,
      };
  }
}

/**
 * Why the recording ended (`CaptureReport.stopReason`: main's StopReason, or `crash` for a meeting
 * a crash left open). Null while it runs. A reason this list does not know (an old row's
 * `page-reloaded`) shows as it is.
 */
export function describeStopReason(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'user':
      return 'You pressed Stop.';
    case 'no-speech':
      return 'Roger stopped: no one spoke for a while.';
    case 'max-duration':
      return 'Roger stopped: one recording is capped in length.';
    case 'quit':
      return 'Roger stopped because the app quit.';
    case 'window-closed':
      return 'Roger stopped because its window closed.';
    case 'renderer-gone':
      return 'Roger stopped because its window could not reload.';
    case 'system-sleep':
      return 'Roger stopped because the Mac went to sleep.';
    case 'call-ended':
      return 'Roger stopped because the call ended.';
    case 'crash':
      return 'Roger closed unexpectedly during this recording.';
    default:
      return `Stopped: ${reason}.`;
  }
}

/** Why audio reached main but not the vendor: a gap's reason, as a clause. */
const GAP_REASON: Readonly<Record<CaptureGapReason, string>> = {
  stt_failed: 'speech-to-text failed',
  offline: 'the Mac was offline',
  asleep: 'the Mac was asleep',
  budget: 'the speech-to-text limit for one meeting was reached',
  crash: 'Roger closed unexpectedly',
};

export interface GapView {
  /** `hh:mm:ss to hh:mm:ss`, offsets from the meeting start. */
  span: string;
  source: string;
  reason: string;
  status: 'recovered' | 'failed' | 'waiting';
  statusText: string;
}

export function describeGap(gap: CaptureReportGap): GapView {
  const base = {
    span: `${formatOffset(gap.startMs)} to ${formatOffset(gap.endMs)}`,
    source: SOURCE_NAME[gap.source],
    reason: GAP_REASON[gap.reason],
  };
  if (gap.recoveredAt !== null) {
    return {
      ...base,
      status: 'recovered',
      statusText: `Transcribed again at ${formatClockTime(gap.recoveredAt)}`,
    };
  }
  if (gap.recoverError !== null) {
    return {
      ...base,
      status: 'failed',
      statusText: `Transcribing again failed: ${gap.recoverError}`,
    };
  }
  return { ...base, status: 'waiting', statusText: 'Waiting to be transcribed again' };
}

/** "2 gaps, 1 transcribed again." for the report's gap line. */
export function summarizeGaps(gaps: readonly CaptureReportGap[]): string {
  if (gaps.length === 0) return 'No gaps: Roger recorded no audio it failed to transcribe.';
  const filled = gaps.filter((gap) => gap.recoveredAt !== null).length;
  const count = plural(gaps.length, 'gap');
  if (filled === 0) return `${count}, none transcribed again yet.`;
  if (filled === gaps.length) {
    return `${count}, ${gaps.length === 1 ? '' : 'all '}transcribed again.`;
  }
  return `${count}, ${filled} transcribed again.`;
}

/**
 * What each warning is called in the timeline. A `Record` over every `CaptureWarningKind`, so a
 * kind added in shared/capture.ts without its label fails the type check.
 */
export const WARNING_LABEL: Readonly<Record<CaptureWarningKind, string>> = {
  'no-audio': 'no audio reaching Roger',
  'source-ended': 'a stream ended',
  'helper-hung': 'the call audio helper stopped responding',
  'mic-dead': 'the mic sends only silence',
  'call-audio-never-heard': 'no call audio since the start',
  'call-audio-silent': 'call audio went silent',
  offline: 'the Mac is offline',
  'backup-paused': 'the audio backup paused',
  'keyterms-rejected': 'the jargon list was refused',
};

const isWarningKind = (value: string): value is CaptureWarningKind =>
  Object.hasOwn(WARNING_LABEL, value);

type Detail = CaptureReportEvent['detail'];

function str(detail: Detail, key: string): string | null {
  const value = detail[key];
  return typeof value === 'string' ? value : null;
}

function num(detail: Detail, key: string): number | null {
  const value = detail[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function waitText(ms: number | null): string {
  return ms === null ? '' : `; retrying in ${formatDuration(ms)}`;
}

const SUSPEND_REASON: Readonly<Record<string, string>> = {
  asleep: 'the Mac slept',
  offline: 'the Mac went offline',
};

/** One capture event as a line of the timeline. */
export function describeEvent(event: CaptureReportEvent): string {
  const { detail } = event;
  switch (event.kind) {
    case 'warning': {
      const kind = str(detail, 'warning');
      if (kind === null) return 'Warning';
      return `Warning: ${isWarningKind(kind) ? WARNING_LABEL[kind] : kind}`;
    }
    case 'warning-cleared': {
      const kind = str(detail, 'warning');
      const lasted = num(detail, 'lastedMs');
      const label = kind === null ? '' : `: ${isWarningKind(kind) ? WARNING_LABEL[kind] : kind}`;
      return `Cleared${label}${lasted === null ? '' : ` (lasted ${formatDuration(lasted)})`}`;
    }
    case 'device-switched': {
      const device = str(detail, 'device');
      return device === null ? 'Mic switched device' : `Mic switched to ${device}`;
    }
    case 'helper-restarted': {
      const cause = str(detail, 'cause');
      const why =
        cause === 'hung' ? ' (it stopped responding)' : cause === 'crashed' ? ' (it crashed)' : '';
      return `Call audio helper restarted${why}`;
    }
    case 'tap-rebuilt': {
      switch (str(detail, 'reason')) {
        case 'output_device_changed':
          return 'Call audio followed the new output device';
        case 'tap_format_changed':
          return 'Call audio followed a change of the output format';
        default:
          return 'Call audio capture rebuilt';
      }
    }
    case 'helper-failed': {
      const why = str(detail, 'detail');
      return `Call audio helper failed for good${why === null ? '' : `: ${why}`}`;
    }
    case 'helper-format-refused':
      return 'Call audio helper refused: it sent a format Roger cannot read';
    case 'helper-missing': {
      const why = str(detail, 'reason');
      return `No call audio helper${why === null ? '' : `: ${why}`}`;
    }
    case 'backup_paused': {
      const free = num(detail, 'freeBytes');
      const min = num(detail, 'minFreeBytes');
      if (free === null || min === null) return 'Audio backup paused';
      return `Audio backup paused: ${formatBytes(free)} free, under ${formatBytes(min)}`;
    }
    case 'backup_resumed': {
      const free = num(detail, 'freeBytes');
      return free === null
        ? 'Audio backup resumed'
        : `Audio backup resumed: ${formatBytes(free)} free`;
    }
    case 'backup_failed': {
      const code = str(detail, 'error');
      return code === null || code === 'unknown'
        ? 'Audio backup failed'
        : `Audio backup failed (${code})`;
    }
    case 'audio_deleted': {
      const by = str(detail, 'by');
      const files = num(detail, 'files');
      const who = by === 'user' ? ' by you' : by === 'retention' ? ' after its retention' : '';
      return `Audio deleted${who}${files === null ? '' : ` (${plural(files, 'file')})`}`;
    }
    case 'stt-paused': {
      const silent = num(detail, 'silentForMs');
      return silent === null
        ? 'Speech-to-text paused'
        : `Speech-to-text paused after ${formatDuration(silent)} with no audio`;
    }
    case 'stt-failed': {
      const stage = str(detail, 'stage');
      const reason = str(detail, 'reason');
      return `Speech-to-text failed${stage === null ? '' : ` (${stage})`}${reason === null ? '' : `: ${reason}`}${waitText(num(detail, 'retryInMs'))}`;
    }
    case 'stt-budget-refused': {
      const limit = str(detail, 'limit');
      return `Speech-to-text reopen refused${limit === null ? '' : ` (${limit} limit)`}${waitText(num(detail, 'retryInMs'))}`;
    }
    case 'stt-closed': {
      const reason = str(detail, 'reason');
      return `Speech-to-text closed${reason === null ? '' : `: ${reason}`}`;
    }
    case 'stt-suspended': {
      const reason = str(detail, 'reason');
      return `Speech-to-text suspended${reason === null ? '' : `: ${SUSPEND_REASON[reason] ?? reason}`}`;
    }
    case 'stt-resumed': {
      const reason = str(detail, 'reason');
      const slept = num(detail, 'suspendedForMs');
      return `Speech-to-text resumed${slept === null ? '' : ` after ${formatDuration(slept)}`}${reason === null ? '' : ` (${SUSPEND_REASON[reason] ?? reason})`}`;
    }
    case 'stt-reopened': {
      const held = num(detail, 'heldMs');
      const dropped = num(detail, 'droppedChunks') ?? 0;
      const sent = held === null ? '' : `, sending the ${formatDuration(held)} held meanwhile`;
      return `Speech-to-text reopened${sent}${dropped > 0 ? ` (${plural(dropped, 'chunk')} dropped)` : ''}`;
    }
    case 'resumed_after_crash': {
      const down = num(detail, 'downMs');
      const app = str(detail, 'callApp');
      return `Roger restarted${down === null ? '' : ` after ${formatDuration(down)}`} and kept taking notes${app === null ? '' : ` (${app} was on the mic)`}`;
    }
    default:
      return `${event.kind}${codes(detail)}`;
  }
}

/** ` (silentForMs 90000, gate true)` for an event with no words: its numbers, flags and codes. */
function codes(detail: Detail): string {
  const parts = Object.entries(detail)
    .filter((entry): entry is [string, string | number | boolean] => isScalar(entry[1]))
    .map(([key, value]) => `${key} ${String(value)}`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

function isScalar(value: CaptureEventValue): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
