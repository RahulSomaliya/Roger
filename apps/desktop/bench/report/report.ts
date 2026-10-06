import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ECHO_FILTER_VERSION } from '../../src/main/capture/echo/EchoFilter';
import { isFiniteNumber, isRecord } from '../../src/main/stt/json';
import { LatencyMeter, type LatencySummary } from '../../src/main/stt/LatencyMeter';
import { AUDIO_SOURCES, type AudioSource } from '../../src/shared/transcript';
import { type BootstrapInterval, type RatioSample, bootstrapInterval } from '../core/bootstrap';
import {
  BenchFileError,
  type EventRecord,
  type RunAttempt,
  type RunItem,
  type RunRecord,
  type RunStream,
  readEvents,
  readRun,
  runPaths,
} from '../core/events';
import { writePrivateFile } from '../core/files';
import { NORMALISER_VERSION } from '../core/normalise';
import { parseReference } from '../core/reference';
import {
  type PreparedTerm,
  type TermCount,
  countTerms,
  prepareTerms,
  scoreTerms,
} from '../core/terms';
import { WAV_SAMPLE_RATE } from '../core/wav';
import { type WerCounts, errorCount, errorRate, poolCounts, scoreSpeakers } from '../core/wer';
import {
  type BenchItem,
  type ItemOrigin,
  readItem,
  readItemAudio,
  readItemReference,
} from '../run/items';
import { type ReplayedFinal, meScoring } from './echo';

/**
 * `bench score` and `bench report --summary` (M3 design, "Scoring" and "Report columns"). A run's
 * files hold what the vendor sent; scoring reads them every time, so a new normaliser rescores old
 * runs. Per configuration: pooled WER with its 95% interval (Me after the echo filter), Me WER, Me
 * on the raw mic (diagnostic), Them WER, term recall and false alarms, word display and final
 * latency per stream, the longest wait, items retried, failed and left out (and why), stream hours
 * and cost per meeting hour.
 *
 * Cost comes from each token's own `price_per_hour_usd`, the API's one price table
 * (stt_vendors.py), so the bench prices exactly as the app's meter does; the bench keeps no price
 * table of its own, and an unknown price is reported as unknown, never as $0.
 *
 * Nothing here writes transcript text: reports and the summary hold ids, counts, rates, times and
 * money only, because the summary is what goes into docs/research/stt-benchmark.md (only aggregate
 * numbers are committed, M3 D2).
 */

/** Bumped when a report field changes meaning; `report --summary` refuses other versions. */
export const REPORT_VERSION = 1;

/** What `score` reads for one item of a run. */
export interface ItemInput {
  record: RunItem;
  /** Null when the item's folder is gone (`bench forget`). */
  item: BenchItem | null;
  /** reference.txt, null while the item has none. */
  reference: string | null;
  /** The last attempt's events per stream it opened. */
  events: ReadonlyMap<AudioSource, readonly EventRecord[]>;
  /** Length of each stream's audio, from its WAV file. */
  audioMs: ReadonlyMap<AudioSource, number>;
}

export interface ScoreOptions {
  /** False for `score --no-echo-filter`: speaker items leave Me and the pooled number. */
  echoFilter: boolean;
  /** ISO 8601. */
  scoredAt: string;
}

/** A pooled word error rate: errors over reference words, null with no reference words. */
export interface WerFigure {
  errors: number;
  referenceWords: number;
  rate: number | null;
}

export interface LeftOutItem {
  itemId: string;
  reason: string;
}

export interface RunReport {
  reportVersion: typeof REPORT_VERSION;
  runId: string;
  provider: string;
  model: string;
  scoredAt: string;
  gate: boolean;
  keyterms: { enabled: boolean; terms: number };
  /** The versions this score ran with, which may be newer than the run's own. */
  normaliserVersion: number;
  echoFilterVersion: number;
  echoFilter: boolean;
  items: {
    total: number;
    /** In the pooled WER. */
    scored: number;
    retried: number;
    /** Failed after every retry: the vendor choice's gate. */
    failed: number;
    leftOut: LeftOutItem[];
    /** Meet recordings are scored on Them alone (M3 design, "Where recordings come from"). */
    scoredByOrigin: Record<ItemOrigin, number>;
  };
  wer: {
    pooled: WerFigure & { interval95: BootstrapInterval | null };
    me: WerFigure;
    meRawMic: WerFigure;
    them: WerFigure;
  };
  terms: {
    referenceCount: number;
    recalled: number;
    falseAlarms: number;
    recall: number | null;
    /** Jargon terms that normalise to no words, so cannot be counted. */
    unscorable: string[];
  };
  latency: Record<AudioSource, LatencySummary>;
  cost: {
    /** Billed open time of every session the run opened, retries included. */
    streamHours: number;
    estimatedCostUsd: number | null;
    /** From the items' last attempts: what an hour of a two-stream meeting cost. */
    costPerMeetingHourUsd: number | null;
    /** Items whose token named no price. */
    unknownPrice: string[];
  };
  /** The row `report --summary` prints. */
  summary: SummaryRow;
}

/** One configuration in the summary table: ids, counts, rates, times and money only. */
export interface SummaryRow {
  runId: string;
  provider: string;
  model: string;
  keyterms: boolean;
  echoFilter: boolean;
  normaliserVersion: number;
  pooledWer: number | null;
  pooledWerLow: number | null;
  pooledWerHigh: number | null;
  meWer: number | null;
  meRawMicWer: number | null;
  themWer: number | null;
  termRecall: number | null;
  termFalseAlarms: number;
  micDisplayP50Ms: number | null;
  micDisplayP95Ms: number | null;
  systemDisplayP50Ms: number | null;
  systemDisplayP95Ms: number | null;
  micFinalP50Ms: number | null;
  micFinalP95Ms: number | null;
  systemFinalP50Ms: number | null;
  systemFinalP95Ms: number | null;
  longestWaitMs: number | null;
  itemsScored: number;
  itemsRetried: number;
  itemsFailed: number;
  itemsLeftOut: number;
  streamHours: number;
  costPerMeetingHourUsd: number | null;
}

export function buildReport(
  run: RunRecord,
  inputs: readonly ItemInput[],
  options: ScoreOptions,
): RunReport {
  const terms = prepareTerms(run.keyterms.terms);
  const leftOut: LeftOutItem[] = [];
  const scoredByOrigin: Record<ItemOrigin, number> = { backup: 0, 'meet-recording': 0 };
  const wer: Record<'pooled' | 'me' | 'meRaw' | 'them', WerCounts[]> = {
    pooled: [],
    me: [],
    meRaw: [],
    them: [],
  };
  const samples: RatioSample[] = [];
  const termCounts: TermCount[] = [];
  const meters: Record<AudioSource, LatencyMeter[]> = { mic: [], system: [] };
  const cost = new CostTally();
  let retried = 0;
  let failed = 0;

  for (const input of inputs) {
    const { record } = input;
    if (record.attempts.length > 1) retried += 1;
    for (const attempt of record.attempts) cost.addAttempt(record.itemId, attempt);
    const last = record.attempts.at(-1);
    if (record.status === 'failed' || last === undefined) {
      failed += 1;
      leftOut.push({
        itemId: record.itemId,
        reason: `failed after ${record.attempts.length} attempts`,
      });
      continue;
    }
    if (input.item === null) {
      leftOut.push({ itemId: record.itemId, reason: 'no longer in the items folder' });
      continue;
    }
    cost.addMeeting(record.itemId, last, input.audioMs);
    const finals = new Map<AudioSource, ReplayedFinal[]>();
    for (const stream of last.streams) {
      const events = input.events.get(stream.source) ?? [];
      meters[stream.source].push(measureLatency(record.itemId, stream, events));
      finals.set(stream.source, replayedFinals(record.itemId, stream, events));
    }

    const score = scoreItem(input.item, input.reference, finals, terms.terms, options);
    if (score.kind === 'left-out') {
      leftOut.push({ itemId: record.itemId, reason: score.reason });
      continue;
    }
    if (score.meRaw !== null) wer.meRaw.push(score.meRaw);
    if (score.them !== null) wer.them.push(score.them);
    if (score.kind === 'unpooled') {
      leftOut.push({ itemId: record.itemId, reason: score.reason });
      continue;
    }
    if (score.me !== null) wer.me.push(score.me);
    wer.pooled.push(score.pooled);
    samples.push({ numerator: errorCount(score.pooled), denominator: score.pooled.referenceWords });
    termCounts.push(...score.terms);
    scoredByOrigin[input.item.origin] += 1;
  }

  const pooled = figure(wer.pooled);
  const termScore = scoreTerms(termCounts);
  const latency = {
    mic: LatencyMeter.pool(meters.mic),
    system: LatencyMeter.pool(meters.system),
  };
  const report: Omit<RunReport, 'summary'> = {
    reportVersion: REPORT_VERSION,
    runId: run.runId,
    provider: run.provider,
    model: run.model,
    scoredAt: options.scoredAt,
    gate: run.gate,
    keyterms: { enabled: run.keyterms.enabled, terms: run.keyterms.terms.length },
    normaliserVersion: NORMALISER_VERSION,
    echoFilterVersion: ECHO_FILTER_VERSION,
    echoFilter: options.echoFilter,
    items: {
      total: inputs.length,
      scored: wer.pooled.length,
      retried,
      failed,
      leftOut,
      scoredByOrigin,
    },
    wer: {
      pooled: { ...pooled, interval95: bootstrapInterval(samples) },
      me: figure(wer.me),
      meRawMic: figure(wer.meRaw),
      them: figure(wer.them),
    },
    terms: {
      referenceCount: termScore.referenceCount,
      recalled: termScore.recalled,
      falseAlarms: termScore.falseAlarms,
      recall: termScore.recall,
      unscorable: terms.unscorable,
    },
    latency,
    cost: cost.summary(),
  };
  return { ...report, summary: summaryRow(report) };
}

type ItemScore =
  | { kind: 'left-out'; reason: string }
  /** Counted in Them and the raw mic only (`--no-echo-filter` on a speakers item). */
  | { kind: 'unpooled'; reason: string; meRaw: WerCounts | null; them: WerCounts | null }
  | {
      kind: 'pooled';
      /** Me as the user sees it; null without a mic stream. */
      me: WerCounts | null;
      meRaw: WerCounts | null;
      them: WerCounts | null;
      /** Me and Them together. */
      pooled: WerCounts;
      terms: TermCount[];
    };

function scoreItem(
  item: BenchItem,
  referenceText: string | null,
  finals: ReadonlyMap<AudioSource, readonly ReplayedFinal[]>,
  terms: readonly PreparedTerm[],
  options: ScoreOptions,
): ItemScore {
  if (referenceText === null) return { kind: 'left-out', reason: 'no reference.txt yet' };
  const { lines, problems } = parseReference(referenceText);
  if (problems.length > 0) {
    const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
    return { kind: 'left-out', reason: `reference.txt has ${count}; run bench check` };
  }
  const mic = finals.get('mic') ?? null;
  const system = finals.get('system') ?? null;
  // Lines for a stream the item lacks would count as deleted words and blame the vendor for a
  // clip that was labelled wrong; scoreSpeakers refuses them too, so the item is left out first.
  for (const [speaker, label, stream] of [
    ['me', 'Me', mic === null ? null : 'mic'],
    ['them', 'Them', system === null ? null : 'system'],
  ] as const) {
    if (stream === null && lines.some((line) => line.speaker === speaker)) {
      const source = speaker === 'me' ? 'mic' : 'system';
      return {
        kind: 'left-out',
        reason: `the reference has ${label} lines but the item has no ${source} stream`,
      };
    }
  }
  const systemTexts = system?.map((line) => line.text) ?? null;
  const me = meScoring(item, mic, system, options);
  const raw = scoreSpeakers(lines, {
    mic: me.kind === 'no-mic' ? null : me.rawMic,
    system: systemTexts,
  });
  if (me.kind === 'needs-filter') {
    return { kind: 'unpooled', reason: me.reason, meRaw: raw.me, them: raw.them };
  }
  const shown =
    me.kind === 'scored' ? scoreSpeakers(lines, { mic: me.filtered, system: systemTexts }) : raw;
  const hypothesis = [...(me.kind === 'scored' ? me.filtered : []), ...(systemTexts ?? [])];
  return {
    kind: 'pooled',
    me: shown.me,
    meRaw: raw.me,
    them: raw.them,
    pooled: poolCounts([shown.me, shown.them].filter(isCounts)),
    terms: countTerms(
      terms,
      lines.map((line) => line.text),
      hypothesis,
    ),
  };
}

function isCounts(counts: WerCounts | null): counts is WerCounts {
  return counts !== null;
}

function figure(counts: readonly WerCounts[]): WerFigure {
  const pooled = poolCounts(counts);
  return {
    errors: errorCount(pooled),
    referenceWords: pooled.referenceWords,
    rate: errorRate(pooled),
  };
}

/** The item offset of an event's session: its stream time plus this is item time. */
function sessionOffsetMs(itemId: string, stream: RunStream, session: number): number {
  const found = stream.sessions[session];
  if (found === undefined) {
    throw new BenchFileError(
      `${itemId}/${stream.source}.events.jsonl`,
      `an event names session ${session}, which run.json does not list`,
    );
  }
  return found.itemOffsetMs;
}

/**
 * The app's own LatencyMeter (M3-T6a) over the stream's events in arrival order. A word's capture
 * time is the replay's start plus its item time, on the clock every arrival time was read from.
 */
function measureLatency(
  itemId: string,
  stream: RunStream,
  events: readonly EventRecord[],
): LatencyMeter {
  let offsetMs = 0;
  const meter = new LatencyMeter((streamMs) => stream.replayStartedAtMs + offsetMs + streamMs);
  for (const record of events) {
    // A gate reopen (M3-T20) restarts the vendor's stream time at its own item offset.
    offsetMs = sessionOffsetMs(itemId, stream, record.session);
    meter.record(record.event, record.arrivedAtMs);
  }
  return meter;
}

/** The stream's finals on the item's timeline, in time order. */
function replayedFinals(
  itemId: string,
  stream: RunStream,
  events: readonly EventRecord[],
): ReplayedFinal[] {
  const finals = events.flatMap((record): ReplayedFinal[] => {
    const event = record.event;
    if (event.type !== 'final') return [];
    const offsetMs = sessionOffsetMs(itemId, stream, record.session);
    return [
      {
        startMs: offsetMs + event.startMs,
        endMs: offsetMs + event.endMs,
        text: event.text,
        words: event.words.map((word) => ({
          ...word,
          startMs: offsetMs + word.startMs,
          endMs: offsetMs + word.endMs,
        })),
      },
    ];
  });
  return finals.sort((a, b) => a.startMs - b.startMs);
}

const MS_PER_HOUR = 3_600_000;

/**
 * Money and time, from run.json. Every session of every attempt is what the vendor billed (the
 * stream hours and the run's cost); cost per meeting hour is the items' last attempts over their
 * audio, two streams making one meeting, as the app's meter counts a meeting with two sessions.
 */
class CostTally {
  private connectedMs = 0;
  private runCostUsd: number | null = 0;
  private meetingCostUsd: number | null = 0;
  private meetingAudioMs = 0;
  private readonly unknownPrice: string[] = [];

  addAttempt(itemId: string, attempt: RunAttempt): void {
    const billedMs = billedMsOf(attempt);
    this.connectedMs += billedMs;
    this.runCostUsd = this.priced(this.runCostUsd, itemId, billedMs, attempt.pricePerHourUsd);
  }

  addMeeting(itemId: string, last: RunAttempt, audioMs: ReadonlyMap<AudioSource, number>): void {
    for (const stream of last.streams) this.meetingAudioMs += audioMs.get(stream.source) ?? 0;
    this.meetingCostUsd = this.priced(
      this.meetingCostUsd,
      itemId,
      billedMsOf(last),
      last.pricePerHourUsd,
    );
  }

  summary(): RunReport['cost'] {
    const meetingHours = this.meetingAudioMs / 2 / MS_PER_HOUR;
    return {
      streamHours: this.connectedMs / MS_PER_HOUR,
      estimatedCostUsd: this.runCostUsd === null ? null : roundUsd(this.runCostUsd),
      costPerMeetingHourUsd:
        this.meetingCostUsd === null || meetingHours === 0
          ? null
          : roundUsd(this.meetingCostUsd / meetingHours),
      unknownPrice: this.unknownPrice,
    };
  }

  /** Adds the billed time at the price; an unknown price makes the sum unknown, never 0. */
  private priced(
    total: number | null,
    itemId: string,
    billedMs: number,
    pricePerHourUsd: number | null,
  ): number | null {
    if (billedMs === 0) return total;
    if (pricePerHourUsd === null) {
      if (!this.unknownPrice.includes(itemId)) this.unknownPrice.push(itemId);
      return null;
    }
    return total === null ? null : total + (billedMs / MS_PER_HOUR) * pricePerHourUsd;
  }
}

function billedMsOf(attempt: RunAttempt): number {
  let billedMs = 0;
  for (const stream of attempt.streams) {
    for (const session of stream.sessions) billedMs += session.connectedMs;
  }
  return billedMs;
}

/** To 1/10000 USD, once, after the sum (as stt/usage.ts rounds the app's meter). */
function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

function summaryRow(report: Omit<RunReport, 'summary'>): SummaryRow {
  const { mic, system } = report.latency;
  const waits = [mic.longestWaitMs, system.longestWaitMs].filter((ms) => ms !== null);
  return {
    runId: report.runId,
    provider: report.provider,
    model: report.model,
    keyterms: report.keyterms.enabled,
    echoFilter: report.echoFilter,
    normaliserVersion: report.normaliserVersion,
    pooledWer: report.wer.pooled.rate,
    pooledWerLow: report.wer.pooled.interval95?.low ?? null,
    pooledWerHigh: report.wer.pooled.interval95?.high ?? null,
    meWer: report.wer.me.rate,
    meRawMicWer: report.wer.meRawMic.rate,
    themWer: report.wer.them.rate,
    termRecall: report.terms.recall,
    termFalseAlarms: report.terms.falseAlarms,
    micDisplayP50Ms: mic.displayP50Ms,
    micDisplayP95Ms: mic.displayP95Ms,
    systemDisplayP50Ms: system.displayP50Ms,
    systemDisplayP95Ms: system.displayP95Ms,
    micFinalP50Ms: mic.finalP50Ms,
    micFinalP95Ms: mic.finalP95Ms,
    systemFinalP50Ms: system.finalP50Ms,
    systemFinalP95Ms: system.finalP95Ms,
    longestWaitMs: waits.length === 0 ? null : Math.max(...waits),
    itemsScored: report.items.scored,
    itemsRetried: report.items.retried,
    itemsFailed: report.items.failed,
    itemsLeftOut: report.items.leftOut.length,
    streamHours: report.cost.streamHours,
    costPerMeetingHourUsd: report.cost.costPerMeetingHourUsd,
  };
}

/** `reports/<run-id>.md`: one run's numbers for a person, no transcript text. */
export function renderReportMarkdown(report: RunReport): string {
  const { wer, latency, items, cost, terms } = report;
  const pooledInterval =
    wer.pooled.interval95 === null
      ? ''
      : ` (95% interval ${percent(wer.pooled.interval95.low)} to ${percent(wer.pooled.interval95.high)})`;
  const origins = `${items.scoredByOrigin.backup} from the backup, ${items.scoredByOrigin['meet-recording']} meet recordings (Them only)`;
  const unknown =
    cost.unknownPrice.length === 0 ? '' : ` (no price for ${cost.unknownPrice.join(', ')})`;
  const rows: [string, string][] = [
    ['Pooled WER', `${percent(wer.pooled.rate)}${pooledInterval}`],
    ['Me WER, after the echo filter', percent(wer.me.rate)],
    ['Me WER, raw mic (diagnostic)', percent(wer.meRawMic.rate)],
    ['Them WER', percent(wer.them.rate)],
    ['Term recall', `${percent(terms.recall)} (${terms.recalled} of ${terms.referenceCount})`],
    ['Term false alarms', String(terms.falseAlarms)],
    ...AUDIO_SOURCES.flatMap((source): [string, string][] => [
      [
        `Word display latency, ${source}, p50 / p95`,
        pair(latency[source].displayP50Ms, latency[source].displayP95Ms),
      ],
      [
        `Final latency, ${source}, p50 / p95`,
        pair(latency[source].finalP50Ms, latency[source].finalP95Ms),
      ],
      [`Longest wait, ${source}`, milliseconds(latency[source].longestWaitMs)],
    ]),
    ['Items scored', `${items.scored} of ${items.total}: ${origins}`],
    ['Items retried', String(items.retried)],
    ['Items failed after retries', String(items.failed)],
    ['Stream hours', cost.streamHours.toFixed(3)],
    [
      'Estimated cost of the run',
      cost.estimatedCostUsd === null ? `unknown${unknown}` : `$${cost.estimatedCostUsd.toFixed(4)}`,
    ],
    [
      'Cost per meeting hour',
      cost.costPerMeetingHourUsd === null
        ? `unknown${unknown}`
        : `$${cost.costPerMeetingHourUsd.toFixed(2)}`,
    ],
  ];
  const lines = [
    `# STT bench run ${report.runId}`,
    '',
    `${report.provider} ${report.model}, keyterms ${onOff(report.keyterms.enabled)} ` +
      `(${report.keyterms.terms} terms). Scored ${report.scoredAt} with normaliser ` +
      `v${report.normaliserVersion} and echo filter v${report.echoFilterVersion} ` +
      `(${onOff(report.echoFilter)}).`,
    '',
    '| Measure | Value |',
    '| --- | --- |',
    ...rows.map(([measure, value]) => `| ${measure} | ${value} |`),
  ];
  if (items.leftOut.length > 0) {
    lines.push('', '## Items left out', '');
    for (const { itemId, reason } of items.leftOut) lines.push(`- \`${itemId}\`: ${reason}`);
  }
  if (terms.unscorable.length > 0) {
    lines.push(
      '',
      `Jargon terms that normalise to nothing and were not counted: ${terms.unscorable.length}.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const SUMMARY_COLUMNS = [
  'Run',
  'Provider',
  'Model',
  'Keyterms',
  'Echo filter',
  'Normaliser',
  'Pooled WER (95% interval)',
  'Me WER',
  'Me raw mic',
  'Them WER',
  'Term recall',
  'False alarms',
  'Display p50 / p95, mic (ms)',
  'Display p50 / p95, system (ms)',
  'Final p50 / p95, mic (ms)',
  'Final p50 / p95, system (ms)',
  'Longest wait (ms)',
  'Scored',
  'Retried',
  'Failed',
  'Left out',
  'Stream hours',
  'Per meeting hour',
];

/** The aggregate table for docs/research/stt-benchmark.md: one row per scored run. */
export function renderSummary(rows: readonly SummaryRow[]): string {
  const cells = rows.map((row) => [
    row.runId,
    row.provider,
    row.model,
    onOff(row.keyterms),
    onOff(row.echoFilter),
    `v${row.normaliserVersion}`,
    `${percent(row.pooledWer)}${row.pooledWerLow === null || row.pooledWerHigh === null ? '' : ` (${percent(row.pooledWerLow)} to ${percent(row.pooledWerHigh)})`}`,
    percent(row.meWer),
    percent(row.meRawMicWer),
    percent(row.themWer),
    percent(row.termRecall),
    String(row.termFalseAlarms),
    pair(row.micDisplayP50Ms, row.micDisplayP95Ms, ''),
    pair(row.systemDisplayP50Ms, row.systemDisplayP95Ms, ''),
    pair(row.micFinalP50Ms, row.micFinalP95Ms, ''),
    pair(row.systemFinalP50Ms, row.systemFinalP95Ms, ''),
    milliseconds(row.longestWaitMs, ''),
    String(row.itemsScored),
    String(row.itemsRetried),
    String(row.itemsFailed),
    String(row.itemsLeftOut),
    row.streamHours.toFixed(3),
    row.costPerMeetingHourUsd === null ? 'unknown' : `$${row.costPerMeetingHourUsd.toFixed(2)}`,
  ]);
  return `${[SUMMARY_COLUMNS, SUMMARY_COLUMNS.map(() => '---'), ...cells]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n')}\n`;
}

function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function milliseconds(ms: number | null, unit = ' ms'): string {
  return ms === null ? 'n/a' : `${Math.round(ms)}${unit}`;
}

function pair(first: number | null, second: number | null, unit = ' ms'): string {
  return `${milliseconds(first, '')} / ${milliseconds(second, '')}${first === null && second === null ? '' : unit}`;
}

function onOff(on: boolean): string {
  return on ? 'on' : 'off';
}

/** What `score` did: the reports it wrote and the runs it passed over. */
export interface ScoreOutcome {
  reports: RunReport[];
  skipped: LeftOutRun[];
}

export interface LeftOutRun {
  runId: string;
  reason: string;
}

/**
 * `bench score [--run <id>]`: scores one run, or every run, and writes `reports/<run-id>.json` and
 * `.md`. A run that did not finish (stopped, or still running) is refused when named and passed
 * over when scoring every run: its numbers would read as a whole configuration's.
 */
export async function scoreRuns(
  benchDir: string,
  options: ScoreOptions & { runId: string | null },
): Promise<ScoreOutcome> {
  const runIds = options.runId === null ? await listRunIds(benchDir) : [options.runId];
  const outcome: ScoreOutcome = { reports: [], skipped: [] };
  for (const runId of runIds) {
    const run = await readRun(runPaths(benchDir, runId).runJson);
    if (run.finishedAt === null) {
      const reason = 'did not finish (stopped, or still running)';
      if (options.runId !== null) {
        throw new Error(`run ${runId} did not finish (stopped, or still running); run it again`);
      }
      outcome.skipped.push({ runId, reason });
      continue;
    }
    const report = buildReport(run, await loadItemInputs(benchDir, run), options);
    const reportDir = join(benchDir, 'reports');
    await writePrivateFile(
      join(reportDir, `${runId}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writePrivateFile(join(reportDir, `${runId}.md`), renderReportMarkdown(report));
    outcome.reports.push(report);
  }
  return outcome;
}

async function listRunIds(benchDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(benchDir, 'runs'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** What `score` needs of each item of a run, read from the bench folder. */
async function loadItemInputs(benchDir: string, run: RunRecord): Promise<ItemInput[]> {
  const paths = runPaths(benchDir, run.runId);
  const inputs: ItemInput[] = [];
  for (const record of run.items) {
    const item = (await exists(join(benchDir, 'items', record.itemId)))
      ? await readItem(benchDir, record.itemId)
      : null;
    const events = new Map<AudioSource, EventRecord[]>();
    const audioMs = new Map<AudioSource, number>();
    const last = record.attempts.at(-1);
    if (item !== null && record.status === 'ok' && last !== undefined) {
      for (const stream of last.streams) {
        events.set(stream.source, await readEvents(paths.events(record.itemId, stream.source)));
      }
      for (const [source, samples] of await readItemAudio(item)) {
        audioMs.set(source, (samples.length / WAV_SAMPLE_RATE) * 1000);
      }
    }
    const reference = item === null ? null : await readItemReference(item);
    inputs.push({ record, item, reference, events, audioMs });
  }
  return inputs;
}

/** Every stored report's summary row, by run id: `bench report --summary`. */
export async function readSummaryRows(benchDir: string): Promise<SummaryRow[]> {
  const dir = join(benchDir, 'reports');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (!isMissing(error)) throw error;
    names = [];
  }
  const rows: SummaryRow[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new BenchFileError(path, 'not valid JSON');
    }
    rows.push(parseSummaryRow(parsed, path));
  }
  return rows;
}

function parseSummaryRow(value: unknown, label: string): SummaryRow {
  if (!isRecord(value)) throw new BenchFileError(label, 'must be a JSON object');
  if (value.reportVersion !== REPORT_VERSION) {
    throw new BenchFileError(
      label,
      `reportVersion must be ${REPORT_VERSION}; score the run again with this bench`,
    );
  }
  const summary = value.summary;
  if (!isRecord(summary)) throw new BenchFileError(label, 'summary must be an object');
  const read = new SummaryReader(summary, label);
  return {
    runId: read.string('runId'),
    provider: read.string('provider'),
    model: read.string('model'),
    keyterms: read.boolean('keyterms'),
    echoFilter: read.boolean('echoFilter'),
    normaliserVersion: read.number('normaliserVersion'),
    pooledWer: read.numberOrNull('pooledWer'),
    pooledWerLow: read.numberOrNull('pooledWerLow'),
    pooledWerHigh: read.numberOrNull('pooledWerHigh'),
    meWer: read.numberOrNull('meWer'),
    meRawMicWer: read.numberOrNull('meRawMicWer'),
    themWer: read.numberOrNull('themWer'),
    termRecall: read.numberOrNull('termRecall'),
    termFalseAlarms: read.number('termFalseAlarms'),
    micDisplayP50Ms: read.numberOrNull('micDisplayP50Ms'),
    micDisplayP95Ms: read.numberOrNull('micDisplayP95Ms'),
    systemDisplayP50Ms: read.numberOrNull('systemDisplayP50Ms'),
    systemDisplayP95Ms: read.numberOrNull('systemDisplayP95Ms'),
    micFinalP50Ms: read.numberOrNull('micFinalP50Ms'),
    micFinalP95Ms: read.numberOrNull('micFinalP95Ms'),
    systemFinalP50Ms: read.numberOrNull('systemFinalP50Ms'),
    systemFinalP95Ms: read.numberOrNull('systemFinalP95Ms'),
    longestWaitMs: read.numberOrNull('longestWaitMs'),
    itemsScored: read.number('itemsScored'),
    itemsRetried: read.number('itemsRetried'),
    itemsFailed: read.number('itemsFailed'),
    itemsLeftOut: read.number('itemsLeftOut'),
    streamHours: read.number('streamHours'),
    costPerMeetingHourUsd: read.numberOrNull('costPerMeetingHourUsd'),
  };
}

/** Typed reads of a summary row, each naming `summary.<field>` when it refuses. */
class SummaryReader {
  constructor(
    private readonly row: Record<string, unknown>,
    private readonly label: string,
  ) {}

  string(key: string): string {
    const value = this.get(key);
    if (typeof value !== 'string') this.fail(key, 'a string');
    return value;
  }

  boolean(key: string): boolean {
    const value = this.get(key);
    if (typeof value !== 'boolean') this.fail(key, 'true or false');
    return value;
  }

  number(key: string): number {
    const value = this.get(key);
    if (!isFiniteNumber(value)) this.fail(key, 'a finite number');
    return value;
  }

  numberOrNull(key: string): number | null {
    const value = this.get(key);
    if (value !== null && !isFiniteNumber(value)) this.fail(key, 'a finite number or null');
    return value;
  }

  private get(key: string): unknown {
    return Object.hasOwn(this.row, key) ? this.row[key] : undefined;
  }

  private fail(key: string, rule: string): never {
    throw new BenchFileError(this.label, `summary.${key} must be ${rule}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
