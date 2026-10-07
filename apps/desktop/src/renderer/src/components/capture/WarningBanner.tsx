import { AUDIO_SOURCE_LABEL, type CaptureWarning } from '../../../../shared/capture';
import type { AudioSource } from '../../../../shared/transcript';
import { formatClockTime } from '../../app/labels';
import './captureStatus.css';

/** One stream's warnings as the banner shows them: one box, every distinct message in it. */
export interface WarningRow {
  /** The stream they are about; null for the ones about neither (offline, the backup). */
  source: AudioSource | null;
  /** Loud when any of its warnings is: the danger style, read out at once. */
  loud: boolean;
  /** The earliest spell's start, ISO 8601. */
  since: string;
  /** Loud ones first, then in the order main sent them; each text once. */
  messages: string[];
}

/**
 * The warnings of `CaptureStatus.warnings`, a row per stream, loud rows first. Main joins every
 * contributor's warnings (M2-T4's status seam), so one stream can hold two at once: while the
 * call audio helper is down, M2-T10's `helper-hung` (or `source-ended` after a crash) and, past
 * 5 s, M2-T11's `no-audio` are both loud and both true. They are different kinds, not a
 * duplicate: the row keeps both messages, and the same text twice is said once.
 */
export function warningRows(warnings: readonly CaptureWarning[]): WarningRow[] {
  const rows = new Map<string, { row: WarningRow; loud: string[]; quiet: string[] }>();
  for (const warning of warnings) {
    const key = warning.source ?? 'none';
    const entry = rows.get(key) ?? {
      row: { source: warning.source, loud: false, since: warning.since, messages: [] },
      loud: [],
      quiet: [],
    };
    rows.set(key, entry);
    if (Date.parse(warning.since) < Date.parse(entry.row.since)) entry.row.since = warning.since;
    entry.row.loud ||= warning.loud;
    const list = warning.loud ? entry.loud : entry.quiet;
    if (!entry.loud.includes(warning.message) && !entry.quiet.includes(warning.message)) {
      list.push(warning.message);
    }
  }
  const joined = [...rows.values()].map(({ row, loud, quiet }) => ({
    ...row,
    messages: [...loud, ...quiet],
  }));
  // Stable: rows of one loudness keep main's order (offline first, then the mic, then call audio).
  return joined.sort((a, b) => Number(b.loud) - Number(a.loud));
}

/**
 * What is wrong with capture now, above every page (the shell's banner slot): loud rows in the
 * danger style as alerts, quiet ones in the warning style as a status. Each row names its stream
 * and when its trouble began; the messages say what to do. Colours: captureStatus.css, tokens only.
 */
export function WarningBanner({ warnings }: { warnings: readonly CaptureWarning[] }) {
  const rows = warningRows(warnings);
  if (rows.length === 0) return null;
  return (
    <div className="capture-warnings">
      {rows.map((row) => (
        <div
          key={row.source ?? 'none'}
          className="capture-warning"
          role={row.loud ? 'alert' : 'status'}
          data-loud={row.loud ? 'true' : 'false'}
          data-source={row.source ?? 'none'}
        >
          <p className="capture-warning-heading">
            <span className="capture-warning-stream">
              {row.source === null ? 'This recording' : AUDIO_SOURCE_LABEL[row.source]}
            </span>{' '}
            <span className="capture-warning-since">since {formatClockTime(row.since)}</span>
          </p>
          <ul className="capture-warning-messages">
            {row.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
