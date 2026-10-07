import { randomUUID } from 'node:crypto';
import { AUDIO_SOURCES } from '../../shared/transcript';
import type { TranscriptStore } from '../store/TranscriptStore';

/** A crash tail shorter than this holds no word: not worth a gap row and a vendor session. */
export const MIN_CRASH_TAIL_MS = 300;

/**
 * At launch (M2 D7): the audio a crash cut off before the vendor turned it into lines becomes a
 * `crash` gap per source, for the re-run to fill from the backup. A meeting counts when a crash
 * ended it: `stop_reason` is `crash` (TranscriptStore.endMeetingsLeftOpen wrote it at this launch
 * or an earlier one) and it has ended. One still open is being recorded, or is M2-T23's to resume,
 * which records its own gap. Its tail runs from the source's last stored line (the watermark: the
 * vendor had answered up to there; hidden echo lines count) to the end of that source's backup
 * audio, or from its first audio when it has no line.
 *
 * Idempotent across launches: a source that already has a `crash` gap is skipped, recovered or
 * not, so a relaunch never records the same tail twice.
 *
 * Cost: everything after the last line is re-run, silence included. A source silent for most of
 * the call before the crash (a muted mic) re-runs all of it, at real time, billed once more; the
 * gap row cannot know where the vendor had got to. Runs only for meetings a crash ended.
 *
 * Reads every line of a source of such a meeting to find its last one (the store has no query for
 * it). Only at launch, only for meetings a crash ended, and their audio, which is what the
 * re-run reads next anyway. Returns how many gaps it recorded.
 */
export function recordCrashTails(store: TranscriptStore, createdAt: string): number {
  let recorded = 0;
  for (const meetingId of store.listMeetingIdsWithAudio()) {
    if (store.getMeeting(meetingId)?.endedAt == null) continue;
    if (store.getMeetingStopReason(meetingId) !== 'crash') continue;
    const gaps = store.listGaps(meetingId);
    const files = store.listAudioFiles(meetingId);
    for (const source of AUDIO_SOURCES) {
      if (gaps.some((gap) => gap.source === source && gap.reason === 'crash')) continue;
      const own = files.filter((file) => file.source === source);
      if (own.length === 0) continue;
      const audioFromMs = Math.min(...own.map((file) => file.startMs));
      const audioToMs = Math.max(...own.map((file) => file.endMs ?? file.startMs));
      const lines = store.listSegmentsOverlapping(meetingId, source, audioFromMs, audioToMs);
      const startMs = Math.max(audioFromMs, ...lines.map((line) => line.endMs));
      if (audioToMs - startMs < MIN_CRASH_TAIL_MS) continue;
      store.addGap({
        id: randomUUID(),
        meetingId,
        source,
        startMs,
        endMs: audioToMs,
        reason: 'crash',
        createdAt,
      });
      recorded += 1;
    }
  }
  return recorded;
}
