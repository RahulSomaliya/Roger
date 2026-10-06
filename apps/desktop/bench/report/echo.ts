import { type EchoLine, filterEcho, isEchoFilterOn } from '../../src/main/capture/echo/EchoFilter';
import type { TranscriptWord } from '../../src/shared/transcript';
import type { BenchItem } from '../run/items';

/**
 * Me as the user sees it (M3 design, "Scoring"): the replayed mic finals after M2's EchoFilter, run
 * over the item's mic and system finals with the route from item.json, as the app runs it. On laptop
 * speakers the mic carries all of Them's speech, so a vendor that transcribes that echo better would
 * get more insertions and a higher Me WER: scored raw, two speaker items could flip the vendor
 * choice. The raw mic stays as a diagnostic column. The filter is the app's own pure module, never a
 * copy, so the bench scores exactly what the app shows.
 */

/** One replayed final on the item's timeline (its session's item offset added). */
export interface ReplayedFinal {
  startMs: number;
  endMs: number;
  text: string;
  words: TranscriptWord[];
}

export type MeScoring =
  /** Me is scored: on `filtered`, and the raw mic as the diagnostic. */
  | { kind: 'scored'; filterApplied: boolean; filtered: string[]; rawMic: string[] }
  /** No mic stream: the item is scored on Them alone, and kept out of the mic latency gate. */
  | { kind: 'no-mic'; reason: string }
  /**
   * The route needs the filter but this score runs without it: Me and the pooled WER leave the
   * item out (Them and the raw mic still count), and the report says so.
   */
  | { kind: 'needs-filter'; rawMic: string[]; reason: string };

/**
 * How one item's Me is scored. `mic` and `system` are the replayed finals in time order, null when
 * the item has no such stream. `echoFilter` false is `score --no-echo-filter`.
 */
export function meScoring(
  item: Pick<BenchItem, 'origin' | 'setup'>,
  mic: readonly ReplayedFinal[] | null,
  system: readonly ReplayedFinal[] | null,
  options: { echoFilter: boolean },
): MeScoring {
  if (mic === null) {
    return {
      kind: 'no-mic',
      reason:
        item.origin === 'meet-recording'
          ? 'a meet recording has only the system stream'
          : 'the item has no mic stream',
    };
  }
  const rawMic = mic.map((line) => line.text);
  // Headphones turn the filter off in the app; an unknown route may be the laptop speakers.
  if (!isEchoFilterOn(item.setup)) {
    return { kind: 'scored', filterApplied: false, filtered: rawMic, rawMic };
  }
  if (!options.echoFilter) {
    return {
      kind: 'needs-filter',
      rawMic,
      reason:
        `${item.setup}: Me needs the echo filter, which this score ran without ` +
        '(--no-echo-filter); left out of Me and the pooled WER',
    };
  }
  const callAudio = (system ?? []).map((line, index) => echoLine(line, `system-${index}`));
  const filtered = mic.flatMap((line, index) => {
    // The line as the vendor wrote it, every call-audio line of the item at hand: the filter
    // decides once with everything, as the app's re-decision of a stored line does.
    const decision = filterEcho(echoLine(line, `mic-${index}`), callAudio, item.setup);
    if (decision.action === 'hide') return [];
    return [decision.action === 'trim' ? decision.text : line.text];
  });
  return { kind: 'scored', filterApplied: true, filtered, rawMic };
}

function echoLine(line: ReplayedFinal, id: string): EchoLine {
  return { id, startMs: line.startMs, endMs: line.endMs, text: line.text, words: line.words };
}
