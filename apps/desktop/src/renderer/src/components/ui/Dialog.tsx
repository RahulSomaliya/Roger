import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { Icon } from './icons';
import { useLeave } from './useLeave';

/**
 * The modal dialog (docs/design.md, Dialog): a native <dialog> shown with showModal(), so the
 * browser traps focus, makes the page behind it inert and closes on Esc, and the scrim is its
 * ::backdrop. Esc, the close button and a press on the scrim all ask the parent to close (`onClose`) after
 * the exit has played; the parent owns `open`.
 *
 * The children mount only while it is open, so a Details dialog reads nothing until someone opens
 * it. A summary inside goes in `<div className="dialog-panel">` (`sunken`), a button row in
 * `<div className="dialog-actions">`. Destructive steps confirm in place: the same button reads
 * "Delete audio?" and then "Delete", never a second dialog.
 */
export interface DialogProps {
  open: boolean;
  /** The heading, and the dialog's accessible name. */
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** Must match `--dur-dialog-leave` in styles.css (useLeave.ts says why it is a timer). */
const LEAVE_MS = 180;

export function Dialog({ open, title, onClose, children }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { leaving, start } = useLeave(open, LEAVE_MS, onClose);

  // showModal() and close() are the DOM's own, so they follow `open` from an effect.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const askToClose = (event: SyntheticEvent): void => {
    // The browser would close it at once and skip the exit.
    event.preventDefault();
    start();
  };

  const closeOnScrimPress = (event: MouseEvent<HTMLDialogElement>): void => {
    // The dialog has no padding of its own, so a press on its ::backdrop lands on the element.
    if (event.target === event.currentTarget) start();
  };

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={titleId}
      data-leaving={leaving ? '' : undefined}
      onCancel={askToClose}
      onClick={closeOnScrimPress}
    >
      {open ? (
        <>
          <div className="dialog-header">
            <h2 className="dialog-title" id={titleId}>
              {title}
            </h2>
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              aria-label="Close"
              onClick={start}
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
        </>
      ) : null}
    </dialog>
  );
}
