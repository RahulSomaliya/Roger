import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { cssDeclarations } from './cssDeclarations';
import { rendererSources } from './rendererSources';

/**
 * Colours live in tokens.css and nowhere else: a literal colour anywhere in the renderer is right
 * in one theme and wrong in the other (house rule, M4 "Theme"). A task that needs a new colour
 * adds a token at the end of tokens.css, in both themes, and reads it with var(--name).
 */
const CSS_FILES = rendererSources(
  (path) => path.endsWith('.css') && path !== 'src/theme/tokens.css',
);
const SCRIPT_FILES = rendererSources(
  (path) => /\.tsx?$/.test(path) && !path.endsWith('.test.ts') && !path.endsWith('.d.ts'),
);
const PAGE_FILES = rendererSources((path) => /\.(?:html|svg)$/.test(path));

/** CSS Color 4's named colours. `transparent`, `currentcolor` and system colours are fine. */
const NAMED_COLOURS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
  brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan
  darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen
  darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
  darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
  forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew
  hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue
  lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple
  mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue
  mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
  powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
  seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal
  thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/),
);

const HEX = /(?:^|[^\w&.#])(#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4}))\b/gi;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
/** A property or attribute that takes a colour, where a bare name like `red` is one. */
const COLOUR_PROPERTY = /colou?r|background|border|outline|fill|stroke|shadow|caret|accent/i;

/** Hex colours and colour functions in any text. */
function hexAndFunctions(text: string): string[] {
  return [
    ...[...text.matchAll(HEX)].map((match) => match[1] ?? ''),
    ...[...text.matchAll(COLOUR_FUNCTION)].map((match) => match[0]),
  ];
}

/** The literal colours in one CSS value: hex, colour functions and named colours. */
function literalColoursInValue(value: string): string[] {
  const bare = value
    .replace(/url\([^)]*\)/gi, '') // url(#mask) names an element, not a colour
    .replace(/(['"])(?:(?!\1).)*\1/g, '') // font names and `content` text
    .replace(/--[\w-]+/g, ''); // custom property names: var(--danger-bg)
  return [
    ...hexAndFunctions(bare),
    ...[...bare.matchAll(/[a-z]+/gi)]
      .map((match) => match[0])
      .filter((word) => NAMED_COLOURS.has(word.toLowerCase())),
  ];
}

/**
 * Each declaration in a style sheet that holds a literal colour, at any nesting depth
 * (cssDeclarations.ts says why that needs a scanner). Selectors are not values.
 */
function literalColoursInCss(css: string): string[] {
  return cssDeclarations(css)
    .filter(({ value }) => literalColoursInValue(value).length > 0)
    .map(({ property, value }) => `${property}: ${value}`);
}

/**
 * The strings in a script that hold a literal colour. Any string with a hex colour or a colour
 * function counts; a named colour counts only as the value of a colour property or attribute
 * (`style={{ color: 'red' }}`, `fill="red"`), because elsewhere `'red'` may be any word.
 */
function literalColoursInScript(fileName: string, text: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const parent = node.parent;
      const owner =
        ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent)
          ? parent.name.getText(source)
          : '';
      const colours = COLOUR_PROPERTY.test(owner)
        ? literalColoursInValue(node.text)
        : hexAndFunctions(node.text);
      if (colours.length > 0) found.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Literal colours in a page or an SVG: its style blocks and its attribute values. */
function literalColoursInPage(text: string): string[] {
  const uncommented = text.replace(/<!--[\s\S]*?-->/g, '');
  const styles = [...uncommented.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].flatMap(
    ([, css = '']) => literalColoursInCss(css),
  );
  const attributes = [...uncommented.matchAll(/\s([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].filter(
    ([, name = '', , value = '']) => {
      if (name.toLowerCase() === 'style') return literalColoursInCss(`{${value}}`).length > 0;
      if (COLOUR_PROPERTY.test(name)) return literalColoursInValue(value).length > 0;
      return hexAndFunctions(value).length > 0;
    },
  );
  return [...styles, ...attributes.map(([attribute]) => attribute.trim())];
}

function scan(
  files: Record<string, string>,
  find: (path: string, text: string) => string[],
): string[] {
  return Object.entries(files).flatMap(([path, text]) =>
    find(path, text).map((colour) => `${path}: ${colour}`),
  );
}

describe('literal colours in the renderer', () => {
  it('finds every kind of literal colour (the scans below can fail)', () => {
    expect(
      literalColoursInCss(`
        .a { color: #fff; background: rgb(0 0 0 / 50%); }
        .b { border: 1px solid white; fill: hsl(10 20% 30%); }
        .c { outline-color: oklch(0.7 0.1 200); box-shadow: 0 0 2px #00000080; }
      `),
    ).toEqual([
      'color: #fff',
      'background: rgb(0 0 0 / 50%)',
      'border: 1px solid white',
      'fill: hsl(10 20% 30%)',
      'outline-color: oklch(0.7 0.1 200)',
      'box-shadow: 0 0 2px #00000080',
    ]);
    // Native nesting (Electron's Chromium renders it): a rule that holds a rule keeps its own
    // declarations before and after the inner one, and a string may hold a brace.
    expect(
      literalColoursInCss(`
        .note { background: #fff; &:hover { background: var(--panel); } }
        .row { &:hover { color: var(--ink); } color: red; }
        @media (width > 600px) { .wide { & .cell { border-color: #ccc } } }
        .quote { content: '}'; color: hsl(0 0% 0%) }
      `),
    ).toEqual(['background: #fff', 'color: red', 'border-color: #ccc', 'color: hsl(0 0% 0%)']);
    expect(
      literalColoursInScript(
        'Probe.tsx',
        `const a = <div style={{ color: 'red', border: \`1px solid \${b}\` }} />;
         const c = <path fill="black" />;
         const d = '#a1b2c3';
         const e = \`rgba(\${f}, 0.5)\`;`,
      ),
    ).toEqual(["'red'", '"black"', "'#a1b2c3'", '`rgba(${']);
    expect(
      literalColoursInPage(
        '<meta name="theme-color" content="#ffffff"><div style="color: red"></div><svg><path stroke="tan"/></svg>',
      ),
    ).toEqual(['content="#ffffff"', 'style="color: red"', 'stroke="tan"']);
  });

  it('lets tokens, keywords, selectors, ids, routes and words through', () => {
    expect(
      literalColoursInCss(`
        #root .red-dot:not(.white) { color: var(--danger); background: var(--danger-bg); }
        .a { border-color: transparent; fill: currentColor; mask: url(#a1b); }
        .b { font-family: -apple-system, 'Segoe UI', sans-serif; content: 'red'; }
        .c { background: color-mix(in srgb, var(--accent) 20%, transparent); }
        .d { font-weight: 650; grid-template-columns: 64px 48px 1fr; }
        .e { color: var(--ink); &:not(.red):hover { color: var(--muted); } }
      `),
    ).toEqual([]);
    expect(
      literalColoursInScript(
        'Probe.tsx',
        `const route = '#/meetings/abc'; const state = 'red';
         class A { #bad = 1; read() { return this.#bad; } }
         const entity = '&#1234;'; const id = document.getElementById('root');
         const a = <a href="#/settings" className="white">x</a>;`,
      ),
    ).toEqual([]);
  });

  it('no renderer CSS file outside tokens.css holds a hex, rgb or hsl colour', () => {
    // A glob that matched nothing would pass on any colour.
    expect(Object.keys(CSS_FILES)).toContain('src/styles.css');
    expect(Object.keys(CSS_FILES)).not.toContain('src/theme/tokens.css');
    expect(scan(CSS_FILES, (_path, text) => literalColoursInCss(text))).toEqual([]);
  });

  it('no renderer script or page holds a literal colour either', () => {
    expect(Object.keys(SCRIPT_FILES)).toContain('src/App.tsx');
    expect(Object.keys(SCRIPT_FILES)).not.toContain('src/theme/noLiteralColours.test.ts');
    expect(Object.keys(PAGE_FILES)).toContain('index.html');
    expect(scan(SCRIPT_FILES, literalColoursInScript)).toEqual([]);
    expect(scan(PAGE_FILES, (_path, text) => literalColoursInPage(text))).toEqual([]);
  });
});
