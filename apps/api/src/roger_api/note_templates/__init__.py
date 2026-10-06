"""The built-in note templates: one `<id>.json` file per template in this package.

A new template is a new file here, with no code change. Each file is a `NoteTemplate`
(`schemas/note_templates.py`). `routers/note_templates.py` loads them when the API starts, so a
broken file stops the API instead of failing the first notes run. The same templates serve every
workspace; per-workspace templates later get a table with `workspace_id`.
"""

from functools import cache
from importlib import resources
from importlib.resources.abc import Traversable

from pydantic import ValidationError

from roger_api.schemas.note_templates import NoteTemplate

_SUFFIX = ".json"


class NoteTemplateError(ValueError):
    """A template file that does not load. The message names the file and what is wrong."""


def load_note_templates(root: Traversable) -> tuple[NoteTemplate, ...]:
    """Every `<id>.json` template in `root`, validated, ordered by name.

    Raises `NoteTemplateError` for the first file that does not load, or when `root` holds none.
    """
    templates = [
        _load(entry) for entry in root.iterdir() if entry.name.endswith(_SUFFIX) and entry.is_file()
    ]
    if not templates:
        raise NoteTemplateError(f"No note templates (*{_SUFFIX}) in {root}")
    return tuple(sorted(templates, key=lambda template: (template.name.casefold(), template.id)))


@cache
def builtin_note_templates() -> tuple[NoteTemplate, ...]:
    # Read through importlib.resources, never through a path built from `__file__`: the files are
    # package data and must load from an installed wheel or a zip as from the source tree.
    return load_note_templates(resources.files(__name__))


def find_note_template(template_id: str) -> NoteTemplate | None:
    """The built-in template with this id, or None when there is none."""
    return next(
        (template for template in builtin_note_templates() if template.id == template_id), None
    )


def _load(entry: Traversable) -> NoteTemplate:
    try:
        template = NoteTemplate.model_validate_json(entry.read_bytes())
    except ValidationError as error:
        raise NoteTemplateError(f"Note template {entry.name} is invalid: {error}") from error
    # The id is the file name, so two files can never claim one id, and a copied file that kept
    # its old id cannot silently replace the template it was copied from.
    expected = entry.name.removesuffix(_SUFFIX)
    if template.id != expected:
        raise NoteTemplateError(
            f"Note template {entry.name} has the id {template.id!r}; "
            f"its id must be its file name, {expected!r}"
        )
    return template
