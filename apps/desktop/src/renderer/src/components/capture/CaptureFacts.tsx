import type { CaptureStatus } from '../../../../shared/capture';
import { AUDIO_SOURCES, type AudioSource } from '../../../../shared/transcript';
import {
  describeHealth,
  describeMeter,
  describeSaved,
  describeSourceConnected,
  describeStream,
  describeUpload,
  meterDetails,
  SOURCE_NAME,
} from '../../format';
import './captureDetails.css';

/**
 * What the old capture panel showed on the meeting page and Details holds now (docs/plans/
 * redesign.md, call 3): nobody acts on these mid-call, and a problem reaches the page as a warning
 * or a problem line. While it records: a row per source with its stream's state, what it captured,
 * its connected time, its device and why its stream is not open; then the lines saved on this Mac,
 * the upload, and the speech-to-text line. After Stop: the upload and the last recording's meter.
 *
 * Keep the meter line in every phase: it is the vendor's billed time and cost, which the owner
 * asked to see (cost guards, G7), "Last recording" after Stop. No level meter: a bar moving twice
 * a second was decoration, and the loud no-audio warning is what says Roger cannot hear.
 */
export function CaptureFacts({ status }: { status: CaptureStatus }) {
  const recording = status.phase !== 'idle';
  return (
    <section className="dialog-panel capture-facts" aria-label="Capture">
      <dl className="facts">
        {recording
          ? AUDIO_SOURCES.map((source) => (
              <SourceFact key={source} source={source} status={status} />
            ))
          : null}
        {/* Main's idle status counts no lines, so after Stop "0 lines" would be false. */}
        {recording ? (
          <Fact
            label="Saved on this Mac"
            value={describeSaved(status.segmentsStored, status.segmentsUnsaved)}
          />
        ) : null}
        <Fact label="Roger's server" value={describeUpload(status.upload)} />
        {status.meter ? (
          // What the vendor bills: open time, silent or not. The tooltip has the rest.
          <Fact
            label={recording ? 'Speech-to-text' : 'Last recording'}
            value={describeMeter(status.meter)}
            title={meterDetails(status.meter)}
          />
        ) : status.sttProvider ? (
          <Fact label="Speech-to-text" value={status.sttProvider} />
        ) : null}
      </dl>
    </section>
  );
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd title={title}>{value}</dd>
    </div>
  );
}

/**
 * One source: its name, its stream's state (format.ts describeStream), then what it captured, its
 * own reason, its connected time and its device, and on a line of its own why its stream is not
 * open (`streamMessages`), unless that repeats its own reason.
 */
function SourceFact({ source, status }: { source: AudioSource; status: CaptureStatus }) {
  const health = status.sources[source];
  const state = status.streams[source];
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
    <div className="fact" data-source={source} data-health={health.health}>
      <dt>{SOURCE_NAME[source]}</dt>
      <dd>
        <span className="fact-state">{describeStream(state, health.health)}</span>
        <span className="fact-detail">{detail.join(' · ')}</span>
        {reason !== null ? <span className="fact-detail">{sentence(reason)}</span> : null}
      </dd>
    </div>
  );
}

/**
 * Main's stream messages are clauses ("the vendor closed the stream"); on a line of their own they
 * read as a sentence.
 */
function sentence(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}
