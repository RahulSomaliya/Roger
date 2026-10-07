/**
 * Every declaration in a style sheet, at any depth, for the theme tests (noLiteralColours.test.ts,
 * tokens.test.ts). Never import it from app code: the page has no use for it.
 *
 * Why a scanner and not `/\{([^{}]*)\}/` over the blocks: that regex sees only innermost blocks.
 * With native CSS nesting, which Electron's Chromium renders and Vite passes through, a rule that
 * holds a rule (`.note { background: #fff; &:hover { ... } }`) is never an innermost block, so its
 * own declarations were never read and a literal colour there passed the colour test.
 */

export interface CssDeclaration {
  property: string;
  value: string;
}

export function cssDeclarations(css: string): CssDeclaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: CssDeclaration[] = [];
  let depth = 0;
  let brackets = 0;
  let segment = '';

  /** The text since the last `{`, `;` or `}` ends here: inside a block, it is a declaration. */
  const endSegment = (): void => {
    const colon = segment.indexOf(':');
    if (depth > 0 && colon !== -1) {
      found.push({
        property: segment.slice(0, colon).trim(),
        value: segment.slice(colon + 1).trim(),
      });
    }
    segment = '';
  };

  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === '"' || char === "'") {
      // A string may hold a brace or a semicolon (`content: '}'`); it never ends anything.
      const close = closingQuote(text, at);
      segment += text.slice(at, close + 1);
      at = close;
    } else if (char === '(' || char === ')') {
      // So does an unquoted url(data:...;...).
      brackets = Math.max(0, brackets + (char === '(' ? 1 : -1));
      segment += char;
    } else if (brackets > 0) {
      segment += char;
    } else if (char === '{') {
      // What came before was a selector (`&:hover`) or an at-rule's prelude, never a declaration.
      depth += 1;
      segment = '';
    } else if (char === ';') {
      endSegment();
    } else if (char === '}') {
      endSegment();
      depth = Math.max(0, depth - 1);
    } else {
      segment += char;
    }
  }
  return found;
}

/** Where the string opened at `open` closes, skipping escaped quotes; the end of the text if never. */
function closingQuote(text: string, open: number): number {
  const quote = text.charAt(open);
  for (let at = open + 1; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (char === '\\') at += 1;
    else if (char === quote) return at;
  }
  return text.length - 1;
}
