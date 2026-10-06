import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Three Vite builds: main (Node), preload (Node, sandboxed CommonJS) and renderer (Chromium).
// `src/shared` is plain TypeScript with no runtime imports so every side can use it.
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
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
    worker: { format: 'es' },
  },
});
