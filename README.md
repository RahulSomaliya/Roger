# Roger

A Mac meeting-notes app for the Linkt team. It records calls with no bot, transcribes them live,
turns rough notes plus the transcript into clean notes, and lets Claude or any AI tool pull the
full transcript of any team call through MCP.

- **Spec:** `docs/spec.md`
- **Roadmap:** `docs/roadmap.md`
- **Plans:** `docs/plans/` (one per milestone)
- **House rules:** `CLAUDE.md`
- **API contract:** `docs/api-contract.md`

## Layout

```
apps/desktop   Electron + React + TypeScript Mac app
apps/api       FastAPI + Postgres, hosts the MCP server at /mcp
docs/          spec, roadmap, plans, research
```

## Quick start

Requirements: Node 22 and pnpm 10 (`corepack enable`), Python 3.12 and [uv](https://docs.astral.sh/uv/),
Docker for the local Postgres.

```bash
cp .env.example .env            # then edit ROGER_API_TOKEN (openssl rand -hex 32)
make setup                      # install both apps
make dev-db                     # Postgres on localhost:5432
make migrate                    # create tables
make dev-api                    # http://127.0.0.1:8000  (OpenAPI docs at /docs)
make dev-desktop                # in a second terminal
make check                      # lint + typecheck + test, both apps
```

To let Claude Code read transcripts, point it at the MCP endpoint:

```bash
claude mcp add --transport http roger http://127.0.0.1:8000/mcp \
  --header "Authorization: Bearer $ROGER_API_TOKEN"
```

See `apps/api/README.md` and `apps/desktop/README.md` for per-app details.
