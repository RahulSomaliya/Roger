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
import { CaptureFacts } from './CaptureFacts';

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
  renderToStaticMarkup(createElement(CaptureFacts, { status }));

/** The text content, tags removed. */
const text = (html: string): string => html.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'");

/** The markup of one source's row. */
function row(html: string, source: 'mic' | 'system'): string {
  const start = html.indexOf(`data-source="${source}"`);
  if (start < 0) throw new Error(`no ${source} row`);
  const end = html.indexOf('</dd>', start);
  return html.slice(start, end);
}

describe('CaptureFacts while recording', () => {
  it('shows each source transcribing, with what it captured and its connected time', () => {
    const html = render(recording());
    expect(html).toContain('aria-label="Capture"');
    const mic = row(html, 'mic');
    // The naming list: the microphone and the call audio, not "Mic (me)".
    expect(text(mic)).toContain('Microphone');
    expect(text(mic)).toContain('Transcribing');
    expect(text(mic)).toContain('6m 15s captured');
    expect(text(mic)).toContain('6m 15s connected');
    expect(text(row(html, 'system'))).toContain('Call audio');
  });

  it('has no level meter: the loud no-audio warning is what says Roger cannot hear', () => {
    const html = render(recording());
    expect(html).not.toContain('level');
    expect(html).not.toContain('role="meter"');
  });

  it('keeps the meter line the owner asked to see, with the details as its tooltip', () => {
    const html = render(recording());
    expect(text(html)).toContain('Speech-to-text');
    expect(text(html)).toContain(describeMeter(METER));
    expect(html).toContain(`title="${meterDetails(METER)}"`);
    expect(text(html)).toContain('Saved on this Mac120 lines');
    // "Roger's server", never "Postgres" (docs/design.md, Naming list).
    expect(text(html)).toContain("Roger's serverall lines uploaded");
    expect(text(html)).not.toContain('Postgres');
  });

  it('says a stream reconnects, and why it dropped, while its audio flows', () => {
    const html = render(
      recording({
        streams: { mic: 'open', system: 'retrying' },
        streamMessages: { mic: null, system: 'the vendor closed the stream (1006)' },
      }),
    );
    const system = text(row(html, 'system'));
    expect(system).toContain('Reconnecting');
    expect(system).toContain('The vendor closed the stream (1006)');
    expect(system).toContain('was connected 6m 15s');
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
      expect(text(row(html, source))).toContain('Offline');
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
    expect(text(mic)).toContain('Paused');
    expect(text(mic)).toContain('no audio for over 5 s');
    expect(text(mic)).toContain('No audio for 30 s; reconnects when audio returns');
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

  it('reads a status from before the signal monitor as no audio yet', () => {
    const plain: SourceStatus = { health: 'pending', chunks: 0, lastChunkAt: null, message: null };
    const html = render(recording({ sources: { mic: plain, system: plain } }));
    expect(text(row(html, 'mic'))).toContain('Connected, no audio yet');
  });

  it('counts lines that could not be saved and an upload that waits', () => {
    const html = render(
      recording({
        segmentsUnsaved: 2,
        upload: { state: 'backoff', pending: 4, rejected: 0, lastError: 'down', nextAttemptAt: 1 },
      }),
    );
    expect(text(html)).toContain('120 lines · 2 could not be saved');
    expect(text(html)).toContain('4 lines waiting, retrying (down)');
  });
});

describe("CaptureFacts and main's error", () => {
  it('shows the raw text behind the plain error here, the one place it may be read', () => {
    const html = render(
      recording({
        error:
          'The speech-to-text service dropped the connection for the call audio. Roger reconnects on its own.',
        errorDetail: 'call audio: xAI connection failed: socket hang up',
      }),
    );
    // The sentence is the banner's and the header's; Details adds only what it came from.
    expect(text(html)).toContain('Problem');
    expect(text(html)).toContain('call audio: xAI connection failed: socket hang up');
    expect(text(html)).not.toContain('Roger reconnects on its own');
  });

  it('keeps it after Stop, as main does until the next Start', () => {
    const html = render({
      ...IDLE,
      error: 'Roger could not finish stopping these notes.',
      errorDetail: 'database or disk is full',
    });
    expect(text(html)).toContain('Problemdatabase or disk is full');
  });

  it('has no problem row while main reports none', () => {
    expect(text(render(recording()))).not.toContain('Problem');
  });
});

describe('CaptureFacts after Stop', () => {
  it("keeps the last recording's meter and the upload, with no source rows left to read", () => {
    const html = render({ ...IDLE, meter: METER });
    expect(text(html)).toContain('Last recording');
    expect(text(html)).toContain(describeMeter(METER));
    expect(text(html)).toContain('all lines uploaded');
    expect(html).not.toContain('data-source=');
    // Main's idle status counts no lines: "0 lines" would be false after a call.
    expect(text(html)).not.toContain('Saved on this Mac');
  });

  it('names the vendor when no meter was kept', () => {
    const html = render(recording({ meter: null }));
    expect(text(html)).toContain('Speech-to-textassemblyai');
  });
});
