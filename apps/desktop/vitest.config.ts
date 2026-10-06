import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'bench/**/*.test.ts', 'preview/**/*.test.ts'],
    // Mac-only tests (the Swift helper, afconvert) run in `pnpm test:mac` and the Electron smoke
    // test in `pnpm test:e2e`; here they would fail on Linux CI. Setting `exclude` replaces
    // Vitest's defaults, so they are spread back in, or node_modules would be searched too.
    exclude: [...configDefaults.exclude, '**/*.mac.test.ts', 'e2e/**'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
});
