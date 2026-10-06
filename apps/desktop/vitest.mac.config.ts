import { defineConfig } from 'vitest/config';

// Tests that need macOS itself: the Swift helper, afconvert, Core Audio. Run with
// `pnpm test:mac`; `vitest.config.ts` excludes the same pattern, so every file runs in exactly one
// of the two. Pass with none: `make check` runs this on a Mac before the first such test exists.
export default defineConfig({
  test: {
    include: ['**/*.mac.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    passWithNoTests: true,
  },
});
