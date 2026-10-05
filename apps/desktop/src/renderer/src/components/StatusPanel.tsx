import { AUDIO_SOURCE_LABEL, type CaptureStatus } from '../../../shared/capture';
import { AUDIO_SOURCES } from '../../../shared/transcript';
import { describeHealth, describeStream, describeUpload } from '../format';

export function StatusPanel({ status }: { status: CaptureStatus }) {
  return (
    <section className="panel" aria-label="Capture status">
      <dl className="status-grid">
        {AUDIO_SOURCES.map((source) => {
          const health = status.sources[source];
          return (
            <div key={source} className={`status-row health-${health.health}`}>
              <dt>{AUDIO_SOURCE_LABEL[source]}</dt>
              <dd>
                {describeHealth(health.health, health.chunks)}
                {health.message ? <span className="muted"> · {health.message}</span> : null}
                <span className="muted"> · {describeStream(status.streams[source])}</span>
              </dd>
            </div>
          );
        })}
        <div className="status-row">
          <dt>Saved locally</dt>
          <dd>{status.segmentsStored} lines</dd>
        </div>
        <div className={`status-row upload-${status.upload.state}`}>
          <dt>Postgres</dt>
          <dd>{describeUpload(status.upload)}</dd>
        </div>
        {status.sttProvider ? (
          <div className="status-row">
            <dt>Speech-to-text</dt>
            <dd>{status.sttProvider}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
