-- M5's exit check: how many calendar calls in a row were started from Roger's prompt.
--
--   sqlite3 ~/Library/Application\ Support/Roger/calendar.sqlite < apps/desktop/scripts/calendar-streak.sql
--
-- Prints `streak` (at least 20 closes M5) and `since`, the first call of the streak. Only `started`
-- and `joined_and_started` count; any other outcome, or none (a card nobody answered), restarts
-- it. Counted: calendar prompts (never a detected call with no event) of the account connected
-- last, whose window has closed (start + 10 min), and not marked by hand as not a call:
--   UPDATE prompts SET excluded_reason = '<why>' WHERE key = '<key>';
-- Instants are stored as YYYY-MM-DDTHH:MM:SS.sssZ, so they sort as text. The `prompts` table and
-- what writes it: apps/desktop/src/main/calendar/PromptLog.ts.
--
-- PromptLog.test.ts runs this file, minus the dot-command line below (the sqlite3 shell's, not
-- SQL): keep it to that one line and exactly one statement, or the test runs something else.
.mode line
WITH calls AS (
  SELECT scheduled_start, IFNULL(action, 'open') AS action FROM prompts
  WHERE source = 'calendar' AND excluded_reason IS NULL
    AND account_email = (SELECT account_email FROM connections_log ORDER BY connected_at DESC LIMIT 1)
    AND julianday(scheduled_start, '+10 minutes') <= julianday('now')   -- closed prompts only
),
last_break AS (
  SELECT MAX(scheduled_start) AS at FROM calls
  WHERE action NOT IN ('started', 'joined_and_started')
)
SELECT COUNT(*) AS streak, MIN(scheduled_start) AS since
FROM calls, last_break
WHERE action IN ('started', 'joined_and_started')
  AND (last_break.at IS NULL OR scheduled_start > last_break.at);
