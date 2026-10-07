import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Three Vite builds: main (Node), preload (Node, sandboxed CommonJS) and renderer (Chromium).
// `src/shared` is plain TypeScript with no runtime imports so every side can use it.
// The preload and the renderer each build two entries: the app's, and the prompt panel's own
// (M5-T10: out/preload/prompt.js and out/renderer/prompt.html). The panel gets its own preload so
// its page never has `window.roger`.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          prompt: resolve(__dirname, 'src/preload/prompt.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          prompt: resolve(__dirname, 'src/renderer/prompt.html'),
        },
      },
    },
    worker: { format: 'es' },
  },
});
