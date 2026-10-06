# Roger API contract (M1)

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
  | 409 | `conflict` | A segment id is already stored under a different meeting. Nothing in that batch is stored. This is the only `409`. |
  | 405 | `method_not_allowed` | Known path, wrong method |
  | 422 | `validation_error` | Body or query failed validation; `message` lists the fields |
  | 500 | `internal_error` | Unexpected; details only in server logs |
  | 502 | `stt_provider_error` | The speech-to-text vendor refused or failed a token request |

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
stream settings. The desktop picks its `SpeechToText` adapter from `provider`. Changing vendor is a
config change on the API (`STT_PROVIDER`). Both sides keep a vendor registry with the same provider
ids (`apps/api/src/roger_api/stt_vendors.py`, `apps/desktop/src/main/stt/registry.ts`).

| `provider` | `access_token` | `expires_in` | Default `stream.model` | Its `stream.price_per_hour_usd` |
| --- | --- | --- | --- | --- |
| `assemblyai` (Roger's vendor since 2026-10-06; `deepgram` is the second adapter) | AssemblyAI temporary streaming token; the desktop sends it as the `token` query parameter | Seconds left to open the stream (1..600). One token opens both streams; a session then runs up to 3 hours, a cap the API asks for explicitly on every token (`max_session_duration_seconds=10800`), after which AssemblyAI closes it with 3008. | `universal-streaming-english` | `0.15` |
| `deepgram` | Deepgram grant (JWT); the desktop sends it as `Authorization: Bearer` | Seconds the grant is valid | `nova-3` | `0.462` |
| `fake` | `""` | `0` | `fake` | `0` |

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
    "price_per_hour_usd": 0.15
  }
}
```

`stream.model` is `STT_MODEL`, or the provider's default above when it is unset. `stream.encoding`
is Roger's own name for 16-bit signed little-endian mono PCM (`linear16`) whatever the vendor; each
desktop adapter maps it to its vendor's name (AssemblyAI calls it `pcm_s16le`). The desktop
refuses to start when `sample_rate` and `encoding` are not the `16000` / `linear16` it sends.

`stream.price_per_hour_usd` is what one open stream of `stream.model` costs per hour in USD: the
vendor's list price from the API's registry, or `STT_PRICE_PER_HOUR_USD` when set, or `null` when
the API knows no price for that model (it then logs `stt_price_unknown` at startup). It is per
stream and per hour the stream is open: a meeting opens two streams, and AssemblyAI bills the open
time, silent or not. The desktop uses it to estimate what a stream cost and never hardcodes vendor
prices.

With `STT_PROVIDER=fake` the response is `{"provider": "fake", "access_token": "", "expires_in": 0, "stream": {...}}`
and the desktop uses its built-in fake adapter (useful for development without a vendor key).

A vendor that refuses, fails, times out or answers with something unreadable is a
`502 stt_provider_error`. The vendor key is never in a response or a log line.

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
