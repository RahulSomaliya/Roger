import {
  NO_AUDIO_WARNING_MS,
  type SourceHealth,
  type SttStreamState,
  type UploadStatus,
} from '../../shared/capture';

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
      return 'closed';
    case 'connecting':
      return 'connecting';
    case 'open':
      return 'transcribing';
    case 'error':
      return 'error';
  }
}

export function describeUpload(upload: UploadStatus): string {
  const rejected = upload.rejected > 0 ? ` · ${upload.rejected} rejected by the API` : '';
  if (upload.state === 'backoff') {
    return `${upload.pending} lines waiting, retrying (${upload.lastError ?? 'error'})${rejected}`;
  }
  if (upload.pending > 0) return `${upload.pending} lines uploading${rejected}`;
  return `all lines uploaded${rejected}`;
}
