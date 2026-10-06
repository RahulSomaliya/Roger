"""What the app's log handler writes for an error (log.py)."""

import logging
from collections.abc import Iterator

import pytest
import structlog

from roger_api.log import configure_logging, get_logger
from tests.conftest import make_settings

# Never connected to: configure_logging reads only the environment and the level.
UNUSED_DATABASE_URL = "postgresql+asyncpg://unused@localhost:5432/roger_test_unused"


class RenderedLines(logging.Handler):
    """The text the app's own handler writes, rendered while the logging call runs, so
    `logger.exception` still finds the exception being handled."""

    def __init__(self, formatter: logging.Formatter) -> None:
        super().__init__()
        self.lines: list[str] = []
        self._formatter = formatter

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self._formatter.format(record))


@pytest.fixture
def app_logging() -> Iterator[None]:
    """Puts the root logger and structlog back as they were: configure_logging sets both for the
    whole process, and a test that builds no app would otherwise log through this one's."""
    root = logging.getLogger()
    handlers, level = list(root.handlers), root.level
    config = structlog.get_config()
    yield
    root.handlers = handlers
    root.setLevel(level)
    structlog.configure(**config)


def rendered_by_the_app_handler() -> RenderedLines:
    root = logging.getLogger()
    [formatter] = [
        handler.formatter
        for handler in root.handlers
        if isinstance(handler.formatter, structlog.stdlib.ProcessorFormatter)
    ]
    recorder = RenderedLines(formatter)
    root.addHandler(recorder)
    return recorder


def store_line(text: str) -> None:
    raise RuntimeError("the line could not be stored")


@pytest.mark.usefixtures("app_logging")
@pytest.mark.parametrize("app_env", ["development", "production"])
def test_an_error_is_logged_without_any_frame_s_locals(app_env: str) -> None:
    # A frame's locals are request bodies (segment text, a calendar sign-in code) and SQL bind
    # parameters, and structlog's dict traceback renders every one by default (M4-T7, M5-T3).
    configure_logging(make_settings(UNUSED_DATABASE_URL, app_env=app_env))
    rendered = rendered_by_the_app_handler()
    transcript = "Them: the acquisition closes at fifty million"

    try:
        store_line(transcript)
    except RuntimeError:
        get_logger("tests.test_log").exception("unhandled_exception")

    [line] = rendered.lines
    # The traceback is still there: the error and the frame that raised it.
    assert "the line could not be stored" in line
    assert "store_line" in line
    assert transcript not in line
