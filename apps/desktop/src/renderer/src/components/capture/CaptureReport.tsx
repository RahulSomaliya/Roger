import type { CaptureReport as Report } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { describeEvent, describeGap, describeStopReason, summarizeGaps } from './reportText';
import './captureDetails.css';

/**
 * What happened to a meeting's capture (the `meetingCaptureReport` region, after Stop): why it
 * ended, the gaps with where each re-run stands, and the timeline of everything capture did or saw.
 * The gaps are the part a person acts on (Re-run is on the audio note); the timeline is for
 * understanding a bad call, so it stays closed until asked for. Never transcript text: a capture
 * event holds codes, counts and timings only.
 */
export function CaptureReport({ report }: { report: Report }) {
  const stop = describeStopReason(report.stopReason);
  return (
    <section className="panel capture-report" aria-label="Capture report">
      <h2 className="capture-report-title">Capture report</h2>
      {stop === null ? null : <p className="report-stop">{stop}</p>}
      <p className="report-gap-summary">{summarizeGaps(report.gaps)}</p>
      {report.gaps.length === 0 ? null : (
        <ul className="report-gaps">
          {report.gaps.map((gap) => {
            const view = describeGap(gap);
            return (
              <li key={gap.id} className="report-gap" data-status={view.status}>
                <span className="report-gap-span">{view.span}</span>
                <span className="report-gap-source">{view.source}</span>
                <span className="report-gap-reason">Lost because {view.reason}.</span>
                <span className="report-gap-status">{view.statusText}</span>
              </li>
            );
          })}
        </ul>
      )}
      {report.events.length === 0 ? null : (
        <details className="report-timeline">
          <summary>Timeline ({report.events.length} events)</summary>
          <ol className="report-events">
            {report.events.map((event, index) => (
              // Events have no id of their own; the list is never reordered, only read.
              <li key={`${event.at}-${index}`} className="report-event">
                <time className="report-event-time" dateTime={event.at}>
                  {formatClockTime(event.at)}
                </time>
                <span className="report-event-text">{describeEvent(event)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
