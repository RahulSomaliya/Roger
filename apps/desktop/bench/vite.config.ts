import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The STT benchmark CLI (`pnpm bench`, `make bench`): bench/cli.ts bundled for plain Node into
// bench/dist/cli.js, which the `bench` script then runs. Vite is already a dev dependency, so the
// bench needs no TypeScript runner of its own (M3 design, "Benchmark code"). An SSR build targets
// Node and leaves node_modules (`ws`) and Node built-ins as imports, resolved at run time from
// apps/desktop. CommonJS, because package.json has no "type": "module" and the script runs the
// file as `.js`. Never import Electron from anything the CLI reaches: run/imports.test.ts.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: fileURLToPath(new URL('./cli.ts', import.meta.url)),
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'cli.js' } },
  },
});
