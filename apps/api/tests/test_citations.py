from uuid import UUID

import pytest

from roger_api.services.citations import (
    Citation,
    CitedLine,
    DroppedLine,
    FromNotesLine,
    RefMap,
    SourceLine,
    check_line,
    check_support,
)
from roger_api.services.notes_protocol import Bullet, Ref


def segment_id(number: int) -> UUID:
    return UUID(f"7f3c2d1e-0000-4000-8000-{number:012d}")


LINES = [
    SourceLine(segment_id(1), 3_000, "me", "Let's talk about the beta launch."),
    SourceLine(segment_id(2), 7_000, "them", "We can ship the beta on Friday."),
    SourceLine(segment_id(3), 12_500, "them", "The budget is fifty thousand dollars for Q3."),
    SourceLine(segment_id(4), 20_000, "me", "Pricing goes up 12% on the 6th."),
    SourceLine(segment_id(5), 31_000, "them", "We need two weeks for the migration."),
]
NOTE_BLOCKS = ["Beta launch date?", "Ask about the 1,200,000 users"]
REFS = RefMap(lines=tuple(LINES), note_blocks=tuple(NOTE_BLOCKS))


def L(number: int) -> Ref:  # noqa: N802 - reads like the ref it builds.
    return Ref("L", number)


def N(number: int) -> Ref:  # noqa: N802 - reads like the ref it builds.
    return Ref("N", number)


def cited(text: str, *refs: Ref) -> CitedLine:
    checked = check_line(Bullet(text, refs), REFS)
    assert isinstance(checked, CitedLine), checked
    return checked


def test_unknown_refs_are_removed() -> None:
    checked = cited("Beta ships Friday", L(2), L(99), N(7), L(0))

    assert [citation.ref for citation in checked.citations] == ["L2"]
    assert checked.note_refs == ()


def test_line_with_no_valid_ref_is_dropped_with_a_reason() -> None:
    assert check_line(Bullet("Beta ships Friday", ()), REFS) == DroppedLine(
        "Beta ships Friday", reason="no_refs"
    )
    assert check_line(Bullet("Beta ships Friday", (L(99), N(9))), REFS) == DroppedLine(
        "Beta ships Friday", reason="unknown_refs"
    )


def test_notes_only_line_goes_to_from_your_notes() -> None:
    checked = check_line(Bullet("Confirm the beta launch date", (N(1), L(99))), REFS)

    assert checked == FromNotesLine("Confirm the beta launch date", note_refs=("N1",))


def test_citations_map_to_segments_in_transcript_order() -> None:
    checked = cited("Beta ships Friday on the fifty thousand budget", L(3), N(1), L(2))

    assert checked.citations == (
        Citation(ref="L2", segment_id=segment_id(2), start_ms=7_000),
        Citation(ref="L3", segment_id=segment_id(3), start_ms=12_500),
    )
    assert checked.note_refs == ("N1",)


def test_number_missing_from_cited_lines_flags_the_line() -> None:
    flagged = cited("Beta ships Friday with an $80k budget", L(2), L(3))
    supported = cited("Beta ships Friday with a $50k budget", L(2), L(3))

    assert flagged.support == "weak"
    assert flagged.check.missing_numbers == ("80000",)
    assert supported.support == "ok"


def test_number_found_only_in_an_uncited_line_still_flags() -> None:
    checked = cited("The migration needs 2 weeks", L(1))

    assert checked.support == "weak"
    assert checked.check.missing_numbers == ("2",)


def test_note_blocks_count_as_sources_for_support() -> None:
    assert cited("Beta ships Friday to 1.2m users", L(2), N(2)).support == "ok"
    assert cited("Beta ships Friday to 1.2m users", L(2)).support == "weak"


def test_a_line_that_shares_no_content_word_with_its_sources_is_weak() -> None:
    checked = cited("Hiring freeze continues", L(2))

    assert checked.support == "weak"
    assert checked.check.missing_numbers == ()
    assert not checked.check.shares_words


def test_spelled_number_supports_digit() -> None:
    assert cited("The migration needs 2 weeks", L(5)).support == "ok"
    assert check_support("Ships in two weeks", ["ships in 2 weeks"]).support == "ok"


def test_50k_matches_50000() -> None:
    assert cited("Q3 budget is $50k", L(3)).support == "ok"
    assert check_support("Budget is 50k", ["budget is $50,000"]).support == "ok"
    assert check_support("Budget is $50,000", ["budget is 50K"]).support == "ok"
    assert check_support("Budget is 50 thousand", ["budget is fifty thousand"]).support == "ok"


def test_thousands_separator_and_percent_match() -> None:
    assert check_support("Ask about 1200000 users", ["about the 1,200,000 users"]).support == "ok"
    assert cited("Pricing goes up 12 percent", L(4)).support == "ok"
    assert check_support("Pricing up twelve percent", ["pricing up 12%"]).support == "ok"
    assert check_support("Pricing up 12%", ["pricing up 13%"]).missing_numbers == ("12",)


def test_q3_is_not_a_bare_number() -> None:
    assert check_support("Budget review in 3 weeks", ["budget for Q3 weeks"]).missing_numbers == (
        "3",
    )
    assert check_support("Q3 budget", ["3 budget items"]).missing_numbers == ("q3",)
    assert check_support("Q3 budget", ["the budget for q3"]).support == "ok"


@pytest.mark.parametrize(
    ("claim", "source", "missing"),
    [
        # Number words, both directions.
        ("Ships in two weeks", "ships in 2 weeks", ()),
        ("Ships in 2 weeks", "ships in two weeks", ()),
        ("Seats: 250", "two hundred and fifty seats", ()),
        ("Seats: 150", "a hundred and fifty seats", ()),
        ("The 101st customer", "a hundred and first customer", ()),
        ("Revenue 1,250,000", "revenue one million two hundred fifty thousand", ()),
        ("Revenue 3500", "revenue of three thousand five hundred", ()),
        ("Rate 2.5", "a rate of two point five", ()),
        ("Teams 2 and 3", "two three teams", ()),
        # Suffixes and scale words.
        ("Raise $1.2m", "raise 1.2 million", ()),
        ("Raise $1.2m", "raise one point two million", ()),
        ("Raise $3bn", "raise three billion", ()),
        ("Raise $3B", "raise three billion", ()),
        ("Raise 1.5k", "raise fifteen hundred", ()),
        ("Raise $1.5m", "raise 1.2 million", ("1500000",)),
        ("Budget is $60k", "budget is fifty thousand", ("60000",)),
        # Halves: "and a half" after number words or digits, "half a" before a scale.
        ("Budget $2.5m", "two and a half million", ()),
        ("Budget $2.5m", "2 and a half million", ()),
        ("Raise $1.5m", "a million and a half", ()),
        ("Demo 1.5 hours", "one and a half hours", ()),
        ("Budget $2m", "two and a half million", ("2000000",)),
        ("Budget $500k", "half a million", ()),
        ("Budget $1m", "half a million", ("1000000",)),
        # Separators, currency and percent.
        ("Budget €50,000", "budget fifty thousand euros", ()),
        ("Budget \uff15\uff10k", "budget fifty thousand", ()),  # Full-width digits.
        ("Up 12%", "up twelve percent", ()),
        # Ordinals and times.
        ("Launch on the 6th", "launch on the sixth", ()),
        ("Launch on the 6th", "launch on day 6", ()),
        ("Launch on October 21st", "October twenty first", ()),
        ("Call at 3pm", "call at three", ()),
        ("Call at 10:30", "call at ten thirty", ()),
        # A time on the hour leaves no bare 0; other minutes still count.
        ("Sync at 9:00", "sync at nine", ()),
        ("Sync at 9:00", "sync at 9", ()),
        ("Call at 3:00pm", "call at 3pm", ()),
        ("Call at 3pm", "call at 3:00 pm", ()),
        ("Call at 10:30", "call at 10", ("30",)),
        # Letters and digits together compare whole.
        ("Plan for Q3", "plan for q3", ()),
        ("Plan for Q3", "plan for quarter 3", ("q3",)),
        ("Ship v2 in 2 weeks", "ship v2 in two weeks", ()),
        ("Ship v2", "ship version 2", ("v2",)),
        # "one", "first", "second" and "third" alone are as often words as numbers: never
        # required...
        ("One open question on pricing", "the open question is pricing", ()),
        ("First release ships Friday", "release ships Friday", ()),
        ("Use a third-party vendor", "we will use an outside vendor", ()),
        # ...but they still back a digit in the line.
        ("Next 1:1 on Friday", "our next one on one is Friday", ()),
        ("Launch on the 3rd", "launch on the third", ()),
        ("Two options on pricing", "pricing options", ("2",)),
    ],
)
def test_number_rules(claim: str, source: str, missing: tuple[str, ...]) -> None:
    assert check_support(claim, [source]).missing_numbers == missing


@pytest.mark.parametrize(
    ("claim", "source", "shares"),
    [
        ("Beta ships Friday", "we ship the beta on friday", True),
        ("Pricing was agreed", "they agreed on the price", True),
        ("Releases planned", "we plan to release", True),
        ("Status updates", "the status update", True),
        ("Sam's deck is ready", "Sam has the deck", True),
        ("Hiring freeze continues", "we ship the beta on friday", False),
        ("We will do it", "nothing in common here", True),  # No content word to compare.
        ("Them: they'll do it", "nothing in common here", True),
        ("Them: they\u2019ll do it", "nothing in common here", True),  # A curly apostrophe.
    ],
)
def test_word_rules(claim: str, source: str, shares: bool) -> None:
    assert check_support(claim, [source]).shares_words is shares


def test_ref_map_resolves_lines_and_note_blocks() -> None:
    assert REFS.has(L(1))
    assert REFS.has(L(5))
    assert not REFS.has(L(6))
    assert not REFS.has(L(0))
    assert REFS.has(N(2))
    assert not REFS.has(N(3))
    assert REFS.text(L(2)) == "We can ship the beta on Friday."
    assert REFS.text(N(1)) == "Beta launch date?"
    assert REFS.citation(L(4)) == Citation(ref="L4", segment_id=segment_id(4), start_ms=20_000)


def test_ref_map_refuses_refs_it_does_not_hold() -> None:
    with pytest.raises(LookupError, match="L6"):
        REFS.text(L(6))
    with pytest.raises(LookupError, match="N1"):
        REFS.citation(N(1))


def test_ref_map_json_maps_each_line_ref_to_its_segment() -> None:
    assert REFS.to_json() == {f"L{n}": str(segment_id(n)) for n in range(1, 6)}
