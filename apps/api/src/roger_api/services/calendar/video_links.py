"""The video-call host allowlist: the only links `normalize.py` returns as an event's `video_link`.

The allowlist exists twice: here and in the desktop's `apps/desktop/src/shared/meetingLinks.ts`,
which re-checks a link before "Join and take notes" opens it. Change both in the same commit and
keep the URL table in tests/test_calendar_video_links.py equal to the desktop's
`meetingLinks.test.ts` (a test there compares them). A host this side accepts and the desktop
refuses shows a Join button that opens nothing; the reverse hides Join for a real call.

The desktop parses with the WHATWG URL parser and this side with `urllib.parse`. They agree on every
row of the table. On odd input they can differ, so this side is the stricter one, and a link it
returns is one the desktop accepts too:
- `urlsplit` takes any text before the port as the host name, where WHATWG percent-decodes it,
  treats `\\` as a path separator and refuses forbidden characters. A host here is ASCII letters,
  digits, dots and hyphens only, with no `xn--` label (WHATWG refuses invalid punycode), and its
  port must be a number in range. Without that, `https://evil.io\\.zoom.us/j/1` passes the Zoom
  rule here and the desktop opens nothing.
- Python's `\\d`, `\\w` and case-folded `[a-z]` match non-ASCII characters, which WHATWG
  percent-encodes before the desktop's patterns see them: every pattern is `re.ASCII`.
- WHATWG resolves `/./`, decodes `%2E` in a host and takes `https:host` with no slashes; this side
  refuses those, which only hides the Join button for such a link.
"""

import html
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from html.entities import html5
from typing import Literal
from urllib.parse import urlsplit

type JoinLinkProvider = Literal["google_meet", "zoom", "teams"]


@dataclass(frozen=True, slots=True)
class JoinLink:
    provider: JoinLinkProvider
    # The parsed link, lower-case host and no default port: the spelling the desktop opens.
    url: str


@dataclass(frozen=True, slots=True)
class _JoinLinkRule:
    provider: JoinLinkProvider
    host: Callable[[str], bool]
    # Path patterns of a meeting, each matched against the whole path. A bare host or a sign-in
    # page is not one.
    paths: tuple[re.Pattern[str], ...]


_RULES: tuple[_JoinLinkRule, ...] = (
    _JoinLinkRule(
        provider="google_meet",
        host=lambda hostname: hostname == "meet.google.com",
        # Only a meeting code: `/new` on the same host would start a fresh meeting, not join one.
        paths=(re.compile(r"/[a-z]{3}-[a-z]{4}-[a-z]{3}", re.ASCII | re.IGNORECASE),),
    ),
    _JoinLinkRule(
        provider="zoom",
        # Company and regional subdomains (`us02web.zoom.us`); the leading dot keeps `evilzoom.us`
        # out.
        host=lambda hostname: hostname == "zoom.us" or hostname.endswith(".zoom.us"),
        # A meeting (`/j/`), a personal room (`/my/`) or a webinar a registrant joins (`/w/`, with
        # its `tk` token in the query). Not `/s/`: that link starts the meeting as its host.
        paths=(re.compile(r"/[jw]/\d+/?", re.ASCII), re.compile(r"/my/[\w.-]+/?", re.ASCII)),
    ),
    _JoinLinkRule(
        provider="teams",
        host=lambda hostname: hostname in ("teams.microsoft.com", "teams.live.com"),
        # DOTALL: the desktop's `.+` sees a path WHATWG already percent-encoded, so any character
        # counts there.
        paths=(
            re.compile(r"/l/meetup-join/.+", re.ASCII | re.DOTALL),
            re.compile(r"/meet/\d+/?", re.ASCII),
        ),
    ),
)

# WHATWG strips these from both ends of a URL before parsing ("C0 control or space").
_C0_CONTROL_OR_SPACE = "".join(chr(code) for code in range(0x21))
_HOST_NAME = re.compile(r"[a-z0-9.-]+", re.ASCII)
_HTTPS_DEFAULT_PORT = 443

# Non-ASCII punctuation (Unicode category P): curly quotes, guillemets, dashes, CJK and fullwidth
# marks. A link a machine writes percent-encodes it; pasted or autocorrected text glues it on, and
# one glued closing quote failed the whole-path match (no Join button) or landed in the query the
# desktop opens. The Basic Multilingual Plane holds every one a person types (built in ~5 ms).
_NON_ASCII_PUNCTUATION = "".join(
    char for char in map(chr, range(0x80, 0x10000)) if unicodedata.category(char).startswith("P")
)
# A link in free text ends at whitespace, a quote or an angle bracket (HTML attributes, `<url>`),
# or any non-ASCII punctuation.
_URL_IN_TEXT = re.compile(
    rf"https?://[^\s<>\"'`{re.escape(_NON_ASCII_PUNCTUATION)}]+", re.IGNORECASE
)
# Sentence punctuation and closing brackets after a link are not part of it.
_TRAILING_PUNCTUATION = ".,;:!?)]}*"
# A character reference that ends in `;`: a name, a decimal or a hex number.
_CHARACTER_REFERENCE = re.compile(r"&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);")


def parse_join_link(raw: str) -> JoinLink | None:
    """The provider and link of a meeting on an allowlisted host, or None for anything else."""
    try:
        parts = urlsplit(raw.strip(_C0_CONTROL_OR_SPACE))
        port = parts.port
    except ValueError:
        return None  # Not a URL (a bad IPv6 literal, a port that is not a number in range).
    hostname = parts.hostname
    # Credentials in a link push the real host out of sight (`https://meet.google.com@evil.io/`
    # is evil.io, and the reverse hides an allowed host behind a name); no join link has any.
    if parts.scheme != "https" or parts.username or parts.password or not hostname:
        return None
    if not _HOST_NAME.fullmatch(hostname) or any(
        label.startswith("xn--") for label in hostname.split(".")
    ):
        return None
    rule = next((candidate for candidate in _RULES if candidate.host(hostname)), None)
    if rule is None or not any(path.fullmatch(parts.path) for path in rule.paths):
        return None
    netloc = hostname if port in (None, _HTTPS_DEFAULT_PORT) else f"{hostname}:{port}"
    url = f"https://{netloc}{parts.path}"
    if parts.query:
        url += f"?{parts.query}"
    if parts.fragment:
        url += f"#{parts.fragment}"
    return JoinLink(provider=rule.provider, url=url)


def find_join_link(text: str) -> JoinLink | None:
    """The first allowlisted join link in free text: an event's location or description.

    Descriptions written in Google's editor are HTML, so character references are decoded first:
    an href's `&amp;` would otherwise stay in the link the desktop opens.
    """
    for match in _URL_IN_TEXT.finditer(_decode_references(text)):
        link = parse_join_link(match.group().rstrip(_TRAILING_PUNCTUATION))
        if link is not None:
            return link
    return None


def _decode_references(text: str) -> str:
    """`text` with each complete character reference (`&amp;`, `&#38;`) decoded, once.

    Not `html.unescape`: it also decodes legacy names with no `;`, and a location or a plain-text
    description holds raw queries. `&region=us` came back as a registered sign and `ion=us`, and
    `&lt=2` as `<=2`, which ends the link before the password that follows. A browser leaves both
    alone inside an href.
    """

    def decode(match: re.Match[str]) -> str:
        reference = match.group()
        if reference.startswith("&#"):
            return html.unescape(reference)
        # The name in full or nothing: `html.unescape("&region;")` is a decoded `&reg` + "ion;".
        return html5.get(reference[1:], reference)

    return _CHARACTER_REFERENCE.sub(decode, text)
