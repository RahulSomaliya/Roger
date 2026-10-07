import type { CapturePhase } from '../../../shared/capture';
import { Icon } from '../components/ui/icons';
import { useNow } from '../calendar/useCalendar';
import { meetingPhase } from './captureMeeting';
import { elapsedInWords, formatElapsed, PHASE_LABEL } from './labels';
import { HOME, type Route } from './router';
import { useShell } from './ShellContext';

const SETTINGS: Route = { name: 'settings' };

/**
 * The slim header on every page but Set up Roger: Roger (Home), the recording chip while a call
 * records, Settings. It replaces the sidebar, whose "New note" was a second Start. Every item is a
 * button that calls navigate(): a link to `#/...` would change the hash, which router.ts explains
 * must never happen.
 */
export function AppHeader() {
  const { route, navigate, capture, captureMeeting } = useShell();
  // "Every 15 s": the chip counts whole minutes, and a seconds counter is motion that never stops.
  const nowMs = useNow(15_000);
  const phase = meetingPhase(captureMeeting, capture.status);
  // The chip opens the live meeting, so it has no job on that meeting's own page.
  const chipShown =
    captureMeeting !== null &&
    phase !== 'idle' &&
    !(route.name === 'meeting' && route.meetingId === captureMeeting.id);
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <button
          type="button"
          className="btn app-brand"
          data-variant="ghost"
          data-size="sm"
          aria-current={route.name === 'home' ? 'page' : undefined}
          onClick={() => {
            navigate(HOME);
          }}
        >
          Roger
        </button>
        <div className="app-header-end">
          {chipShown ? (
            <RecordingChip
              phase={phase}
              startedAt={captureMeeting.startedAt}
              nowMs={nowMs}
              onOpen={() => {
                navigate({ name: 'meeting', meetingId: captureMeeting.id });
              }}
            />
          ) : null}
          <button
            type="button"
            className="btn icon-button"
            data-variant="ghost"
            data-size="sm"
            aria-label="Settings"
            aria-current={route.name === 'settings' ? 'page' : undefined}
            onClick={() => {
              navigate(SETTINGS);
            }}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>
    </header>
  );
}

export interface RecordingChipProps {
  phase: CapturePhase;
  /** ISO 8601 instant; null until main reports it, when the chip shows no time. */
  startedAt: string | null;
  nowMs: number;
  onOpen: () => void;
}

/**
 * "Recording 12m": a static dot, the word and the whole minutes. Its accessible name says it all
 * ("Recording, 12 minutes") because the dot and the digits alone say little to a screen reader.
 * While Roger stops the call it says "Stopping…" and no time: the time is the recording's.
 */
export function RecordingChip({ phase, startedAt, nowMs, onOpen }: RecordingChipProps) {
  const sinceMs = phase === 'recording' && startedAt !== null ? Date.parse(startedAt) : null;
  const label = PHASE_LABEL[phase];
  const name = sinceMs === null ? label : `${label}, ${elapsedInWords(sinceMs, nowMs)}`;
  return (
    <button
      type="button"
      className="btn recording-chip"
      data-variant="secondary"
      data-size="sm"
      aria-label={name}
      onClick={onOpen}
    >
      <span className="recording-dot" aria-hidden="true" />
      <span>{label}</span>
      {sinceMs === null ? null : (
        <span className="recording-chip-time">{formatElapsed(sinceMs, nowMs)}</span>
      )}
    </button>
  );
}
