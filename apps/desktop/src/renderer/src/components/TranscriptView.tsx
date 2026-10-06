import { useEffect, useRef } from 'react';
import {
  AUDIO_SOURCES,
  type AudioSource,
  type InterimTranscript,
  type TranscriptSegment,
} from '../../../shared/transcript';
import { formatOffset } from '../format';

interface Props {
  segments: TranscriptSegment[];
  interim: Record<AudioSource, InterimTranscript | null>;
  recording: boolean;
}

const SPEAKER_LABEL = { me: 'Me', them: 'Them' } as const;

export function TranscriptView({ segments, interim, recording }: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [segments.length, interim.mic?.text, interim.system?.text]);

  const ordered = [...segments].sort(
    (a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source),
  );
  return (
    <section className="transcript" aria-label="Transcript" aria-live="polite">
      {ordered.length === 0 && !recording ? (
        <p className="muted empty">Press Start before a call. Lines appear here as people speak.</p>
      ) : null}
      {ordered.map((segment) => (
        <p key={segment.id} className={`line speaker-${segment.speaker}`}>
          <span className="time">{formatOffset(segment.startMs)}</span>
          <span className="speaker">{SPEAKER_LABEL[segment.speaker]}</span>
          <span className="text">{segment.text}</span>
        </p>
      ))}
      {AUDIO_SOURCES.map((source) => {
        const line = interim[source];
        return line ? (
          <p key={`interim-${source}`} className="line interim">
            <span className="time">{formatOffset(line.startMs)}</span>
            <span className="speaker">{source === 'mic' ? 'Me' : 'Them'}</span>
            <span className="text">{line.text}</span>
          </p>
        ) : null;
      })}
      <div ref={bottom} />
    </section>
  );
}
