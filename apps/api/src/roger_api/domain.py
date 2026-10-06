"""Vocabulary shared by the database models, the services and the HTTP schemas."""

from typing import Literal

type MeetingStatus = Literal["recording", "ended"]
type AudioSource = Literal["mic", "system"]

DEFAULT_MEETING_TITLE = "Untitled meeting"
MAX_SEGMENTS_PER_APPEND = 500
