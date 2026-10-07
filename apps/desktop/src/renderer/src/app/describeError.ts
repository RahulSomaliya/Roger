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

/**
 * Why a READ failed, for the page to show: a few plain words by kind, never the error's own text.
 * An IPC rejection carries only a message, and the messages of main's API client name the request
 * path ("GET /v1/meetings/<id>/chat failed: ...", http.ts) or carry the API's own wording, which
 * can quote a vendor. So the kind is read off the message's shape, and anything unplaced gets the
 * generic line rather than the raw text. If http.ts words its errors differently, the tests of
 * this function fail first.
 */
export function describeReadFailure(error: unknown): string {
  const text = error instanceof Error ? describeError(error) : '';
  if (/^[A-Z]+ \/\S* failed(?::|$)/.test(text)) return 'Roger could not reach its server.';
  const status = /^[A-Z]+ \/\S* returned HTTP (\d{3})$/.exec(text)?.[1];
  if (status === '401' || status === '403')
    return "Roger's server did not accept this Mac's access.";
  if (status === '404' || /\bnot found$/i.test(text)) {
    return "Roger's server does not have this meeting yet.";
  }
  if (status?.startsWith('5') === true) return "Roger's server had a problem.";
  if (/^[A-Z]+ \/\S* returned non-JSON$/.test(text)) {
    return "Roger's server sent an answer Roger could not read.";
  }
  return 'Something went wrong.';
}
