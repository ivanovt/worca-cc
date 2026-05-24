"""Tests for the implement JSON schema (src/worca/schemas/implement.json)."""
import json
import os

import jsonschema
import pytest

import worca

SCHEMA_PATH = os.path.join(
    os.path.dirname(worca.__file__), "schemas", "implement.json",
)


@pytest.fixture
def schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def _minimal_doc():
    return {
        "bead_id": "beads-abc",
        "files_changed": ["src/foo.py"],
    }


def test_implement_schema_allows_missing_design_notes(schema):
    doc = _minimal_doc()
    assert "design_notes" not in doc
    jsonschema.validate(doc, schema)


def test_implement_schema_rejects_overlong_design_notes(schema):
    doc = _minimal_doc()
    doc["design_notes"] = "x" * 401
    with pytest.raises(jsonschema.ValidationError, match="maxLength"):
        jsonschema.validate(doc, schema)


def test_implement_schema_accepts_valid_design_notes(schema):
    doc = _minimal_doc()
    doc["design_notes"] = "Use snake_case for all helper functions in this module."
    jsonschema.validate(doc, schema)
