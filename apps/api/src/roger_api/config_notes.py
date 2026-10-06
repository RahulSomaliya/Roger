"""Notes and AI settings: which model writes notes and answers chat, and its budgets.

`config.Settings` inherits `NotesSettings`, so a field declared here is read from the environment
and the repo-root `.env` like any other setting, and a validator here runs on `Settings`. Two rules
(tests/test_settings_layout.py checks both):
- No `model_config`: `Settings` takes its config from `DatabaseSettings`, and a mixin's own would
  be merged into it.
- Import neither `roger_api.config` nor `roger_api.stt_vendors`: config.py imports this module, so
  either import is a cycle that fails at startup.

`.env.example` lists every field here in its "Notes and AI" section, and
tests/test_notes_config.py fails when the two drift apart.
"""

from typing import Literal, Self

from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator

# `fake` writes notes from the prompt itself, for development and tests (notes_model_fake.py).
# `openrouter` calls OpenRouter (notes_model_openrouter.py). A new provider is a value here, an
# adapter and a branch in `open_notes_model` (notes_model.py); callers never change.
type NotesProvider = Literal["fake", "openrouter"]
# `off` asks the model not to reason; `on` gives it NOTES_REASONING_TOKENS to reason with.
type NotesReasoning = Literal["off", "on"]

# The owner's choice on 2026-10-06 (M4 plan, D2): checked on openrouter.ai/api/v1/models that day,
# 1,050,000 tokens of context at $0.435 / $0.87 per million input / output tokens, with
# zero-retention endpoints on Novita and DeepInfra. A pinned id keeps eval runs comparable; the
# eval compares it with other models through NOTES_MODEL.
DEFAULT_NOTES_MODEL = "xiaomi/mimo-v2.6-pro"


class NotesSettings(BaseModel):
    """The notes model: provider, key, model ids, reasoning and budgets (M4-T2)."""

    notes_provider: NotesProvider = "fake"
    # Only needed when NOTES_PROVIDER=openrouter. Never ships in the desktop app (house rule 3).
    openrouter_api_key: SecretStr | None = None
    notes_model: str = DEFAULT_NOTES_MODEL
    chat_model: str = DEFAULT_NOTES_MODEL
    notes_reasoning: NotesReasoning = "off"
    # The reasoning budget when NOTES_REASONING=on. Reasoning tokens are output tokens and count
    # against the request's max_tokens, so the adapter raises max_tokens by this much: otherwise
    # reasoning would eat the notes' budget and the run would fail as cut off.
    notes_reasoning_tokens: int = Field(default=4_096, ge=256, le=64_000)
    # One pass while the prompt is under this (estimated as characters / 4, a budget guard only,
    # never reported as usage); map then reduce above it (M4-T9). A 2-hour call is about 30,000.
    notes_max_input_tokens: int = Field(default=200_000, ge=1_000, le=1_000_000)
    # The longest answer the model may write. A 1-hour call's notes are about 2,000 tokens; a run
    # that hits the limit fails as cut off and keeps the previous AI notes.
    notes_max_output_tokens: int = Field(default=8_192, ge=256, le=64_000)
    # The longest silence from the provider: to connect, and between two pieces of a stream.
    # OpenRouter sends keep-alive comments while a model reads a long prompt, so this does not cap
    # a whole run; cancelling one is the run registry's job (M4-T7).
    notes_timeout_seconds: float = Field(default=120.0, gt=0, le=600)

    @field_validator("notes_model", "chat_model", mode="before")
    @classmethod
    def _blank_model_is_the_default(cls, value: object) -> object:
        """`NOTES_MODEL=` in a `.env` arrives as an empty string: it means the default model."""
        if isinstance(value, str):
            return value.strip() or DEFAULT_NOTES_MODEL
        return value

    @field_validator("openrouter_api_key", mode="before")
    @classmethod
    def _blank_key_is_unset(cls, value: object) -> object:
        """`OPENROUTER_API_KEY=` in a `.env` arrives as an empty string."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @model_validator(mode="after")
    def _openrouter_needs_a_key(self) -> Self:
        if self.notes_provider == "openrouter" and self.openrouter_api_key is None:
            raise ValueError("OPENROUTER_API_KEY is required when NOTES_PROVIDER=openrouter")
        return self
