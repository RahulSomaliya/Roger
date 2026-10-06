"""Structured logging: readable console output in development, JSON lines in production.

Standard-library loggers (uvicorn, SQLAlchemy, the MCP SDK) are routed through the same
processors, so every line carries the same fields, including the bound `request_id`.
"""

import logging
import sys
from typing import TYPE_CHECKING

import structlog
from structlog.typing import EventDict, Processor, WrappedLogger

if TYPE_CHECKING:
    # Only for the annotation, never at runtime: config imports the STT vendor registry, whose
    # token issuers log through this module, so a runtime import here is an import cycle that
    # fails at startup with "cannot import name 'Settings' from partially initialized module".
    from roger_api.config import Settings


def _drop_color_message(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    """uvicorn passes an ANSI-coloured copy of its message as an `extra`; keep the plain one."""
    event_dict.pop("color_message", None)
    return event_dict


def configure_logging(settings: "Settings") -> None:
    shared: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.ExtraAdder(),
        _drop_color_message,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]
    renderer: list[Processor] = (
        [structlog.processors.dict_tracebacks, structlog.processors.JSONRenderer()]
        if settings.is_production
        else [structlog.dev.ConsoleRenderer()]
    )

    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            *shared,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared,
            processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, *renderer],
        )
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(settings.log_level)

    # uvicorn installs its own handlers before importing the app; send its records through ours.
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
    # The request middleware writes one structured access line per request instead.
    logging.getLogger("uvicorn.access").disabled = True
    # The stateless MCP transport logs "Terminating session: None" at INFO on every request.
    if settings.log_level != "DEBUG":
        logging.getLogger("mcp.server.streamable_http").setLevel(logging.WARNING)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    logger: structlog.stdlib.BoundLogger = structlog.stdlib.get_logger(name)
    return logger
