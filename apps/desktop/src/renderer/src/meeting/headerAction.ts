import type { CapturePhase } from '../../../shared/capture';
import { suggestTemplate } from '../../../shared/suggestTemplate';
import type { MenuEntry } from '../components/ui/Menu';
import { type AiNotesSession, type AiNotesState, layoutAiNotes } from '../notes/aiNotesActions';

/**
 * What the meeting header's one primary button is (the table "The one primary, per screen and
 * moment" in docs/design.md). `none` is a real answer: with AI notes written the notes are the
 * loud thing, and a past meeting beside a live one offers nothing.
 */
export type HeaderAction =
  /** "Starting…", busy. */
  | { kind: 'start' }
  /** "Stop", or "Stopping…" while busy. */
  | { kind: 'stop'; busy: boolean }
  /** "Write notes". */
  | { kind: 'write' }
  /** "Writing notes…", busy, with Cancel (ghost) while main can drop the generate. */
  | { kind: 'writing'; cancellable: boolean; cancelling: boolean }
  | { kind: 'none' };

export interface HeaderActionInput {
  /** This meeting's phase (meetingPhase), never main's alone. */
  phase: CapturePhase;
  /** A start or stop is running (the shell's `capture.busy`). */
  captureBusy: boolean;
  /** Main records, starts or stops ANOTHER meeting: this one offers nothing. */
  elsewhere: boolean;
  /** Main holds this meeting; "Write notes" has nothing to write from otherwise. */
  stored: boolean;
  notes: AiNotesState;
}

export function headerAction({
  phase,
  captureBusy,
  elsewhere,
  stored,
  notes,
}: HeaderActionInput): HeaderAction {
  switch (phase) {
    case 'starting':
      return { kind: 'start' };
    case 'recording':
      return { kind: 'stop', busy: captureBusy };
    case 'stopping':
      return { kind: 'stop', busy: true };
    case 'idle':
      break;
  }
  // The AI notes state answers only once main has: before that Write notes would flash and then
  // vanish for a meeting that already has notes, and a failed read says so in its own problem line.
  if (elsewhere || !stored || notes.status !== 'ready') return { kind: 'none' };
  const layout = layoutAiNotes(notes);
  // `busy` is the press itself, before main has a pending generate to cancel.
  if (layout.stop !== null || layout.stream === 'live' || notes.busy === 'generate') {
    return { kind: 'writing', cancellable: layout.stop !== null, cancelling: notes.cancelling };
  }
  return layout.empty ? { kind: 'write' } : { kind: 'none' };
}

/**
 * The template "Write notes" uses: the title's best guess (shared/suggestTemplate.ts), else
 * General (docs/plans/redesign.md, call 6: no question, "Write again as" changes it). The page
 * cannot read notes.sqlite's remembered picks, so `lastPick` is none.
 */
export function templateForWriting(title: string): string {
  return suggestTemplate({ title, lastPick: () => null }).templateId ?? 'general';
}

/** What the ⋯ menu calls; AiNotesSession is one, a test passes stand-ins. */
export type NotesMenuActions = Pick<AiNotesSession, 'regenerate' | 'restorePrevious'>;

/**
 * The ⋯ menu's entries: what is used rarely once AI notes exist (docs/design.md, Menu). "Write
 * again as" lists the templates (the call 6 replacement for the question after Stop), "Restore
 * previous notes" brings back what the last run replaced. Both ask first over notes the user
 * edited (the session's `confirm`, which the page shows). None while a run is under way
 * (`canRegenerate`) or before there are notes.
 */
export function notesMenuEntries(
  state: AiNotesState,
  actions: NotesMenuActions,
): readonly MenuEntry[] {
  if (state.status !== 'ready') return [];
  const layout = layoutAiNotes(state);
  const again: MenuEntry[] =
    layout.canRegenerate && state.templates.status === 'ready'
      ? state.templates.value.map((template) => ({
          id: `write-again-${template.id}`,
          label: `Write again as ${template.name}`,
          onSelect: () => {
            void actions.regenerate(template.id);
          },
        }))
      : [];
  const restore: MenuEntry[] =
    layout.restorable === null
      ? []
      : [
          {
            id: 'restore-previous',
            label: 'Restore previous notes',
            onSelect: () => {
              void actions.restorePrevious();
            },
          },
        ];
  return [...again, ...restore];
}
