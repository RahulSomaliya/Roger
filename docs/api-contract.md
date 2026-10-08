# Roger API contract

The desktop app and every MCP client talk to the API through this contract. It is updated in the
same change as the code on both sides. Base URL in development: `http://127.0.0.1:8000` (the port
`make dev-api` serves, and the desktop's default `ROGER_API_URL`).

## Conventions

- JSON everywhere. Instants are ISO 8601 in UTC with a `Z` suffix (`2026-10-05T10:00:00Z`).
  Durations and offsets are integer milliseconds. Ids are UUIDv4 strings.
- **Auth:** every `/v1/*` route and the `/mcp` endpoint require `Authorization: Bearer <token>`.
  In M1 the token is the shared secret `ROGER_API_TOKEN`; it resolves to one `Principal`
  (workspace, user). M6 replaces the secret with Google sign-in, M7 adds OAuth for MCP, M14 adds
  project keys. Callers never change.
- **Idempotency:** the client generates meeting and segment ids. Re-sending a create, append or end
  is safe: it never stores a second copy. The response is not identical: a re-sent create answers
  `200` instead of `201`, and a re-sent append counts the stored ids under `duplicates` instead of
  `accepted`. Re-sends are matched by id alone. A meeting re-sent with a different `title` returns
  `200` with the stored row, unchanged; a segment re-sent with different `text` counts as a
  duplicate and the stored text stays.
- **Errors** use one envelope:

  ```json
  { "error": { "code": "not_found", "message": "Meeting 7f3c... not found" } }
  ```

  | HTTP | code | When |
  | --- | --- | --- |
  | 401 | `unauthorized` | Missing or wrong bearer token |
  | 404 | `not_found` | Unknown id, or an id in another workspace |
  | 409 | `conflict` | The request clashes with what is stored. Each route's section lists its own `409`s. |
  | 405 | `method_not_allowed` | Known path, wrong method |
  | 422 | `validation_error` | Body or query failed validation; `message` lists the fields |
  | 422 | `empty_meeting` | Notes were asked for a meeting with no transcript lines and no user notes |
  | 422 | `meeting_too_long` | The meeting is over the chat model's input budget (about 10 hours of talk) |
  | 424 | `calendar_reconnect_required` | Only connecting the calendar again helps: Google refused the stored refresh token or a used or expired sign-in code (`invalid_grant`), the user did not grant calendar access, or the API can no longer use the stored grant (`CALENDAR_TOKEN_KEY` changed). Also when `CALENDAR_PROVIDER` changed since the connect, where setting it back helps too. The message says what to do. |
  | 500 | `internal_error` | Unexpected; details only in server logs |
  | 502 | `stt_provider_error` | The speech-to-text vendor refused or failed a token request |
  | 502 | `llm_provider_error` | The notes model's vendor refused or failed before the stream started |
  | 502 | `calendar_provider_error` | Google is unreachable or answered with an error we cannot use |
  | 503 | `calendar_not_configured` | The API has no calendar provider (no Google client set up on the server). Only the server's owner can fix it; the desktop says so in plain words. Sent by the calendar authorization, connection (POST) and events routes. |

  A 401 carries `WWW-Authenticate: Bearer`. Every response carries `X-Request-ID` (echoed when the
  caller sends a safe one, generated otherwise); the same id is on every log line for the request.
  A meeting id that exists in another workspace is a `404`, never a `409`. On `/mcp` only the `401`
  uses this envelope. The MCP SDK answers the rest itself: `405` as a JSON-RPC error object, `421`
  (a `Host` outside `MCP_ALLOWED_HOSTS`) as plain text.

## Entities

```ts
type MeetingStatus = "recording" | "ended";
// How the recording was started. `notification` is a click on the calendar prompt,
// `call_detected` one on the call-detected card; `manual` is the default.
type StartSource = "manual" | "notification" | "home" | "tray" | "call_detected";

interface Meeting {
  id: string;
  workspace_id: string;
  title: string;
  status: MeetingStatus;
  started_at: string;        // instant
  ended_at: string | null;   // instant
  segment_count: number;     // transcript segments stored so far
  start_source: StartSource; // "manual" for every meeting stored before it existed
  calendar_event: MeetingCalendarEvent | null; // the event it was started for
  created_at: string;
  updated_at: string;
}

// `CalendarAttendee` and its `ResponseStatus` are defined once, under Calendar (Endpoints), and
// shared with `CalendarEvent`. Never copy them here: two copies drift apart.
interface MeetingCalendarEvent {
  provider: "google" | "fake";
  event_id: string;                // the instance id for a recurring event
  ical_uid: string | null;         // the same for every invitee
  recurring_event_id: string | null;
  scheduled_start: string;         // instant
  scheduled_end: string;           // instant
  attendees: CalendarAttendee[];   // at most 200, in invite order
}

type AudioSource = "mic" | "system";

interface TranscriptWord {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number | null;
}

interface TranscriptSegment {
  id: string;
  meeting_id: string;
  source: AudioSource;       // which audio stream produced it
  speaker: string;           // "me" for mic, "them" for system in M1; names arrive in M9
  start_ms: number;          // offset from meeting.started_at
  end_ms: number;            // >= start_ms
  text: string;              // non-empty, trimmed
  confidence: number | null; // 0..1
  words: TranscriptWord[] | null;
  created_at: string;
}
```

## Endpoints

Every route has its own heading, ``### `METHOD /path` `` (``#### `METHOD /path` `` under a
feature's heading). `apps/api/tests/test_http_plumbing.py` reads these headings and fails on a
served route without one, or on one without a route.

### `GET /health`

No auth. `200 {"status": "ok", "version": "0.1.0", "database": "ok"}`. Returns `503` with
`"database": "error"` when Postgres is unreachable.

### `POST /v1/meetings`

Create a meeting. Idempotent on `id`.

Request:

```json
{
  "id": "uuid (optional)",
  "title": "string (optional, default \"Untitled meeting\")",
  "started_at": "instant (optional, default now)",
  "start_source": "StartSource (optional, default \"manual\")",
  "calendar_event": "MeetingCalendarEvent (optional, default null)"
}
```

Postgres cannot store U+0000 or an unpaired UTF-16 surrogate (half of an emoji, which
`JSON.stringify` sends as an escape). Neither is text anyone reads, and a refused create would keep
the meeting off the server, so `title` and the text fields of `calendar_event` drop each U+0000 and
replace each unpaired surrogate with U+FFFD before they are checked. `title` is then trimmed and at
most 500 characters; blank, it is `"Untitled meeting"`.

`calendar_event` links the meeting to the calendar event it was started for. Every field of it and
of its attendees is required except `ical_uid`, `recurring_event_id` and `display_name`, which may
be left out; any of those three sent blank is stored as `null`. Every text field is cleaned as
above, trimmed, and is then 1 to 2048 characters. At most 200
attendees, kept in the order sent. `scheduled_start` and `scheduled_end` are instants with an
offset; their order is not checked, as they copy what the calendar said. A bad value is a `422` naming the field (`body.calendar_event.attendees[1].email`).

Response: `201 Meeting` when created, `200 Meeting` when `id` already exists in this workspace. The
`200` is the stored meeting as it is: a different `title`, `started_at`, `start_source` or
`calendar_event` in the re-send is ignored, and a link sent only in a re-send is not stored.

### `GET /v1/meetings?limit=50&before=<instant>&before_id=<uuid>`

Newest first by `started_at`, then `id`. `limit` 1..200, default 50.
Response: `200 { "items": Meeting[] }`.

Paging: for the next page, pass the last item's `started_at` as `before` and its `id` as
`before_id`. An empty `items` means there are no more. `before` alone is a time filter, not a
cursor: it lists meetings that started strictly before that instant, so meetings that share the
last item's `started_at` would be skipped. `before_id` without `before` is a `422`.

### `GET /v1/meetings/{meeting_id}`

Response: `200 Meeting`.

### `POST /v1/meetings/{meeting_id}/segments`

Append transcript segments. Idempotent on segment `id`; duplicates are counted and ignored. A
re-sent id is a duplicate even when its text or timings changed: the stored segment is kept. An id
already stored under a different meeting is a `409`, and nothing in that batch is stored.

Request:

```json
{
  "segments": [
    {
      "id": "uuid", "source": "mic", "speaker": "me",
      "start_ms": 1200, "end_ms": 2950, "text": "Hello everyone.",
      "confidence": 0.98,
      "words": [{ "text": "Hello", "start_ms": 1200, "end_ms": 1600, "confidence": 0.99 }]
    }
  ]
}
```

Constraints: 1..500 segments per request; `text`, `speaker` and each word's `text` non-empty after
trimming; `end_ms >= start_ms`. Before the check, each of those drops every U+0000 and replaces
every unpaired surrogate with U+FFFD, as `POST /v1/meetings` does: one such character fails
neither its line nor the batch.
Response: `200 { "accepted": 1, "duplicates": 0 }`.

### `POST /v1/meetings/{meeting_id}/end`

Request: `{ "ended_at": "instant (optional, default now)" }`. Idempotent: ending an ended meeting
returns it unchanged. Response: `200 Meeting`.

### `GET /v1/meetings/{meeting_id}/transcript`

Response: `200 { "meeting": Meeting, "segments": TranscriptSegment[] }` ordered by `start_ms`, then
`source` (`mic` before `system`), then `id`.

### `POST /v1/stt/token`

The API holds the speech-to-text vendor key and hands the desktop a short-lived credential plus the
stream settings. The desktop picks its `SpeechToText` adapter from `provider`. Changing vendor or
model is one config line on the API: `STT_PROVIDER` names a preset, a vendor and one of its models
(`STT_PRESETS` in `apps/api/src/roger_api/stt_vendors.py`). Two presets can share a vendor, so
`provider` is always the vendor id, `"assemblyai" | "deepgram" | "soniox" | "xai" | "fake"`, never the
preset. Both sides keep a vendor registry with the same provider ids (`STT_VENDORS` in
`stt_vendors.py`, `apps/desktop/src/main/stt/registry.ts`); the desktop never sees presets. The
API may list a vendor before the desktop has its adapter (`soniox` did until M3-T15): Start then
fails on the Mac with "Unsupported speech-to-text provider".

| `STT_PROVIDER` (preset) | `provider` | `stream.model` | `stream.price_per_hour_usd_without_keyterms`, and `price_per_hour_usd` with no jargon list | `stream.price_per_hour_usd` with a jargon list |
| --- | --- | --- | --- | --- |
| `assemblyai` (Roger's vendor since 2026-10-06) | `assemblyai` | `universal-streaming-english` | `0.15` | `0.19` |
| `assemblyai-pro` | `assemblyai` | `universal-3-6-pro` | `0.45` | `0.45` (keyterms included) |
| `deepgram` (the second adapter) | `deepgram` | `nova-3` | `0.462` | `0.54` |
| `soniox` (the optional third vendor) | `soniox` | `stt-rt-v5` | `0.12` | `0.12` (Soniox bills the list as a few input tokens per stream opened, under $0.001, not per hour) |
| `xai` (to compare Grok with AssemblyAI) | `xai` | `grok-voice-transcribe-2.0` | `0.2` | `0.2` (xAI lists no keyterm charge) |
| `fake` | `fake` | `fake` | `0` | `0` |

| `provider` | `access_token` | `expires_in` |
| --- | --- | --- |
| `assemblyai` | AssemblyAI temporary streaming token; the desktop sends it as the `token` query parameter | Seconds left to open the stream (1..600). One token opens both streams; a session then runs up to 3 hours, a cap the API asks for explicitly on every token (`max_session_duration_seconds=10800`), after which AssemblyAI closes it with 3008. |
| `deepgram` | Deepgram grant (JWT); the desktop sends it as `Authorization: Bearer` | Seconds the grant is valid |
| `soniox` | Soniox temporary API key; the desktop sends it as `Authorization: Bearer` | Seconds left to open a stream (1..3600). One key opens both streams (never `single_use`); a stream then runs up to 5 hours, a cap the API asks for explicitly on every key (`max_session_duration_seconds=18000`), after which Soniox ends it with a `temp_api_key_session_expired` error. |
| `xai` | xAI client secret (`xai-client-secret.` prefix), minted by `POST /v1/realtime/client_secrets`; the desktop sends it as `Authorization: Bearer` on the websocket handshake. `/v1/stt` accepts it (live check 2026-10-07), though xAI documents it for the voice-agent socket only. It opens ONE connection, ever: a second websocket on it, at the same time or after the first closed, is refused with HTTP 401 (probe 2026-10-08), so the desktop asks for one token per stream it opens (two at every Start). | Seconds left to open its one stream (1..3600). xAI documents no session cap, so the API asks for none. |
| `fake` | `""` | `0` |

How many streams one `access_token` opens is the vendor's, and the desktop's adapter declares it
(`credentialUse` in `apps/desktop/src/main/stt/core/SttProtocol.ts`): `reusable` for `assemblyai`,
`deepgram`, `soniox` and `fake` (Start opens both streams on one token, and the silence gate keeps
one for both), `single-connection` for `xai` (every open, Start's two, each reopen and each gap
re-run session, asks for its own). The response carries no field for it: a vendor's rule changes
with its adapter, not with the API.

Response:

```json
{
  "provider": "assemblyai",
  "access_token": "<AssemblyAI temporary token>",
  "expires_in": 30,
  "stream": {
    "model": "universal-streaming-english",
    "language": "en",
    "sample_rate": 16000,
    "encoding": "linear16",
    "keyterms": ["Linkt", "Roger"],
    "price_per_hour_usd": 0.19,
    "price_per_hour_usd_without_keyterms": 0.15
  }
}
```

`stream.model` is the preset's model (the retired `STT_MODEL` stops the API at startup while it
has a value). `stream.encoding` is Roger's own name for 16-bit signed little-endian mono PCM
(`linear16`) whatever the vendor; each desktop adapter maps it to its vendor's name (AssemblyAI
calls it `pcm_s16le`). The desktop refuses to start when `sample_rate` and `encoding` are not the
`16000` / `linear16` it sends.

`stream.keyterms` is the caller's workspace jargon list (see Vocabulary), as `GET /v1/vocabulary`
lists it: spelled as stored, sorted ignoring case, at most 100 terms, `[]` when the workspace has
none. The API reads it on every token request, so a term saved mid-week reaches the next Start,
and a reopen's fresh token, with no restart; the desktop never caches it. The desktop sends it to
the vendor (Deepgram `keyterm`, AssemblyAI `keyterms_prompt`, Soniox `context.terms`, xAI `keyterm`). An API
older than the jargon list sends no `keyterms`; the desktop reads that as `[]`.

`stream.price_per_hour_usd` is what one open stream of `stream.model` costs per hour in USD. The
base is the vendor's list price for the preset's model from the API's registry, or
`STT_PRICE_PER_HOUR_USD` when set. When `stream.keyterms` is not empty, the vendor's keyterm
surcharge for that model is added to the base, the override included (the table above; `0` where
the model's price includes keyterms), so the override is a rate without keyterms: an all-in rate
counts the surcharge twice. It is `null` when the API knows no base price for that model
(it then logs `stt_price_unknown` at startup), and also when the list is not empty and the API
knows no keyterm surcharge for it. It is per stream and per hour the stream is open: a meeting
opens two streams, and AssemblyAI bills the open time, silent or not. The desktop uses it to
estimate what a stream cost and never hardcodes vendor prices.

`stream.price_per_hour_usd_without_keyterms` is what one stream of `stream.model` costs per hour
when it is opened with no keyterms: the base alone, never the surcharge (the first price column
above), and the same as `stream.price_per_hour_usd` when `stream.keyterms` is empty. The vendor
bills a stream by what it was opened with, so a stream the desktop opens with `keyterms: []` from
a token that carried a list is metered at this price: the one reopen after the vendor rejected the
list, and every stream of a bench `--no-keyterms` run. Metered at `stream.price_per_hour_usd`, the
reopen would over-count and the bench would price a run without the list the same as one with it.
It is `null` only when the API knows no base price. An API older than the field omits it; the
desktop then meters such a stream at `stream.price_per_hour_usd`, which errs high.

With `STT_PROVIDER=fake` the response is `{"provider": "fake", "access_token": "", "expires_in": 0, "stream": {...}}`
and the desktop uses its built-in fake adapter (useful for development without a vendor key). The
fake's `stream` carries the workspace's `keyterms` too.

A vendor that refuses, fails, times out or answers with something unreadable is a
`502 stt_provider_error`. The vendor key is never in a response or a log line.

### Vocabulary

The workspace's jargon list: names and terms the speech-to-text vendor should spell right
("Linkt", "Roger"). One list per workspace, kept as the user spelled each term.

#### `GET /v1/vocabulary`

Response: `200 {"terms": ["Linkt", "Roger"]}`, sorted ignoring case; `{"terms": []}` when the
workspace has none.

#### `PUT /v1/vocabulary`

Replaces the whole list. Idempotent: re-sending the same list changes nothing. `{"terms": []}`
clears it.

Request:

```json
{ "terms": ["Roger", " Linkt ", "LINKT"] }
```

Each term is trimmed. Terms that then differ only in case are one term: the first spelling sent is
kept and the rest are dropped, never refused. A term already stored takes the spelling sent.
Response: `200 {"terms": ["Linkt", "Roger"]}`, the list as stored, in `GET`'s order.

Limits. Breaking one is a `422 validation_error` whose message names the field (`body.terms`,
or `body.terms[3]` for one term), and nothing is stored:

- at most 100 terms, counted as sent, before duplicates are dropped;
- each term 1 to 50 characters after trimming;
- at most 800 characters in all, the trimmed terms' lengths summed;
- no control characters inside a term (Unicode category Cc: U+0000 to U+001F, U+007F to U+009F).

Characters are Unicode code points, not UTF-16 units: in JavaScript count `[...term].length`, not
`term.length`. The limits are the strictest vendor's (AssemblyAI takes at most 100 keyterms of 50
characters; Deepgram refuses a request over 500 tokens, which 800 characters approximates). The
desktop editor applies the same limits before it saves (M3-T8).

There is no `409`: a `PUT` replaces whatever is stored. Two `PUT`s for one workspace take turns,
so the stored list is always one of the lists sent, never a mix.

### STT usage

What each meeting's speech-to-text sessions used, as the desktop metered them, and what that comes
to per meeting hour. The desktop keeps the numbers in its local `stt_usage` table and uploads a
meeting's row each time it changes (M3-T19b). The API stores one row per workspace and meeting and
never recomputes a cost: the estimate is the desktop's, the connected time of each session at the
price its token named (see `POST /v1/stt/token`).

```ts
interface SttSourceUsage {
  sessions_opened: number;           // sockets that completed the handshake; each may be billed
  connected_ms: number;              // open time summed over sessions: what the vendor bills
  audio_sent_ms: number;             // audio sent, in ms of PCM; a fraction is rounded (PUT below)
  dropped_chunks: number;            // chunks dropped because their stream was not open
  gated_ms: number;                  // stream time the silence gate kept closed (M3-T20)
  estimated_cost_usd: number | null; // null when a session opened with no known price, never 0
}

interface SttUsage {
  meeting_id: string;
  provider: string;                  // the token's `provider`, such as "assemblyai"
  sessions_opened: number;           // these six: both sources summed
  connected_ms: number;
  audio_sent_ms: number;
  dropped_chunks: number;
  gated_ms: number;
  estimated_cost_usd: number | null;
  by_source: { mic: SttSourceUsage; system: SttSourceUsage };
  stop_reason: string | null;        // why the recording stopped; null while it still runs
  created_at: string;                // the first upload
  updated_at: string;                // the last
}
```

#### `PUT /v1/stt-usage/meetings/{meeting_id}`

Stores the meeting's whole usage so far, replacing what was stored. Request: an `SttUsage` without
`meeting_id`, `created_at` and `updated_at`. Response: `200` with the `SttUsage` as stored, whether
the row was created or replaced.

- Idempotent: the same body again stores the same row, and only `updated_at` moves. A later body
  replaces the row whole and never adds to it: the desktop sends a meeting's totals, not increments.
- No meeting row is needed, and the API never looks for one: the desktop deletes a meeting that got
  no line, but its sessions were billed. A meeting id another workspace also uses is a row of its
  own: no workspace ever reads or overwrites another's.
- `provider` and `stop_reason` are free text, 1 to 64 characters after trimming, never a fixed
  list: the desktop's stop reasons change across releases (`page-reloaded` is retired,
  `start-failed` is not a stop at all, `call-ended` arrives later), and its vendors may too.
  `stop_reason` may also be `null` or left out. U+0000 is dropped from both.
- `gated_ms`, at the top and in each source, reads as `0` when left out. Every other field is
  required: `estimated_cost_usd` is `null` when the price is unknown, never left out.
- Counts (`sessions_opened`, `dropped_chunks`) are whole numbers. A time (every `*_ms` field) may
  carry a fraction, which is rounded to the nearest ms before the rules below check it and the
  row stores it: the desktop computes audio time from PCM bytes in floating point, so whole
  chunks can sum to `16100.000000000002`. The response carries the rounded times.

Breaking a rule is a `422 validation_error` whose message names the field (`body.stop_reason`,
`body.by_source.system.connected_ms`), and nothing is stored: a negative number, a count with a
fraction, a count over 2147483647 or a time over 9223372036854775807 ms, a time or cost that is
not a finite number, a cost over 1000000 USD (a day-long call at today's dearest list price costs
under 30), a source missing from `by_source`, a blank or over-long `provider` or `stop_reason`.
The desktop treats a `422` as a rejected row and sends it again only after the meeting's usage
changes (M3-T19b), so nothing a Mac of another release could hold is refused. There is no `409`: a
`PUT` replaces whatever is stored.

#### `GET /v1/stt-usage/summary?since=<instant>`

Totals over the caller's meetings held at or after `since`, or over every meeting without it. A
meeting is held at its `started_at`; one the API has no meeting row for counts from its usage's
`created_at` (the desktop uploads usage while the meeting records, so the two are minutes apart).
`since` is an instant with an offset (`2026-10-01T00:00:00Z`); one without is a
`422 validation_error`. No `409`s.

Response:

```json
{
  "meetings": 3,
  "stream_hours": 3.1667,
  "meeting_hours": 1.5,
  "estimated_cost_usd": 0.41,
  "cost_per_meeting_hour": 0.38,
  "gated_hours": 0.5,
  "estimated_saved_usd": 0.095,
  "unpriced_meetings": 1,
  "unpriced_meeting_ids": ["7f3c..."]
}
```

| Field | What it is |
| --- | --- |
| `meetings` | Meetings with usage in the window |
| `stream_hours` | `connected_ms` summed: the open time the vendor bills. A meeting opens two streams, so an hour's call is about 2 stream hours. |
| `meeting_hours` | From `started_at` to `ended_at`, for meetings that have a meeting row and have ended (an end before the start counts 0). A meeting without a row, or still recording, adds none. |
| `estimated_cost_usd` | The known costs summed. `null` when every meeting in the window has an unknown price; `0` when the window has no meetings. |
| `cost_per_meeting_hour` | The cost of the meetings with both a known price and meeting hours, over those meetings' hours. `null` when there are none. |
| `gated_hours` | `gated_ms` summed: stream time the silence gate kept closed |
| `estimated_saved_usd` | Each meeting's `gated_ms` at that meeting's own price per stream hour (its `estimated_cost_usd` over its `connected_ms`), summed over meetings with a known price. `null` exactly when `estimated_cost_usd` is. |
| `unpriced_meetings` | Meetings whose `estimated_cost_usd` is `null` |
| `unpriced_meeting_ids` | Their ids, newest first, at most 100 |

A meeting with an unknown price is counted and named, never summed as `0`: its time counts in
`stream_hours`, `meeting_hours` and `gated_hours`, its cost nowhere, and `cost_per_meeting_hour`
leaves it out of both sides of the division (counted as free, it would make an hour look cheaper).
Hours and USD are rounded to 4 decimal places, at any size: a meeting gated nearly throughout can
show a saving far above its cost (1 ms connected and hours gated), and the summary still answers.

### Note templates

A template gives the AI notes their sections for one kind of call. Templates are data: one JSON
file per template in `apps/api/src/roger_api/note_templates/`, named after its id. The API checks
every file when it starts and does not start while one is broken. A new template is a new file,
with no code change. Every workspace gets the same templates.

#### `GET /v1/note-templates`

Response: `200 { "items": NoteTemplate[] }`, ordered by `name`. No `409`s.

```ts
interface NoteTemplateSection {
  heading: string;   // written as the notes heading, exactly as given
  guidance: string;  // what goes under the heading; only the model reads it
}

interface NoteTemplate {
  id: string;        // stable: stored on notes and runs as `template_id`
  name: string;      // shown in the template picker
  description: string;
  sections: NoteTemplateSection[];  // in the order the notes use them; at least one
}
```

The built-in ids are `general`, `standup`, `client_call` and `one_on_one`. Every text field is one
non-empty line. Headings are unique in a template, ignoring case. A heading carries no Markdown
marks and no `[L12]` refs, and it is never "From your notes": that heading closes the AI notes
(M4 D7).

### Notes

A meeting has two notes, each one whole TipTap JSON doc: the user's own notes (`user`, "My
notes") and the AI notes (`ai`). The desktop keeps a copy of each on the Mac and saves it here.
Every stored save raises the note's version, so two places that edited the same version get a
`409` instead of one silently overwriting the other.

```ts
type NoteKind = "user" | "ai";

interface Note {
  kind: NoteKind;
  doc: { type: "doc"; content?: object[] };  // TipTap JSON, as the editor's getJSON() writes it
  version: number;                  // 1 when created; every stored save adds 1
  template_id: string | null;       // the template of the notes run that wrote the AI notes
  last_run_id: string | null;       // that run
  generated_version: number | null; // the version that run wrote: a higher `version` was edited since
  updated_at: string;               // instant
}
```

Notes runs write `template_id`, `last_run_id` and `generated_version` (Notes runs and streaming);
a `PUT` never changes them, and on the user's notes they stay `null`.

#### `GET /v1/meetings/{meeting_id}/notes`

Response: `200 { "user": Note | null, "ai": Note | null }`, `null` where that doc was never saved.
No `409`s.

#### `PUT /v1/meetings/{meeting_id}/notes/{kind}`

Saves the whole doc of one kind. `kind` is `user` or `ai`; anything else is a `422`.

Request:

```json
{ "doc": { "type": "doc", "content": [] }, "base_version": 3, "revision_id": "uuid" }
```

- `base_version`: the stored version the doc was edited from; `0` creates the note.
- `revision_id`: the client's id for this save, new for every save.

Response: `200 Note`, the note as stored, one version above `base_version`.

Re-sends: a `revision_id` equal to the stored note's is the save that made it, sent again. It
answers `200` with the stored note and writes nothing, whatever else it carries (matched by id
alone, like segment ids). Only the latest save matches: an older one sent again is a stale base.

`409 conflict`, and nothing is stored, when:

- `base_version` is not the stored version (`0` when nothing is stored): the doc was saved from
  somewhere else since. The desktop loads the stored note and keeps its own doc as a conflict copy.
- `kind` is `ai` while a notes run of this meeting is running: the run is about to replace the AI
  notes. Save again once the run has finished. The user's notes can be saved during a run.

A notes run's claim and every save take the meeting's lock first, so a save lands wholly before a
run starts (and the run sees its version) or wholly after (and gets the `409`).

Limits on `doc`. Breaking one is a `422 validation_error` whose message names `body.doc` and the
rule, never the doc's text, and nothing is stored:

- a JSON object whose `type` is `"doc"`;
- at most 512 KiB (524,288 bytes) as compact JSON in UTF-8: no spaces after `,` and `:`,
  characters as they are, not as `\u` escapes, and numbers as `JSON.stringify` writes them
  (`1e-7`, not `1e-07`);
- at most 32 levels deep. The doc is level 1, and every object or array is one level below its
  parent, except an array under a `content` key, which stays on the level of the object holding
  it. So each node is one level below the node holding it, and a bullet list tabbed 13 deep with
  a link in its deepest item still fits;
- no `__proto__`, `constructor` or `prototype` key anywhere: the editor would turn them into DOM
  attributes that reach prototypes;
- no `NaN` or `Infinity`, which are not JSON.

The desktop refuses a save over these limits before sending it (`noteDocProblem` in
`apps/desktop/src/shared/notes.ts`), and the API never counts more strictly: a doc the desktop
saved but the API refused would stay unsynced on the Mac and be sent again forever. A body nested
past what the JSON parser reads (thousands of levels) is a `400 bad_request` before these checks.

Postgres cannot store U+0000 or an unpaired UTF-16 surrogate (half of an emoji) in a doc. Neither
is text anyone reads, so the API drops each U+0000 and replaces each unpaired surrogate with
U+FFFD, in keys and values alike, and answers with the doc as stored. The key rules apply to keys
as stored: `"__proto\u0000__"` is a `__proto__` key, and two keys of one object that would be
stored as one (`"type"` and `"type\u0000"`) are a `422` rather than a value lost. The editor never
writes such keys: its keys are its schema's names.

### Notes runs and streaming

A notes run writes the AI notes. The API reads the meeting's transcript and the user's notes,
asks the notes model, checks every line the model writes against the transcript lines and note
blocks it cites, streams each line as a server-sent event once it is checked, and saves the result
as the meeting's `ai` note (Notes). A run outlives its request: a client that drops the stream does
not stop it, and it saves without anyone listening. Notes runs and chat runs (Chat) are both
`LlmRun`s.

```ts
type RunKind = "notes" | "chat";
type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
// The `error` event's codes, also stored as `error_code`.
type RunErrorCode = "llm_provider_error" | "cut_off" | "cancelled" | "internal_error";
// `no_refs`: the line cited nothing. `unknown_refs`: every ref it cited points nowhere.
type DropReason = "no_refs" | "unknown_refs";

interface DroppedLine {
  text: string;
  reason: DropReason;
}

interface LlmRun {
  id: string;
  meeting_id: string;
  kind: RunKind;
  status: RunStatus;
  model: string;                     // the model the run asked
  prompt_version: string;            // changes with the prompt's rules or layout
  template_id: string | null;        // notes runs only
  line_count: number;                // transcript lines the model was shown
  user_notes_version: number | null; // the versions a notes run built on; 0: that note did not exist
  ai_base_version: number | null;
  error_code: RunErrorCode | null;   // null unless failed or cancelled
  error: string | null;              // in words for the user; never the vendor's body
  dropped: DroppedLine[] | null;     // removed lines, in the order written; null unless succeeded
  flagged_count: number;             // lines kept with support "weak" ("check this")
  from_notes_count: number;          // lines under "From your notes"
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: string | null;           // a decimal string ("0.00083"); null when unknown, never "0"
  started_at: string;                // instant
  heartbeat_at: string;              // instant; moves every 20 s while the run runs
  finished_at: string | null;        // instant
}
```

A `running` run whose `heartbeat_at` is 2 minutes old is dead (the API process driving it
stopped). It is stored `failed` with `internal_error` when the API starts, and before the next run
of its meeting is claimed.

#### `POST /v1/meetings/{meeting_id}/notes/generate`

Request:

```json
{ "run_id": "uuid", "template_id": "standup", "user_notes_version": 3, "ai_base_version": 1 }
```

- `run_id`: made by the client before its first attempt and re-sent by every retry of that
  attempt (Re-sends, below). A retry after a failed run takes a new id: the old one replays the
  failure.
- `template_id`: an id from `GET /v1/note-templates`; any other is a `422 validation_error`.
- `user_notes_version`, `ai_base_version`: the stored versions of the user's notes and of the AI
  notes, `0` for a note that does not exist. The desktop saves its notes first, so the run reads
  what the user last typed.

Response: `200 text/event-stream`. The headers are sent only once the run is claimed and the
model's vendor has accepted the request, then a `: ping` comment every 15 s while nothing else is
sent. Each event's `data` is one JSON object:

| Event | Data | When |
| --- | --- | --- |
| `run` | `{run_id, model, template_id, line_count}` | First |
| `section` | `{index, heading}` | Before the first kept line of a section. `index` names the section in `item`; a section that keeps no line is never sent. |
| `item` | `{section, text, citations: [{ref, segment_id, start_ms}], support}` | A kept line, with each transcript line it cites in transcript order. `support` is `"weak"` when a number in the line is in none of its cited lines and note blocks, or the line shares no word with them; else `"ok"`. |
| `from_notes` | `{text}` | A line only the user's notes back: it goes to the closing "From your notes" list, without chips |
| `dropped` | `{text, reason}` | A removed line (`DropReason`) |
| `done` | `{run_id, note}` | Last, once the AI notes are saved: `note` is the `ai` `Note` as stored |
| `error` | `{code, message}` | Last, when the run failed or was cancelled (`RunErrorCode`); the AI notes are unchanged |

Error codes: `llm_provider_error` (the vendor failed after the stream started), `cut_off` (the
answer stopped at the output limit), `cancelled` (`POST .../cancel`), `internal_error`. A stream
that ends with neither `done` nor `error` (a dropped connection, or a re-send this API process
cannot follow) means the run may still finish: poll `GET .../runs/{run_id}` until it ends or its
`heartbeat_at` is 2 minutes old, then read the notes.

Long calls: when the prompt (the rules, the template, the user's notes and every transcript line,
estimated as characters / 4) is over `NOTES_MAX_INPUT_TOKENS` (default 200,000 tokens, about 10
hours of talk), the run first drafts notes for overlapping windows of whole lines, then merges the
drafts in one last pass. Only that last pass sends `section`, `item`, `from_notes` and `dropped`
events, so after `run` the stream may carry nothing but `: ping` comments for minutes. Citations
still name lines of the whole transcript. The run's `prompt_version` ends in `+long-v1`, and its
tokens and cost add up every pass. The one exception: when every line fits one window, the prompt
is long because of the user's notes, and the run is one pass as below the budget, with the plain
`prompt_version` and its events sent as each line is checked.

Each window's prompt repeats the rules, the template and the user's notes, and holds as many lines
as keep it within the budget, at most 60,000 tokens of them. It is over the budget only when it
holds one line longer than that room, or when the rest of its prompt takes over three quarters of
the budget: its lines still get a quarter, so the run never becomes one paid call per line. The
last pass's prompt (the template, the notes, every draft and the lines the drafts cite) is not
measured against the budget.

The AI notes doc (`done`'s `note.doc`, and the run's `output_doc`): for each section that kept a
line, in the order the model wrote them, a level-2 heading and a bullet list. A template section's
heading is written as the template has it, whatever case the model used; a heading the template
does not have keeps its own section, under the model's wording; lines before any heading belong to
the template's first section. Each bullet is a list item holding one paragraph: the line's text,
then a `citation` chip for each run of neighbouring transcript lines it cites (`[L12, L13, L15]`
is two chips):

```json
{ "type": "citation",
  "attrs": { "segmentIds": ["uuid", "uuid"], "startMs": 305000, "label": "05:05", "support": "ok" } }
```

`startMs` is the first line's start; `label` is its time as the chip shows it (`mm:ss`, or
`h:mm:ss` past an hour). When some lines only the user's notes back, the doc ends with a level-2
"From your notes" heading, an italic paragraph "Not said on the call" and a plain bullet list, in
the order of the user's notes. A run that kept no line writes an empty doc (one empty paragraph).
`apps/api/tests/fixtures/ai_notes_doc.json` is the example both apps test against.

The save takes the meeting's lock, as every save of the AI notes does. The stored AI doc at that
moment becomes the run's `replaced_doc`; the new doc raises the note's `version`, and
`template_id`, `last_run_id` and `generated_version` (the new version) record the run. A run that
fails or is cancelled leaves the AI notes as they were.

Re-sends: a `run_id` already stored for this meeting is matched by id alone, before any other
check, and never starts a second run. While the run runs in this API process, the stream sends
every event so far, then each new one. Once it has ended, it sends the stored result: `run`, then
its `dropped` lines and `done` with the AI notes as stored now, or its `error`. A `running` run that
this process does not drive sends `run` only; poll it.

`409 conflict`, and nothing is stored or replayed, when:

- another notes run of the meeting is running;
- `user_notes_version` or `ai_base_version` is not the stored version: the notes were saved from
  somewhere else since. The desktop saves its notes again and retries once;
- `run_id` is stored under another meeting or workspace.

`422 empty_meeting` when the meeting has no transcript lines and its user notes hold no words.
`502 llm_provider_error` when the vendor refused before the stream started: the run is stored
`failed`, and re-sending its id replays that failure.

#### `GET /v1/meetings/{meeting_id}/runs?kind=notes&limit=10`

Response: `200 { "items": LlmRun[] }`, newest first. `kind` (`notes` or `chat`) filters; `limit` is
1 to 100, default 10. No `409`s.

#### `GET /v1/meetings/{meeting_id}/runs/{run_id}`

Response: `200`, the `LlmRun` with `output_doc` (the doc the run wrote) and `replaced_doc` (the AI
doc it replaced, which "Restore previous notes" puts back), both always present and `null` when
empty. A run of another meeting or workspace is a `404`. No `409`s.

#### `POST /v1/meetings/{meeting_id}/runs/{run_id}/cancel`

Stops a notes or chat run. No body. Response: `200 LlmRun` once the run has ended: `cancelled`,
or as it ended when it finished first (a run already saving its result ends as it would have).
Its stream ends with the `error` code `cancelled`. A run of another meeting or workspace is a
`404`. No `409`s.

### Chat

One thread per meeting: the person's questions and the answers to them. Each answer is written by
a chat run (`llm_runs.kind` `chat`) from the meeting's transcript, the user's notes and the AI
notes, and cites the transcript lines it rests on.

```ts
type ChatRole = "user" | "assistant";
type ChatMessageStatus = "complete" | "streaming" | "failed";

interface RefCitation {
  ref: string;         // "L12": the transcript line as the answer cites it
  segment_id: string;  // that line's segment
  start_ms: number;    // and its start, so a chip outlives a re-numbered transcript
}

interface ChatMessage {
  id: string;                       // a question's id is the desktop's `message_id`
  role: ChatRole;                   // "user": a question; "assistant": an answer
  text: string;                     // "" while an answer streams
  citations: RefCitation[] | null;  // an answer's, each ref once, in the order it first appears
                                    // in `text`; null for a question
  reply_to: string | null;          // the question an answer replies to; null for a question
  run_id: string | null;            // the run that wrote an answer (the latest, when written
                                    // again); null for a question
  status: ChatMessageStatus;        // a question is always "complete"
  created_at: string;               // instant
}
```

An answer's `text` cites lines as `[L12]` or `[L12, L15]`. In a stored answer every bracket holds
only refs that its `citations` list, written out (`[L12, L13, L14]`, never a range): the desktop
turns each into a chip. Refs to lines the meeting does not hold are taken out, and so are refs to
the user's note blocks (`[N2]`): they ground an answer but have no line to show.

#### `GET /v1/meetings/{meeting_id}/chat?limit=50`

Response: `200 { "items": ChatMessage[] }`, the latest `limit` messages (1 to 200, default 50),
oldest first. A question sorts before its answer. No `409`s.

#### `POST /v1/meetings/{meeting_id}/chat`

Asks a question about the meeting. Any meeting, recording or ended.

```json
{ "message_id": "uuid", "text": "When does the beta ship?" }
```

- `message_id`: the desktop's id for the question, new for every question.
- `text`: 1 to 4,000 characters (code points), counted after trimming; spaces alone are a `422`.
  As in notes docs, U+0000 is dropped and an unpaired surrogate becomes U+FFFD.

Response: `200 text/event-stream`, with a `: ping` comment after every 15 s of silence. Each event's
`data` is one JSON object:

| Event | Data | When |
| --- | --- | --- |
| `run` | `{ run_id, model }` | First, before any text. Both fields are always there. |
| `delta` | `{ text }` | The answer's next piece, as the model wrote it |
| `citation` | `RefCitation` | Once per line the answer cites, as soon as its bracket closes. A ref with no `citation` stays text. |
| `done` | `{ message: ChatMessage }` | Last, once the answer is stored. Its `text` replaces the streamed text. |
| `error` | `{ code, message }` | Last, when no answer was stored: `llm_provider_error`, `cut_off`, `cancelled` or `internal_error`. The answer is stored `failed`. |

The answer is written in the background: a dropped stream does not stop it, and it is stored when
it finishes. Read it with the thread, or by sending the same `message_id` again. Cancel it with
`POST /v1/meetings/{meeting_id}/runs/{run_id}/cancel` (Notes runs and streaming), using the `run`
event's `run_id`. A chat run takes no meeting lock: an AI-notes save while an answer streams is not
a `409`, and chat runs beside a notes run.

Re-sends: a `message_id` already stored as a question of this meeting never stores a second
message, and the `text` sent with it is ignored (matched by id alone, like segment ids).

- Its answer is complete: the stream is that answer's `done` alone, nothing is paid for twice.
- Its answer is being written: the stream attaches to it, the events so far, then live ones.
- Its answer failed, or the API process writing it stopped: the same answer (same `id`) is written
  again by a new run, with a new `run` event.

Before the stream, as the error envelope:

- `404 not_found`: an unknown meeting, or one in another workspace.
- `409 conflict`, nothing stored or replayed: `message_id` is stored under another meeting or
  workspace, or is an answer's id. Also when its answer is being written by another API process
  (a re-send that reached another one; Roger runs one until M6), or when a new question was sent
  twice at once.
- `422 validation_error`: the body.
- `422 meeting_too_long`, nothing stored: the meeting's transcript and notes are over the chat
  budget, `NOTES_MAX_INPUT_TOKENS` (default 200,000 tokens, estimated as characters / 4; about 10
  hours of talk). The thread a question carries never counts: it is capped on its own, at the 10
  latest complete exchanges and 24,000 characters.
- `502 llm_provider_error`: the model's vendor refused before the stream started. The question is
  stored and its answer `failed`, so sending the same `message_id` again asks again.

### Calendar

Google Calendar, read only: the primary calendar's events for the desktop's "Today" list and its
prompts (M5). The API signs in to Google for the desktop and keeps the refresh token, encrypted
(`calendar_connections`, Database below); the desktop never holds a Google token. Events are not
stored: every `GET /v1/calendar/events` asks Google live. One connection per workspace (per user
from M6). With no `CALENDAR_PROVIDER` set (the default) the API has no calendar: the authorization
and connection routes and the events route answer `503 calendar_not_configured`, while
`GET /v1/calendar/connection` and `DELETE /v1/calendar/connection` keep working on a stored
connection. `CALENDAR_PROVIDER=fake` is for developers only: it answers every route with no Google
client, its authorization URL is the desktop's own redirect with `code=fake`, its account is
`Demo calendar` (shown as `account_email`, which is then not an address), and its events are a
script anchored to the API's start time.

Sign-in: the desktop makes a PKCE verifier, its S256 challenge and a state, and listens on
`http://127.0.0.1:<random port>/oauth/callback`. It asks for the authorization URL, opens it in the
default browser, takes `code` and `state` from the redirect (checking the state itself), and sends
the code and the verifier to the connection route, which redeems them at Google.

```ts
type CalendarProvider = "google" | "fake";
type ResponseStatus = "accepted" | "tentative" | "declined" | "needs_action";

interface CalendarAttendee {
  email: string;
  display_name: string | null;
  response_status: ResponseStatus;
  is_self: boolean;
  is_organizer: boolean;          // rooms and other resources are never listed
}

interface CalendarEvent {
  provider: CalendarProvider;
  id: string;                      // instance id for a recurring event
  ical_uid: string | null;
  recurring_event_id: string | null;
  title: string;                   // "" when the invite has none
  status: "confirmed" | "tentative"; // cancelled events are never returned
  all_day: boolean;
  start: string | null;            // instant; null when all_day
  end: string | null;
  start_date: string | null;       // "2026-10-06" when all_day; never turned into midnight UTC
  end_date: string | null;         // exclusive
  self_response: ResponseStatus | "organizer" | "unknown";
  attendees: CalendarAttendee[];   // invite order, at most 100
  attendees_omitted: boolean;      // Google left some out (privacy or more than 100)
  video_link: string | null;       // Meet, Zoom or Teams join links only
  video_link_source: "conference" | "location" | "description" | null;
  html_link: string | null;
}

interface CalendarConnection {
  provider: CalendarProvider;
  account_email: string;
  status: "active" | "reconnect_required";
  connected_at: string;            // instant
  expires_hint: string | null;     // connected_at + 7 d, see below
  last_error: string | null;       // the 424's message while reconnect_required
}
```

`video_link` is the first join link someone typed into the location, then the description; only
without one does it come from the conference data Google adds by itself (`hangoutLink`, then video
entry points). So `conference` means nothing was typed: many Workspace calendars add a Meet link to
every new event, a solo block included.

`expires_hint` is `connected_at` + 7 days for a Google connection while the consent screen is
External in publishing status Testing (`GOOGLE_OAUTH_AUDIENCE=external_testing`, the default),
because Google expires such refresh tokens after 7 days; `null` for `external_production`,
`internal` and the fake provider.

`424 calendar_reconnect_required` is final until the user connects again. On the events route it
also sets the connection's `status` to `reconnect_required` with the message in `last_error`, and
later event requests answer the same `424` without asking Google. One events `424` stores nothing:
`CALENDAR_PROVIDER` changed since the connect. The grant is still good, so the connection stays
`active` and setting `CALENDAR_PROVIDER` back serves events again. No route here answers `409`.

#### `POST /v1/calendar/google/authorization`

Request:

```json
{
  "redirect_uri": "http://127.0.0.1:53682/oauth/callback",
  "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "state": "st-8f2c1d9e0a7b"
}
```

- `redirect_uri` is exactly `http://127.0.0.1:<port>/<path>`: any port from 1 to 65535 written
  without a leading zero, printable ASCII only, no fragment, no backslash, no user info. Never
  `localhost` or another loopback address.
- `code_challenge` is the S256 of the verifier: base64url without padding, 43 characters.
- `state`: 1 to 512 of `A-Z a-z 0-9 - . _ ~`.

Response: `200 {"authorization_url": "https://accounts.google.com/o/oauth2/v2/auth?..."}` with the
client id, the redirect, the scopes `openid email https://www.googleapis.com/auth/calendar.events.readonly`,
the challenge (`S256`), the state, `access_type=offline`, `prompt=consent` and
`include_granted_scopes=true`. Building it calls nobody.

#### `POST /v1/calendar/google/connection`

Request:

```json
{
  "code": "4/0AVG7fiQ...",
  "code_verifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  "redirect_uri": "http://127.0.0.1:53682/oauth/callback"
}
```

`code`: 1 to 2048 printable ASCII characters. `code_verifier`: 43 to 128 of `A-Z a-z 0-9 - . _ ~`
(RFC 7636). `redirect_uri`: the same value the authorization used, under the same rule. A `422`
names the field, never its value.

Response: `201 CalendarConnection`, `status: "active"`. It replaces the workspace's connection if it
had one; the replaced grant is not revoked at Google. `424` when Google refuses the code (used or
expired) or the user did not grant calendar access (the message says to connect again and tick
"View events on all your calendars"); `502` when Google fails. Nothing is stored on an error.

#### `GET /v1/calendar/connection`

Response: `200 {"connection": CalendarConnection}`, or `{"connection": null}` before any connect
and after a disconnect.

#### `DELETE /v1/calendar/connection`

`204`, no body. Deletes the connection, then revokes its grant at Google. A revoke that fails is
logged (`calendar_revoke_failed`) and the connection stays deleted. Repeatable: `204` with no
connection.

#### `GET /v1/calendar/events?from=<instant>&to=<instant>`

Both instants carry an offset (a time without one is a `422`), `from` is before `to`, and the
window is at most 7 days; otherwise `422 validation_error`. The desktop asks for now - 36 h to
now + 36 h.

Response: `200 {"items": CalendarEvent[], "fetched_at": "<instant>"}`: the primary calendar's
events that end after `from` and start before `to`, ordered by start (all-day events by date, as
Google orders them), recurring events expanded into instances. Focus time, out of office, working
location and birthdays are not listed. `fetched_at` is when the API had Google's answer.

`404` with no connection; `424` (above); `502` when Google fails, with the connection's status
unchanged. The Google access token is kept in the API's memory until a minute before it expires;
when Google refuses it, the API refreshes once and retries once, and a second refusal is a `502`.

## MCP

Endpoint: `POST /mcp` and `GET /mcp` (MCP Streamable HTTP, stateless). Same bearer token.
`DELETE /mcp` is a `405`: the server keeps no sessions, so there is none to end. Connect from Claude
Code:

```bash
claude mcp add --transport http roger http://127.0.0.1:8000/mcp --header "Authorization: Bearer $ROGER_API_TOKEN"
```

### Tool `get_transcript`

Description shown to the model (this wording is part of the contract; it is what makes Roger
transcript-first):

> Get the full, word-for-word transcript of a meeting as plain text with timestamps and speakers.
> Use this when you need what was actually said: quote the transcript's exact words rather than
> paraphrasing. If `meeting_id` is omitted, returns the most recent meeting.

Input: `{ "meeting_id": "uuid (optional)" }`.

Output (text content):

```
Meeting: Weekly sync with Acme
Meeting ID: 7f3c2d1e-...
Started: 2026-10-05T10:00:00Z   Ended: 2026-10-05T10:31:12Z   Segments: 412

[00:00:03] Me: Hi everyone, thanks for joining.
[00:00:07] Them: Hi Rahul, good to see you.
```

Timestamps are `hh:mm:ss` offsets from `started_at`. A missing id returns a tool error
"Meeting not found". An empty workspace returns "No meetings yet".

The tool returns every line of the meeting in one text block, so a very long call produces a very
large output that an MCP client may cut off at its output cap. Slicing by time range arrives in
M7. The text never includes word timings; read them from `GET /v1/meetings/{id}/transcript`.

### Tool `get_notes`

Description shown to the model (this wording is part of the contract; it sends the model to
`get_transcript` for quotes):

> Get the notes for a meeting: the AI-written notes and the user's own rough notes, as Markdown.
> Each AI line ends with the transcript times it came from, like [00:12:03]. Notes are a summary:
> to quote what someone said, call get_transcript and use its exact words. If meeting_id is
> omitted, returns the most recent meeting.

Input: `{ "meeting_id": "uuid (optional)" }`.

Output (text content): a header, then three Markdown sections, read from the meeting's stored
notes (`GET /v1/meetings/{meeting_id}/notes`) as they are now, edits included:

```
Meeting: Weekly sync with Acme
Meeting ID: 7f3c2d1e-...
Started: 2026-10-05T10:00:00Z   Ended: 2026-10-05T10:31:12Z

# AI notes

### Decisions

- Beta ships Friday [00:03:12]

### Action items

- Me: book the follow-up for the 14th [00:10:10] [00:10:55]

# From your notes

*Not said on the call*

- Ask Acme about the Q3 renewal

# My notes

#### Pricing

- 50k **first year**
```

- `Ended` reads `still recording` for a meeting that has not ended.
- `# AI notes`: the AI doc without its "From your notes" list. A section the user added after
  that list, under a heading at the list's level or higher, stays here. Each citation chip is the
  `hh:mm:ss` offset of the line it points at (its `startMs`), the same offsets `get_transcript`
  prints, so the line can be found there. A chip with no `startMs` shows its label instead.
  "(No AI notes yet.)" when there is no AI doc or it is empty; "(No lines from the transcript. See
  From your notes.)" when every AI line is in that list.
- `# From your notes`: the AI lines only the user's notes back (M4 D7), with their "Not said on
  the call" line: what the AI doc holds under its "From your notes" heading, up to the next
  heading at that level or higher. The notes run writes these lines with no chips, so they carry
  no times unless the user pasted one in. Only present when the AI doc has that list.
- `# My notes`: the user's doc; "(No notes yet.)" when there is none or it is empty.
- Lines the app flags "check this" (citation `support: "weak"`) carry no mark here: their times
  read like any other. A cue for MCP is an open product call.
- Text is Markdown as written, never escaped. Headings inside the docs go one level lower, so
  each sits under its section: a doc's level-1 heading reads `##`, and level 6 stays at 6.

A missing id, or one in another workspace, returns a tool error "Meeting not found". An empty
workspace returns "No meetings yet". Both docs come back whole in one text block; date ranges and
other shapes are M7's.

## Database (Postgres)

Every table carries `workspace_id` from day one.

```sql
workspaces           (id uuid pk, name text, created_at timestamptz)
meetings             (id uuid pk, workspace_id uuid fk, title text, status text check in ('recording','ended'),
                      started_at timestamptz, ended_at timestamptz null, created_at, updated_at)
                     index (workspace_id, started_at desc)
transcript_segments  (id uuid pk, meeting_id uuid fk on delete cascade, workspace_id uuid fk,
                      source text check in ('mic','system'), speaker text, start_ms int, end_ms int,
                      text text, confidence real null, words jsonb null, created_at timestamptz)
                     index (meeting_id, start_ms)
```

Phase 2 tables. Each line is replaced by its owner's tables, in the form above, in the commit that
fills its migration:

- Vocabulary (revision `0002`, M3-T2):

  ```sql
  vocabulary_terms     (id uuid pk, workspace_id uuid fk, term text check (char_length(term) between 1 and 50),
                        created_at timestamptz)
                       unique index (workspace_id, lower(term))
  ```

- Notes (revision `0003`, M4-T1). Two TipTap docs per meeting (`user`, `ai`), one row per notes
  or chat run, one chat thread per meeting. Timestamps without a type are `timestamptz`; `now()`
  and `0` are server defaults.

  ```sql
  llm_runs       (id uuid pk, workspace_id uuid fk, meeting_id uuid fk on delete cascade,
                  kind text check in ('notes','chat'),
                  status text check in ('running','succeeded','failed','cancelled'),
                  model text, prompt_version text, template_id text null, line_count int,
                  user_notes_version int null, ai_base_version int null,
                  ref_map jsonb, output_text text null, output_doc jsonb null, replaced_doc jsonb null,
                  dropped jsonb null, flagged_count int default 0, from_notes_count int default 0,
                  error_code text null, error text null,
                  input_tokens int null, output_tokens int null, cached_tokens int null,
                  cost_usd numeric null,               -- null when the vendor sent no usage, never 0
                  heartbeat_at default now(), started_at default now(), finished_at null)
                 index (meeting_id, started_at desc)
                 index (heartbeat_at) where status = 'running'        -- the stale sweep
                 unique (meeting_id) where kind = 'notes' and status = 'running'
  meeting_notes  (id uuid pk, workspace_id uuid fk, meeting_id uuid fk on delete cascade,
                  kind text check in ('user','ai'), doc jsonb, version int,
                  last_revision_id uuid, template_id text null,
                  last_run_id uuid null fk llm_runs on delete set null,
                  generated_version int null,          -- the version last_run_id wrote (ai only)
                  created_at, updated_at)
                 unique (meeting_id, kind)
  chat_messages  (id uuid pk, workspace_id uuid fk, meeting_id uuid fk on delete cascade,
                  role text check in ('user','assistant'), text text, citations jsonb null,
                  reply_to uuid null, run_id uuid null fk llm_runs,
                  status text check in ('complete','streaming','failed'), created_at)
                 index (meeting_id, created_at)
  ```

- Calendar (revision `0004`, M5-T1). The `pgcrypto` extension (a downgrade leaves it in place);
  `refresh_token` holds `pgp_sym_encrypt(token, CALENDAR_TOKEN_KEY)`, never the token.

  ```sql
  calendar_connections (id uuid pk, workspace_id uuid fk, user_id uuid null,
                        provider text check in ('google','fake'), account_email text, scopes text,
                        refresh_token bytea null, status text check in ('active','reconnect_required'),
                        last_error text null, connected_at timestamptz, created_at, updated_at)
                       unique nulls not distinct (workspace_id, user_id)
  meetings             + start_source text default 'manual'
                           check in ('manual','notification','home','tray','call_detected'),
                         calendar_provider text null, calendar_event_id text null,
                         calendar_ical_uid text null, calendar_recurring_event_id text null,
                         scheduled_start_at timestamptz null, scheduled_end_at timestamptz null
  meeting_attendees    (id uuid pk, workspace_id uuid fk, meeting_id uuid fk on delete cascade,
                        position int, email text, display_name text null, response_status text,
                        is_self bool, is_organizer bool)
                       unique (meeting_id, position)
  ```

- STT usage (revision `0005`, M3-T19a). One row per workspace and meeting, with no foreign key to
  `meetings`: a meeting deleted for having no lines was still billed.

  ```sql
  stt_usage            (workspace_id uuid fk, meeting_id uuid, provider text check (char_length between 1 and 64),
                        sessions_opened int, connected_ms bigint, audio_sent_ms bigint, dropped_chunks int,
                        gated_ms bigint default 0, estimated_cost_usd numeric null, by_source jsonb,
                        stop_reason text null check (char_length between 1 and 64),
                        created_at timestamptz, updated_at timestamptz,
                        check (every count, time and cost >= 0))
                       primary key (workspace_id, meeting_id)
  ```
