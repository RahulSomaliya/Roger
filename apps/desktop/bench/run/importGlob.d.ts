import type { ImportGlobFunction } from 'vite';

/**
 * Vite's `import.meta.glob`, which tsconfig.node.json (`types: ["node"]`) does not declare;
 * run/dataset.ts finds M3-T12's command table with it. Only `glob`, not all of vite/client: its
 * `import.meta.env` types every key as `any`, in main's code too. Declared as vite/client declares
 * it, so the two merge if a program ever holds both.
 */
declare global {
  interface ImportMeta {
    glob: ImportGlobFunction;
  }
}
