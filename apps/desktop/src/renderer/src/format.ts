import {
  AUDIO_SOURCE_LABEL,
  NO_AUDIO_WARNING_MS,
  type SourceHealth,
  type SttMeterStatus,
  type SttStreamState,
  type UploadStatus,
} from '../../shared/capture';
import { AUDIO_SOURCES } from '../../shared/transcript';

/** `hh:mm:ss` for an offset in milliseconds. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}

export function describeHealth(health: SourceHealth, chunks: number): string {
  switch (health) {
    case 'pending':
      return 'waiting for audio';
    case 'active':
      return chunks === 0 ? 'open, no audio yet' : `${(chunks / 10).toFixed(0)}s captured`;
    case 'stalled':
      return `no audio for over ${NO_AUDIO_WARNING_MS / 1000} s`;
    case 'ended':
      return 'stopped';
    case 'error':
      return 'error';
  }
}

export function describeStream(state: SttStreamState): string {
  switch (state) {
    case 'closed':
      // No vendor session: before Start, after Stop, or the source failed or ended.
      return 'not connected';
    case 'connecting':
      return 'connecting';
    case 'open':
      return 'transcribing';
    case 'paused':
      return 'paused, no audio';
    case 'retrying':
      return 'reconnecting';
    case 'error':
      return 'error';
  }
}

export function describeSaved(stored: number, unsaved: number): string {
  const lines = `${stored} lines`;
  return unsaved > 0 ? `${lines} · ${unsaved} could not be saved` : lines;
}

export function describeUpload(upload: UploadStatus): string {
  const rejected = upload.rejected > 0 ? ` · ${upload.rejected} rejected by the API` : '';
  if (upload.state === 'backoff') {
    return `${upload.pending} lines waiting, retrying (${upload.lastError ?? 'error'})${rejected}`;
  }
  if (upload.pending > 0) return `${upload.pending} lines uploading${rejected}`;
  return `all lines uploaded${rejected}`;
}

/** `45s`, `12m 30s`, `1h 02m`: how long a speech-to-text session was open. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** An estimate from the API's list price, so never shown as exact. */
export function describeCost(usd: number | null): string {
  if (usd === null) return 'cost unknown';
  if (usd === 0) return 'no cost';
  if (usd < 0.005) return 'under $0.01';
  return `about $${usd.toFixed(2)}`;
}

/** The status line: what the vendor bills for this meeting so far (open time, silent or not). */
export function describeMeter(meter: SttMeterStatus): string {
  const { total } = meter;
  return `${meter.vendorName} · ${formatDuration(total.connectedMs)} connected · ${describeCost(total.estimatedCostUsd)}`;
}

/** The rest of the meter, for the line's tooltip. */
export function meterDetails(meter: SttMeterStatus): string {
  const { total } = meter;
  const sessions = `${total.sessionsOpened} session${total.sessionsOpened === 1 ? '' : 's'} opened`;
  const perSource = AUDIO_SOURCES.map((source) => {
    const used = meter.sources[source];
    return `${AUDIO_SOURCE_LABEL[source]}: ${formatDuration(used.connectedMs)} connected, ${describeCost(used.estimatedCostUsd)}.`;
  });
  return [`${sessions} · ${formatDuration(total.audioSentMs)} of audio sent.`, ...perSource].join(
    ' ',
  );
}
