import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConnectCalendarCard } from './ConnectCalendarCard';

// The card is called as a function below, outside a render, where React's hooks do not run.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useId: () => 'heading',
}));

describe('ConnectCalendarCard', () => {
  it('is a titled section that says what connecting gives, and that it only reads', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectCalendarCard, { connecting: false, error: null, onConnect: vi.fn() }),
    );
    expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
    expect(html).toContain('See your day in Roger');
    expect(html).toContain('reminds you just before a call');
    expect(html).toContain('Roger only reads your calendar');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it('connects when the button is pressed', () => {
    const onConnect = vi.fn();
    const section = ConnectCalendarCard({ connecting: false, error: null, onConnect });
    const found: (() => void)[] = [];
    const walk = (node: unknown): void => {
      if (!isValidElement<{ children?: unknown; onClick?: () => void }>(node)) return;
      if (node.type === 'button' && node.props.onClick !== undefined)
        found.push(node.props.onClick);
      for (const child of [node.props.children].flat()) walk(child);
    };
    walk(section);
    expect(found).toHaveLength(1);
    found[0]?.();
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
