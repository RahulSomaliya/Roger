# Roger v1: one-page spec

**Status:** living document, revised at every gate. **Owner:** Rahul. **Last update:** 2026-10-05.

## What it is

A Mac app the Linkt team uses every day instead of Granola. It records calls with no bot,
turns rough notes plus the transcript into clean notes, knows who said what, and lets Claude or
any AI tool pull the full transcript of any team call. v1 is the product at Gate 3: three to five
Linkt people run every call on it and cancel Granola.

## Who it is for

Linkt team members on macOS, taking client calls, standups and 1:1s on Google Meet first, Zoom
and Teams later. Each person's calls are private by default; team spaces are shared on purpose.

## What v1 does

| Area | v1 behaviour |
| --- | --- |
| Capture | Mic and system audio as two streams. No bot. Starts from a notification or one click. Loud warning when it hears nothing. Local audio backup kept a few days. |
| Transcript | Live, within about 2 seconds, labelled Me and Them. Saved on the Mac as it arrives, then in Postgres. Jargon list. |
| Speaker names | Attendee names from the invite plus the active-speaker signal from Meet. One click fixes a name for the whole call. |
| Notes | Notepad beside the transcript. After the call, AI rewrites rough notes with the transcript. Every AI line links to the transcript lines behind it. Templates per meeting type. |
| Calendar | Google Calendar sign-in, today's meetings, pre-call notification, consent notice on by default. |
| Team | Google sign-in, workspaces, folders, private by default, share by link or person, Slack export. |
| Search and chat | Keyword plus meaning search across every call the user may see; chat with one call or many. |
| MCP and API | Remote MCP (Streamable HTTP, OAuth) and REST with the same powers: list meetings for any dates, search, get notes, get a full transcript or a time slice. |
| Ship | Signed, notarized, auto-updating Mac build. First run under 3 minutes. |

## Where it beats Granola

1. **Transcript-first MCP.** Search every call, get exact quotes with speaker and time, pull any slice of any call. Tool text tells the AI to use the real words.
2. **Access for projects and agents.** A key per project sees only that project's calls.
3. **Speaker names that stick.** Live names plus voice memory, applied to old and future calls.
4. **Your data, your rules.** Transcripts in our Postgres. Audio kept briefly to re-run with a better model.

## What v1 does not do

Windows, phones, CRM sync, SSO and SCIM, billing, on-device transcription, training on calls (never).

## Principles

- Never lose a call: save text locally first, upload second, warn loudly on silence.
- No vendor keys in the app; the backend hands out short-lived tokens.
- Vendors behind small interfaces; swapping one is a config change.
- `workspace_id` on every row from day one; the same permission rules on app, API, search and MCP.
- Consent by default: the notice to other people on the call is on from M5.

## System shape

```
Mac (Electron)                              Cloud
┌──────────────────────────────┐            ┌────────────────────────────┐
│ renderer: UI, audio capture  │  REST      │ FastAPI                    │
│ main: STT streams, SQLite    │───────────▶│  /v1/*  meetings, segments │
│       safety copy, uploader  │            │  /mcp   Streamable HTTP    │──▶ Claude, Claude Code
└──────────────┬───────────────┘            │ Postgres (pgvector later)  │
               │ short-lived token           └────────────────────────────┘
               ▼
        Speech-to-text vendor (two streams: mic = Me, system = Them)
```

## Quality bar

Each milestone ends with an exit check on a real call (see `docs/roadmap.md`). `make check` is
green on every commit. Permission tests cover app, API, search and MCP before anything is shared.
