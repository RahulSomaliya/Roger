"""Note templates as data (M4-T3): JSON files in the API package, validated when the API starts,
listed by `GET /v1/note-templates`."""

import json
import zipfile
from importlib import resources
from pathlib import Path

import httpx
import pytest

from roger_api.note_templates import (
    NoteTemplateError,
    builtin_note_templates,
    find_note_template,
    load_note_templates,
)
from roger_api.schemas.note_templates import NoteTemplate
from roger_api.services.citations import RefMap
from roger_api.services.notes_prompt import build_notes_prompt
from tests.helpers import Json, assert_error

BUILTIN_IDS = {"general", "standup", "client_call", "one_on_one"}


def template_json(**overrides: object) -> Json:
    return {
        "id": "retro",
        "name": "Retro",
        "description": "A sprint retrospective.",
        "sections": [
            {"heading": "Went well", "guidance": "What the team wants to keep doing."},
            {"heading": "To change", "guidance": "What the team wants to do differently."},
        ],
        **overrides,
    }


def write_template(folder: Path, file_name: str, content: Json | str) -> None:
    text = content if isinstance(content, str) else json.dumps(content)
    (folder / file_name).write_text(text, encoding="utf-8")


def test_builtin_templates_load_and_validate() -> None:
    templates = builtin_note_templates()

    assert templates
    for template in templates:
        assert isinstance(template, NoteTemplate)
        assert template.sections
        # The prompt (M4-T5) reads these objects as they are: every heading reaches it in order.
        prompt = build_notes_prompt(template, RefMap(lines=(), note_blocks=()))
        positions = [
            prompt.user.index(f"\n## {section.heading}\n") for section in template.sections
        ]
        assert positions == sorted(positions)
    assert [template.name for template in templates] == sorted(
        (template.name for template in templates), key=str.casefold
    )


def test_the_four_templates_exist_with_unique_ids() -> None:
    ids = [template.id for template in builtin_note_templates()]

    assert set(ids) == BUILTIN_IDS
    assert len(ids) == len(set(ids))
    for template_id in BUILTIN_IDS:
        found = find_note_template(template_id)
        assert found is not None
        assert found.id == template_id
    assert find_note_template("retro") is None


def test_templates_load_through_importlib_resources(tmp_path: Path) -> None:
    # The JSON files are package data, read through importlib.resources and never through a path
    # built from __file__, so they load from an installed wheel or a zip as from the source tree.
    package = resources.files("roger_api.note_templates")
    names = sorted(entry.name for entry in package.iterdir() if entry.name.endswith(".json"))
    assert names == sorted(f"{template_id}.json" for template_id in BUILTIN_IDS)

    archive = tmp_path / "roger_api.zip"
    with zipfile.ZipFile(archive, "w") as writer:
        for name in names:
            writer.writestr(f"note_templates/{name}", package.joinpath(name).read_bytes())
    with zipfile.ZipFile(archive) as reader:
        from_zip = load_note_templates(zipfile.Path(reader, "note_templates/"))

    assert from_zip == builtin_note_templates()


async def test_templates_route_requires_auth(anonymous_client: httpx.AsyncClient) -> None:
    response = await anonymous_client.get("/v1/note-templates")

    assert_error(response, 401, "unauthorized")
    assert response.headers["WWW-Authenticate"] == "Bearer"


async def test_templates_route_lists_the_builtin_templates(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/note-templates")

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert items == [template.model_dump(mode="json") for template in builtin_note_templates()]
    for item in items:
        assert set(item) == {"id", "name", "description", "sections"}
        for section in item["sections"]:
            assert set(section) == {"heading", "guidance"}


def test_templates_load_from_a_folder_ordered_by_name(tmp_path: Path) -> None:
    write_template(tmp_path, "retro.json", template_json())
    write_template(tmp_path, "demo.json", template_json(id="demo", name="client demo"))
    write_template(tmp_path, "README.md", "Not a template.")
    (tmp_path / "drafts").mkdir()

    templates = load_note_templates(tmp_path)

    assert [template.id for template in templates] == ["demo", "retro"]
    assert templates[1].sections[0].heading == "Went well"


def section(heading: str, guidance: str = "What goes here.") -> Json:
    return {"heading": heading, "guidance": guidance}


@pytest.mark.parametrize(
    ("file_name", "content", "named"),
    [
        pytest.param("retro.json", "{not json", "retro.json", id="not-json"),
        pytest.param(
            "retro.json",
            template_json(sections=[{"heading": "Went well", "guideance": "A typo."}]),
            "guideance",
            id="unknown-key",
        ),
        pytest.param("retro.json", template_json(sections=[]), "sections", id="no-sections"),
        pytest.param("retro.json", template_json(name="  "), "name", id="blank-name"),
        pytest.param(
            "retro.json",
            template_json(sections=[section("Went well", "Keep doing.\n## Forged heading")]),
            "guidance",
            id="line-break-in-guidance",
        ),
        pytest.param(
            "retro.json",
            template_json(sections=[section("Went well"), section("went WELL")]),
            "went WELL",
            id="duplicate-heading",
        ),
        pytest.param(
            "retro.json",
            template_json(sections=[section("**Decisions**")]),
            "**Decisions**",
            id="heading-with-bold-marks",
        ),
        pytest.param(
            "retro.json",
            template_json(sections=[section("Next steps [L1]")]),
            "Next steps [L1]",
            id="heading-with-a-ref-group",
        ),
        pytest.param(
            "retro.json",
            template_json(sections=[section("From Your Notes")]),
            "From Your Notes",
            id="heading-of-the-from-your-notes-list",
        ),
        pytest.param("retro.json", template_json(id="Retro"), "'Retro'", id="id-not-lower-case"),
        pytest.param("retro.json", template_json(id="standup"), "standup", id="id-not-file-name"),
    ],
)
def test_a_broken_template_fails_to_load_naming_its_file(
    tmp_path: Path, file_name: str, content: Json | str, named: str
) -> None:
    write_template(tmp_path, "general.json", template_json(id="general", name="General"))
    write_template(tmp_path, file_name, content)

    with pytest.raises(NoteTemplateError) as raised:
        load_note_templates(tmp_path)

    assert file_name in str(raised.value)
    assert named in str(raised.value)


def test_a_folder_without_templates_fails_to_load(tmp_path: Path) -> None:
    # A wheel built without the JSON files would otherwise start an API with no templates, and
    # every generate would fail on an unknown template id instead of the API failing at startup.
    write_template(tmp_path, "README.md", "Not a template.")

    with pytest.raises(NoteTemplateError, match="No note templates"):
        load_note_templates(tmp_path)
