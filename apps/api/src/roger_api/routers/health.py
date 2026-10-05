from fastapi import APIRouter, Response, status

from roger_api.dependencies import DatabaseDep, SettingsDep
from roger_api.schemas.health import HealthOut

router = APIRouter(tags=["health"])


@router.get(
    "/health",
    responses={503: {"model": HealthOut, "description": "Postgres is unreachable"}},
)
async def health(response: Response, database: DatabaseDep, settings: SettingsDep) -> HealthOut:
    database_ok = await database.ping()
    if not database_ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthOut(
        status="ok" if database_ok else "error",
        version=settings.app_version,
        database="ok" if database_ok else "error",
    )
