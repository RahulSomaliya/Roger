"""`open_notes_model`: NOTES_PROVIDER picks the adapter, and the app gets it for its lifetime."""

from pydantic import SecretStr

from roger_api.config_notes import NotesSettings
from roger_api.services.notes_model import open_notes_model
from roger_api.services.notes_model_fake import FakeNotesModel
from roger_api.services.notes_model_openrouter import OpenRouterNotesModel
from tests.helpers import modules_loaded_by


async def test_fake_provider_opens_the_fake_model() -> None:
    async with open_notes_model(NotesSettings()) as model:
        assert isinstance(model, FakeNotesModel)


async def test_openrouter_provider_opens_the_openrouter_model_with_the_settings() -> None:
    settings = NotesSettings(
        notes_provider="openrouter",
        openrouter_api_key=SecretStr("sk-or-v1-secret-key"),
        notes_model="xiaomi/mimo-v2.6-pro",
        chat_model="anthropic/claude-sonnet-5.5",
    )

    async with open_notes_model(settings) as model:
        assert isinstance(model, OpenRouterNotesModel)
        assert model.model_id("notes") == "xiaomi/mimo-v2.6-pro"
        assert model.model_id("chat") == "anthropic/claude-sonnet-5.5"


def test_the_interface_imports_without_its_adapters() -> None:
    # The adapters import the interface's types, so the interface imports them only when a model
    # is opened; a top-level import either way round is a cycle that fails at startup.
    loaded = modules_loaded_by("roger_api.services.notes_model")

    assert "roger_api.services.notes_model_openrouter" not in loaded
    assert "roger_api.services.notes_model_fake" not in loaded
