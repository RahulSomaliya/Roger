import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from './icons';
import { nextIndex } from './keyNav';
import { menuSide } from './menuPlacement';
import { useLeave } from './useLeave';

/**
 * The more-actions menu (docs/design.md, Menu): what is used rarely (Write again as, Restore previous
 * notes), behind a ghost icon button. Keyboard: Enter, Space or ArrowDown on the button opens it
 * on the first item, arrows move (wrapping), Esc closes and puts focus back on the button, Tab
 * closes, and a pointer press outside closes. Picking an item runs it, then closes.
 *
 * The list stays inside the window at every width: `align` is the side asked for, and the open list
 * flips to the other one when it would run off the window (`menuSide`). A fixed side opened 142 px
 * off the left edge at 390 px, where the meeting header's buttons wrap under the title.
 */
export interface MenuEntry {
  id: string;
  label: string;
  onSelect: () => void;
}

export interface MenuProps {
  /** Names the button for a screen reader ("More actions"). */
  label: string;
  items: readonly MenuEntry[];
  /** Which edge of the button the list lines up with; `end` (right) is the more-actions button at a row's end. */
  align?: 'start' | 'end';
}

/** Must match `--dur-menu-leave` in styles.css (useLeave.ts says why it is a timer). */
const LEAVE_MS = 140;
/** The room the open list keeps from the window's edge: `--space-2`. */
const MARGIN_PX = 8;

export function Menu({ label, items, align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const { leaving, start } = useLeave(open, LEAVE_MS, () => {
    setOpen(false);
  });

  // Keep the open list inside the window. It writes the attribute on the element, not state: a
  // state write in an effect renders the list once on the wrong side first, and React leaves the
  // attribute alone on later renders because the `align` prop does not change.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const list = anchor.current?.querySelector<HTMLElement>('.menu');
      const button = trigger.current;
      if (!list || !button) return;
      const box = button.getBoundingClientRect();
      list.dataset.align = menuSide(
        align,
        box,
        list.offsetWidth,
        document.documentElement.clientWidth,
        MARGIN_PX,
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
    };
  }, [open, align]);

  // Focus the first item as the list appears. Not a setState: the effect only moves focus.
  useEffect(() => {
    if (open) anchor.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent): void => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) start();
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
    };
  });

  const itemButtons = (): HTMLElement[] =>
    Array.from(anchor.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      start();
      trigger.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      start();
      return;
    }
    const buttons = itemButtons();
    const focused = buttons.findIndex((button) => button === document.activeElement);
    const next = nextIndex('vertical', event.key, focused, buttons.length);
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <div className="menu-anchor" ref={anchor}>
      <button
        ref={trigger}
        type="button"
        className="btn"
        data-variant="ghost"
        data-size="sm"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          if (open) start();
          else setOpen(true);
        }}
      >
        <Icon name="ellipsis" />
      </button>
      {open ? (
        <MenuList
          id={listId}
          label={label}
          items={items}
          align={align}
          leaving={leaving}
          onKeyDown={onListKeyDown}
          onPick={(entry) => {
            entry.onSelect();
            start();
            trigger.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

/** The open list. Its own component so a test can render it open: effects never run in
    renderToStaticMarkup, so `Menu` itself always renders closed there. */
export function MenuList(props: {
  id: string;
  label: string;
  items: readonly MenuEntry[];
  align: 'start' | 'end';
  leaving: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPick: (entry: MenuEntry) => void;
}) {
  return (
    <div
      id={props.id}
      className="menu"
      role="menu"
      aria-label={props.label}
      data-align={props.align}
      data-leaving={props.leaving ? '' : undefined}
      onKeyDown={props.onKeyDown}
    >
      {props.items.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          className="menu-item"
          tabIndex={-1}
          onClick={() => {
            props.onPick(entry);
          }}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
