import { defineConfig } from 'vitest/config';

// The Electron smoke test: `pnpm test:e2e` (`make e2e-desktop`) builds the app, then each
// `e2e/*.e2e.ts` launches the unpackaged build through playwright-core. Pass with none until the
// first smoke test lands.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    passWithNoTests: true,
    // Vitest's 5 s default is shorter than one Electron launch plus the wait for the first
    // transcript line (up to 10 s).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
