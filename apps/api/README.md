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
| `STT_PROVIDER` | `fake` | `assemblyai` (Roger's vendor), `deepgram` (second adapter) or `fake` (no vendor). See [Speech-to-text tokens](#speech-to-text-tokens). |
| `ASSEMBLYAI_API_KEY` | empty | Required when `STT_PROVIDER=assemblyai`; startup fails without it. Never leaves the API. |
| `DEEPGRAM_API_KEY` | empty | Required when `STT_PROVIDER=deepgram`; startup fails without it. Never leaves the API. |
| `STT_TOKEN_TTL_SECONDS` | `30` | Lifetime of the speech-to-text token handed to the desktop (1..3600; at most 600 with `assemblyai`, the vendor's limit). |
| `STT_MODEL` / `STT_LANGUAGE` | unset / `en` | Returned to the desktop as stream settings. Unset `STT_MODEL` means the provider's English streaming model: `universal-streaming-english` (assemblyai), `nova-3` (deepgram), `fake`. Startup fails on the other vendor's model (`nova-*` with assemblyai, `universal-*` with deepgram). |
| `STT_PRICE_PER_HOUR_USD` | unset | USD per hour of one open stream, returned to the desktop as `stream.price_per_hour_usd`. Unset means the vendor's list price for the model (`src/roger_api/stt_vendors.py`); a model with no list price there returns `null` and logs `stt_price_unknown` at startup. |
| `STT_SAMPLE_RATE` / `STT_ENCODING` | `16000` / `linear16` | Returned to the desktop as stream settings. |
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
`src/roger_api/stt_vendors.py` (issuer, default model, model-name prefix, token TTL limit, list
price per stream-hour), picked by `STT_PROVIDER`. To add a vendor, follow "Add a speech-to-text
vendor" in [`apps/desktop/README.md`](../desktop/README.md#add-a-speech-to-text-vendor): the
desktop and the API change together.

AssemblyAI is Roger's vendor (owner decision, 2026-10-06: AssemblyAI lists Granola as a customer,
live text costs about $0.15 an hour per stream, and it has generous free hours). The model
is Universal-Streaming English. Deepgram stays as the second adapter for the M3 bake-off. To
switch from the fake provider, set in `.env`:

```bash
STT_PROVIDER=assemblyai
ASSEMBLYAI_API_KEY=...   # from the AssemblyAI dashboard
```

and leave `STT_MODEL` empty. The issuer asks AssemblyAI for a temporary token
(`GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=<STT_TOKEN_TTL_SECONDS>`, raw
key as `Authorization`). The TTL is only the window to open a stream; one token opens both of the
desktop's streams, and each session can then run for up to 3 hours. A vendor that refuses, fails
or times out is a `502 stt_provider_error`.

Two vendor rules to know before testing (read 2026-10-06):

- AssemblyAI bills the time each websocket is open, not the audio sent
  ([docs](https://www.assemblyai.com/docs/universal-streaming)). A call opens two, mic and system
  audio, so a call hour costs about $0.30, and a silent or dead system stream costs as much as a
  live one until Stop.
- A free account may start 5 streaming sessions a minute, paid accounts 100 or more
  ([docs](https://www.assemblyai.com/docs/streaming/rate-limits)). Every Start opens two, so a
  third Start within a minute fails with "Too many concurrent sessions" although nothing leaked.
  The desktop error says to wait a minute.

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
losing: the suite migrates it down and up again with Alembic at the start of the run (so the
migrations themselves are tested, and a test checks they match the models), and truncates every
table before each test.

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

Tables are only ever created by Alembic. To change the schema:

1. Edit `src/roger_api/db/models.py`.
2. `uv run --frozen alembic revision --autogenerate --rev-id 0002 -m "Add meeting notes"`
   against a database at `head`. The file is formatted by ruff automatically.
3. Read the generated file and fix what autogenerate gets wrong (server defaults, data
   migrations, index expressions). Keep `downgrade()` working.
4. `uv run --frozen alembic upgrade head`, then run the tests: `test_migrations.py` fails if the
   models and the migrations disagree.

## Layout

```
src/roger_api/
  main.py              ASGI entry point (`app = create_app()`)
  app.py               create_app(): lifespan, middleware, error handlers, routers, /mcp
  config.py            Settings (pydantic-settings); DatabaseSettings for Alembic
  stt_vendors.py       speech-to-text vendor registry (issuer, default model, price)
  log.py               structlog setup (console in development, JSON in production)
  middleware.py        request id, access log, 500 envelope
  error_handlers.py    the error envelope for every other error
  errors.py            typed application errors (status + code)
  auth.py              Principal, verify_bearer, get_principal
  dependencies.py      FastAPI dependencies for app state (settings, database, sessions)
  domain.py            shared vocabulary (statuses, sources, limits)
  mcp_server.py        MCP server, get_transcript tool, bearer middleware
  db/                  engine wrapper, declarative base, models
  migrations/          Alembic environment and revisions
  schemas/             pydantic models at the HTTP edge
  services/            meetings, segments, workspaces, STT tokens, transcript rendering
  routers/             health, meetings, stt
tests/                 pytest against real Postgres; MCP tests go through the SDK client
```
