"""A note template: the sections the AI notes are written in, for one kind of call.

The same model reads the JSON files in `roger_api/note_templates/` and is the API's
`NoteTemplate` (`GET /v1/note-templates`). `notes_prompt.py` reads `name` and `sections` from it
as they are.
"""

from typing import Annotated, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from roger_api.services.notes_markdown import FROM_YOUR_NOTES_HEADING
from roger_api.services.notes_protocol import Heading, parse_line

# One line of text with no control characters. The prompt shows each field on a line of its own
# inside the <template> fence (`notes_prompt.py`), so a line break in a guidance would start a
# line of its own there: a forged `## Heading` the model would treat as one more section.
TemplateText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, pattern=r"^[^\x00-\x1f\x7f]+$")
]

# Stored on notes and runs (`template_id`) and sent by the desktop, so it never changes once
# shipped. It is also the file name (`<id>.json`), which the loader checks.
TemplateId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9_]*$")]

# Frozen: `builtin_note_templates()` is cached and hands the same objects to every caller, so a
# caller that changed one would change it for every later request. `extra="forbid"`: a misspelt
# key in a template file ("guideance") fails at startup instead of silently dropping the field.
_TEMPLATE_CONFIG = ConfigDict(frozen=True, extra="forbid")


class NoteTemplateSection(BaseModel):
    model_config = _TEMPLATE_CONFIG

    heading: TemplateText
    # What belongs under the heading, for the model. Shown only in the prompt.
    guidance: TemplateText

    @field_validator("heading")
    @classmethod
    def _heading_reads_back_as_written(cls, heading: str) -> str:
        # The model is told to write each heading exactly as given, and `notes_protocol.py` takes
        # bold and italic marks and `[L12]` ref groups out of the headings it parses. A template
        # heading holding them ("**Decisions**", "Next steps [L1]") would come back as another
        # heading, so the AI notes would never carry the template's heading as written.
        if parse_line(f"## {heading}") != Heading(heading):
            raise ValueError(
                f"Heading {heading!r} does not read back from the notes line protocol as written; "
                "remove Markdown marks, square-bracket refs and repeated spaces"
            )
        # The AI notes close with this heading over the lines only the user's notes back (M4 D7),
        # and `notes_markdown.py` finds that list by these words. With no such lines, a template
        # section of the same name would be rendered as that list in `get_notes`.
        if heading.casefold() == FROM_YOUR_NOTES_HEADING.casefold():
            raise ValueError(
                f"Heading {heading!r} is the heading the AI notes close with "
                f"({FROM_YOUR_NOTES_HEADING!r}); name the section something else"
            )
        return heading


class NoteTemplate(BaseModel):
    model_config = _TEMPLATE_CONFIG

    id: TemplateId
    # Shown in the template picker.
    name: TemplateText
    description: TemplateText
    # In the order the AI notes use them.
    sections: tuple[NoteTemplateSection, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def _headings_are_unique(self) -> Self:
        # Two sections with one heading: the model's `## Heading` line could not say which of
        # them its bullets belong to. Compared ignoring case, as the model may change it.
        seen: set[str] = set()
        for section in self.sections:
            key = section.heading.casefold()
            if key in seen:
                raise ValueError(f"Two sections have the heading {section.heading!r}")
            seen.add(key)
        return self


class NoteTemplateList(BaseModel):
    model_config = ConfigDict(frozen=True)

    items: tuple[NoteTemplate, ...]
