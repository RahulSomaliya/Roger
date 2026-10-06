import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioSource } from '../../shared/transcript';
import { createLogger, type LogFields } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { ensureMeetingAudioDir, storedAudioPath } from './audioPaths';
import { AFCONVERT, AudioCompressor, type CompressJob, type RunTool } from './AudioCompressor';
import { wavHeader } from './wav';

const MEETING = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const OTHER_MEETING = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const FILE_IDS = [
  '2f6a8c1d-5e3b-4a7f-9c2d-8e1f0a3b4c5d',
  '5b7c9d0e-1f2a-4b3c-8d4e-6f7a8b9c0d1e',
  '8c0d1e2f-3a4b-4c5d-9e6f-0a1b2c3d4e5f',
];

interface Call {
  command: string;
  args: readonly string[];
  signal: AbortSignal;
  finish: () => void;
  fail: (error: Error) => void;
}

/** afconvert stand-in: each call waits until the test finishes or fails it. */
function manualRunner(): { run: RunTool; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunTool = (command, args, { signal }) =>
    new Promise<void>((resolve, reject) => {
      const output = args.at(-1) ?? '';
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
      calls.push({
        command,
        args,
        signal,
        finish: () => {
          writeFileSync(output, Buffer.from('....ftypM4A encoded'));
          // As afconvert leaves its output under a umask of 022.
          chmodSync(output, 0o644);
          resolve();
        },
        fail: (error) => {
          // afconvert leaves what it had written when it fails.
          writeFileSync(output, 'half');
          reject(error);
        },
      });
    });
  return { run, calls };
}

/** Lets the compressor reach its next await. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('AudioCompressor', () => {
  let userData = '';
  let store: InMemoryTranscriptStore;
  let logged: { level: string; message: string; fields: LogFields }[];

  const logger = () =>
    createLogger({
      level: 'debug',
      format: 'json',
      sink: (line) => {
        const { level, msg, ...fields } = JSON.parse(line) as LogFields & {
          level: string;
          msg: string;
        };
        logged.push({ level, message: msg, fields });
      },
    });

  /** A closed WAV of one second on disk with its row, as the writer leaves it. */
  function closedWav(meetingId: string, id: string, source: AudioSource = 'mic'): CompressJob {
    if (store.getMeeting(meetingId) === null) {
      store.createMeeting({ id: meetingId, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    }
    const name = `${source}-000000000-${id.slice(0, 8)}.wav`;
    const path = storedAudioPath(meetingId, name);
    writeFileSync(
      join(ensureMeetingAudioDir(userData, meetingId), name),
      Buffer.concat([wavHeader(32_000), Buffer.alloc(32_000)]),
    );
    store.addAudioFile({
      id,
      meetingId,
      source,
      startMs: 0,
      path,
      format: 'wav',
      createdAt: '2026-10-06T09:00:00.000Z',
    });
    store.closeAudioFile(id, { endMs: 1_000, bytes: 32_044, closedAt: '2026-10-06T09:00:01.000Z' });
    return { id, meetingId, path };
  }

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'roger-compressor-'));
    store = new InMemoryTranscriptStore();
    logged = [];
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  it('turns a closed WAV into 48 kbps AAC with afconvert, then deletes the WAV', async () => {
    const { run, calls } = manualRunner();
    const onEncoded = vi.fn();
    const compressor = new AudioCompressor({ store, userData, logger: logger(), run, onEncoded });
    const job = closedWav(MEETING, FILE_IDS[0]!);
    const wav = join(userData, job.path);

    compressor.enqueue(job);
    await settle();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // The exact command the Mac test (AudioCompressor.mac.test.ts) runs for real.
    expect(call!.command).toBe(AFCONVERT);
    expect(call!.args.slice(0, -1)).toEqual(['-f', 'm4af', '-d', 'aac', '-b', '48000', wav]);
    // Written under a name of its own, so a crash mid-encode never leaves a torn file the row names.
    expect(call!.args.at(-1)).not.toBe(wav.replace(/\.wav$/, '.m4a'));
    call!.finish();
    await compressor.idle();

    const [file] = store.listAudioFiles(MEETING);
    const m4a = job.path.replace(/\.wav$/, '.m4a');
    expect(file).toMatchObject({ format: 'm4a', path: m4a });
    expect(file!.bytes).toBe(statSync(join(userData, m4a)).size);
    // Owner-only like the WAV it replaces, for the weeks it is kept.
    expect(statSync(join(userData, m4a)).mode & 0o777).toBe(0o600);
    expect(existsSync(wav)).toBe(false);
    expect(readdirSync(join(userData, 'audio', MEETING))).toEqual([m4a.split('/').at(-1)]);
    expect(onEncoded).toHaveBeenCalledWith(job);
  });

  it('keeps the WAV when afconvert fails, and leaves no half-made m4a', async () => {
    const { run, calls } = manualRunner();
    const onEncoded = vi.fn();
    const compressor = new AudioCompressor({ store, userData, logger: logger(), run, onEncoded });
    const job = closedWav(MEETING, FILE_IDS[0]!);

    compressor.enqueue(job);
    await settle();
    calls[0]!.fail(new Error('afconvert: Error: unsupported bit rate'));
    await compressor.idle();

    expect(store.listAudioFiles(MEETING)).toEqual([
      expect.objectContaining({ format: 'wav', path: job.path }),
    ]);
    expect(readdirSync(join(userData, 'audio', MEETING))).toEqual([job.path.split('/').at(-1)]);
    expect(onEncoded).not.toHaveBeenCalled();
    const warning = logged.find((entry) => entry.level === 'warn');
    expect(warning?.fields).toMatchObject({ meetingId: MEETING, fileId: job.id });
  });

  it('encodes one file at a time, in the order they were handed over', async () => {
    const { run, calls } = manualRunner();
    const compressor = new AudioCompressor({ store, userData, logger: logger(), run });
    const first = closedWav(MEETING, FILE_IDS[0]!, 'mic');
    const second = closedWav(MEETING, FILE_IDS[1]!, 'system');

    compressor.enqueue(first);
    compressor.enqueue(second);
    compressor.enqueue(first);
    await settle();
    expect(calls).toHaveLength(1);
    calls[0]!.finish();
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain(join(userData, second.path));
    calls[1]!.finish();
    await compressor.idle();

    expect(calls).toHaveLength(2);
    expect(store.listAudioFiles(MEETING).map((file) => file.format)).toEqual(['m4a', 'm4a']);
  });

  it('skips a file whose audio was deleted before its turn', async () => {
    const { run, calls } = manualRunner();
    const compressor = new AudioCompressor({ store, userData, logger: logger(), run });
    const job = closedWav(MEETING, FILE_IDS[0]!);
    store.markMeetingAudioDeleted(MEETING, '2026-10-07T09:00:00.000Z');

    compressor.enqueue(job);
    await compressor.idle();

    expect(calls).toEqual([]);
  });

  it('refuses a stored path outside the audio folder and runs nothing', async () => {
    const { run, calls } = manualRunner();
    const compressor = new AudioCompressor({ store, userData, logger: logger(), run });
    store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    store.addAudioFile({
      id: FILE_IDS[0]!,
      meetingId: MEETING,
      source: 'mic',
      startMs: 0,
      path: 'roger.wav',
      format: 'wav',
      createdAt: '2026-10-06T09:00:00.000Z',
    });
    store.closeAudioFile(FILE_IDS[0]!, {
      endMs: 1_000,
      bytes: 44,
      closedAt: '2026-10-06T09:00:01.000Z',
    });

    compressor.enqueue({ id: FILE_IDS[0]!, meetingId: MEETING, path: 'roger.wav' });
    await compressor.idle();

    expect(calls).toEqual([]);
    expect(logged).toContainEqual(expect.objectContaining({ level: 'warn' }));
  });

  it("forgets a meeting's waiting files and stops the one it is encoding", async () => {
    const { run, calls } = manualRunner();
    const compressor = new AudioCompressor({ store, userData, logger: logger(), run });
    const running = closedWav(MEETING, FILE_IDS[0]!, 'mic');
    const waiting = closedWav(MEETING, FILE_IDS[1]!, 'system');
    const other = closedWav(OTHER_MEETING, FILE_IDS[2]!);
    compressor.enqueue(running);
    compressor.enqueue(waiting);
    compressor.enqueue(other);
    await settle();

    await compressor.forget(MEETING);

    expect(calls[0]!.signal.aborted).toBe(true);
    await settle();
    // The other meeting's file goes next; nothing of the forgotten meeting runs again.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain(join(userData, other.path));
    calls[1]!.finish();
    await compressor.idle();
    expect(store.listAudioFiles(MEETING).map((file) => file.format)).toEqual(['wav', 'wav']);
    expect(readdirSync(join(userData, 'audio', MEETING)).sort()).toEqual(
      [running, waiting].map((job) => job.path.split('/').at(-1)).sort(),
    );
  });

  it('stops the encoding under way at quit and takes no more', async () => {
    const { run, calls } = manualRunner();
    const compressor = new AudioCompressor({ store, userData, logger: logger(), run });
    compressor.enqueue(closedWav(MEETING, FILE_IDS[0]!, 'mic'));
    compressor.enqueue(closedWav(MEETING, FILE_IDS[1]!, 'system'));
    await settle();

    await compressor.stop();
    compressor.enqueue(closedWav(OTHER_MEETING, FILE_IDS[2]!));
    await compressor.idle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(true);
    // The WAVs stay; the next launch encodes them (AudioBackup's launch work).
    expect(store.listAudioFiles(MEETING).map((file) => file.format)).toEqual(['wav', 'wav']);
  });
});
