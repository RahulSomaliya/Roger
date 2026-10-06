import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePrivateFile } from './files';

describe('writePrivateFile', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roger-bench-files-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates missing folders 0700 and the file 0600', async () => {
    const path = join(dir, 'runs', 'run-1', 'run.json');
    await writePrivateFile(path, '{}');

    expect(await readFile(path, 'utf8')).toBe('{}');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'runs', 'run-1'))).mode & 0o777).toBe(0o700);
  });

  it('tightens a file that already existed with a looser mode', async () => {
    const path = join(dir, 'reference.draft.txt');
    await writeFile(path, 'old', { mode: 0o644 });

    await writePrivateFile(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('new');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
