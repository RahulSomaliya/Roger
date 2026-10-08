import {
  NO_AUDIO_WARNING_MS,
  type SourceHealth,
  type SttMeter,
  type SttMeterStatus,
  type SttStreamState,
  type UploadStatus,
} from '../../shared/capture';
import { AUDIO_SOURCES, type AudioSource } from '../../shared/transcript';

/**
 * What Details calls each source (docs/design.md, Naming list): the microphone and the call audio.
 * Not `AUDIO_SOURCE_LABEL` ("Mic (me)", "Call audio (them)"): main writes that into its own messages,
 * and the transcript's speakers are Me and Them.
 */
export const SOURCE_NAME: Readonly<Record<AudioSource, string>> = {
  mic: 'Microphone',
  system: 'Call audio',
};

/**
 * An offset in milliseconds as docs/design.md writes it: "4:07", and "1:02:05" past an hour.
 * Only the leading unit goes unpadded. The offsets that main prints for the API's MCP tools
 * (`hh:mm:ss`, docs/api-contract.md) and a citation chip's label (`mm:ss`, `chipLabel`) are other
 * formats, fixed by the contract: they are not this one.
 */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * Every chunk is 100 ms of audio, from the renderer (`CHUNK_SAMPLES` in
 * audio/AudioCaptureController.ts) and from the helper's tap (`TAP_CHUNK_MS` in
 * main/audio/system/TapSystemAudio.ts). Change the three together.
 */
const CHUNK_MS = 100;

export function describeHealth(health: SourceHealth, chunks: number): string {
  switch (health) {
    case 'pending':
      return 'waiting for audio';
    case 'active':
      // As formatDuration, like the connected time beside it: "39m 52s", never "2392s".
      return chunks === 0 ? 'open, no audio yet' : `${formatDuration(chunks * CHUNK_MS)} captured`;
    case 'stalled':
      return `no audio for over ${NO_AUDIO_WARNING_MS / 1000} s`;
    case 'ended':
      return 'stopped';
    case 'error':
      return 'error';
  }
}

/**
 * A source's speech-to-text session as its row's label says it (components/capture/CaptureFacts):
 * short, because the row shows why beside it (`streamMessages`). "Transcribing" only while its
 * source sends audio; "Reconnecting" only while the audio a reopen waits for flows, because a
 * source reopens with its next chunk, never on a timer (CaptureSession.pushAudio).
 *
 * No default case: a new SttStreamState fails the type check (TS2366) until this says how it reads
 * (section 3.1 of docs/plans/phase-2-build-order.md).
 */
export function describeStream(state: SttStreamState, health: SourceHealth): string {
  switch (state) {
    case 'closed':
      // No vendor session: before Start, after Stop, or the source failed or ended.
      return 'Not connected';
    case 'connecting':
      return 'Connecting';
    case 'open':
      // Open but fed nothing: billed, not transcribing. It closes after the stall window.
      if (health === 'active') return 'Transcribing';
      return health === 'pending' ? 'Connected, no audio yet' : 'Connected, no audio';
    case 'paused':
      // Chunks still arriving while it is paused: the silence gate closed it (M3-T20), since a
      // stall sends none and a stall's source reopens with its very next chunk. The gate reopens
      // it only on speech, so "Paused" would read as a fault on every quiet mic.
      if (health === 'active') return 'Closed while silent, reopens on speech';
      // Closed until its audio returns: a stall, or the Mac asleep. The message says which.
      return 'Paused';
    case 'retrying':
      if (health === 'active') return 'Reconnecting';
      // A stopped source never sends the chunk a reopen needs (G1 closes it at once).
      if (health === 'ended' || health === 'error') return 'Not connected';
      // The wait may be over, but with no chunk arriving no reopen is attempted.
      return 'Reconnects with audio';
    case 'offline':
      // Not the vendor's fault, and nothing reopens until the network is back, so never
      // "Reconnecting"; the message and the banner's offline warning say so.
      return 'Offline';
    case 'error':
      // Ended for this meeting; the message says why (a refused open, a fatal vendor error).
      return 'Failed';
  }
}

export function describeSaved(stored: number, unsaved: number): string {
  const lines = `${stored} lines`;
  return unsaved > 0 ? `${lines} · ${unsaved} could not be saved` : lines;
}

export function describeUpload(upload: UploadStatus): string {
  const rejected = upload.rejected > 0 ? ` · ${upload.rejected} refused for good` : '';
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

/**
 * A source's connected time for its row: summed over every session it opened this meeting, so once
 * its session closed it is time it was connected ("not connected · 12s connected" contradicted
 * itself). Null before any session opened.
 */
export function describeSourceConnected(state: SttStreamState, connectedMs: number): string | null {
  if (connectedMs <= 0) return null;
  // formatDuration floors to whole seconds; a session open under one still counts.
  const time = connectedMs < 1000 ? 'under 1s' : formatDuration(connectedMs);
  return state === 'open' || state === 'connecting' ? `${time} connected` : `was connected ${time}`;
}

/** An estimate from the API's list price, so never shown as exact. */
export function describeCost(usd: number | null): string {
  if (usd === null) return 'cost unknown';
  if (usd === 0) return 'no cost';
  if (usd < 0.005) return 'under $0.01';
  return `about $${usd.toFixed(2)}`;
}

/**
 * The speech-to-text line in Details: what the vendor bills for this meeting so far (open time, silent or not). The
 * time sums both sources' sessions, each billed on its own, so a 12m 30s call with both open
 * reads "25m 00s connected". What the silence gate saved follows ("saved about $0.03 in silence").
 */
export function describeMeter(meter: SttMeterStatus): string {
  const { total } = meter;
  const line = `${meter.vendorName} · ${formatDuration(total.connectedMs)} connected · ${describeCost(total.estimatedCostUsd)}`;
  const saved = describeSilenceSaved(total);
  return saved === null ? line : `${line} · ${saved}`;
}

/** The rest of the meter, for the line's tooltip. */
export function meterDetails(meter: SttMeterStatus): string {
  const { total } = meter;
  const sessions = `${total.sessionsOpened} session${total.sessionsOpened === 1 ? '' : 's'} opened`;
  const closed = describeClosedInSilence(total);
  const perSource = AUDIO_SOURCES.map((source) => {
    const used = meter.sources[source];
    const sourceClosed = describeClosedInSilence(used);
    return `${SOURCE_NAME[source]}: ${formatDuration(used.connectedMs)} connected, ${describeCost(used.estimatedCostUsd)}${sourceClosed === null ? '' : `, ${sourceClosed}`}.`;
  });
  const parts = [
    `${sessions} · ${formatDuration(total.audioSentMs)} of audio sent${closed === null ? '' : ` · ${closed}`}.`,
    ...perSource,
  ];
  if (meter.silenceGate === 'spent') {
    parts.push('Silence gate off for this meeting: its reopens are spent.');
  }
  return parts.join(' ');
}

/**
 * What the silence gate saved (M3-T20), for the meter line: the money when it is known and more
 * than nothing, else the time it kept sessions closed. Null when it closed none: a meter built
 * without the gate fields (other tasks' fixtures) reads exactly as before.
 */
function describeSilenceSaved(meter: SttMeter): string | null {
  const closed = describeClosedInSilence(meter);
  if (closed === null) return null;
  const saved = meter.estimatedSavedUsd ?? null;
  return saved === null || saved <= 0 ? closed : `saved ${describeCost(saved)} in silence`;
}

/** "12m 00s closed in silence", or null when the gate kept nothing closed. */
function describeClosedInSilence(meter: SttMeter): string | null {
  const gatedMs = meter.gatedMs ?? 0;
  return gatedMs > 0 ? `${formatDuration(gatedMs)} closed in silence` : null;
}
