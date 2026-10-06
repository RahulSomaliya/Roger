"""The video-call host allowlist (M5-T2): `services/calendar/video_links.py`.

The API picks each event's `video_link` with these rules and the desktop re-checks it with
`parseJoinLink` (apps/desktop/src/shared/meetingLinks.ts) before "Join and take notes" opens it.
JOIN_LINK_CASES is the desktop's table in `meetingLinks.test.ts`, row for row:
`test_table_matches_the_desktop` fails when the two differ, so change both in the same commit.
"""

import re

import pytest

from roger_api.config import REPO_ROOT_ENV_FILE
from roger_api.services.calendar.video_links import (
    JoinLink,
    JoinLinkProvider,
    find_join_link,
    parse_join_link,
)

DESKTOP_TABLE = REPO_ROOT_ENV_FILE.parent / "apps/desktop/src/shared/meetingLinks.test.ts"

JOIN_LINK_CASES: list[tuple[str, JoinLinkProvider | None]] = [
    # Accepted
    ("https://meet.google.com/abc-defg-hij", "google_meet"),
    ("https://meet.google.com/abc-defg-hij?authuser=1", "google_meet"),
    ("https://MEET.google.com/ABC-DEFG-HIJ", "google_meet"),
    ("https://zoom.us/j/1234567890", "zoom"),
    ("https://us02web.zoom.us/j/81234567890?pwd=AbC123", "zoom"),
    ("https://linkt.zoom.us/my/rahul.s", "zoom"),
    ("https://zoom.us/w/123456789", "zoom"),
    ("https://us06web.zoom.us/w/81234567890?tk=AbC123", "zoom"),
    (
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d",
        "teams",
    ),
    ("https://teams.microsoft.com/meet/2345678901234?p=AbCdEf", "teams"),
    ("https://teams.live.com/meet/9876543210", "teams"),
    # Refused: not https
    ("http://meet.google.com/abc-defg-hij", None),
    ("http://zoom.us/j/1234567890", None),
    ("javascript:alert(1)", None),
    ("file:///etc/passwd", None),
    # Refused: lookalike hosts
    ("https://meet.google.com.evil.io/abc-defg-hij", None),
    ("https://meet.google.com@evil.io/abc-defg-hij", None),
    ("https://zoom.us.evil.io/j/1234567890", None),
    ("https://evilzoom.us/j/1234567890", None),
    ("https://teams.microsoft.com.evil.io/l/meetup-join/abc", None),
    ("https://calendar.google.com/calendar/event?eid=abc", None),
    # Refused: right host, not a meeting
    ("https://meet.google.com/", None),
    ("https://meet.google.com/new", None),
    ("https://meet.google.com/landing", None),
    ("https://zoom.us/", None),
    ("https://zoom.us/signin", None),
    ("https://zoom.us/j/", None),
    ("https://zoom.us/w/", None),
    ("https://zoom.us/s/1234567890", None),
    ("https://teams.microsoft.com/", None),
    ("https://teams.microsoft.com/l/meetup-join/", None),
    # Refused: credentials hide the real host from a glance
    ("https://user:secret@meet.google.com/abc-defg-hij", None),
    # Refused: not a URL
    ("meet.google.com/abc-defg-hij", None),
    ("", None),
]

# Where `urllib.parse` and the desktop's WHATWG parser could disagree. Each expected value is what
# `parseJoinLink` answers (checked with node 22 on 2026-10-06), except where it says otherwise:
# there this side refuses a link the desktop would take, never the reverse.
PARSER_EDGE_CASES: list[tuple[str, JoinLinkProvider | None]] = [
    # Python would read these hosts as an allowlisted name; WHATWG refuses them.
    ("https://evil%2F.zoom.us/j/1", None),
    ("https://evil.io\\.zoom.us/j/1", None),
    ("https://xn--zz.zoom.us/j/1", None),
    ("https://meet.google.com:abc/abc-defg-hij", None),
    ("https://zoom.us:65536/j/1", None),
    # Python's `\d`, `\w` and case-folded `[a-z]` take non-ASCII; WHATWG percent-encodes it first.
    ("https://zoom.us/j/\u0661\u0662\u0663", None),
    ("https://meet.google.com/abc-defg-hi\u212a", None),
    # Agreed: WHATWG strips surrounding spaces and newlines, drops the default port.
    ("  https://zoom.us/j/1234567890  ", "zoom"),
    ("https://zoom.us/j/1234567890\n", "zoom"),
    ("https://meet.google.com:443/abc-defg-hij", "google_meet"),
    ("https://zoom.us:8443/j/1234567890", "zoom"),
    ("HTTPS://ZOOM.US/j/1234567890", "zoom"),
    ("https://@meet.google.com/abc-defg-hij", "google_meet"),
    # Stricter here (the desktop accepts): WHATWG resolves `/./`, percent-decodes the host and
    # takes a scheme with no slashes. Refusing only hides the Join button for that link.
    ("https://meet.google.com/./abc-defg-hij", None),
    ("https://meet%2Egoogle.com/abc-defg-hij", None),
    ("https:meet.google.com/abc-defg-hij", None),
]


@pytest.mark.parametrize(("url", "expected"), JOIN_LINK_CASES)
def test_parse_join_link(url: str, expected: JoinLinkProvider | None) -> None:
    link = parse_join_link(url)
    assert (link.provider if link else None) == expected


@pytest.mark.parametrize(("url", "expected"), PARSER_EDGE_CASES)
def test_parse_join_link_never_looser_than_the_desktop(
    url: str, expected: JoinLinkProvider | None
) -> None:
    link = parse_join_link(url)
    assert (link.provider if link else None) == expected


def test_returns_the_parsed_href() -> None:
    # The desktop opens the href it parsed; this side returns the same spelling for the same link.
    assert parse_join_link("https://MEET.google.com/abc-defg-hij") == JoinLink(
        provider="google_meet", url="https://meet.google.com/abc-defg-hij"
    )
    assert parse_join_link("  https://zoom.us:443/j/1234567890?pwd=x#y ") == JoinLink(
        provider="zoom", url="https://zoom.us/j/1234567890?pwd=x#y"
    )
    assert parse_join_link("https://zoom.us:8443/j/1") == JoinLink(
        provider="zoom", url="https://zoom.us:8443/j/1"
    )


# One row of `JOIN_LINK_CASES` in the TypeScript file: ['<url>', 'provider'] or ['<url>', null].
_TS_ROW = re.compile(r"\[\s*'((?:[^'\\]|\\.)*)',\s*(?:'(\w+)'|null)\s*,?\s*\]")


def _desktop_table() -> list[tuple[str, str | None]]:
    source = DESKTOP_TABLE.read_text(encoding="utf-8")
    start = source.index("const JOIN_LINK_CASES")
    block = source[start : source.index("];", start)]
    return [(url, provider or None) for url, provider in _TS_ROW.findall(block)]


def test_table_matches_the_desktop() -> None:
    desktop = _desktop_table()
    assert len(desktop) > 30, "the desktop table was not found or not parsed"
    assert desktop == JOIN_LINK_CASES


def test_find_join_link_takes_the_first_allowlisted_link() -> None:
    text = "Agenda: https://docs.example.com/x then https://zoom.us/j/111 or https://zoom.us/j/222"
    assert find_join_link(text) == JoinLink(provider="zoom", url="https://zoom.us/j/111")


def test_find_join_link_skips_a_lookalike_host() -> None:
    text = (
        "Join https://meet.google.com.evil.io/abc-defg-hij"
        " (backup: https://meet.google.com/abc-defg-hij)"
    )
    assert find_join_link(text) == JoinLink(
        provider="google_meet", url="https://meet.google.com/abc-defg-hij"
    )


def test_find_join_link_finds_nothing_without_an_allowlisted_link() -> None:
    assert find_join_link("Join https://meet.google.com.evil.io/abc-defg-hij") is None
    assert find_join_link("Room 4B, no link") is None
    assert find_join_link("") is None


@pytest.mark.parametrize(
    "text",
    [
        "Zoom: https://zoom.us/j/1234567890.",
        "(https://zoom.us/j/1234567890)",
        "<https://zoom.us/j/1234567890>",
        "**https://zoom.us/j/1234567890**",
        "Link: https://zoom.us/j/1234567890, see you there!",
        "\u00a0https://zoom.us/j/1234567890\u00a0",
    ],
)
def test_find_join_link_leaves_surrounding_punctuation_out(text: str) -> None:
    assert find_join_link(text) == JoinLink(provider="zoom", url="https://zoom.us/j/1234567890")


def test_find_join_link_reads_an_html_description() -> None:
    # Google returns descriptions written in its editor as HTML, with `&amp;` in the hrefs.
    html = (
        "Microsoft Teams meeting<br><b>Join on your computer</b><br>"
        '<a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0'
        '?context=%7b%7d&amp;btype=a">Click here to join the meeting</a>'
    )
    assert find_join_link(html) == JoinLink(
        provider="teams",
        url="https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"
        "?context=%7b%7d&btype=a",
    )


@pytest.mark.parametrize(
    "url",
    [
        # A query parameter whose name starts with a legacy HTML entity name (`reg`, `not`,
        # `para`, `times`, `amp`): Python's `html.unescape` decodes those even with no `;`.
        "https://us02web.zoom.us/j/123?pwd=abc&region=us",
        "https://zoom.us/j/1?pwd=x&notify=1",
        "https://teams.microsoft.com/meet/123?p=a&param=1",
        "https://zoom.us/j/1?pwd=x&times=1",
        "https://zoom.us/j/1?pwd=x&amp=1",
        # A decoded `<` would end the link and drop the password after it.
        "https://zoom.us/j/1?uname=a&lt=2&pwd=abc",
        # Not an entity: a legacy name followed by more letters and `;` stays as typed.
        "https://zoom.us/j/1?pwd=x&region;=1",
    ],
)
def test_find_join_link_keeps_a_plain_text_query_as_typed(url: str) -> None:
    # A location is plain text; so are descriptions written by the Zoom add-in or an API.
    link = find_join_link(f"Zoom: {url} ")

    assert link is not None
    assert link.url == url


def test_find_join_link_decodes_an_html_entity_once() -> None:
    # `&amp;region` in an href is `&region`; decoding twice would turn `&reg` into a sign.
    text = '<a href="https://zoom.us/j/1?pwd=x&amp;region=us&#38;a=1">Join</a>'
    assert find_join_link(text) == JoinLink(
        provider="zoom", url="https://zoom.us/j/1?pwd=x&region=us&a=1"
    )
