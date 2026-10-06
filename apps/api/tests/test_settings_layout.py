"""How `Settings` is put together. The notes and calendar settings arrive as mixins from their own
files, so M4-T2 and M5-T1 never edit config.py (phase-2-build-order.md, section 1), and the modules
config.py imports never import it back."""

from roger_api.config import DatabaseSettings, Settings
from roger_api.config_calendar import CalendarSettings
from roger_api.config_notes import NotesSettings
from tests.helpers import modules_loaded_by


def test_settings_compose_the_notes_and_calendar_mixins() -> None:
    assert issubclass(Settings, NotesSettings)
    assert issubclass(Settings, CalendarSettings)


def test_the_mixins_leave_the_settings_config_to_database_settings() -> None:
    # A mixin's own model_config would be merged into Settings' and change how every setting is
    # read (the `.env` file, unknown keys ignored, secrets kept out of validation errors).
    assert NotesSettings.model_config == {}
    assert CalendarSettings.model_config == {}
    assert Settings.model_config == DatabaseSettings.model_config


def test_modules_config_imports_never_import_it_back() -> None:
    # config.py imports these (the registry, its token issuers, their logger and the mixins). A
    # runtime import of config from any of them is a cycle that fails at startup with "cannot
    # import name 'Settings' from partially initialized module"; they import it only under
    # TYPE_CHECKING.
    loaded = modules_loaded_by(
        "roger_api.stt_vendors",
        "roger_api.services.stt_tokens",
        "roger_api.log",
        "roger_api.config_notes",
        "roger_api.config_calendar",
    )

    assert "roger_api.config" not in loaded


def test_the_mixins_never_import_the_vendor_registry() -> None:
    loaded = modules_loaded_by("roger_api.config_notes", "roger_api.config_calendar")

    assert "roger_api.stt_vendors" not in loaded
