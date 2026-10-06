import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * The bench's settings come from the same repo-root `.env` as the desktop in development
 * (main/index.ts, loadDevEnv), with the same rule: only the desktop's own `ROGER_*` keys are taken,
 * so the API's vendor keys in that file never enter the bench (house rule 3 holds for tools too:
 * the bench asks the API for a token like the app). A variable already set wins.
 *
 * The repo root is the first folder above `startDir` holding `pnpm-workspace.yaml`: `make bench`
 * runs the CLI from apps/desktop. Returns the file it loaded, or null when there was none.
 */
export function loadRepoEnv(env: NodeJS.ProcessEnv, startDir: string): string | null {
  for (let folder = startDir; ; folder = dirname(folder)) {
    if (existsSync(join(folder, 'pnpm-workspace.yaml'))) {
      const path = join(folder, '.env');
      if (!existsSync(path)) return null;
      for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
        if (key.startsWith('ROGER_') && env[key] === undefined) env[key] = value;
      }
      return path;
    }
    if (dirname(folder) === folder) return null;
  }
}
