import { execFileSync } from 'node:child_process';
import { rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GalleryManifest } from '../qa/driver';
import type { CapturePhase } from '../src/shared/capture';
import {
  APP_DIR,
  launchRoger,
  type LaunchOptions,
  type Look,
  LOOKS,
  type RogerRun,
  shoot,
} from './harness';

/**
 * The Electron smoke test (M2-T13): the real app, unpackaged, from New note to Stop. Chromium's
 * fake microphone plays a tone into the page's worklet, which sends it over IPC to main; the fake
 * helper plays the call audio; the fake STT turns each 2 s of sound into a line. It checks what
 * only a real Chromium shows (M1 checked the worklet and getUserMedia wiring only on a real call):
 * both sides' lines on screen within 10 s of Start, all of them in roger.sqlite after Stop, and
 * no macOS prompt asked for on the way. It also checks the harness's screenshot helper and its
 * raised open budget, which M2-T19 and M2-T20 rely on. Run alone:
 *   pnpm --filter @roger/desktop exec electron-vite build
 *   pnpm --filter @roger/desktop exec vitest run --config vitest.e2e.config.ts e2e/capture.e2e.ts
 */

const LINES_WITHIN_MS = 10_000;
/** Start opens two fake sessions; Stop closes them and gives the (absent) API one refused upload. */
const PHASE_WITHIN_MS = 10_000;
/** What the fake STT writes for each window of sound (stt/fake/FakeSpeechToText.ts). */
const FAKE_LINE = '(fake transcript) heard';

type Speaker = 'Me' | 'Them';

/** One line as the transcript on screen shows it. */
interface ShownLine {
  speaker: Speaker;
  text: string;
}

/** Launches Roger for the tests of the enclosing describe, and quits it after them. */
function useRoger(options: LaunchOptions): () => RogerRun {
  let launched: RogerRun | undefined;
  beforeAll(async () => {
    launched = await launchRoger(options);
  });
  afterAll(async () => {
    // Undefined when the launch threw: launchRoger quit Roger then.
    await launched?.close();
  });
  return () => {
    if (launched === undefined) throw new Error('Roger did not launch');
    return launched;
  };
}

/**
 * A speaker's final lines in the transcript. By role and words, not by class: M1's TranscriptView
 * and M3-T9's LiveTranscript both label the region "Transcript" and name the speaker "Me" or
 * "Them" in a span of its own.
 */
function linesOf(page: Page, speaker: Speaker): Locator {
  return page
    .locator('[aria-label="Transcript"] p')
    .filter({ hasText: FAKE_LINE })
    .filter({ has: page.getByText(speaker, { exact: true }) });
}

async function shownLines(page: Page): Promise<ShownLine[]> {
  return page.evaluate((fakeLine) => {
    const lines: { speaker: 'Me' | 'Them'; text: string }[] = [];
    for (const line of document.querySelectorAll('[aria-label="Transcript"] p')) {
      const spans = [...line.querySelectorAll('span')].map((span) => span.textContent);
      const speaker = spans.find((text) => text === 'Me' || text === 'Them');
      const text = spans.find((words) => words.startsWith(fakeLine));
      if ((speaker === 'Me' || speaker === 'Them') && text !== undefined) {
        lines.push({ speaker, text });
      }
    }
    return lines;
  }, FAKE_LINE);
}

/**
 * How many of a speaker's lines a person could see: the line has a size, its centre is inside the
 * viewport, and `document.elementFromPoint` there is the line or inside it. Counting the matches
 * alone also counts a line scrolled out of the transcript or drawn under another element.
 */
function visibleLines(page: Page, speaker: Speaker): Promise<number> {
  return linesOf(page, speaker).evaluateAll(
    (lines) =>
      lines.filter((line) => {
        const box = line.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
        const top = document.elementFromPoint(x, y);
        return top !== null && (top === line || line.contains(top));
      }).length,
  );
}

/**
 * What a shot of the saved meeting must show, checked on the page as shot: capture idle after
 * Stop, and each side's lines where a person could see them. Returns how many of each it saw.
 */
async function expectBothSidesShown(run: RogerRun, look: Look): Promise<Record<Speaker, number>> {
  const where = `${look.theme} at ${look.width} px`;
  const status = await run.page.evaluate(() => window.roger.getCaptureStatus());
  expect(status.phase, withLog(run, `Capture is not idle in the ${where} shot`)).toBe('idle');
  const seen = {
    Me: await visibleLines(run.page, 'Me'),
    Them: await visibleLines(run.page, 'Them'),
  };
  for (const speaker of ['Me', 'Them'] as const) {
    expect(seen[speaker], `No "${speaker}" line a person could see in ${where}`).toBeGreaterThan(0);
  }
  return seen;
}

/** The gallery's provenance, read from git: a branch typed in here goes stale once the task merges. */
function checkoutMeta(): Record<string, string> {
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', APP_DIR, ...args], { encoding: 'utf8' }).trim();
  return {
    Branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    Commit: git('rev-parse', '--short', 'HEAD'),
  };
}

/** On failure, the end of main's log says what Roger saw. */
function withLog(run: RogerRun, message: string): string {
  return `${message}\nRoger's log:\n${run.logs.slice(-40).join('\n')}`;
}

/**
 * Waits, polling from here, until main's capture is in `phase`; on a timeout the failure names
 * the status error, such as a Start the open budget refused. Not `page.waitForFunction`: a page
 * predicate that returns a promise reads as truthy at once.
 */
async function waitForPhase(run: RogerRun, phase: CapturePhase): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const status = await run.page.evaluate(() => window.roger.getCaptureStatus());
          return status.phase === phase ? phase : `${status.phase}: ${status.error ?? 'no error'}`;
        },
        { timeout: PHASE_WITHIN_MS },
      )
      .toBe(phase);
  } catch (error) {
    throw new Error(withLog(run, `Capture never reached ${phase}`), { cause: error });
  }
}

describe('a recording', () => {
  const roger = useRoger({
    // The fake STT writes the same words for every line, so the echo filter (M2-T14b) would hide
    // the microphone's lines as echoes of the call's. This test checks the pipeline, not it.
    config: { echoFilter: false },
  });
  // Set once the recording test passed every check: only then does the page show a saved meeting
  // for the shots to prove. Vitest runs the shots after a failed recording test too (no bail), and
  // `-t shoots` runs them alone, over Home. On an object, not a `let`: `no-unnecessary-condition`
  // trusts a narrowing that only another test's callback undoes (CLAUDE.md failure log).
  const recorded = { saved: false };

  it('shows both sides within 10 s of Start, and Stop saves every line', async () => {
    const run = roger();
    const { page } = run;
    const startedAt = Date.now();
    await page.getByRole('button', { name: 'New note' }).click();
    for (const speaker of ['Me', 'Them'] as const) {
      const left = LINES_WITHIN_MS - (Date.now() - startedAt);
      await linesOf(page, speaker)
        .first()
        .waitFor({ timeout: Math.max(left, 1) })
        .catch((error: unknown) => {
          const message = `No "${speaker}" line within ${LINES_WITHIN_MS} ms of Start`;
          throw new Error(withLog(run, message), { cause: error });
        });
    }
    expect(Date.now() - startedAt).toBeLessThan(LINES_WITHIN_MS);

    const recording = await page.evaluate(() => window.roger.getCaptureStatus());
    expect(recording.phase, withLog(run, 'not recording')).toBe('recording');
    // The fake helper's tap, not Electron's fallback: that path would need Screen Recording.
    expect(recording.systemCapture).toBe('tap');
    const meetingId = recording.meetingId;
    if (meetingId === null) throw new Error(withLog(run, 'A recording with no meeting id'));
    const shown = await shownLines(page);

    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await waitForPhase(run, 'idle');

    // Main's store, as the meeting page reads it: every line that was on screen, from both sides.
    const saved = await page.evaluate(
      (id) => window.roger.getMeeting({ meetingId: id }),
      meetingId,
    );
    if (saved === null) throw new Error(withLog(run, `Meeting ${meetingId} was not saved`));
    expect(saved.endedAt, withLog(run, `Meeting ${meetingId} is open after Stop`)).not.toBeNull();
    const savedLines = saved.segments.map((segment) => ({
      speaker: segment.speaker === 'me' ? 'Me' : 'Them',
      text: segment.text,
    }));
    for (const line of shown) expect(savedLines).toContainEqual(line);
    expect(new Set(savedLines.map((line) => line.speaker))).toEqual(new Set(['Me', 'Them']));

    // The TCC gate answered in e2e mode, without macOS; nothing reached a prompt.
    expect(await run.promptCalls()).toEqual({
      askForMediaAccess: 0,
      getSources: 0,
      notifications: 0,
    });
    expect(
      run.logs.some(
        (line) =>
          line.includes('media access answered without asking macOS') &&
          line.includes('mediaType="microphone"'),
      ),
      withLog(run, 'The TCC gate was not answered by e2e mode'),
    ).toBe(true);
    expect(run.logs.filter((line) => line.includes('refused to'))).toEqual([]);
    recorded.saved = true;
  });

  // The screenshot helper M2-T19 and M2-T20 shoot the real app with: each look applies and lands,
  // and each caption says what its check saw on the page as shot.
  it('shoots the saved meeting in both themes, wide and narrow', async () => {
    const run = roger();
    const dir = process.env.ROGER_QA_OUT ?? join(tmpdir(), 'roger-qa', 'm2-t13');
    // A red run leaves no manifest: an earlier run's shots.json would read as this run's evidence.
    await rm(join(dir, 'shots.json'), { force: true });
    if (!recorded.saved) {
      throw new Error(
        'No saved meeting to shoot: the recording test did not pass (or was filtered out)',
      );
    }
    const manifest: GalleryManifest = {
      title: 'M2-T13 Electron smoke test',
      subtitle:
        'The saved meeting after New note and Stop, in the real app (fake mic, helper, STT)',
      meta: { Task: 'M2-T13', ...checkoutMeta() },
      groups: [{ name: 'Saved meeting', shots: [] }],
    };
    for (const look of LOOKS) {
      const file = join(dir, `meeting-${look.theme}-${look.width}.png`);
      const seen = await shoot(run, file, look, () => expectBothSidesShown(run, look));
      expect((await stat(file)).size).toBeGreaterThan(0);
      manifest.groups[0]?.shots.push({
        file,
        caption: `${look.theme}, ${look.width} px, idle after Stop: ${seen.Me} Me and ${seen.Them} Them lines on screen`,
        check: 'pass',
      });
    }
    await writeFile(join(dir, 'shots.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  });
});

describe('Start three times inside a minute', () => {
  // Each Start opens two sessions and the default budget allows four a minute (cost guard G3), so
  // the third Start would be refused, fake STT or not, unless the harness raises it.
  const roger = useRoger({ manyStarts: true });

  it('records every time once the harness raises the open budget', async () => {
    const run = roger();
    for (let start = 1; start <= 3; start += 1) {
      await run.page.getByRole('button', { name: 'New note' }).click();
      await waitForPhase(run, 'recording');
      await run.page.getByRole('button', { name: 'Stop', exact: true }).click();
      await waitForPhase(run, 'idle');
    }
    expect(await run.promptCalls()).toEqual({
      askForMediaAccess: 0,
      getSources: 0,
      notifications: 0,
    });
  });
});
