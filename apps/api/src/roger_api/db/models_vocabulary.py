"""Vocabulary tables: the workspace jargon list (`vocabulary_terms`, revision 0002, M3-T2).

`db/models.py` imports this module at its end, so Alembic and the test truncation see every table
declared here without anyone editing that file. Every row carries `workspace_id` (house rule 2).
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from roger_api.db.base import Base

# AssemblyAI takes keyterms of at most 50 characters. The API refuses a longer term with a 422
# (schemas/vocabulary.py); this check is the database's own backstop. Migration 0002 copies the
# number, as migrations never import models.
MAX_TERM_LENGTH = 50


class VocabularyTerm(Base):
    """One term of a workspace's jargon list, as the user spelled it."""

    __tablename__ = "vocabulary_terms"
    __table_args__ = (
        CheckConstraint(f"char_length(term) BETWEEN 1 AND {MAX_TERM_LENGTH}", name="term_length"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"))
    term: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# One row per term per workspace, whatever its case. It is also the conflict target of the PUT's
# upsert and the order of the list (services/vocabulary.py): both use Postgres's own lower(), never
# Python's, so the two can never disagree about which terms are the same.
Index(
    "ix_vocabulary_terms_workspace_id_lower_term",
    VocabularyTerm.workspace_id,
    func.lower(VocabularyTerm.term),
    unique=True,
)
