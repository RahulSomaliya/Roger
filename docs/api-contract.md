# Roger API contract (M1)

The desktop app and every MCP client talk to the API through this contract. It is updated in the
same change as the code on both sides. Base URL in development: `http://127.0.0.1:8000`.

## Conventions

- JSON everywhere. Instants are ISO 8601 in UTC with a `Z` suffix (`2026-10-05T10:00:00Z`).
  Durations and offsets are integer milliseconds. Ids are UUIDv4 strings.
- **Auth:** every `/v1/*` route and the `/mcp` endpoint require `Authorization: Bearer <token>`.
  In M1 the token is the shared secret `ROGER_API_TOKEN`; it resolves to one `Principal`
  (workspace, user). M6 replaces the secret with Google sign-in, M7 adds OAuth for MCP, M14 adds
  project keys. Callers never change.
- **Idempotency:** the client generates meeting and segment ids. Re-sending any create or append is
  safe and returns the same result.
- **Errors** use one envelope:

  ```json
  { "error": { "code": "not_found", "message": "Meeting 7f3c... not found" } }
  ```

  | HTTP | code | When |
  | --- | --- | --- |
  | 401 | `unauthorized` | Missing or wrong bearer token |
  | 404 | `not_found` | Unknown id, or an id in another workspace |
  | 409 | `conflict` | An id exists with different immutable fields (for example the same meeting id in a different workspace is reported as 404, never 409) |
  | 422 | `validation_error` | Body or query failed validation; `message` lists the fields |
  | 500 | `internal_error` | Unexpected; details only in server logs |

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

Response: `201 Meeting` when created, `200 Meeting` when `id` already exists in this workspace.

### `GET /v1/meetings?limit=50&before=<instant>`

Newest first by `started_at`. `limit` 1..200, default 50. `before` pages backwards.
Response: `200 { "items": Meeting[] }`.

### `GET /v1/meetings/{meeting_id}`

Response: `200 Meeting`.

### `POST /v1/meetings/{meeting_id}/segments`

Append transcript segments. Idempotent on segment `id`; duplicates are counted and ignored.

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
config change on the API.

Response:

```json
{
  "provider": "deepgram",
  "access_token": "eyJ...",
  "expires_in": 30,
  "stream": { "model": "nova-3", "language": "en", "sample_rate": 16000, "encoding": "linear16" }
}
```

With `STT_PROVIDER=fake` the response is `{"provider": "fake", "access_token": "", "expires_in": 0, "stream": {...}}`
and the desktop uses its built-in fake adapter (useful for development without a vendor key).

## MCP

Endpoint: `POST|GET|DELETE /mcp` (MCP Streamable HTTP). Same bearer token. Connect from Claude Code:

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
