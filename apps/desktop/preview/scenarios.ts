import {
  type CaptureStatus,
  idleCaptureStatus,
  type SourceStatus,
  type SttMeter,
  type SttMeterStatus,
  type UploadStatus,
} from '../src/shared/capture';
import type { RogerApi } from '../src/shared/ipc';
import { captureChannels } from '../src/shared/ipc/capture';
import {
  type AudioSource,
  type InterimTranscript,
  isAudioSource,
  SPEAKER_FOR_SOURCE,
  type TranscriptSegment,
} from '../src/shared/transcript';
import { apiUnreachableMessage, type ForcedTheme, type PreviewHub } from './control';
import liveCallFixture from './fixtures/live-call.json';
import pastMeetingFixture from './fixtures/past-meeting.json';

/**
 * The states the preview can open the renderer in: main as it would be on a Mac in that state,
 * played through the same hub the fakes use. Every status starts from idleCaptureStatus(), so a
 * field added to CaptureStatus later reaches the scenarios without an edit here.
 *
 * Scenarios start after the app has mounted and subscribed (preview/main.tsx), so the lines they
 * send reach the page: like main, the hub keeps no event for a listener that comes later. A fake
 * that answers reads (a meetings list, a meeting's stored lines) can record the meetings and lines
 * the scenarios play on the hub, as main's store records what it sends.
 */

export const SCENARIO_IDS = ['empty-mac', 'past-meeting', 'live-call', 'api-offline'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** The scenario a page opened without `?scenario=` shows: a Mac Roger has never recorded on. */
export const DEFAULT_SCENARIO: ScenarioId = 'empty-mac';

export function isScenarioId(value: string): value is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(value);
}

/** Stops what a scenario started (its timers). Safe to call more than once. */
export type StopScenario = () => void;

export interface ScenarioContext {
  hub: PreviewHub;
  /**
   * The composed fake, before the page sees it as `window.roger`. A scenario may replace a member
   * to answer as main does in its state; the replacement still answers through `hub.request`.
   */
  roger: RogerApi;
}

export interface Scenario {
  title: string;
  start(context: ScenarioContext): StopScenario;
}

/** The live call's new lines arrive this often, faster than speech, to load the transcript. */
export const LIVE_LINE_INTERVAL_MS = 200;
/** Lines the live call already has when the page opens: a long call, for scrolling and reveal. */
export const LIVE_CALL_FIRST_LINES = 500;

/** The preview page's query, `?scenario=live-call&theme=dark`. qa/driver.ts builds it here. */
export interface PreviewQuery {
  scenario: ScenarioId;
  theme: ForcedTheme | null;
}

export function parsePreviewQuery(search: string): PreviewQuery {
  const params = new URLSearchParams(search);
  const scenario = params.get('scenario') ?? DEFAULT_SCENARIO;
  if (!isScenarioId(scenario)) {
    throw new Error(
      `Unknown preview scenario "${scenario}": use one of ${SCENARIO_IDS.join(', ')}`,
    );
  }
  const theme = params.get('theme');
  if (theme !== null && theme !== 'light' && theme !== 'dark') {
    throw new Error(
      `Unknown preview theme "${theme}": use light or dark, or leave it out to follow the system`,
    );
  }
  return { scenario, theme };
}

export function previewSearch(query: PreviewQuery): string {
  const params = new URLSearchParams({ scenario: query.scenario });
  if (query.theme !== null) params.set('theme', query.theme);
  return `?${params.toString()}`;
}

/**
 * The id of line `line` (counting from 1) of a preview meeting: the meeting id's first four groups
 * and the line number, so it is a UUIDv4 like the ids the desktop makes, and a QA script can cite
 * "line 40" of the live call without reading the page.
 */
export function segmentIdForLine(meetingId: string, line: number): string {
  if (!Number.isInteger(line) || line < 1 || line > 0xffff_ffff_ffff) {
    throw new Error(`No line ${line} in meeting ${meetingId}: lines count from 1`);
  }
  return `${meetingId.slice(0, 24)}${line.toString(16).padStart(12, '0')}`;
}

interface ScriptLine {
  source: AudioSource;
  text: string;
}

interface TimedLine extends ScriptLine {
  /** Milliseconds from the meeting start, as TranscriptSegment counts them. */
  startMs: number;
  endMs: number;
}

/** A meeting the scenarios play; its lines are numbered from 1 in this order. */
interface PreviewMeeting {
  meetingId: string;
  startedAtMs: number;
  sttProvider: string;
}

function scriptSource(raw: string, where: string): AudioSource {
  if (isAudioSource(raw)) return raw;
  throw new Error(`${where}: source "${raw}" is neither mic nor system`);
}

function meterStatus(vendorName: string, sources: Record<AudioSource, SttMeter>): SttMeterStatus {
  const { mic, system } = sources;
  return {
    vendorName,
    total: {
      sessionsOpened: mic.sessionsOpened + system.sessionsOpened,
      connectedMs: mic.connectedMs + system.connectedMs,
      audioSentMs: mic.audioSentMs + system.audioSentMs,
      estimatedCostUsd:
        mic.estimatedCostUsd === null || system.estimatedCostUsd === null
          ? null
          : mic.estimatedCostUsd + system.estimatedCostUsd,
    },
    sources,
  };
}

/** A standup that has ended: every line stored, uploaded, and its meter kept as after Stop. */
export const PAST_MEETING = {
  meetingId: pastMeetingFixture.meetingId,
  title: pastMeetingFixture.title,
  startedAt: pastMeetingFixture.startedAt,
  sttProvider: pastMeetingFixture.sttProvider,
  meter: meterStatus(pastMeetingFixture.meter.vendorName, pastMeetingFixture.meter.sources),
  lines: pastMeetingFixture.lines.map((line, index): TimedLine => ({
    ...line,
    source: scriptSource(line.source, `past-meeting.json line ${index + 1}`),
  })),
};

/** A client call in progress. Its script repeats for as long as the call runs. */
export const LIVE_CALL = {
  meetingId: liveCallFixture.meetingId,
  title: liveCallFixture.title,
  sttProvider: liveCallFixture.sttProvider,
  vendorName: liveCallFixture.vendorName,
  pricePerStreamHourUsd: liveCallFixture.pricePerStreamHourUsd,
  script: liveCallFixture.lines.map((line, index): ScriptLine => ({
    ...line,
    source: scriptSource(line.source, `live-call.json line ${index + 1}`),
  })),
};

/** Speech-ish timing for a scripted line: about 330 ms a word, with a pause between lines. */
const MS_PER_WORD = 330;
const MIN_LINE_MS = 900;
const PAUSE_MS = 450;
/** The renderer sends 100 ms PCM chunks (src/renderer/src/audio/PcmChunker.ts). */
const CHUNK_MS = 100;
/** The uploader's longest wait between attempts while the API is away. */
const UPLOAD_RETRY_MS = 30_000;

function segment(meeting: PreviewMeeting, index: number, line: TimedLine): TranscriptSegment {
  return {
    id: segmentIdForLine(meeting.meetingId, index + 1),
    meetingId: meeting.meetingId,
    source: line.source,
    speaker: SPEAKER_FOR_SOURCE[line.source],
    startMs: line.startMs,
    endMs: line.endMs,
    text: line.text,
    confidence: 0.92,
    words: null,
    createdAt: new Date(meeting.startedAtMs + line.endMs).toISOString(),
  };
}

function activeSource(elapsedMs: number, now: number): SourceStatus {
  return {
    health: 'active',
    chunks: Math.floor(elapsedMs / CHUNK_MS),
    lastChunkAt: now,
    message: null,
  };
}

/** What main sends while a meeting records: both sources live, `lines` stored. */
function recordingStatus(
  meeting: PreviewMeeting,
  lines: number,
  elapsedMs: number,
  meter: SttMeterStatus,
  upload: UploadStatus,
): CaptureStatus {
  const now = Date.now();
  return {
    ...idleCaptureStatus(upload),
    phase: 'recording',
    meetingId: meeting.meetingId,
    startedAt: new Date(meeting.startedAtMs).toISOString(),
    sttProvider: meeting.sttProvider,
    sources: { mic: activeSource(elapsedMs, now), system: activeSource(elapsedMs, now) },
    streams: { mic: 'open', system: 'open' },
    segmentsStored: lines,
    meter,
  };
}

const ALL_UPLOADED: UploadStatus = {
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
};

/**
 * Plays the past meeting as main sent it, then stops it: its status while recording, every line,
 * and the idle status after Stop with `upload` and the meeting's meter. Returns that last status.
 */
function playPastMeeting(hub: PreviewHub, upload: UploadStatus): CaptureStatus {
  const meeting: PreviewMeeting = {
    meetingId: PAST_MEETING.meetingId,
    startedAtMs: Date.parse(PAST_MEETING.startedAt),
    sttProvider: PAST_MEETING.sttProvider,
  };
  const lines = PAST_MEETING.lines;
  const elapsedMs = lines.at(-1)?.endMs ?? 0;
  hub.emit(
    captureChannels.CaptureStatusChanged,
    recordingStatus(meeting, lines.length, elapsedMs, PAST_MEETING.meter, upload),
  );
  for (const [index, line] of lines.entries()) {
    hub.emit(captureChannels.TranscriptSegment, segment(meeting, index, line));
  }
  const stopped: CaptureStatus = { ...idleCaptureStatus(upload), meter: PAST_MEETING.meter };
  hub.emit(captureChannels.CaptureStatusChanged, stopped);
  return stopped;
}

/** The live call's script, line after line and round again, timed from the meeting start. */
function liveTimeline(): () => TimedLine {
  const script = LIVE_CALL.script;
  let index = 0;
  let cursorMs = PAUSE_MS;
  return () => {
    const line = script[index % script.length];
    if (line === undefined) throw new Error('live-call.json has no lines');
    index += 1;
    const words = line.text.split(/\s+/).length;
    const startMs = cursorMs;
    const endMs = startMs + Math.max(MIN_LINE_MS, words * MS_PER_WORD);
    cursorMs = endMs + PAUSE_MS;
    return { ...line, startMs, endMs };
  };
}

/** The first words of a line, as an interim shows them before the vendor finalises it. */
function interimOf(meeting: PreviewMeeting, line: TimedLine): InterimTranscript {
  const words = line.text.split(/\s+/);
  const shown = words.slice(0, Math.ceil(words.length / 2));
  return {
    meetingId: meeting.meetingId,
    source: line.source,
    text: shown.join(' '),
    startMs: line.startMs,
    endMs: line.startMs + shown.length * MS_PER_WORD,
  };
}

function startLiveCall({ hub }: ScenarioContext): StopScenario {
  const next = liveTimeline();
  const first = Array.from({ length: LIVE_CALL_FIRST_LINES }, next);
  // The call began as long ago as its lines so far took, so elapsed times read true.
  const meeting: PreviewMeeting = {
    meetingId: LIVE_CALL.meetingId,
    startedAtMs: Date.now() - (first.at(-1)?.endMs ?? 0),
    sttProvider: LIVE_CALL.sttProvider,
  };
  const perSource = (elapsedMs: number): SttMeter => ({
    sessionsOpened: 1,
    connectedMs: elapsedMs,
    audioSentMs: elapsedMs,
    estimatedCostUsd: (LIVE_CALL.pricePerStreamHourUsd * elapsedMs) / 3_600_000,
  });
  // Main sends a status with every final line (CaptureService's onSegment).
  const sendStatus = (lines: number, elapsedMs: number): void => {
    const sources = { mic: perSource(elapsedMs), system: perSource(elapsedMs) };
    hub.emit(
      captureChannels.CaptureStatusChanged,
      recordingStatus(
        meeting,
        lines,
        elapsedMs,
        meterStatus(LIVE_CALL.vendorName, sources),
        ALL_UPLOADED,
      ),
    );
  };

  let lines = first.length;
  sendStatus(lines, first.at(-1)?.endMs ?? 0);
  for (const [index, line] of first.entries()) {
    hub.emit(captureChannels.TranscriptSegment, segment(meeting, index, line));
  }
  let upcoming = next();
  hub.emit(captureChannels.TranscriptInterim, interimOf(meeting, upcoming));

  const timer = setInterval(() => {
    hub.emit(captureChannels.TranscriptSegment, segment(meeting, lines, upcoming));
    lines += 1;
    sendStatus(lines, upcoming.endMs);
    upcoming = next();
    hub.emit(captureChannels.TranscriptInterim, interimOf(meeting, upcoming));
  }, LIVE_LINE_INTERVAL_MS);

  const stop: StopScenario = () => {
    clearInterval(timer);
    stopFollowing();
  };
  // Stop (the fake's stopCapture) or a scenario script ending the call ends the new lines too,
  // as main sends no line for a meeting it is no longer recording.
  const stopFollowing = hub.on(captureChannels.CaptureStatusChanged, (status: CaptureStatus) => {
    if (status.phase !== 'recording' || status.meetingId !== meeting.meetingId) stop();
  });
  return stop;
}

/** Main's words for a Start whose token request found no server (errorWords.ts serverAway). */
const API_AWAY_AT_START =
  'Roger could not reach its server, so notes did not start. Check the Mac is online, then Start notes again.';

function startApiOffline({ hub, roger }: ScenarioContext): StopScenario {
  // A meeting recorded while the API was away: every line safe on this Mac, none in Postgres.
  // The pending meeting is created first (TranscriptUploader.syncMeeting), so that is what fails.
  const stopped = playPastMeeting(hub, {
    state: 'backoff',
    pending: PAST_MEETING.lines.length,
    rejected: 0,
    lastError: apiUnreachableMessage('POST /v1/meetings'),
    nextAttemptAt: Date.now() + UPLOAD_RETRY_MS,
  });
  hub.setApiOffline(true);
  // Start fetches a speech-to-text token before anything else, and CaptureService.start reports
  // that ApiError in the status it answers instead of rejecting: main's plain sentence for it
  // (main/capture/errorWords.ts START_FAILURE_SENTENCES.serverAway, which this copies: the preview
  // cannot import main), and the raw text as the detail only Details shows.
  roger.startCapture = () =>
    hub.request(captureChannels.CaptureStart, () => {
      const failed: CaptureStatus = {
        ...stopped,
        error: API_AWAY_AT_START,
        errorDetail: apiUnreachableMessage('POST /v1/stt/token'),
      };
      hub.emit(captureChannels.CaptureStatusChanged, failed);
      return failed;
    });
  return () => undefined;
}

export const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  'empty-mac': {
    title: 'An empty Mac: Roger has never recorded here',
    start: () => () => undefined,
  },
  'past-meeting': {
    title: 'A past meeting: a standup that has ended and uploaded',
    start: ({ hub }) => {
      playPastMeeting(hub, ALL_UPLOADED);
      return () => undefined;
    },
  },
  'live-call': {
    title: `A live call: ${LIVE_CALL_FIRST_LINES} lines, then one every ${LIVE_LINE_INTERVAL_MS} ms`,
    start: startLiveCall,
  },
  'api-offline': {
    title: 'The API offline: a meeting waiting to upload, API requests failing',
    start: startApiOffline,
  },
};
