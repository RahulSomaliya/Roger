import pytest

from roger_api.services.notes_protocol import (
    MAX_REFS_PER_LINE,
    Bullet,
    Heading,
    LineProtocolParser,
    ProtocolLine,
    Ref,
    parse_line,
    split_refs,
)

MODEL_OUTPUT = (
    "## Decisions\n"
    "- Beta ships Friday [L12, L15]\n"
    "- Pricing stays at $50k [N2]\r\n"
    "\n"
    "## Action items\n"
    "- Them: send the deck by Monday [L40-L42]\n"
    "- Me: book the follow-up [L44]"
)

EXPECTED = [
    Heading("Decisions"),
    Bullet("Beta ships Friday", (Ref("L", 12), Ref("L", 15))),
    Bullet("Pricing stays at $50k", (Ref("N", 2),)),
    Heading("Action items"),
    Bullet("Them: send the deck by Monday", (Ref("L", 40), Ref("L", 41), Ref("L", 42))),
    Bullet("Me: book the follow-up", (Ref("L", 44),)),
]


def parse_in_chunks(chunks: list[str]) -> list[ProtocolLine]:
    parser = LineProtocolParser()
    lines = [line for chunk in chunks for line in parser.feed(chunk)]
    return [*lines, *parser.finish()]


def bullet(text: str) -> Bullet:
    parsed = parse_line(text)
    assert isinstance(parsed, Bullet), parsed
    return parsed


def test_same_items_for_any_chunk_split() -> None:
    assert parse_in_chunks([MODEL_OUTPUT]) == EXPECTED
    assert parse_in_chunks(list(MODEL_OUTPUT)) == EXPECTED
    for cut in range(len(MODEL_OUTPUT) + 1):
        assert parse_in_chunks([MODEL_OUTPUT[:cut], MODEL_OUTPUT[cut:]]) == EXPECTED, cut
    for first in range(0, len(MODEL_OUTPUT), 7):
        for second in range(first, len(MODEL_OUTPUT), 11):
            chunks = [MODEL_OUTPUT[:first], MODEL_OUTPUT[first:second], MODEL_OUTPUT[second:]]
            assert parse_in_chunks(chunks) == EXPECTED, (first, second)


def test_a_finished_line_is_returned_as_soon_as_its_newline_arrives() -> None:
    parser = LineProtocolParser()

    assert parser.feed("## Decisions\n- Beta ships") == [Heading("Decisions")]
    assert parser.feed(" Friday [L12]") == []
    assert parser.feed("\n") == [Bullet("Beta ships Friday", (Ref("L", 12),))]
    assert parser.finish() == []


def test_preamble_and_code_fences_are_ignored() -> None:
    output = (
        "Here are your meeting notes:\n"
        "```markdown\n"
        "## Decisions\n"
        "- Beta ships Friday [L12]\n"
        "```\n"
        "Let me know if you want any changes!"
    )

    assert parse_in_chunks([output]) == [
        Heading("Decisions"),
        Bullet("Beta ships Friday", (Ref("L", 12),)),
    ]


def test_ranges_expand_and_are_capped() -> None:
    assert bullet("- Scope agreed [L12-L15]").refs == tuple(Ref("L", n) for n in range(12, 16))
    # The forms models write besides the asked-for one: a bare end, an en dash, a reversed range.
    assert bullet("- Scope agreed [L12-15]").refs == tuple(Ref("L", n) for n in range(12, 16))
    assert bullet("- Scope agreed [L12\u2013L13]").refs == (Ref("L", 12), Ref("L", 13))
    assert bullet("- Scope agreed [L15-L14]").refs == (Ref("L", 14), Ref("L", 15))
    # Repeats count once, in first-seen order.
    assert bullet("- Scope agreed [L13, L12-L14, N1, L13]").refs == (
        Ref("L", 13),
        Ref("L", 12),
        Ref("L", 14),
        Ref("N", 1),
    )
    # A huge range is cut at the cap without being built in full.
    capped = bullet("- Everything [L1-L999999]").refs
    assert capped == tuple(Ref("L", n) for n in range(1, MAX_REFS_PER_LINE + 1))
    assert len(bullet("- Many [L1, L2, L3, L4, L5, L6, L7, L8, L9, N1]").refs) == MAX_REFS_PER_LINE


def test_headings_keep_their_text() -> None:
    assert parse_line("## Next steps") == Heading("Next steps")
    assert parse_line("### Risks and blockers  ") == Heading("Risks and blockers")
    assert parse_line("# Summary") == Heading("Summary")
    assert parse_line("##NoSpace") is None


@pytest.mark.parametrize(
    "line",
    [
        "- Beta ships Friday [L12]",
        "* Beta ships Friday [L12]",
        "+ Beta ships Friday [L12]",
        "• Beta ships Friday [L12]",
        "1. Beta ships Friday [L12]",
        "2) Beta ships Friday [L12]",
        "   - Beta ships Friday [L12]",
        "- [ ] Beta ships Friday [L12]",
        "- [x] Beta ships Friday [L12]",
        "Beta ships Friday [L12]",
        "- Beta ships Friday [l12]",
        "- Beta ships Friday. [L12]",
        "- Beta ships Friday **[L12]**",
        "- **Beta ships Friday** [L12]",
        "- *Beta* ships _Friday_ [L12]",
    ],
)
def test_bullet_forms_parse_to_the_same_item(line: str) -> None:
    parsed = bullet(line)

    assert parsed.text.rstrip(".") == "Beta ships Friday"
    assert parsed.refs == (Ref("L", 12),)


def test_every_ref_group_is_taken_out_of_the_text() -> None:
    parsed = bullet("- Beta ships Friday [L12]; pricing at $50k [L15, N2].")

    assert parsed.text == "Beta ships Friday; pricing at $50k."
    assert parsed.refs == (Ref("L", 12), Ref("L", 15), Ref("N", 2))


def test_brackets_that_are_not_refs_stay_in_the_text() -> None:
    parsed = bullet("- Rename the [TBD] field before v2 [sic] [L3]")

    assert parsed.text == "Rename the [TBD] field before v2 [sic]"
    assert parsed.refs == (Ref("L", 3),)
    assert bullet("- Follow up on [L3, see above]").refs == ()


def test_emphasis_marks_are_taken_out_of_the_text() -> None:
    # The AI doc is built from plain text nodes: a mark left here shows as literal asterisks, and a
    # bolded heading would not equal the template heading it names.
    assert parse_line("- **Them:** send the deck by **Monday** [L3]") == Bullet(
        "Them: send the deck by Monday", (Ref("L", 3),)
    )
    assert bullet("- ***Me:*** book the _follow-up_ by __Friday__ [L4]").text == (
        "Me: book the follow-up by Friday"
    )
    assert bullet("- **Send the _deck_ today** [L4]").text == "Send the deck today"
    assert bullet("- **Beta ships Friday [L12]**").refs == (Ref("L", 12),)
    assert parse_line("## **Action items**") == Heading("Action items")
    assert parse_line("### *Risks* [L2]") == Heading("Risks")


def test_a_wholly_bold_line_is_a_heading() -> None:
    assert parse_line("**Action items**") == Heading("Action items")
    assert parse_line("__Action items__") == Heading("Action items")
    # With refs it is a bullet whose dash the model forgot.
    assert parse_line("**Beta ships Friday** [L12]") == Bullet("Beta ships Friday", (Ref("L", 12),))
    # Bold inside a line with no refs is still a preamble.
    assert parse_line("Here are your **notes**:") is None


def test_marks_that_are_not_emphasis_stay_in_the_text() -> None:
    assert bullet("- Rename user_id to account_id [L3]").text == "Rename user_id to account_id"
    assert bullet("- Fix the `__init__` and `*args` handling [L3]").text == (
        "Fix the `__init__` and `*args` handling"
    )
    assert bullet("- Size is 2 * 3 * 5, or 2*3*5 [L3]").text == "Size is 2 * 3 * 5, or 2*3*5"


def test_a_bullet_with_no_refs_parses_with_none() -> None:
    assert parse_line("- Beta ships Friday") == Bullet("Beta ships Friday", ())


def test_lines_with_nothing_to_show_are_skipped() -> None:
    assert parse_line("") is None
    assert parse_line("   ") is None
    assert parse_line("-") is None
    assert parse_line("- [L12]") is None
    assert parse_line("~~~") is None


def test_text_whitespace_is_collapsed() -> None:
    assert bullet("-   Beta \t ships   Friday   [ L12 ,  L15 ]").text == "Beta ships Friday"


def test_split_refs_reads_refs_anywhere_in_a_text() -> None:
    assert split_refs("The beta ships Friday [L12] and costs $50k [L15].") == (
        "The beta ships Friday and costs $50k.",
        (Ref("L", 12), Ref("L", 15)),
    )
    assert split_refs("Nothing cited here.") == ("Nothing cited here.", ())


def test_refs_print_as_written_in_the_prompt() -> None:
    assert str(Ref("L", 12)) == "L12"
    assert str(Ref("N", 3)) == "N3"
