"""Note template routes (M4-T3).

app.py includes `router` once (P2-F2); its prefix, tags and routes live here, never in app.py.
Every route resolves the `Principal` first, here through the router's `get_principal`
dependency; tests/test_auth.py fails any route that answers without a token.
"""

from fastapi import APIRouter, Depends

from roger_api.auth import get_principal
from roger_api.note_templates import builtin_note_templates
from roger_api.routers.responses import ERROR_RESPONSES
from roger_api.schemas.note_templates import NoteTemplateList

router = APIRouter(
    prefix="/v1/note-templates",
    tags=["notes"],
    dependencies=[Depends(get_principal)],
    responses=ERROR_RESPONSES,
)

# Loaded when this module is imported, which app.py does at startup: a broken template file stops
# the API there, naming the file, instead of failing the first notes run that asks for it.
_TEMPLATES = NoteTemplateList(items=builtin_note_templates())


@router.get("")
async def list_note_templates() -> NoteTemplateList:
    # The built-in templates are the same for every workspace, so the principal only
    # authenticates. Per-workspace templates (after M10) get a table with `workspace_id`; this
    # route then takes `PrincipalDep` and filters by it.
    return _TEMPLATES
