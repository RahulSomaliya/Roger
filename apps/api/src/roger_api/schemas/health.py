from typing import Literal

from pydantic import BaseModel

type Status = Literal["ok", "error"]


class HealthOut(BaseModel):
    status: Status
    version: str
    database: Status
