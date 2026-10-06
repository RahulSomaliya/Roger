/**
 * Electron rejects a failed ipcRenderer.invoke with main's error wrapped as
 * "Error invoking remote method '<channel>': <Name>: <message>"; only the message is for people.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

/** An error's message for the page. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(IPC_WRAPPER, '');
  if (typeof error === 'string') return error;
  return 'an unexpected error';
}
