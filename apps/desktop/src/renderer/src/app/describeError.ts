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
 * Main's wrapper around a failed API request in the calendar flows (CalendarAccount.ts):
 * "Could not reach the Roger API to <action>. Is it running? (<client message>)". The action is
 * plain words ("connect Google Calendar") and is kept; the parenthesis holds the route and the
 * errno, and is dropped. Keep in step with that file's wording: its test and this one fail together.
 */
const REACH_WRAPPER = /^Could not reach the Roger API to ([^.(]+)\. Is it running\?(?: \(.*\))?$/s;

/**
 * A vendor's failure as the STT core and the notes model word it: "<Vendor>: rejected with HTTP
 * 401", "<Vendor>: socket closed". Only the HTTP/socket shapes count, so main's own
 * "Microphone: permission denied" is not mistaken for one.
 */
const VENDOR_FAILURE =
  /^[A-Za-z][\w.-]*(?: [\w.-]+)?: .*(?:\bHTTP \d{3}\b|\b(?:socket|websocket|closed|timed out|overloaded)\b|\bE[A-Z]{4,}\b)/i;

/**
 * What must never reach a sentence a person reads: a route, an address, an errno or a database
 * code, an HTTP status. A message with any of these (and no wrapper above that explains it) reads
 * as the generic line instead.
 */
const INTERNALS =
  /\/v1\/|\bHTTP \d{3}\b|\b(?:E[A-Z]{4,}|SQLITE_[A-Z_]+)\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|:\d{4,5}\b/;

const GENERIC = 'Something went wrong. Try again in a moment.';

/**
 * An error for the page: a failed API request in a few plain words by kind, a vendor's failure as
 * "A service Roger relies on had a problem", any other message (main writes those for people: "the
 * notes of meeting m-1 are still being written") as it is unless it carries a route, an address, an
 * errno or an HTTP code.
 */
export function describeError(error: unknown): string {
  const text = messageOf(error);
  if (text === null) return 'an unexpected error';
  const api = apiFailureInWords(text);
  if (api !== null) return api;
  const reach = REACH_WRAPPER.exec(text)?.[1];
  if (reach !== undefined) {
    return `Roger could not reach its server to ${reach}. Check the connection and try again.`;
  }
  if (VENDOR_FAILURE.test(text)) {
    return 'A service Roger relies on had a problem. Try again in a moment.';
  }
  return INTERNALS.test(text) ? GENERIC : text;
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
