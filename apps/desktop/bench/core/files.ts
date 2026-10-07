import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write a bench file that only its owner can read: mode 0600 in folders made 0700. Everything the
 * bench writes under ROGER_BENCH_DIR is a recording of real people or text transcribed from one
 * (M3 D2), so every writer goes through here.
 *
 * `writeFile`'s `mode` only applies when it creates the file; the chmod covers a file that already
 * existed with a looser mode (a re-clip, a re-run), which would otherwise keep it.
 */
export async function writePrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
}
