from uuid import UUID

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.db.models import Workspace


async def ensure_workspace(session: AsyncSession, workspace_id: UUID, name: str) -> None:
    """Create the workspace row if it is missing. Safe to run on every startup."""
    await session.execute(
        insert(Workspace)
        .values(id=workspace_id, name=name)
        .on_conflict_do_nothing(index_elements=[Workspace.id])
    )
    await session.commit()
