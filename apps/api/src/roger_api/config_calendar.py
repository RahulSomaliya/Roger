"""Calendar settings. Stub from P2-F2; owned by M5-T1.

`config.Settings` inherits `CalendarSettings`, so a field declared here is read from the
environment and the repo-root `.env` like any other setting, and a validator here runs on
`Settings`. Two rules (tests/test_settings_layout.py checks both):
- No `model_config`: `Settings` takes its config from `DatabaseSettings`, and a mixin's own would
  be merged into it.
- Import neither `roger_api.config` nor `roger_api.stt_vendors`: config.py imports this module, so
  either import is a cycle that fails at startup.
"""

from pydantic import BaseModel


class CalendarSettings(BaseModel):
    """The Google OAuth client, its audience and the token encryption key (M5-T1)."""
