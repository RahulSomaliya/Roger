"""Vocabulary shared by the database models, the services and the HTTP schemas."""

from typing import Literal

type MeetingStatus = Literal["recording", "ended"]
type AudioSource = Literal["mic", "system"]
# Speech-to-text vendors the API can hand out tokens for. Each has an entry in
# stt_vendors.STT_VENDORS (a test fails without one) and an adapter on the desktop, or a place in
# `AWAITING_A_DESKTOP_ADAPTER` (tests/test_stt_providers.py) until its adapter lands.
type SttProvider = Literal["fake", "deepgram", "assemblyai", "soniox", "xai"]

# Phase 2 vocabulary, defined before the tables that use it so parallel tasks share one copy. Each
# list is also a check constraint in its migration; change the two together.
type NoteKind = Literal["user", "ai"]  # meeting_notes.kind (M4-T1)
type RunKind = Literal["notes", "chat"]  # llm_runs.kind (M4-T1)
type RunStatus = Literal["running", "succeeded", "failed", "cancelled"]  # llm_runs.status (M4-T1)
# How a recording was started: meetings.start_source (M5-T1), sent by the desktop's StartSource
# (M5-T5). `call_detected` is M2's call offer; it is in the check constraint from the start so M2
# never needs a migration of its own.
type StartSource = Literal["manual", "notification", "home", "tray", "call_detected"]

DEFAULT_MEETING_TITLE = "Untitled meeting"
MAX_SEGMENTS_PER_APPEND = 500
