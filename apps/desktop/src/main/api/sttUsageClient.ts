import type { AudioSource } from '../../shared/transcript';
import type { MeetingSttUsage, SourceSttUsage } from '../store/TranscriptStore';
import type { SttUsage } from '../stt/usage';
import { type ApiConnection, type ApiRequest, createApiRequest } from './http';

const PATH = '/v1/stt-usage/meetings';

/**
 * Typed client for STT usage (docs/api-contract.md, "STT usage"), on the shared HTTP core in
 * ./http.ts. The wire speaks snake_case; this file maps the local `stt_usage` row to it and is the
 * only place that does. The figures go as the Mac metered them: the API rounds a fractional ms
 * (`pcmBytesToMs` sums chunks in floating point), and an unknown price is sent as null.
 */
export class SttUsageClient {
  private readonly request: ApiRequest;

  constructor(connection: ApiConnection) {
    this.request = createApiRequest(connection);
  }

  /**
   * `PUT /v1/stt-usage/meetings/{id}`: the meeting's whole usage so far, replacing what the API
   * held. The PUT has no ordering guard (the last to arrive wins), so a caller sends one meeting's
   * usage one request at a time, as SttUsageUploader does. A row the API refuses is its
   * `422 validation_error`, an ApiError naming the field.
   */
  async saveMeetingUsage(usage: MeetingSttUsage): Promise<void> {
    // The answer is the row as stored; nothing here needs it.
    await this.request<unknown>(
      'PUT',
      `${PATH}/${encodeURIComponent(usage.meetingId)}`,
      toWire(usage),
    );
  }
}

/** The client as SttUsageUploader uses it; a test fake typed by it needs no cast. */
export type SttUsageRoutes = Pick<SttUsageClient, 'saveMeetingUsage'>;

// The wire shapes, as docs/api-contract.md writes them.

interface SttSourceUsageWire {
  sessions_opened: number;
  connected_ms: number;
  audio_sent_ms: number;
  dropped_chunks: number;
  gated_ms: number;
  /** Required by the API: null when the price is unknown, never left out and never 0. */
  estimated_cost_usd: number | null;
}

interface SttUsageWire extends SttSourceUsageWire {
  provider: string;
  by_source: Record<AudioSource, SttSourceUsageWire>;
  stop_reason: string | null;
}

/**
 * Field by field, never a spread: only what the contract names goes out. Gated time a row does
 * not have (every row until the silence gate, M3-T20) is sent as 0, as the API reads it left out.
 */
function toWire(usage: MeetingSttUsage): SttUsageWire {
  return {
    provider: usage.provider,
    ...figures(usage.total, usage.gatedMs ?? 0),
    by_source: {
      mic: sourceToWire(usage.bySource.mic),
      system: sourceToWire(usage.bySource.system),
    },
    stop_reason: usage.stopReason,
  };
}

function sourceToWire(source: SourceSttUsage): SttSourceUsageWire {
  return figures(source, source.gatedMs ?? 0);
}

function figures(usage: SttUsage, gatedMs: number): SttSourceUsageWire {
  return {
    sessions_opened: usage.sessionsOpened,
    connected_ms: usage.connectedMs,
    audio_sent_ms: usage.audioSentMs,
    dropped_chunks: usage.droppedChunks,
    gated_ms: gatedMs,
    estimated_cost_usd: usage.estimatedCostUsd,
  };
}
