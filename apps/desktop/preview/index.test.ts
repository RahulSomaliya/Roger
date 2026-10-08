import { describe, expect, it } from 'vitest';
import rendererHtml from '../src/renderer/index.html?raw';
import previewHtml from './index.html?raw';
import promptPreviewHtml from './prompt.html?raw';
import promptRendererHtml from '../src/renderer/prompt.html?raw';

const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/;

/** The page's Content-Security-Policy, and where in the source its meta tag starts. */
function policyOf(html: string, page: string): { policy: string; at: number } {
  const match = CSP_META.exec(html);
  if (match?.[1] === undefined) throw new Error(`${page} has no Content-Security-Policy meta tag`);
  return { policy: match[1], at: match.index };
}

describe('preview/index.html', () => {
  // The renderer's policy keeps the network in main (house rule 5): an image from another host or
  // a direct fetch to the API is refused in Electron. Without the same policy the preview draws
  // it, logs nothing, and every QA check passes on a page the app breaks.
  it("enforces the renderer's Content-Security-Policy, unchanged", () => {
    const renderer = policyOf(rendererHtml, 'src/renderer/index.html');
    expect(policyOf(previewHtml, 'preview/index.html').policy).toBe(renderer.policy);
  });

  // A meta policy covers only what the page loads after it.
  it('sets the policy before any script', () => {
    const { at } = policyOf(previewHtml, 'preview/index.html');
    const firstScript = previewHtml.indexOf('<script');
    expect(firstScript).toBeGreaterThan(at);
  });
});

describe('preview/prompt.html', () => {
  // The panel's own policy is narrower than the main window's (no media, no workers).
  it("enforces the prompt panel's Content-Security-Policy, unchanged", () => {
    const panel = policyOf(promptRendererHtml, 'src/renderer/prompt.html');
    expect(policyOf(promptPreviewHtml, 'preview/prompt.html').policy).toBe(panel.policy);
  });

  it('sets the policy before any script', () => {
    const { at } = policyOf(promptPreviewHtml, 'preview/prompt.html');
    expect(promptPreviewHtml.indexOf('<script')).toBeGreaterThan(at);
  });
});
