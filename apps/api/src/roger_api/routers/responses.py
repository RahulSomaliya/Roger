"""OpenAPI descriptions of the error envelope, shared by every authenticated router."""

from typing import Any

from roger_api.schemas.common import ErrorEnvelope

ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorEnvelope, "description": "Missing or wrong bearer token"},
    422: {"model": ErrorEnvelope, "description": "Body or query failed validation"},
    500: {"model": ErrorEnvelope, "description": "Unexpected error"},
}
NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorEnvelope, "description": "Unknown meeting, or one in another workspace"}
}
