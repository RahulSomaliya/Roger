/**
 * The renderer's own source files as text, for the theme tests (noLiteralColours.test.ts,
 * tokens.test.ts). Never import it from app code: the page has no Node.
 *
 * Why not `import.meta.glob(..., { query: '?raw' })`: Vitest turns every CSS import into an empty
 * string, `?raw` included, unless its `css` option is on, so a colour scan through it passes on
 * any colour. And the page's tsconfig has no Node types, so `node:fs` cannot be imported. The tests
 * run under Node, so this asks Node for its file module at run time (Node 22.3 and later).
 */

interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
  readdirSync(path: URL, options: { recursive: true; encoding: 'utf8' }): string[];
}

interface NodeProcess {
  getBuiltinModule(id: 'node:fs'): NodeFs;
}

/** src/renderer/, the folder every path below is relative to. */
const RENDERER = new URL('../../', import.meta.url);

function nodeFs(): NodeFs {
  const { process } = globalThis as { process?: NodeProcess };
  if (!process) throw new Error('rendererSources reads files and runs only under Node (Vitest)');
  return process.getBuiltinModule('node:fs');
}

/** Every file under src/renderer/ whose path passes `include`, by path relative to it. */
export function rendererSources(include: (path: string) => boolean): Record<string, string> {
  const fs = nodeFs();
  const paths = fs.readdirSync(RENDERER, { recursive: true, encoding: 'utf8' }).filter(include);
  return Object.fromEntries(
    paths.sort().map((path) => [path, fs.readFileSync(new URL(path, RENDERER), 'utf8')]),
  );
}

/** One file under src/renderer/, such as `src/theme/tokens.css`. */
export function rendererSource(path: string): string {
  return nodeFs().readFileSync(new URL(path, RENDERER), 'utf8');
}
