// The preview's fake `window.roger`, typed once for every QA script. tsconfig.e2e.json compiles all
// e2e/ files as one program, so two scripts that each declare `Window.roger` with different types
// fail the type check together (TS2687/TS2717) even though each passed alone in its own worktree.
// Declare page globals a script needs for itself under a name only it uses (`__m4t17`, `__abWatch`).
import type { RogerApi } from '../src/shared/ipc';
import type { PromptActionRequest } from '../src/shared/ipc/prompt';

declare global {
  interface Window {
    /** The preview's fake (preview/main.tsx), as src/renderer/src/roger.d.ts types it. */
    roger: RogerApi;
    /** The prompt panel preview's click log (preview/prompt.tsx declares the same type). */
    __rogerPromptPreview?: { acts: PromptActionRequest[] };
  }
}
