import { Component, createElement, type ReactNode } from 'react';
import { Icon } from '../components/ui/icons';
import type { SlotName, SlotPropsByName } from './slotRegistry';
import { slots } from './slots';

interface SlotOutletProps<Name extends SlotName> {
  name: Name;
  props: SlotPropsByName[Name];
}

/** Renders every entry mounted in one slot (./slots.ts), in order. Nothing when none is. */
export function SlotOutlet<Name extends SlotName>({ name, props }: SlotOutletProps<Name>) {
  return slots[name].map((entry) => (
    <SlotBoundary key={entry.id} slot={name} id={entry.id}>
      {createElement(entry.component, props)}
    </SlotBoundary>
  ));
}

/** True when nothing is mounted in the slot, so a page can show its own empty state. */
export function isSlotEmpty(name: SlotName): boolean {
  return slots[name].length === 0;
}

export interface SlotBoundaryProps {
  slot: SlotName;
  id: string;
  children: ReactNode;
}

/**
 * One failing mount must not blank the window: React unmounts the whole tree on an error no
 * boundary catches, and the user loses the Stop button mid-call. The failure stays visible in
 * place of that one entry, as a problem line (docs/design.md): an icon and words, no red box.
 * The words are plain, with a way out ("Try again" draws the part again); the slot and entry ids
 * and the error go to the log through `reportError`, never to the screen (redesign sweep, App. A).
 */
export class SlotBoundary extends Component<SlotBoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    reportError(
      new Error(`Slot ${this.props.slot} entry ${this.props.id} failed to render`, {
        cause: error,
      }),
    );
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="problem slot-problem">
        <Icon name="circle-alert" />
        <span className="problem-text">Roger could not show this part of the page.</span>
        <button
          type="button"
          className="btn"
          data-size="sm"
          onClick={() => {
            this.setState({ failed: false });
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
