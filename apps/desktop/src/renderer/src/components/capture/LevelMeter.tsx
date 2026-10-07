import type { SignalState } from '../../../../shared/capture';
import './captureStatus.css';

/**
 * The quietest level the meter shows: an empty bar. A room's noise floor sits near it, and speech
 * peaks well above (-25 to -6 dBFS), so the bar moves with a voice and stays near empty in a pause.
 */
export const LEVEL_FLOOR_DB = -60;

/**
 * How far to fill the bar for `levelDb`, the peak of the source's last second in dBFS
 * (`SourceStatus.levelDb`, M2-T11's SignalMonitor). Null (digital silence, or no chunk in the last
 * second) is empty.
 */
export function levelPercent(levelDb: number | null): number {
  if (levelDb === null) return 0;
  const fraction = (levelDb - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/**
 * The level in words. `signal` tells apart what a null level cannot: a pause (`quiet`), a dead
 * input (`dead`, which also covers the flat-level rule's faint steady level), nothing measured yet
 * (`unknown`), and a source that carried sound and then sent no chunk at all (`signal` with no
 * level: SignalMonitor keeps the last state while no chunk comes).
 */
export function describeLevel(levelDb: number | null, signal: SignalState): string {
  if (signal === 'dead') return 'no signal';
  // `|| 0`: full scale rounds to -0, which a template writes as "0" but toBe tells from 0.
  if (levelDb !== null) return `${Math.round(levelDb) || 0} dB`;
  switch (signal) {
    case 'unknown':
      return 'no audio yet';
    case 'quiet':
      return 'silent';
    case 'signal':
      return 'no audio';
  }
}

export interface LevelMeterProps {
  /** The source, as AUDIO_SOURCE_LABEL names it: the meter is "<label> level". */
  label: string;
  levelDb: number | null;
  signal: SignalState;
}

/**
 * One source's level: a bar and its value in words, coloured by `signal` (captureStatus.css). The
 * fill's width is set inline, as the one value that changes with every status (twice a second).
 */
export function LevelMeter({ label, levelDb, signal }: LevelMeterProps) {
  const text = describeLevel(levelDb, signal);
  const now = levelDb === null ? LEVEL_FLOOR_DB : Math.min(0, Math.max(LEVEL_FLOOR_DB, levelDb));
  return (
    <div
      className="level-meter"
      role="meter"
      aria-label={`${label} level`}
      aria-valuemin={LEVEL_FLOOR_DB}
      aria-valuemax={0}
      aria-valuenow={Math.round(now) || 0}
      aria-valuetext={text}
      data-signal={signal}
    >
      <span className="level-meter-track" aria-hidden="true">
        <span className="level-meter-fill" style={{ width: `${levelPercent(levelDb)}%` }} />
      </span>
      <span className="level-meter-text" aria-hidden="true">
        {text}
      </span>
    </div>
  );
}
