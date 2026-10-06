import { Component, createElement, type ReactNode } from 'react';
import { describeError } from './describeError';
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

interface SlotBoundaryProps {
  slot: SlotName;
  id: string;
  children: ReactNode;
}

/**
 * One failing mount must not blank the window: React unmounts the whole tree on an error no
 * boundary catches, and the user loses the Stop button mid-call. The failure stays visible in
 * place of that one entry.
 */
class SlotBoundary extends Component<SlotBoundaryProps, { failure: string | null }> {
  override state: { failure: string | null } = { failure: null };

  static getDerivedStateFromError(error: unknown): { failure: string } {
    return { failure: describeError(error) };
  }

  override render(): ReactNode {
    if (this.state.failure === null) return this.props.children;
    return (
      <div role="alert" className="error slot-failure">
        This part of Roger failed to show ({this.props.slot}: {this.props.id}): {this.state.failure}
      </div>
    );
  }
}
