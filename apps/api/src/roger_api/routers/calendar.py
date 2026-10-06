"""Calendar routes. Stub from P2-F2; owned by M5-T3.

app.py already includes `router`, once: the owner sets its prefix, tags, responses and routes
here and never edits app.py. Every route resolves the `Principal` first (`PrincipalDep`);
tests/test_auth.py fails any route that answers without a token.
"""

from fastapi import APIRouter

router = APIRouter()
