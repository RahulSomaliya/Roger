# Roger API: failure log

Extends the root `CLAUDE.md`, whose house rules and repo-wide failure log apply here too: these are the traps hit only in `apps/api`. Add one when you hit a new one.

- A NOT NULL column added to a table that holds rows needs a server default in the migration. The
  suite migrates an empty database, so only a test that upgrades a scratch database with rows shows
  a missing one (`test_calendar_schema.py::test_existing_meetings_read_manual_after_the_upgrade`,
  M5-T1).
- A pydantic-settings mixin with its own `model_config` changes how every setting is read (feature
  config modules are plain `BaseModel`). Pydantic keeps one validator per name across the class
  tree: a mixin validator named like one in `Settings` (`_blank_is_unset`) is silently replaced by
  it and the mixin's fields go unchecked, so name each uniquely (P2-F2, M5-T1).
- To retire a setting, keep it typed `None` with a before-validator that refuses a value. Deleting
  it lets `extra="ignore"` drop a leftover `.env` line in silence, and the API runs something other
  than what `.env` says (`STT_MODEL`, M3-T1).
- Never name a conftest helper `test_*`: imported into a test module, pytest collects it (P2-F2).
- `structlog.testing.capture_logs()` misses a module logger first used under an earlier
  `create_app()`: each `configure_logging` call installs a new processor list, a cached logger
  keeps the one it first saw, and `capture_logs` edits only the current one. In a suite that builds
  an app per test, a "never logged" assertion then passes on nothing. Attach a root
  `logging.Handler` after `create_app()` (`recorded_events()` in `test_stt_providers.py`) and assert
  the expected event arrived before asserting what did not (M3-T1; checked with structlog 26.1).
  The reverse also bites: firing `services/calendar/google.py`'s logger under an app breaks
  `test_calendar_google.py`'s `capture_logs` later in the run, so swap that module's logger per
  test (`_fresh_google_logger` in `test_calendar_api.py`, M5-T3).
- A case-insensitive dedupe feeding a unique index on `lower(...)` takes its keys from Postgres:
  Python's `str.lower()` disagrees on a final capital sigma, U+0130 and, in a C-locale database, any
  non-ASCII letter, and one multi-row `ON CONFLICT DO UPDATE` then fails "cannot affect row a second
  time" (a 500). Postgres 16 has no `lc_ctype` to SHOW; read `pg_database.datctype` (M3-T2).
- A whole-list replace (delete what is missing, then upsert) in two concurrent transactions stores
  the union of both lists. Lock the owner row with `with_for_update(key_share=True)` (FOR NO KEY
  UPDATE), not FOR UPDATE, which blocks the FOR KEY SHARE every foreign-key insert takes (M3-T2).
- A test that streams JSON in byte pieces to cover multi-byte UTF-8 dumps with `ensure_ascii=False`,
  or it only ever sends ASCII. Inside `pytest.raises`, `seen += [e async for e in events]` records
  nothing (the comprehension raises before `+=` assigns): append in a helper (M4-T2).
- Never hold a database transaction across a vendor call: a request-scoped `SessionDep` stays idle
  in a transaction until the response is sent. Read in your own `database.session()` and close it
  first (`routers/stt.py`); commit a write before the vendor call (`connections.py`'s revoke)
  (M3-T3, M5-T3).
- Postgres refuses U+0000 in `text` and `jsonb`, and an unpaired surrogate in `jsonb`, with a 500;
  Python's `json.loads` accepts both. Drop or replace them at the schema with
  `schemas/common.storable_text` (`NonEmptyText`, `MeetingTitle`, `CalendarText` and `storable_doc`
  use it). In pydantic, a `BeforeValidator` before `StringConstraints` checks length before the
  trim: constraints first (M4-T6, M5-T4, P2-C1).
- Postgres `now()` is the transaction's start time: two rows inserted in one transaction share
  `created_at`, so a thread ordered by `created_at` alone shuffles a question and its answer. Break
  the tie explicitly (`_THREAD_ORDER` in `services/chat.py`: the question first, then the id)
  (M4-T10).
- A notes doc with `content: []` fails ProseMirror's `doc.check()` (a `doc` needs a block): an
  empty AI doc is TipTap's `{"type": "doc", "content": [{"type": "paragraph"}]}`
  (`notes_generation.build_ai_doc`, M4-T8).
