import type { AudioSource } from '../../shared/transcript';
import type { MeetingSttUsage, TranscriptStore } from '../store/TranscriptStore';
import type { SttUsage } from '../stt/usage';

/** One re-run session's use, for the meeting it re-ran. */
export interface RerunUsage {
  meetingId: string;
  /** The vendor the re-run used; a new row is made for it, an existing row keeps its own. */
  provider: string;
  source: AudioSource;
  usage: SttUsage;
  /** ISO 8601 instant, UTC. */
  updatedAt: string;
}

const NO_USAGE: Readonly<SttUsage> = Object.freeze({
  sessionsOpened: 0,
  connectedMs: 0,
  audioSentMs: 0,
  droppedChunks: 0,
  estimatedCostUsd: 0,
});

/**
 * Adds a re-run session to its meeting's `stt_usage` row (cost guard G7): the vendor bills a
 * re-run like any session, and the row is what SttUsageUploader sends (the save clears its upload
 * mark, so the new total goes up). Everything else the row holds stays: the silence gate's time
 * (the whole row's and each source's), the stop reason and the provider. A meeting with no row yet
 * gets one, with its stop reason.
 *
 * Read and written in one synchronous turn, so no other save lands between: CaptureService saves
 * only the recording's meeting, and a re-run never runs while one records.
 */
export function addRerunUsage(
  store: Pick<TranscriptStore, 'getSttUsage' | 'saveSttUsage' | 'getMeetingStopReason'>,
  rerun: RerunUsage,
): void {
  const { meetingId, source } = rerun;
  const saved: MeetingSttUsage = store.getSttUsage(meetingId) ?? {
    meetingId,
    provider: rerun.provider,
    total: { ...NO_USAGE },
    bySource: { mic: { ...NO_USAGE }, system: { ...NO_USAGE } },
    stopReason: store.getMeetingStopReason(meetingId),
    updatedAt: rerun.updatedAt,
  };
  store.saveSttUsage({
    ...saved,
    total: addUsage(saved.total, rerun.usage),
    bySource: {
      ...saved.bySource,
      [source]: { ...saved.bySource[source], ...addUsage(saved.bySource[source], rerun.usage) },
    },
    updatedAt: rerun.updatedAt,
  });
}

/**
 * Two usages summed; an unknown cost on either side stays unknown (stt/usage.ts: a partial sum
 * would read as the whole cost). The twin of CaptureService's private `addUsage` for a resumed
 * meeting, which this task may not edit (M2-T16): change both together.
 */
function addUsage(saved: SttUsage, more: SttUsage): SttUsage {
  return {
    sessionsOpened: saved.sessionsOpened + more.sessionsOpened,
    connectedMs: saved.connectedMs + more.connectedMs,
    audioSentMs: saved.audioSentMs + more.audioSentMs,
    droppedChunks: saved.droppedChunks + more.droppedChunks,
    estimatedCostUsd:
      saved.estimatedCostUsd === null || more.estimatedCostUsd === null
        ? null
        : Math.round((saved.estimatedCostUsd + more.estimatedCostUsd) * 10_000) / 10_000,
  };
}
