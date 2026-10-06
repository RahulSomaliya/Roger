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
  | 424 | `calendar_reconnect_required` | Google refused the stored refresh token (`invalid_grant`), or the user did not grant calendar access. The message says what to do. |
  | 500 | `internal_error` | Unexpected; details only in server logs |
  | 502 | `stt_provider_error` | The speech-to-text vendor refused or failed a token request |
  | 502 | `llm_provider_error` | The notes model's vendor refused or failed before the stream started |
  | 502 | `calendar_provider_error` | Google is unreachable or answered with an error we cannot use |

  A 401 carries `WWW-Authenticate: Bearer`. Every response carries `X-Request-ID` (echoed when the
  caller sends a safe one, generated otherwise); the same id is on every log line for the request.
  A meeting id that exists in another workspace is a `404`, never a `409`. On `/mcp` only the `401`
  uses this envelope. The MCP SDK answers the rest itself: `405` as a JSON-RPC error object, `421`
  (a `Host` outside `MCP_ALLOWED_HOSTS`) as plain text.

## Entities

```ts
type MeetingStatus = "recording" | "ended";

interface Meeting {
  id: string;
  workspace_id: string;
  title: string;
  status: MeetingStatus;
  started_at: string;        // instant
  ended_at: string | null;   // instant
  segment_count: number;     // transcript segments stored so far
  created_at: string;
  updated_at: string;
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
{ "id": "uuid (optional)", "title": "string (optional, default \"Untitled meeting\")", "started_at": "instant (optional, default now)" }
```

Response: `201 Meeting` when created, `200 Meeting` when `id` already exists in this workspace. The
`200` is the stored meeting as it is: a different `title` or `started_at` in the re-send is ignored.

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

Constraints: 1..500 segments per request; `text` non-empty after trimming; `end_ms >= start_ms`.
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
`provider` is always the vendor id, `"assemblyai" | "deepgram" | "fake"`, never the preset. Both
sides keep a vendor registry with the same provider ids (`STT_VENDORS` in `stt_vendors.py`,
`apps/desktop/src/main/stt/registry.ts`); the desktop never sees presets.

| `STT_PROVIDER` (preset) | `provider` | `stream.model` | `stream.price_per_hour_usd_without_keyterms`, and `price_per_hour_usd` with no jargon list | `stream.price_per_hour_usd` with a jargon list |
| --- | --- | --- | --- | --- |
| `assemblyai` (Roger's vendor since 2026-10-06) | `assemblyai` | `universal-streaming-english` | `0.15` | `0.19` |
| `assemblyai-pro` | `assemblyai` | `universal-3-6-pro` | `0.45` | `0.45` (keyterms included) |
| `deepgram` (the second adapter) | `deepgram` | `nova-3` | `0.462` | `0.54` |
| `fake` | `fake` | `fake` | `0` | `0` |

| `provider` | `access_token` | `expires_in` |
| --- | --- | --- |
| `assemblyai` | AssemblyAI temporary streaming token; the desktop sends it as the `token` query parameter | Seconds left to open the stream (1..600). One token opens both streams; a session then runs up to 3 hours, a cap the API asks for explicitly on every token (`max_session_duration_seconds=10800`), after which AssemblyAI closes it with 3008. |
| `deepgram` | Deepgram grant (JWT); the desktop sends it as `Authorization: Bearer` | Seconds the grant is valid |
| `fake` | `""` | `0` |

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
the vendor (Deepgram `keyterm`, AssemblyAI `keyterms_prompt`). An API older than the jargon list
sends no `keyterms`; the desktop reads that as `[]`.

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

Not built yet. Owner: M3-T19a, which writes its routes here, with their `409`s.

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

Not built yet. Owner: M4-T8, which writes its routes here, with their `409`s.

### Chat

Not built yet. Owner: M4-T10, which writes its routes here, with their `409`s.

### Calendar

Not built yet. Owner: M5-T3, which writes its routes here, with their `409`s.

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

- STT usage (`stt_usage`, revision `0005`): M3-T19a.
