# Roger API

FastAPI + Postgres. The source of truth for meetings and transcripts, and the home of the MCP
server that lets Claude (or any MCP client) read them. The HTTP, MCP and database contract is
[`docs/api-contract.md`](../../docs/api-contract.md); this README covers running and changing the
app.

## Run it

Requirements: Python 3.12 and [uv](https://docs.astral.sh/uv/), Postgres 16 (`make dev-db` starts
one in Docker). Settings come from the environment and from the repo-root `.env`
(`cp .env.example .env`, then set `ROGER_API_TOKEN` with `openssl rand -hex 32`).

```bash
make setup-api   # uv sync --frozen
make dev-db      # Postgres on localhost:5432 (databases roger and roger_test)
make migrate     # uv run --frozen alembic upgrade head
make dev-api     # uv run --frozen uvicorn roger_api.main:app --reload --port 8000
```

- OpenAPI docs: <http://127.0.0.1:8000/docs>
- Health: `curl http://127.0.0.1:8000/health`
- MCP: `http://127.0.0.1:8000/mcp`

On startup the API makes sure the default workspace row exists. If Postgres is down or not
migrated it logs `database_not_ready` and exits.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | `postgresql+asyncpg://...`. Plain `postgres://` and `postgresql://` URLs are accepted and switched to asyncpg. Alembic reads the same variable. |
| `ROGER_API_TOKEN` | required | Shared bearer secret for `/v1/*` and `/mcp`. At least 16 characters; startup fails on the `.env.example` placeholder (anything starting with `change-me`). |
| `STT_PROVIDER` | `fake` | A preset: the vendor and its model together, `assemblyai` (Roger's vendor), `assemblyai-pro`, `deepgram` or `fake` (no vendor). Startup fails on any other value. See [Speech-to-text tokens](#speech-to-text-tokens). |
| `ASSEMBLYAI_API_KEY` | empty | Required with the `assemblyai` and `assemblyai-pro` presets; startup fails without it. Never leaves the API. |
| `DEEPGRAM_API_KEY` | empty | Required when `STT_PROVIDER=deepgram`; startup fails without it. Never leaves the API. |
| `STT_TOKEN_TTL_SECONDS` | `30` | Lifetime of the speech-to-text token handed to the desktop (1..3600; at most 600 with the AssemblyAI presets, the vendor's limit). |
| `STT_MODEL` | retired | The preset names the model. Startup fails while `STT_MODEL` has a value and names it; delete the line (a blank `STT_MODEL=` still counts as unset). |
| `STT_PRICE_PER_HOUR_USD` | unset | USD per hour of one open stream, returned to the desktop as `stream.price_per_hour_usd`. Unset means the list price of the preset's model (`src/roger_api/stt_vendors.py`); set it for a negotiated rate. A model with no list price returns `null` and logs `stt_price_unknown` at startup. |
| `STT_LANGUAGE` / `STT_SAMPLE_RATE` / `STT_ENCODING` | `en` / `16000` / `linear16` | Returned to the desktop as stream settings. |
| `DEFAULT_WORKSPACE_ID` | `805dd994-ff52-405c-a3cc-58f09b32a2dd` | The one workspace every M1 request resolves to. |
| `DEFAULT_WORKSPACE_NAME` | `Linkt` | Used only when the workspace row is first created. |
| `APP_ENV` | `development` | `production` switches logs to JSON lines. |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`. |
| `MCP_ALLOWED_HOSTS` | empty | Comma-separated `Host` values the MCP endpoint accepts besides localhost, e.g. `roger.example.com,roger.example.com:*`. Empty means localhost only; any other host gets `421`. |
| `TEST_DATABASE_URL` | `postgresql+asyncpg://postgres:postgres@localhost:5432/roger_test` | Test suite only. |

The version reported by `/health` comes from the package metadata (`pyproject.toml`).

## Speech-to-text tokens

`POST /v1/stt/token` hands the desktop a short-lived vendor credential plus stream settings; the
vendor key never leaves the API. Each vendor is one `SttTokenIssuer` in
`src/roger_api/services/stt_tokens.py` and one entry in the vendor registry,
`src/roger_api/stt_vendors.py` (`STT_VENDORS`: issuer, token TTL limit, list price per
stream-hour by model). `STT_PROVIDER` names a preset in the same file (`STT_PRESETS`): one vendor
and one of its models, so switching vendor or model is one line in `.env`, then a restart.

| `STT_PROVIDER` | Vendor (`provider` in the token) | Model | USD per stream-hour |
| --- | --- | --- | --- |
| `assemblyai` | `assemblyai` | `universal-streaming-english` | 0.15 |
| `assemblyai-pro` | `assemblyai` | `universal-3-6-pro` | 0.45 |
| `deepgram` | `deepgram` | `nova-3` | 0.462 |
| `fake` | `fake` | `fake` | 0 |

The token's `provider` is always the vendor, never the preset, so the desktop never sees presets.
Another model is another row in `STT_PRESETS`, spelt exactly as the vendor spells it: AssemblyAI
quietly runs another model for a name it does not know, and a test fails on a preset model with no
list price. To add a vendor, follow "Add a speech-to-text vendor" in
[`apps/desktop/README.md`](../desktop/README.md#add-a-speech-to-text-vendor): the desktop and the
API change together.

AssemblyAI is Roger's vendor (owner decision, 2026-10-06: AssemblyAI lists Granola as a customer,
live text costs about $0.15 an hour per stream, and it has generous free hours). The model
is Universal-Streaming English. Deepgram stays as the second adapter for the M3 bake-off. To
switch from the fake provider, set in `.env`:

```bash
STT_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=...   # from the AssemblyAI dashboard
```

The issuer asks AssemblyAI for a temporary token
(`GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=<STT_TOKEN_TTL_SECONDS>&max_session_duration_seconds=10800`,
raw key as `Authorization`). The TTL is only the window to open a stream; one token opens both of
the desktop's streams, and each session can then run for up to 3 hours, a cap asked for explicitly
so a change of the vendor's default never lengthens a billed session. A vendor that refuses, fails
or times out is a `502 stt_provider_error`.

Two vendor rules to know before testing (read 2026-10-06):

- AssemblyAI bills the time each websocket is open, not the audio sent
  ([docs](https://www.assemblyai.com/docs/universal-streaming)). A call opens two, mic and system
  audio, so a call hour costs about $0.30, and a silent or dead system stream costs as much as a
  live one while it is open. The desktop's cost guards close such a session and stop a forgotten
  recording (apps/desktop/README.md, "Cost guards").
- A free account may start 5 streaming sessions a minute, paid accounts 100 or more
  ([docs](https://www.assemblyai.com/docs/streaming/rate-limits)). Every Start opens two, so a
  third Start within a minute would fail at the vendor with "Too many concurrent sessions"
  although nothing leaked. The desktop's own limiter (4 opens a minute) refuses it first and says
  when to try.

## Calendar

The `/v1/calendar/*` routes sign in to Google Calendar for the desktop and list the primary
calendar's events (contract: "Calendar"). The API keeps the Google refresh token, encrypted in
Postgres with pgcrypto under `CALENDAR_TOKEN_KEY`; the desktop never sees a Google token.
`CALENDAR_PROVIDER=fake`, the default, needs no Google client: sign-in completes at once and the
events are a script anchored to the API's start time (restart for a fresh "call in 2 minutes"), or
the `events.list` JSON in `FAKE_CALENDAR_FILE`.

For real calendars, create the Google OAuth client first:
[`docs/plans/M5-calendar.md`, "Owner setup: Google Cloud"](../../docs/plans/M5-calendar.md#owner-setup-google-cloud-about-10-minutes)
(about 10 minutes). Then set `CALENDAR_PROVIDER=google`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET` and `CALENDAR_TOKEN_KEY` (`openssl rand -hex 32`) in `.env`, as
`.env.example` describes. Keep the key: with another key the stored grant is unreadable and the
calendar must be connected again. `GOOGLE_OAUTH_AUDIENCE` stays `external_testing` until Google has
verified the app: Google then expires each connection after 7 days, and the API reports when
(`expires_hint`).

## Errors

Every error uses the envelope from the contract, `{"error": {"code": "...", "message": "..."}}`,
and every response carries `X-Request-ID` (echoed when the caller sends a safe one, generated
otherwise; it is also on every log line for that request).

| HTTP | `code` | When |
| --- | --- | --- |
| 401 | `unauthorized` | Missing or wrong bearer token (also on `/mcp`). Sends `WWW-Authenticate: Bearer`. |
| 404 | `not_found` | Unknown id, an id in another workspace, or an unknown path. |
| 405 | `method_not_allowed` | Known path, wrong method. |
| 409 | `conflict` | A segment id already stored under a different meeting. Nothing in that batch is stored. |
| 422 | `validation_error` | `message` lists the fields, e.g. `Invalid request: body.segments[0].text: String should have at least 1 character`. |
| 500 | `internal_error` | Unexpected. Details go to the server log only, under the same request id. |
| 502 | `stt_provider_error` | `POST /v1/stt/token`: the speech-to-text vendor refused, failed or was unreachable. |

## MCP

The MCP server is mounted in the same app at exactly `/mcp` (Streamable HTTP, stateless, so any
worker can serve any request). It needs the same bearer token as the REST API and exposes one
tool, `get_transcript(meeting_id?)`, which returns the transcript as plain text:

```
Meeting: Weekly sync with Acme
Meeting ID: 7f3c2d1e-...
Started: 2026-10-05T10:00:00Z   Ended: 2026-10-05T10:31:12Z   Segments: 412

[00:00:03] Me: Hi everyone, thanks for joining.
[00:00:07] Them: Hi Rahul, good to see you.
```

Add it to Claude Code:

```bash
claude mcp add --transport http roger http://127.0.0.1:8000/mcp \
  --header "Authorization: Bearer $ROGER_API_TOKEN"
```

Then ask, for example, "Quote the first thing the other person said in my last meeting."

The tool returns the whole meeting in one text block, so a very long call can exceed an MCP
client's output cap. Slicing arrives in M7.

Behind a real hostname, set `MCP_ALLOWED_HOSTS` (see above) or the endpoint answers `421`.
Behind a TLS-terminating proxy, run uvicorn with `--proxy-headers --forwarded-allow-ips=...`.

## Tests and checks

The tests run against a real Postgres. Point `TEST_DATABASE_URL` at a database you do not mind
losing: at the start of the run the suite drops and recreates it, then migrates it up, down and up
again with Alembic (so the migrations themselves are tested, and a test checks they match the
models), and it truncates every table before each test. The database name must start with
`roger_test`: the suite refuses any other name before it connects. Parallel worktrees each use
their own: `make check TEST_DB=roger_test_<task>`. Close any other session on it first (psql, a
GUI client); the drop fails while one is open.

```bash
uv run --frozen ruff check . && uv run --frozen ruff format --check .   # make lint-api
uv run --frozen mypy                                                     # make typecheck-api
uv run --frozen pytest                                                   # make test-api
```

`--frozen` runs against `uv.lock` as committed. Without it, `uv run` re-resolves the lock and fails
on a machine whose global uv config has an `exclude-newer` cutoff.

`TEST_DATABASE_URL` is read from the environment or the repo-root `.env`. `make check` runs all
three for both apps.

## Migrations

Tables are only ever created by Alembic. The chain is fixed through `0005`: Phase 2's revisions
`0002` to `0005` began as empty stubs (P2-F2), each filled in place by the one task that owns it
(`docs/plans/phase-2-build-order.md`, section 2), and `tests/test_migrations.py` fails on a second
head or a re-pointed `down_revision`. To fill a stub, run step 2 into a scratch revision, move its
operations into the stub, and delete the scratch file.

A stub is filled in place, so a database migrated while it was empty already sits past it:
`alembic upgrade head` does nothing (the new tables never arrive) and `alembic downgrade` fails on
the tables it never created. The test suite needs nothing: it recreates its database every run.
Any other database, the dev `roger` included, needs one repair after you fill a stub or pull one
that someone else filled: `uv run --frozen alembic stamp <the stub's down_revision>` (this only
rewrites the recorded version; it runs nothing), then `uv run --frozen alembic upgrade head`. When
several stubs were filled since that database was last migrated, stamp to the down_revision of the
earliest. Stamping too far back fails loudly on a table that already exists; dropping and
recreating the database also works, but loses its data.

To change the schema:

1. Edit the models: `src/roger_api/db/models_<domain>.py` for a Phase 2 domain (`db/models.py`
   imports each at its end), `db/models.py` for the M1 tables.
2. `uv run --frozen alembic revision --autogenerate --rev-id 0006 -m "Add ..."` against a
   database at `head`. The file is formatted by ruff automatically. A new revision also needs its
   row in the plan's table and in `test_revision_chain_is_fixed`.
3. Read the generated file and fix what autogenerate gets wrong (server defaults, data
   migrations, index expressions). Keep `downgrade()` working.
4. `uv run --frozen alembic upgrade head` (after filling a stub, the `alembic stamp` above comes
   first, since step 2 needed the database at `head`), then run the tests: `test_migrations.py`
   fails if the models and the migrations disagree.

## Layout

```
src/roger_api/
  main.py              ASGI entry point (`app = create_app()`)
  app.py               create_app(): lifespan, middleware, error handlers, routers, /mcp
  config.py            Settings (pydantic-settings); DatabaseSettings for Alembic
  config_notes.py      NotesSettings mixin of Settings (notes model)
  config_calendar.py   CalendarSettings mixin of Settings (Google Calendar)
  stt_vendors.py       speech-to-text registry: vendors (issuer, price) and presets
  log.py               structlog setup (console in development, JSON in production)
  middleware.py        request id, access log, 500 envelope
  error_handlers.py    the error envelope for every other error
  errors.py            typed application errors (status + code)
  auth.py              Principal, verify_bearer, get_principal
  dependencies.py      FastAPI dependencies for app state (settings, database, sessions)
  domain.py            shared vocabulary (statuses, sources, limits)
  mcp_server.py        MCP server, get_transcript tool, bearer middleware
  db/                  engine wrapper, declarative base, models (one module per Phase 2 domain)
  migrations/          Alembic environment and revisions
  schemas/             pydantic models at the HTTP edge
  services/            meetings, segments, workspaces, STT tokens, transcript rendering, notes,
                       the LLM run registry, calendar
  routers/             health, meetings, stt, and one per Phase 2 feature (all included in app.py)
tests/                 pytest against real Postgres; MCP tests go through the SDK client
```
