"""Notes and AI settings. Stub from P2-F2; owned by M4-T2.

`config.Settings` inherits `NotesSettings`, so a field declared here is read from the environment
and the repo-root `.env` like any other setting, and a validator here runs on `Settings`. Two rules
(tests/test_settings_layout.py checks both):
- No `model_config`: `Settings` takes its config from `DatabaseSettings`, and a mixin's own would
  be merged into it.
- Import neither `roger_api.config` nor `roger_api.stt_vendors`: config.py imports this module, so
  either import is a cycle that fails at startup.
"""

from pydantic import BaseModel


class NotesSettings(BaseModel):
    """The notes model: provider, key, model ids, reasoning and budgets (M4-T2)."""
