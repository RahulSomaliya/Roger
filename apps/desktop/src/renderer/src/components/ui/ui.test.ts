import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog } from './Dialog';
import { Icon, ICON_NAMES } from './icons';
import { Menu, MenuList } from './Menu';
import { panelId, tabId, Tabs, type TabList } from './Tabs';

/**
 * Server-rendered markup only, as every renderer test here (apps/desktop/CLAUDE.md): effects do
 * not run, so what these check is the structure a screen reader and the CSS read. The key logic is
 * keyNav.test.ts; the look is styles.css and the QA gallery.
 */

const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element);

describe('Icon', () => {
  it('draws ten icons, no more: a new one is a decision, not an accident', () => {
    expect([...ICON_NAMES].sort()).toEqual([
      'arrow-left',
      'check',
      'chevron-down',
      'chevron-right',
      'circle-alert',
      'copy',
      'ellipsis',
      'refresh-cw',
      'settings',
      'x',
    ]);
  });

  it('is 16 px, stroke 1.5, currentColor and hidden from a screen reader', () => {
    for (const name of ICON_NAMES) {
      const svg = html(createElement(Icon, { name }));
      expect(svg).toContain('width="16" height="16"');
      expect(svg).toContain('stroke="currentColor"');
      expect(svg).toContain('stroke-width="1.5"');
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toMatch(/<(path|circle|line|rect) /);
    }
  });
});

describe('Tabs', () => {
  const tabs: TabList = [
    { id: 'mine', label: 'My notes' },
    { id: 'ai', label: 'AI notes' },
    { id: 'transcript', label: 'Transcript' },
    { id: 'chat', label: 'Chat' },
  ];
  const markup = html(
    createElement(Tabs, {
      tabs,
      selected: 'ai',
      onSelect: () => undefined,
      label: 'Meeting',
      idPrefix: 'm',
    }),
  );

  it('is one named tablist with a tab per entry, in order', () => {
    expect(markup).toContain('role="tablist" aria-label="Meeting"');
    const labels = [...markup.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((match) => match[1]);
    expect(labels).toEqual(['My notes', 'AI notes', 'Transcript', 'Chat']);
  });

  it('marks only the picked tab selected, and only it in the Tab order', () => {
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    expect(markup).toMatch(/id="m-tab-ai"[^>]*aria-selected="true"[^>]*tabindex="0"/);
    expect(markup).toMatch(/id="m-tab-chat"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  });

  it('points each tab at its pane by an id the caller can use', () => {
    expect(tabId('m', 'ai')).toBe('m-tab-ai');
    expect(panelId('m', 'ai')).toBe('m-panel-ai');
    expect(markup).toContain('aria-controls="m-panel-ai"');
  });
});

describe('Menu', () => {
  const items = [
    { id: 'again', label: 'Write again as', onSelect: () => undefined },
    { id: 'restore', label: 'Restore previous notes', onSelect: () => undefined },
  ];

  it('is closed until opened: only the ghost icon button, named and collapsed', () => {
    const markup = html(createElement(Menu, { label: 'More actions', items }));
    expect(markup).toContain('aria-label="More actions"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-variant="ghost"');
    expect(markup).not.toContain('role="menu"');
    expect(markup).not.toContain('Write again as');
  });

  it('lists its items as menu items kept out of the Tab order, so arrows are the way in', () => {
    const markup = html(
      createElement(MenuList, {
        id: 'x',
        label: 'More actions',
        items,
        align: 'end',
        leaving: false,
        onKeyDown: () => undefined,
        onPick: () => undefined,
      }),
    );
    expect(markup).toContain('role="menu"');
    expect([...markup.matchAll(/role="menuitem"[^>]*tabindex="-1"/g)]).toHaveLength(2);
    expect(markup).toContain('>Restore previous notes<');
    expect(markup).not.toContain('data-leaving');
  });
});

describe('Dialog', () => {
  const dialog = (open: boolean): string =>
    html(
      createElement(Dialog, {
        open,
        title: 'Details',
        onClose: () => undefined,
        children: createElement('p', null, 'Source states'),
      }),
    );

  it('mounts nothing inside while closed, so a Details dialog reads nothing until opened', () => {
    const markup = dialog(false);
    expect(markup).toMatch(/^<dialog[^>]*class="dialog"[^>]*><\/dialog>$/);
    expect(markup).not.toContain('Source states');
  });

  it('is named by its heading, closes from an x, and shows its children when open', () => {
    const markup = dialog(true);
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
    expect(labelledBy).toBeDefined();
    expect(markup).toContain(`<h2 class="dialog-title" id="${labelledBy ?? ''}">Details</h2>`);
    expect(markup).toContain('aria-label="Close"');
    expect(markup).toContain('<p>Source states</p>');
  });
});
