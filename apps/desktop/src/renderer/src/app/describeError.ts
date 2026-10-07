/**
 * Electron rejects a failed ipcRenderer.invoke with main's error wrapped as
 * "Error invoking remote method '<channel>': <Name>: <message>"; only the message is for people.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

/**
 * The ONE mapping from a failed API request to words for the page. Every error line a person reads
 * goes through `describeError`, so none can show a request path, an address or vendor text.
 *
 * An IPC rejection carries only a message, and the messages of main's API client name the request
 * ("PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000", "GET /v1/x returned HTTP 502",
 * http.ts). The kind is read off that shape, so a client message worded differently falls through
 * unmapped: the tests of this file fail first when http.ts changes its wording. Returns null for a
 * message that is not the client's (the caller decides what a plain sentence of main's becomes).
 */
function apiFailureInWords(text: string): string | null {
  if (/^[A-Z]+ \/\S* failed(?::|$)/.test(text)) return 'Roger could not reach its server.';
  const status = /^[A-Z]+ \/\S* returned HTTP (\d{3})$/.exec(text)?.[1];
  if (status === '401' || status === '403')
    return "Roger's server did not accept this Mac's access.";
  if (status === '404') return "Roger's server does not have this meeting yet.";
  if (status?.startsWith('5') === true) return "Roger's server had a problem.";
  if (status !== undefined) return "Roger's server turned that down.";
  if (/^[A-Z]+ \/\S* returned non-JSON$/.test(text)) {
    return "Roger's server sent an answer Roger could not read.";
  }
  return null;
}

/**
 * An error for the page: a failed API request in a few plain words by kind, any other message
 * (main writes those for people: "the notes of meeting m-1 are still being written") as it is.
 */
export function describeError(error: unknown): string {
  const text = messageOf(error);
  return text === null ? 'an unexpected error' : (apiFailureInWords(text) ?? text);
}

/** The message with Electron's IPC wrapper off; null for what is neither an Error nor a string. */
function messageOf(error: unknown): string | null {
  if (error instanceof Error) return error.message.replace(IPC_WRAPPER, '');
  if (typeof error === 'string') return error.replace(IPC_WRAPPER, '');
  return null;
}

/**
 * Why a READ failed: `describeError`'s words for an API failure, and the generic line for any
 * other text, which could be anything (a vendor's error). A read has no message of main's to keep.
 */
export function describeReadFailure(error: unknown): string {
  const text = error instanceof Error ? messageOf(error) : null;
  if (text === null) return 'Something went wrong.';
  // The API's own "<thing> not found" envelope: for a read that means the record is not there yet.
  if (/\bnot found$/i.test(text)) return "Roger's server does not have this meeting yet.";
  return apiFailureInWords(text) ?? 'Something went wrong.';
}
