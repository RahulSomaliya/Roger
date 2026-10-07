import { mkdir, writeFile } from 'node:fs/promises';
import { AUDIO_SOURCES, type AudioSource } from '../../../src/shared/transcript';
import { encodeWav } from '../../core/wav';
import { type ItemOrigin, type ItemSetup, itemPaths } from '../items';

/** Test-only: one item folder as `bench clip` (M3-T12) leaves it, plus a reference when given. */
export async function writeTestItem(
  benchDir: string,
  id: string,
  options: {
    origin?: ItemOrigin;
    setup?: ItemSetup;
    /** Audio per stream; a stream left out has no WAV file. */
    audio: Partial<Record<AudioSource, Int16Array>>;
    reference?: string;
  },
): Promise<void> {
  const paths = itemPaths(benchDir, id);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(
    paths.itemJson,
    JSON.stringify({
      id,
      origin: options.origin ?? 'backup',
      setup: options.setup ?? 'headphones',
    }),
  );
  for (const source of AUDIO_SOURCES) {
    const samples = options.audio[source];
    if (samples !== undefined) await writeFile(paths.wav(source), encodeWav(samples));
  }
  if (options.reference !== undefined) await writeFile(paths.reference, options.reference);
}

/** A tone loud enough for the fake adapter to "hear" (its level lines), `ms` long at 16 kHz. */
export function tone(ms: number): Int16Array {
  const samples = new Int16Array(ms * 16);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(8000 * Math.sin(index / 5));
  }
  return samples;
}
