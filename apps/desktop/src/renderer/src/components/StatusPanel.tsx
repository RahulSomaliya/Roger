import { AUDIO_SOURCE_LABEL, type CaptureStatus } from '../../../shared/capture';
import { AUDIO_SOURCES } from '../../../shared/transcript';
import {
  describeHealth,
  describeMeter,
  describeSaved,
  describeStream,
  describeUpload,
  formatDuration,
  meterDetails,
} from '../format';

export function StatusPanel({ status }: { status: CaptureStatus }) {
  const recording = status.phase !== 'idle';
  return (
    <section className="panel" aria-label="Capture status">
      <dl className="status-grid">
        {AUDIO_SOURCES.map((source) => {
          const health = status.sources[source];
          const streamMessage = status.streamMessages[source];
          const connectedMs = status.meter?.sources[source].connectedMs ?? 0;
          return (
            <div key={source} className={`status-row health-${health.health}`}>
              <dt>{AUDIO_SOURCE_LABEL[source]}</dt>
              <dd>
                {describeHealth(health.health, health.chunks)}
                {health.message ? <span className="muted"> · {health.message}</span> : null}
                <span className="muted">
                  {' '}
                  · {describeStream(status.streams[source], health.health)}
                </span>
                {streamMessage !== null && streamMessage !== health.message ? (
                  <span className="muted"> ({streamMessage})</span>
                ) : null}
                {recording && connectedMs > 0 ? (
                  <span className="muted"> · {formatDuration(connectedMs)} connected</span>
                ) : null}
              </dd>
            </div>
          );
        })}
        <div className={`status-row${status.segmentsUnsaved > 0 ? ' save-failed' : ''}`}>
          <dt>Saved locally</dt>
          <dd>{describeSaved(status.segmentsStored, status.segmentsUnsaved)}</dd>
        </div>
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
    </section>
  );
}
