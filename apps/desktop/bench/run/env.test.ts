import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRepoEnv } from './env';

describe('loadRepoEnv', () => {
  let repo = '';

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'roger-bench-env-'));
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    await mkdir(join(repo, 'apps', 'desktop'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("takes only the desktop's ROGER_* keys from the repo-root .env", async () => {
    await writeFile(
      join(repo, '.env'),
      'ROGER_API_URL=http://127.0.0.1:9000\nROGER_BENCH_DIR=/data/bench\nASSEMBLYAI_API_KEY=secret\n',
    );
    const env: NodeJS.ProcessEnv = {};

    const loaded = loadRepoEnv(env, join(repo, 'apps', 'desktop'));

    expect(loaded).toBe(join(repo, '.env'));
    expect(env).toEqual({ ROGER_API_URL: 'http://127.0.0.1:9000', ROGER_BENCH_DIR: '/data/bench' });
  });

  it('never overrides a variable already set', async () => {
    await writeFile(join(repo, '.env'), 'ROGER_BENCH_DIR=/from/file\n');
    const env: NodeJS.ProcessEnv = { ROGER_BENCH_DIR: '/from/shell' };

    loadRepoEnv(env, join(repo, 'apps', 'desktop'));

    expect(env.ROGER_BENCH_DIR).toBe('/from/shell');
  });

  it('loads nothing when the repo has no .env or the folder is outside the repo', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(loadRepoEnv(env, join(repo, 'apps', 'desktop'))).toBeNull();
    expect(loadRepoEnv(env, tmpdir())).toBeNull();
    expect(env).toEqual({});
  });
});
