import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AUDIO_SOURCES, type AudioSource } from '../../src/shared/transcript';
import { assertBenchId } from '../core/events';
import { writePrivateFile } from '../core/files';
import { WAV_SAMPLE_RATE, encodeStereoWav, writeWav } from '../core/wav';
import {
  type BackupChunk,
  type DecodeChunk,
  assertFileVaultOn,
  decodeBackupChunk,
  ensurePrivateBenchDir,
  readBackupMeeting,
} from './backup';
import {
  ITEM_SCHEMA_VERSION,
  type ItemGap,
  type ItemKind,
  type ItemRecord,
  type ItemSetup,
  type Participant,
  isIsoDate,
  itemPaths,
  writeItem,
} from './item';

/**
 * `bench clip`: cuts the same window from both streams of a meeting in the app's audio backup and
 * makes a test-set item of it: `mic.wav` and `system.wav` (16 kHz mono PCM16, what the replay
 * streams), `listen.wav` (stereo, mic left and system right, for fixing the reference by ear) and
 * `item.json`, written last so a folder with no item.json is a clip that did not finish.
 *
 * Chunks are laid out by their `start_ms` and every stretch no chunk covers (a capture gap, a
 * deleted chunk) is silence, listed in `gaps`. Every vendor then hears the same decoded audio, so
 * the comparison is fair, though absolute WER may sit a little above what the live stream got
 * (M3 plan, "Where recordings come from").
 */

export interface ClipOptions {
  benchDir: string;
  userDataDir: string;
  meetingId: string;
  /** Meeting time. */
  fromMs: number;
  toMs: number;
  itemId: string;
  participants: Participant[];
  kind: ItemKind;
  setup: ItemSetup;
}

export interface ClipDeps {
  /** Throws unless the disk is encrypted; injected so tests run on any Mac. */
  assertFileVault: () => Promise<void>;
  decode: DecodeChunk;
}

const DEFAULT_DEPS: ClipDeps = { assertFileVault: assertFileVaultOn, decode: decodeBackupChunk };

const SAMPLES_PER_MS = WAV_SAMPLE_RATE / 1000;

/** Writes the item and returns its item.json. Leaves nothing behind when it fails. */
export async function clip(
  options: ClipOptions,
  deps: ClipDeps = DEFAULT_DEPS,
): Promise<ItemRecord> {
  const { benchDir, meetingId, fromMs, toMs, itemId } = options;
  assertBenchId(itemId, '--name');
  if (toMs <= fromMs) {
    throw new Error(`--to (${formatClock(toMs)}) must be after --from (${formatClock(fromMs)})`);
  }
  // Before anything is read or written: decoded audio of colleagues never lands on a plain disk.
  await deps.assertFileVault();

  const meeting = readBackupMeeting(options.userDataDir, meetingId);
  if (meeting.chunks.length === 0) {
    throw new Error(
      `meeting ${meetingId} has no audio left in the backup: it was deleted, or it is older ` +
        'than the retention window (7 days by default). Clip a meeting within the week.',
    );
  }
  // Before anything is written, from the rows' ends. An open row (end_ms null: the app is still
  // writing it, or a crash left it for the next launch to close) has no end until it is decoded,
  // so it passes here as endless and the cut checks again below; without that second check one
  // open row on either stream would let a mistyped --to through as minutes of silence.
  const rowsEndMs = Math.max(...meeting.chunks.map((chunk) => chunk.endMs ?? Infinity));
  if (toMs > rowsEndMs) throw pastTheEnd(meetingId, rowsEndMs, toMs);

  await ensurePrivateBenchDir(benchDir);
  const paths = itemPaths(benchDir, itemId);
  if (existsSync(paths.itemJson)) {
    throw new Error(
      `item ${itemId} already exists at ${paths.dir}; pick another --name, or delete that ` +
        'folder to clip it again (its reference.txt goes with it)',
    );
  }
  // Never written into: a stream file left there from another window would sit beside this
  // clip's item.json, which might not list it.
  if (existsSync(paths.dir)) {
    throw new Error(
      `${paths.dir} holds a clip that did not finish (no item.json); delete the folder and clip ` +
        'again',
    );
  }
  // Decoded chunks go inside the item folder, under the 0700 bench folder on the FileVault disk,
  // never to the system temp folder. A clip killed mid-way leaves them where `check` reports the
  // folder (no item.json) and deleting the folder removes them.
  const scratchDir = join(paths.dir, '.decode');
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  try {
    const streams = new Map<AudioSource, Int16Array>();
    const gaps: ItemGap[] = [];
    let audioEndMs = 0;
    try {
      for (const source of AUDIO_SOURCES) {
        const chunks = meeting.chunks.filter((chunk) => chunk.source === source);
        const cut = await cutWindow(chunks, fromMs, toMs, deps.decode, scratchDir);
        audioEndMs = Math.max(audioEndMs, cut.audioEndMs);
        if (cut.samples === null) continue;
        streams.set(source, cut.samples);
        gaps.push(...cut.gaps.map((gap) => ({ source, ...gap })));
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
    if (toMs > audioEndMs) throw pastTheEnd(meetingId, audioEndMs, toMs);
    if (streams.size === 0) {
      throw new Error(
        `meeting ${meetingId} has no backup audio between ${formatClock(fromMs)} and ` +
          formatClock(toMs),
      );
    }

    const silence = new Int16Array(0);
    for (const [source, samples] of streams) await writeWav(paths.wav(source), samples);
    await writePrivateFile(
      paths.listen,
      encodeStereoWav(streams.get('mic') ?? silence, streams.get('system') ?? silence),
    );
    const item: ItemRecord = {
      schemaVersion: ITEM_SCHEMA_VERSION,
      id: itemId,
      origin: 'backup',
      meetingId,
      window: { fromMs, toMs },
      recordedOn: localDate(meeting.startedAt),
      kind: options.kind,
      setup: options.setup,
      streams: AUDIO_SOURCES.filter((source) => streams.has(source)),
      gaps,
      participants: options.participants,
      draftRuns: [],
    };
    await writeItem(benchDir, item);
    return item;
  } catch (error) {
    await rm(paths.dir, { recursive: true, force: true });
    throw error;
  }
}

/** `mm:ss` (minutes may run past 59, as in reference lines) in ms. `flag` names it in the error. */
export function parseClockTime(text: string, flag: string): number {
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(text);
  if (match === null) {
    throw new Error(
      `${flag} must be minutes and seconds, mm:ss, such as 12:30; got ${JSON.stringify(text)}`,
    );
  }
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
}

/** `--person <name>:<consent date>`; the name may hold a colon, the date is after the last one. */
export function parseParticipant(text: string): Participant {
  const colon = text.lastIndexOf(':');
  const name = text.slice(0, Math.max(colon, 0)).trim();
  const consentOn = text.slice(colon + 1).trim();
  if (colon === -1 || name === '' || !isIsoDate(consentOn)) {
    throw new Error(
      '--person must be <name>:<consent date>, such as "Ana Lopez:2026-10-05" (the date ' +
        'they agreed to the clip being kept, YYYY-MM-DD)',
    );
  }
  return { name, consentOn };
}

interface Cut {
  /** The window's samples; null when no chunk of the stream reaches into the window. */
  samples: Int16Array | null;
  /** In item time. */
  gaps: { startMs: number; endMs: number }[];
  /** Meeting time past the stream's last sample: an open row ends where its decoded audio does. */
  audioEndMs: number;
}

/** One stream's samples for the window, and where its audio ends. */
async function cutWindow(
  chunks: readonly BackupChunk[],
  fromMs: number,
  toMs: number,
  decode: DecodeChunk,
  scratchDir: string,
): Promise<Cut> {
  // Sample indexes, never ms, so a window is cut to the exact sample.
  const from = fromMs * SAMPLES_PER_MS;
  const to = toMs * SAMPLES_PER_MS;
  const samples = new Int16Array(to - from);
  const covered: [number, number][] = [];
  let audioEndMs = 0;
  for (const chunk of chunks) {
    if (chunk.startMs >= toMs || (chunk.endMs !== null && chunk.endMs <= fromMs)) {
      // Not decoded: an open row starting at or after --to already shows the audio reaches it.
      audioEndMs = Math.max(audioEndMs, chunk.endMs ?? chunk.startMs);
      continue;
    }
    const decoded = await decode(chunk, scratchDir);
    audioEndMs = Math.max(
      audioEndMs,
      chunk.endMs ?? chunk.startMs + decoded.length / SAMPLES_PER_MS,
    );
    const start = chunk.startMs * SAMPLES_PER_MS;
    // The row's end bounds the chunk: a decoder that pads its output must not spill over the next
    // chunk's start. A decode shorter than the row leaves the rest as a gap.
    const length =
      chunk.endMs === null
        ? decoded.length
        : Math.min(decoded.length, (chunk.endMs - chunk.startMs) * SAMPLES_PER_MS);
    const lo = Math.max(from, start);
    const hi = Math.min(to, start + length);
    if (hi <= lo) continue;
    samples.set(decoded.subarray(lo - start, hi - start), lo - from);
    covered.push([lo - from, hi - from]);
  }
  if (covered.length === 0) return { samples: null, gaps: [], audioEndMs };

  const gaps: Cut['gaps'] = [];
  let cursor = 0;
  for (const [lo, hi] of covered.sort((a, b) => a[0] - b[0])) {
    if (lo > cursor) gaps.push(gapMs(cursor, lo));
    cursor = Math.max(cursor, hi);
  }
  if (cursor < samples.length) gaps.push(gapMs(cursor, samples.length));
  return { samples, gaps, audioEndMs };
}

function pastTheEnd(meetingId: string, audioEndMs: number, toMs: number): Error {
  return new Error(
    `the backup of meeting ${meetingId} ends at ${formatClock(audioEndMs)}; ` +
      `--to ${formatClock(toMs)} is past it`,
  );
}

function gapMs(fromSample: number, toSample: number): { startMs: number; endMs: number } {
  return {
    startMs: Math.floor(fromSample / SAMPLES_PER_MS),
    endMs: Math.ceil(toSample / SAMPLES_PER_MS),
  };
}

/** `mm:ss`, as the clip flags and reference lines write it. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** The local calendar day of an instant: the day the owner would say the call was on. */
function localDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`the meeting's started_at is not a time: ${JSON.stringify(iso)}`);
  }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
