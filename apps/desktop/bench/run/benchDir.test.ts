import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BenchDirError, benchDirSetting, resolveBenchDir } from './benchDir';

describe('benchDirSetting', () => {
  it('defaults to Roger-bench in the home folder', () => {
    expect(benchDirSetting({}, '/Users/ann')).toBe('/Users/ann/Roger-bench');
    expect(benchDirSetting({ ROGER_BENCH_DIR: '  ' }, '/Users/ann')).toBe('/Users/ann/Roger-bench');
  });

  it('expands a leading ~ the way a shell would', () => {
    expect(benchDirSetting({ ROGER_BENCH_DIR: '~/data/bench' }, '/Users/ann')).toBe(
      '/Users/ann/data/bench',
    );
    expect(benchDirSetting({ ROGER_BENCH_DIR: '~' }, '/Users/ann')).toBe('/Users/ann');
  });

  it('refuses a relative path, which would land wherever make ran', () => {
    expect(() => benchDirSetting({ ROGER_BENCH_DIR: 'bench' }, '/Users/ann')).toThrow(
      /ROGER_BENCH_DIR must be an absolute path/,
    );
  });
});

describe('resolveBenchDir', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'roger-bench-dir-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('accepts a folder outside any git checkout, even one that does not exist yet', async () => {
    const dir = join(root, 'Roger-bench');

    await expect(resolveBenchDir({ ROGER_BENCH_DIR: dir }, root)).resolves.toBe(dir);
  });

  it('refuses a bench dir inside the repo and names the checkout', async () => {
    const repo = join(root, 'Roger');
    await mkdir(join(repo, '.git'), { recursive: true });
    const dir = join(repo, 'apps', 'desktop', 'bench', 'data');

    const refused = resolveBenchDir({ ROGER_BENCH_DIR: dir }, root);

    await expect(refused).rejects.toThrow(BenchDirError);
    await expect(refused).rejects.toThrow(`inside the git checkout ${await realpath(repo)}`);
  });

  it('refuses the checkout itself and a worktree, whose .git is a file', async () => {
    const worktree = join(root, 'worktree');
    await mkdir(worktree);
    await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');

    await expect(resolveBenchDir({ ROGER_BENCH_DIR: worktree }, root)).rejects.toThrow(
      BenchDirError,
    );
    await expect(
      resolveBenchDir({ ROGER_BENCH_DIR: join(worktree, 'bench') }, root),
    ).rejects.toThrow(BenchDirError);
  });

  it('follows a symlink that leads into a checkout', async () => {
    const repo = join(root, 'Roger');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'data'));
    const link = join(root, 'bench-link');
    await symlink(join(repo, 'data'), link);

    await expect(
      resolveBenchDir({ ROGER_BENCH_DIR: join(link, 'Roger-bench') }, root),
    ).rejects.toThrow(BenchDirError);
  });
});
