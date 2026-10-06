import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The renderer preview: the renderer's React code in a plain browser tab, with a fake
// `window.roger` (preview/). `pnpm preview:renderer` serves it for people; qa/driver.ts starts the
// same config on a free port for QA scripts. Dev server only: nothing here is built or shipped.
export default defineConfig({
  root: fileURLToPath(new URL('./preview', import.meta.url)),
  // Not the default node_modules/.vite, where the Electron renderer's dev server keeps its own
  // optimised dependencies: two dev servers sharing it re-optimise over each other.
  cacheDir: fileURLToPath(new URL('./node_modules/.vite-preview', import.meta.url)),
  plugins: [react()],
  // Loopback only: the preview has no reason to be reachable from the network.
  server: { host: '127.0.0.1' },
  worker: { format: 'es' },
});
