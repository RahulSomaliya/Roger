"""Notes generation and run routes (streaming). Stub from P2-F2; owned by M4-T8.

app.py already includes `router`, once: the owner sets its prefix, tags, responses and routes
here and never edits app.py. Every route resolves the `Principal` first (`PrincipalDep`);
tests/test_auth.py fails any route that answers without a token.
"""

from fastapi import APIRouter

router = APIRouter()
