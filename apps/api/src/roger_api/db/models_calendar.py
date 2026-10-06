"""Calendar tables. Stub from P2-F2; owned by M5-T1 (`calendar_connections`,
`meeting_attendees`, revision 0004; the new `meetings` columns go in db/models.py).

`db/models.py` imports this module at its end, so Alembic and the test truncation see every table
declared here without anyone editing that file. Every row carries `workspace_id` (house rule 2).
"""
