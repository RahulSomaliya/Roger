"""ASGI entry point: `uvicorn roger_api.main:app`. Reads settings from the environment."""

from roger_api.app import create_app

app = create_app()
