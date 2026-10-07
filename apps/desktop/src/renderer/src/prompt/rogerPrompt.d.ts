import type { PromptApi } from '../../../shared/ipc/prompt';

declare global {
  interface Window {
    /** Exposed by src/preload/prompt.ts, on the prompt panel's page only. */
    rogerPrompt: PromptApi;
  }
}
