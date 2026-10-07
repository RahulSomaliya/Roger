/**
 * An incremental parser for the API's event streams (`text/event-stream`, "Parsing an event
 * stream" in the WHATWG HTML spec): the notes and chat streams main reads (streamRequest.ts).
 * The network cuts the bytes anywhere: inside a UTF-8 character, between a CR and its LF, inside
 * a field. So the parser decodes in streaming mode, keeps the unfinished line, and remembers a CR
 * that ended a piece, because an LF opening the next piece belongs to it and is not a blank line
 * (which would dispatch the event early).
 *
 * Comments are skipped: the API's `: ping` every 15 s keeps the connection alive and only resets
 * the idle timer in streamRequest.ts. Of the fields, only `event` and `data` are read: a stream is
 * resumed by re-sending its run id (M4 "Re-sent ids"), never by `Last-Event-ID`, so `id` and
 * `retry` mean nothing here. An event the stream never closes with a blank line is dropped, as the
 * spec says.
 */

export interface SseEvent {
  /** The `event:` field; `message` when the event has none. */
  event: string;
  /** The `data:` lines, joined with LF. */
  data: string;
}

/** CRLF before CR, so a pair that arrived whole is one line ending. */
const LINE_END = /\r\n|\r|\n/g;

export class SseParser {
  /** Decodes UTF-8 across pieces, and drops a byte order mark at the start, as the spec asks. */
  private readonly decoder = new TextDecoder();
  /** The text after the last line ending: a line still arriving. */
  private pending = '';
  /** The last piece ended in a CR: an LF that opens the next piece is its pair, not a line. */
  private afterCr = false;
  private eventType = '';
  private dataLines: string[] = [];

  /** Takes the next piece of the stream and returns the events it completed, in order. */
  push(bytes: Uint8Array): SseEvent[] {
    let text = this.decoder.decode(bytes, { stream: true });
    // A piece that ends inside a character decodes to nothing yet; keep `afterCr` for the text.
    if (text === '') return [];
    if (this.afterCr) {
      this.afterCr = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    const buffer = this.pending + text;
    const events: SseEvent[] = [];
    let lineStart = 0;
    for (const end of buffer.matchAll(LINE_END)) {
      const event = this.line(buffer.slice(lineStart, end.index));
      if (event !== null) events.push(event);
      lineStart = end.index + end[0].length;
    }
    this.afterCr = lineStart === buffer.length && buffer.endsWith('\r');
    this.pending = buffer.slice(lineStart);
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') this.eventType = value;
    else if (field === 'data') this.dataLines.push(value);
    return null;
  }

  /** A blank line ends the event. One with no `data` line is none (the spec), type and all. */
  private dispatch(): SseEvent | null {
    const type = this.eventType;
    const lines = this.dataLines;
    this.eventType = '';
    this.dataLines = [];
    if (lines.length === 0) return null;
    return { event: type === '' ? 'message' : type, data: lines.join('\n') };
  }
}
