"""Tests for the coordinate JSON schema (src/worca/schemas/coordinate.json)."""
import json
import os

import jsonschema
import pytest

import worca

SCHEMA_PATH = os.path.join(
    os.path.dirname(worca.__file__), "schemas", "coordinate.json",
)


@pytest.fixture
def schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def _minimal_doc():
    return {
        "beads_ids": ["beads-abc", "beads-def"],
        "dependency_graph": {"beads-def": ["beads-abc"]},
    }


class TestEffortPropertyExists:
    def test_effort_absent_is_valid(self, schema):
        doc = _minimal_doc()
        jsonschema.validate(doc, schema)

    def test_effort_empty_object_is_valid(self, schema):
        doc = _minimal_doc()
        doc["effort"] = {}
        jsonschema.validate(doc, schema)

    def test_effort_with_valid_levels(self, schema):
        doc = _minimal_doc()
        doc["effort"] = {
            "beads-abc": "low",
            "beads-def": "high",
        }
        jsonschema.validate(doc, schema)


class TestEffortEnumValues:
    VALID_LEVELS = ["low", "medium", "high", "xhigh", "max"]

    @pytest.mark.parametrize("level", VALID_LEVELS)
    def test_valid_effort_level(self, schema, level):
        doc = _minimal_doc()
        doc["effort"] = {"beads-abc": level}
        jsonschema.validate(doc, schema)

    def test_invalid_effort_level_rejected(self, schema):
        doc = _minimal_doc()
        doc["effort"] = {"beads-abc": "ultra"}
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_numeric_effort_level_rejected(self, schema):
        doc = _minimal_doc()
        doc["effort"] = {"beads-abc": 3}
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_null_effort_level_rejected(self, schema):
        doc = _minimal_doc()
        doc["effort"] = {"beads-abc": None}
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)


class TestEffortMapStructure:
    def test_effort_must_be_object(self, schema):
        doc = _minimal_doc()
        doc["effort"] = ["low", "high"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_effort_string_rejected(self, schema):
        doc = _minimal_doc()
        doc["effort"] = "high"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_multiple_beads_with_different_levels(self, schema):
        doc = _minimal_doc()
        doc["effort"] = {
            "beads-abc": "low",
            "beads-def": "max",
        }
        jsonschema.validate(doc, schema)
