import { AUDIO_SOURCE_LABEL, type CaptureStatus } from '../../../../shared/capture';
import { AUDIO_SOURCES, type AudioSource } from '../../../../shared/transcript';
import {
  describeHealth,
  describeMeter,
  describeSaved,
  describeSourceConnected,
  describeStream,
  describeUpload,
  meterDetails,
  streamTone,
} from '../../format';
import './captureStatus.css';
import { LevelMeter } from './LevelMeter';
import { Notices } from './Notices';

/**
 * A meeting's capture status (the meeting page's capture status region; M2-T20a replaced M1's
 * StatusPanel with it). While it records: a row per source with its stream's state, its level,
 * what it captured, its connected time, its device and why its stream is not open; then the lines
 * saved, the upload, the meter line, and what Roger recovered from on its own. After Stop: the
 * upload and the last recording's meter.
 *
 * Keep the meter line in every phase: it is the vendor's billed time and cost, which the owner
 * asked to see (cost guards, G7), "Last recording" after Stop. The stop notice is not here: the
 * shell's banner shows it above every page (app/BannerSlot.tsx).
 */
export function StreamStatus({ status }: { status: CaptureStatus }) {
  const recording = status.phase !== 'idle';
  return (
    <section className="panel capture-status" aria-label="Capture status">
      {recording ? (
        <ul className="capture-streams">
          {AUDIO_SOURCES.map((source) => (
            <SourceRow key={source} source={source} status={status} />
          ))}
        </ul>
      ) : null}
      <dl className="status-grid">
        {/* Main's idle status counts no lines, so after Stop "0 lines" would be false. */}
        {recording ? (
          <div className={`status-row${status.segmentsUnsaved > 0 ? ' save-failed' : ''}`}>
            <dt>Saved locally</dt>
            <dd>{describeSaved(status.segmentsStored, status.segmentsUnsaved)}</dd>
          </div>
        ) : null}
        <div className={`status-row upload-${status.upload.state}`}>
          <dt>Postgres</dt>
          <dd>{describeUpload(status.upload)}</dd>
        </div>
        {status.meter ? (
          // What the vendor bills: open time, silent or not. The tooltip has the rest.
          <div className="status-row">
            <dt>{recording ? 'Speech-to-text' : 'Last recording'}</dt>
            <dd title={meterDetails(status.meter)}>{describeMeter(status.meter)}</dd>
          </div>
        ) : status.sttProvider ? (
          <div className="status-row">
            <dt>Speech-to-text</dt>
            <dd>{status.sttProvider}</dd>
          </div>
        ) : null}
      </dl>
      {recording ? <Notices notices={status.notices ?? []} /> : null}
    </section>
  );
}

/**
 * One source: its name, its stream's state (format.ts describeStream, coloured by streamTone), its
 * level, then what it captured, its own reason, its connected time and its device, and on a line
 * of its own why its stream is not open (`streamMessages`), unless that repeats its own reason.
 */
function SourceRow({ source, status }: { source: AudioSource; status: CaptureStatus }) {
  const health = status.sources[source];
  const state = status.streams[source];
  const label = AUDIO_SOURCE_LABEL[source];
  const connected = describeSourceConnected(state, status.meter?.sources[source].connectedMs ?? 0);
  const detail = [
    describeHealth(health.health, health.chunks),
    health.message,
    connected,
    health.device ?? null,
  ].filter((part) => part !== null && part !== '');
  const streamMessage = status.streamMessages[source];
  const reason = streamMessage !== null && streamMessage !== health.message ? streamMessage : null;
  return (
    <li className="capture-stream" data-source={source} data-health={health.health}>
      <div className="capture-stream-head">
        <span className="capture-stream-name">{label}</span>
        <span className="stream-state" data-tone={streamTone(state, health.health)}>
          {describeStream(state, health.health)}
        </span>
        <LevelMeter
          label={label}
          levelDb={health.levelDb ?? null}
          signal={health.signal ?? 'unknown'}
        />
      </div>
      <p className="capture-stream-detail">{detail.join(' · ')}</p>
      {reason !== null ? <p className="capture-stream-reason">{sentence(reason)}</p> : null}
    </li>
  );
}

/**
 * Main's stream messages are clauses ("the vendor closed the stream"); on a line of their own they
 * read as a sentence.
 */
function sentence(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}
