import { access, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

/**
 * Where the standing test set lives: ROGER_BENCH_DIR, default ~/Roger-bench (M3 design, "Where test
 * data lives"). Everything under it is a recording of real people or text transcribed from one
 * (M3 D2), so it must never sit inside a git checkout: one wrong `git add` would publish it. Every
 * command resolves the folder through resolveBenchDir before it reads or writes anything there.
 */

const DEFAULT_BENCH_DIR_NAME = 'Roger-bench';

/** A bench folder the bench will not use. The message says what to set instead. */
export class BenchDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BenchDirError';
  }
}

/** The configured folder as an absolute path, `~` expanded; not yet checked against git. */
export function benchDirSetting(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.ROGER_BENCH_DIR?.trim() ?? '';
  if (raw === '') return join(home, DEFAULT_BENCH_DIR_NAME);
  // A .env value is not run through a shell, so "~/Roger-bench" would otherwise be a folder named
  // "~" under whatever directory make ran in.
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) {
    throw new BenchDirError(
      `ROGER_BENCH_DIR must be an absolute path (got ${JSON.stringify(raw)}); the default is ` +
        `~/${DEFAULT_BENCH_DIR_NAME}`,
    );
  }
  return expanded;
}

/**
 * The bench folder, refused when it lies inside any git checkout. Checked on the real path (every
 * symlink resolved, also for a folder not created yet), so a link from outside into a checkout is
 * caught. Any checkout is refused, not only this repo's: a recording committed to another repository
 * is published just the same.
 */
export async function resolveBenchDir(env: NodeJS.ProcessEnv, home: string): Promise<string> {
  const dir = benchDirSetting(env, home);
  const real = await realPathOfPossiblyMissing(dir);
  for (let folder = real; ; folder = dirname(folder)) {
    if (await exists(join(folder, '.git'))) {
      throw new BenchDirError(
        `ROGER_BENCH_DIR ${dir} is inside the git checkout ${folder}: these are recordings of ` +
          `real people and one git add would publish them. Point ROGER_BENCH_DIR outside it ` +
          `(the default is ~/${DEFAULT_BENCH_DIR_NAME}).`,
      );
    }
    if (dirname(folder) === folder) return dir;
  }
}

/** The real path of `path`, resolving its nearest existing ancestor and keeping the rest as named. */
async function realPathOfPossiblyMissing(path: string): Promise<string> {
  const missing: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error) || dirname(current) === current) throw error;
      missing.push(basename(current));
    }
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
