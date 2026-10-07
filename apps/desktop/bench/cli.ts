import { homedir } from 'node:os';
import { ApiClient } from '../src/main/api/ApiClient';
import { type DesktopConfig, loadConfig } from '../src/main/config';
import { createLogger, errorMessage } from '../src/main/logger';
import { runCanary, sayToWav } from './canary';
import { readSummaryRows, renderSummary, scoreRuns } from './report/report';
import { registryAdapters } from './run/adapters';
import { type BenchCommand, USAGE, UsageError, parseBenchArgs } from './run/args';
import { resolveBenchDir } from './run/benchDir';
import { findDatasetCommands, runDatasetCommand } from './run/dataset';
import { loadRepoEnv } from './run/env';
import { type RunDeps, runBench } from './run/run';
import { REAL_TIMERS } from './run/timers';

/**
 * The STT benchmark CLI (M3 design, "Benchmark code"): `make bench ARGS="..."` builds this file with
 * bench/vite.config.ts and runs it in plain Node 22.13 or later, outside Electron, so every module it
 * reaches must stay free of Electron imports (run/imports.test.ts checks the whole graph). It
 * measures the exact adapter code the app runs, through the registry, the shared STT core and the
 * same cost guards, with the desktop's settings from the repo-root .env. The test-set commands
 * (clip, draft, check, forget) are M3-T12's; run/dataset.ts finds them.
 */

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
  let command: BenchCommand;
  try {
    // INIT_CWD: the folder make (and pnpm) ran in; pnpm runs this script from apps/desktop.
    command = parseBenchArgs(argv, process.env.INIT_CWD ?? process.cwd());
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`bench: ${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (command.command === 'help') {
    print(USAGE);
    return 0;
  }

  loadRepoEnv(process.env, process.cwd());
  const benchDir = await resolveBenchDir(process.env, homedir());
  if (command.command === 'dataset') {
    // The test-set commands reach neither the API nor a vendor, so the desktop's settings are not
    // checked first: a refused cost guard must not block `forget`, which deletes recordings.
    return runDatasetCommand(command, { benchDir, print }, findDatasetCommands());
  }
  const config = loadConfig(process.env);
  if (config.errors.length > 0) {
    // A refused cost guard keeps its default in the app and blocks Start; here it stops the bench.
    throw new Error(`desktop settings refused: ${config.errors.join('; ')}`);
  }
  switch (command.command) {
    case 'run': {
      const outcome = await runBench(command, {
        benchDir,
        api: apiClient(config),
        adapters: adapters(config),
        opensPerMinute: config.costGuards.sttOpensPerMinute,
        retryBackoffMs: {
          first: config.costGuards.sttReopenBackoffMs,
          max: config.costGuards.sttReopenBackoffMaxMs,
        },
        silenceGate: silenceGate(config),
        timers: REAL_TIMERS,
        out: print,
      });
      return outcome.failed === 0 && outcome.stopped === null && outcome.runJson !== null ? 0 : 1;
    }
    case 'score': {
      const outcome = await scoreRuns(benchDir, {
        ...command,
        scoredAt: new Date().toISOString(),
      });
      for (const report of outcome.reports) {
        print(`scored ${report.runId}: ${report.items.scored} of ${report.items.total} items`);
      }
      for (const { runId, reason } of outcome.skipped) print(`skipped ${runId}: ${reason}`);
      if (outcome.reports.length === 0 && outcome.skipped.length === 0) {
        print(`no runs in ${benchDir}/runs yet; make one with bench run`);
      }
      return 0;
    }
    case 'report': {
      const rows = await readSummaryRows(benchDir);
      if (rows.length === 0) {
        throw new Error(`no reports in ${benchDir}/reports yet; run bench score first`);
      }
      process.stdout.write(renderSummary(rows));
      return 0;
    }
    case 'canary': {
      const result = await runCanary(command, {
        api: apiClient(config),
        adapters: adapters(config),
        timers: REAL_TIMERS,
        opensPerMinute: config.costGuards.sttOpensPerMinute,
        synthesize: sayToWav,
        out: print,
      });
      return result.passed ? 0 : 1;
    }
  }
}

function apiClient(config: DesktopConfig): ApiClient {
  if (config.apiToken === null) {
    throw new Error(
      "ROGER_DESKTOP_API_TOKEN is not set: put the API's ROGER_API_TOKEN in the repo-root .env",
    );
  }
  return new ApiClient({ baseUrl: config.apiUrl, token: config.apiToken });
}

/** The desktop's silence gate, as CaptureService runs it: none when sttSilenceCloseSeconds is 0. */
function silenceGate(config: DesktopConfig): RunDeps['silenceGate'] {
  const guards = config.costGuards;
  if (guards.sttSilenceCloseMs <= 0) return null;
  return {
    closeAfterMs: guards.sttSilenceCloseMs,
    preRollMs: guards.sttSilencePreRollMs,
    reopensPerMeeting: guards.sttSilenceReopensPerMeeting,
    reopenBufferMs: guards.sttReopenBufferMs,
  };
}

function adapters(config: DesktopConfig): ReturnType<typeof registryAdapters> {
  // Logs go to stderr, so `report --summary` output can be redirected into a file on its own.
  const logger = createLogger({ level: config.logLevel, format: 'pretty' }, { bench: true });
  return registryAdapters({ logger, guards: config.costGuards });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`bench: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  },
);
