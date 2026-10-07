import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type CaptureStatus,
  idleCaptureStatus,
  type SourceStatus,
  type SttMeterStatus,
} from '../../../../shared/capture';
import { describeMeter, meterDetails } from '../../format';
import { StreamStatus } from './StreamStatus';

const IDLE = idleCaptureStatus({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
});

const METER: SttMeterStatus = {
  vendorName: 'AssemblyAI',
  total: { sessionsOpened: 3, connectedMs: 750_000, audioSentMs: 740_000, estimatedCostUsd: 0.03 },
  sources: {
    mic: { sessionsOpened: 1, connectedMs: 375_000, audioSentMs: 370_000, estimatedCostUsd: 0.015 },
    system: {
      sessionsOpened: 2,
      connectedMs: 375_000,
      audioSentMs: 370_000,
      estimatedCostUsd: 0.015,
    },
  },
};

const live = (fields: Partial<SourceStatus> = {}): SourceStatus => ({
  health: 'active',
  chunks: 3_750,
  lastChunkAt: 1,
  message: null,
  signal: 'signal',
  levelDb: -18,
  ...fields,
});

function recording(fields: Partial<CaptureStatus> = {}): CaptureStatus {
  return {
    ...IDLE,
    phase: 'recording',
    meetingId: '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13',
    title: 'Client call',
    startedAt: '2026-10-07T09:00:00.000Z',
    sttProvider: 'assemblyai',
    sources: { mic: live(), system: live({ levelDb: -27.6 }) },
    streams: { mic: 'open', system: 'open' },
    segmentsStored: 120,
    meter: METER,
    ...fields,
  };
}

const render = (status: CaptureStatus): string =>
  renderToStaticMarkup(createElement(StreamStatus, { status }));

/** The text content, tags removed. */
const text = (html: string): string => html.replace(/<[^>]*>/g, '');

/** The markup of one source's row. */
function row(html: string, source: 'mic' | 'system'): string {
  const start = html.indexOf(`data-source="${source}"`);
  if (start < 0) throw new Error(`no ${source} row`);
  const end = html.indexOf('</li>', start);
  return html.slice(start, end);
}

describe('StreamStatus while recording', () => {
  it('shows each source transcribing, with its level, what it captured and its connected time', () => {
    const html = render(recording());
    expect(html).toContain('aria-label="Capture status"');
    const mic = row(html, 'mic');
    expect(text(mic)).toContain('Mic (me)');
    expect(mic).toMatch(/class="stream-state" data-tone="ok"[^>]*>Transcribing</);
    expect(mic).toContain('aria-label="Mic (me) level"');
    expect(mic).toContain('aria-valuetext="-18 dB"');
    expect(text(mic)).toContain('6m 15s captured');
    expect(text(mic)).toContain('6m 15s connected');
    expect(row(html, 'system')).toContain('aria-valuetext="-28 dB"');
  });

  it('keeps the meter line the owner asked to see, with the details as its tooltip', () => {
    const html = render(recording());
    expect(text(html)).toContain('Speech-to-text');
    expect(text(html)).toContain(describeMeter(METER));
    expect(html).toContain(`title="${meterDetails(METER)}"`);
    expect(text(html)).toContain('Saved locally120 lines');
    expect(text(html)).toContain('Postgresall lines uploaded');
  });

  it('says a stream reconnects, and why it dropped, while its audio flows', () => {
    const html = render(
      recording({
        streams: { mic: 'open', system: 'retrying' },
        streamMessages: { mic: null, system: 'the vendor closed the stream (1006)' },
      }),
    );
    const system = row(html, 'system');
    expect(system).toMatch(/data-tone="warn"[^>]*>Reconnecting</);
    expect(text(system)).toContain('The vendor closed the stream (1006)');
    expect(text(system)).toContain('was connected 6m 15s');
  });

  it('says Offline, never Reconnecting, while the Mac has no network', () => {
    const message = 'the Mac is offline; reconnects when the network is back';
    const html = render(
      recording({
        streams: { mic: 'offline', system: 'offline' },
        streamMessages: { mic: message, system: message },
      }),
    );
    for (const source of ['mic', 'system'] as const) {
      expect(row(html, source)).toMatch(/data-tone="warn"[^>]*>Offline</);
      expect(text(row(html, source))).toContain(
        'The Mac is offline; reconnects when the network is back',
      );
    }
    expect(text(html)).not.toContain('Reconnecting');
  });

  it('says Paused with its reason, and marks a source that sends nothing', () => {
    const html = render(
      recording({
        sources: { mic: live({ health: 'stalled', levelDb: null }), system: live() },
        streams: { mic: 'paused', system: 'open' },
        streamMessages: { mic: 'no audio for 30 s; reconnects when audio returns', system: null },
      }),
    );
    const mic = row(html, 'mic');
    expect(mic).toContain('data-health="stalled"');
    expect(mic).toMatch(/data-tone="warn"[^>]*>Paused</);
    expect(text(mic)).toContain('no audio for over 5 s');
    expect(text(mic)).toContain('No audio for 30 s; reconnects when audio returns');
    // It carried sound before the chunks stopped.
    expect(mic).toContain('aria-valuetext="no audio"');
  });

  it("names a source's device and says its own reason once", () => {
    const reason = 'the microphone track ended';
    const html = render(
      recording({
        sources: {
          mic: live({ health: 'ended', message: reason, device: 'MacBook Pro Microphone' }),
          system: live({ device: 'External Headphones' }),
        },
        streams: { mic: 'closed', system: 'open' },
        streamMessages: { mic: reason, system: null },
      }),
    );
    const mic = row(html, 'mic');
    expect(text(mic)).toContain('MacBook Pro Microphone');
    expect(text(mic).match(/microphone track ended/gi)).toHaveLength(1);
    expect(text(row(html, 'system'))).toContain('External Headphones');
  });

  it('reads a status from before the signal monitor as no level yet', () => {
    const plain: SourceStatus = { health: 'pending', chunks: 0, lastChunkAt: null, message: null };
    const html = render(recording({ sources: { mic: plain, system: plain } }));
    expect(row(html, 'mic')).toContain('aria-valuetext="no audio yet"');
    expect(row(html, 'mic')).toMatch(/data-tone="pending"[^>]*>Connected, no audio yet</);
  });

  it('flags lines that could not be saved and an upload that waits', () => {
    const html = render(
      recording({
        segmentsUnsaved: 2,
        upload: { state: 'backoff', pending: 4, rejected: 0, lastError: 'down', nextAttemptAt: 1 },
      }),
    );
    expect(html).toContain('status-row save-failed');
    expect(text(html)).toContain('120 lines · 2 could not be saved');
    expect(html).toContain('status-row upload-backoff');
  });

  it('shows the notices of what Roger recovered from', () => {
    const html = render(
      recording({
        notices: [
          {
            kind: 'device-switched',
            source: 'mic',
            at: '2026-10-07T09:05:00.000Z',
            message: 'Switched to AirPods Pro',
          },
        ],
      }),
    );
    expect(text(html)).toContain('Switched to AirPods Pro');
  });
});

describe('StreamStatus after Stop', () => {
  it("keeps the last recording's meter and the upload, with no stream rows left to read", () => {
    const html = render({ ...IDLE, meter: METER });
    expect(html).toContain('aria-label="Capture status"');
    expect(text(html)).toContain('Last recording');
    expect(text(html)).toContain(describeMeter(METER));
    expect(text(html)).toContain('all lines uploaded');
    expect(html).not.toContain('data-source=');
    // Main's idle status counts no lines: "0 lines" would be false after a call.
    expect(text(html)).not.toContain('Saved locally');
  });

  it('names the vendor when no meter was kept', () => {
    const html = render(recording({ meter: null }));
    expect(text(html)).toContain('Speech-to-textassemblyai');
  });
});
