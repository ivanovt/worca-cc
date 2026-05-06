"""Schema-alignment tests for the guardian agent template.

Rather than asserting individual strings are present in guardian.md (which
breaks on every reword), we extract the JSON example block from the template
and validate it against pr.json. This catches real drift (missing required
field, wrong enum, type mismatch) and ignores prose changes.
"""

import json
import re
from pathlib import Path

import jsonschema
import pytest

REPO_ROOT = Path(__file__).parent.parent
GUARDIAN_PATH = REPO_ROOT / "src" / "worca" / "agents" / "core" / "guardian.md"
SCHEMA_PATH = REPO_ROOT / "src" / "worca" / "schemas" / "pr.json"


@pytest.fixture
def guardian_md() -> str:
    return GUARDIAN_PATH.read_text()


@pytest.fixture
def pr_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def _extract_json_blocks(md: str) -> list:
    """Pull all fenced JSON-object blocks out of guardian.md."""
    blocks = []
    for match in re.finditer(r"```\s*\n(\{.*?\})\s*\n```", md, re.DOTALL):
        try:
            blocks.append(json.loads(match.group(1)))
        except json.JSONDecodeError:
            continue
    return blocks


def test_guardian_md_exists(guardian_md):
    assert guardian_md.strip(), "guardian.md must not be empty"


def test_guardian_md_contains_at_least_one_json_example(guardian_md):
    blocks = _extract_json_blocks(guardian_md)
    assert blocks, "guardian.md must contain at least one fenced JSON example"


def test_guardian_json_example_validates_against_schema(guardian_md, pr_schema):
    """The example output in guardian.md must validate against pr.json.

    This is the only test that catches drift between the schema and the
    documented example, and it survives prompt rewordings.
    """
    blocks = _extract_json_blocks(guardian_md)
    for block in blocks:
        jsonschema.validate(block, pr_schema)


def test_guardian_json_example_has_outcome_success(guardian_md):
    """The primary example should show a successful PR (the happy path)."""
    blocks = _extract_json_blocks(guardian_md)
    assert any(b.get("outcome") == "success" for b in blocks), (
        "guardian.md should include at least one outcome=success example"
    )
