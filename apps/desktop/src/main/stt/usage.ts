/**
 * What speech-to-text sessions used, as the vendor bills it: AssemblyAI and Deepgram charge for the
 * time a session is open, so connected time, not audio sent, is what the estimate prices.
 */
export interface SttUsage {
  /** Sockets that completed the handshake, failed connects included: each may be billed. */
  sessionsOpened: number;
  /** Handshake to close (to now while open), summed over sessions. */
  connectedMs: number;
  /** Audio sent, in ms of the stream's PCM. */
  audioSentMs: number;
  /** Chunks dropped because their stream was not open. */
  droppedChunks: number;
  /**
   * Connected time at each session's price per stream-hour (from the API), to 1/10000 USD. Null
   * when a session opened with no known price: a partial sum would read as the whole cost.
   */
  estimatedCostUsd: number | null;
}

/** One session's share, for summing. */
export interface SessionUsage {
  opened: boolean;
  connectedMs: number;
  audioSentMs: number;
  droppedChunks: number;
  pricePerHourUsd: number | null;
}

/** Sums sessions into one SttUsage; the cost is rounded once, after the sum. */
export function sumUsage(sessions: Iterable<SessionUsage>): SttUsage {
  const usage: SttUsage = {
    sessionsOpened: 0,
    connectedMs: 0,
    audioSentMs: 0,
    droppedChunks: 0,
    estimatedCostUsd: 0,
  };
  let costUsd: number | null = 0;
  for (const session of sessions) {
    if (session.opened) usage.sessionsOpened += 1;
    usage.connectedMs += session.connectedMs;
    usage.audioSentMs += session.audioSentMs;
    usage.droppedChunks += session.droppedChunks;
    if (!session.opened) continue;
    costUsd =
      costUsd === null || session.pricePerHourUsd === null
        ? null
        : costUsd + (session.connectedMs / 3_600_000) * session.pricePerHourUsd;
  }
  usage.estimatedCostUsd = costUsd === null ? null : roundUsd(costUsd);
  return usage;
}

/** Open time at a price per stream-hour, to 1/10000 USD; null when the price is unknown. */
export function estimateCostUsd(
  connectedMs: number,
  pricePerHourUsd: number | null,
): number | null {
  if (pricePerHourUsd === null) return null;
  return roundUsd((connectedMs / 3_600_000) * pricePerHourUsd);
}

function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}
