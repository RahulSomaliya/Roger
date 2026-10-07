"""The workspace jargon list on the wire, and its limits.

The limits are the strictest vendor's (M3 plan, "Jargon list limits"): AssemblyAI takes at most 100
keyterms of 50 characters, and Deepgram refuses a whole request over 500 tokens, which 800
characters approximates. The desktop's `shared/vocabulary.ts` (M3-T8) repeats these numbers so the
editor refuses what the API would; change both together, with docs/api-contract.md.
"""

import unicodedata
from typing import Annotated

from pydantic import AfterValidator, BaseModel, Field, StringConstraints, field_validator

from roger_api.db.models_vocabulary import MAX_TERM_LENGTH

MAX_TERMS = 100
MAX_TERMS_TOTAL_LENGTH = 800


def _refuse_control_characters(term: str) -> str:
    # Category Cc: U+0000-U+001F and U+007F-U+009F. Runs after trimming, so only a control
    # character inside a term is refused; a trailing newline from a paste is simply trimmed.
    if any(unicodedata.category(character) == "Cc" for character in term):
        raise ValueError("Term must not contain control characters")
    return term


# Lengths count Unicode code points (Python `len`, Postgres `char_length`), after trimming.
VocabularyTermText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TERM_LENGTH),
    AfterValidator(_refuse_control_characters),
]


class VocabularyIn(BaseModel):
    # The limits count the list as sent (each term trimmed), before case duplicates are dropped,
    # so the stored list always meets them too.
    terms: Annotated[list[VocabularyTermText], Field(max_length=MAX_TERMS)]

    @field_validator("terms")
    @classmethod
    def _total_length_within_limit(cls, terms: list[str]) -> list[str]:
        total = sum(len(term) for term in terms)
        if total > MAX_TERMS_TOTAL_LENGTH:
            raise ValueError(
                f"Terms add up to {total} characters; at most {MAX_TERMS_TOTAL_LENGTH} in all"
            )
        return terms


class VocabularyOut(BaseModel):
    terms: list[str]
