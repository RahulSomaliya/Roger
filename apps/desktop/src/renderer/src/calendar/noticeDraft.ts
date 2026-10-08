/**
 * The text Settings saves when the notice box loses focus, or null when there is nothing to save.
 * The box saves on blur (redesign R6: no Save notice button), so every blur lands here, and most
 * are a click through the box that changed nothing.
 *
 * A blank text is never saved: main refuses `notice.text` when it is blank (a blank notice would
 * paste nothing), so sending it would only raise a "could not save" line. The page shows its own
 * line for a blank draft and keeps the stored text.
 */
export function noticeToSave(draft: string, stored: string): string | null {
  if (draft.trim() === '' || draft === stored) return null;
  return draft;
}
