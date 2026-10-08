import type { KeyboardEvent } from 'react';
import { nextIndex } from './keyNav';

/**
 * The one tab row (docs/design.md, Tabs): a segmented track, the picked tab raised. Never more
 * than four, which `TabList` enforces in the type: a fifth is a compile error, not a layout bug.
 *
 * It renders only the row. The panes belong to the caller, who keeps every one MOUNTED and sets
 * `hidden` on the others: unmounting the notes editor would drop its unsaved text and save
 * timers, and the citation navigator finds a chip's line in a hidden transcript (docs/design.md,
 * Traps). Give each pane `id={panelId(idPrefix, tab.id)}` and `aria-labelledby={tabId(...)}`.
 *
 * Arrow keys, Home and End move between tabs and pick as they go: panes swap at once, so there is
 * nothing to confirm with Enter. Only the picked tab is in the Tab order.
 */
export interface TabSpec {
  id: string;
  label: string;
}

export type TabList =
  | readonly [TabSpec]
  | readonly [TabSpec, TabSpec]
  | readonly [TabSpec, TabSpec, TabSpec]
  | readonly [TabSpec, TabSpec, TabSpec, TabSpec];

export interface TabsProps {
  tabs: TabList;
  /** The picked tab's id. */
  selected: string;
  onSelect: (id: string) => void;
  /** Names the row for a screen reader ("Meeting"). */
  label: string;
  /** Keeps the ids unique when two rows share a page. */
  idPrefix: string;
}

export const tabId = (idPrefix: string, id: string): string => `${idPrefix}-tab-${id}`;
export const panelId = (idPrefix: string, id: string): string => `${idPrefix}-panel-${id}`;

export function Tabs({ tabs, selected, onSelect, label, idPrefix }: TabsProps) {
  const pick = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = tabs.findIndex((tab) => tab.id === selected);
    const next = nextIndex('horizontal', event.key, Math.max(current, 0), tabs.length);
    const target = next === null ? undefined : tabs[next];
    if (target === undefined) return;
    event.preventDefault();
    onSelect(target.id);
    // Focus follows the pick; the button exists already, so no effect is needed.
    document.getElementById(tabId(idPrefix, target.id))?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={pick}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="tab"
          id={tabId(idPrefix, tab.id)}
          aria-selected={tab.id === selected}
          aria-controls={panelId(idPrefix, tab.id)}
          tabIndex={tab.id === selected ? 0 : -1}
          onClick={() => {
            onSelect(tab.id);
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
