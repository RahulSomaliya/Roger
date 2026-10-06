"""Vocabulary shared by the database models, the services and the HTTP schemas."""

from typing import Literal

type MeetingStatus = Literal["recording", "ended"]
type AudioSource = Literal["mic", "system"]
# Speech-to-text vendors the API can hand out tokens for. Each has an entry in
# stt_vendors.STT_VENDORS (a test fails without one) and an adapter on the desktop.
type SttProvider = Literal["fake", "deepgram", "assemblyai"]

DEFAULT_MEETING_TITLE = "Untitled meeting"
MAX_SEGMENTS_PER_APPEND = 500
