"""Tests for the pr.json schema — commit_sha required when outcome == success."""
import json
import os

import jsonschema
import pytest

import worca

SCHEMA_PATH = os.path.join(os.path.dirname(worca.__file__), "schemas", "pr.json")


@pytest.fixture
def schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def _success_doc():
    return {
        "outcome": "success",
        "pr_number": 42,
        "pr_url": "https://github.com/org/repo/pull/42",
        "commit_sha": "abc1234",
    }


def _reject_doc():
    return {
        "outcome": "reject",
        "pr_number": 0,
        "pr_url": "https://github.com/org/repo/pull/0",
    }


class TestSchemaStructure:
    def test_schema_file_exists(self):
        assert os.path.isfile(SCHEMA_PATH)

    def test_schema_is_valid_json(self, schema):
        assert isinstance(schema, dict)

    def test_schema_has_commit_sha_property(self, schema):
        assert "commit_sha" in schema["properties"]

    def test_commit_sha_is_string(self, schema):
        assert schema["properties"]["commit_sha"]["type"] == "string"

    def test_commit_sha_min_length_7(self, schema):
        assert schema["properties"]["commit_sha"]["minLength"] == 7


class TestSuccessOutcome:
    def test_success_with_commit_sha_valid(self, schema):
        jsonschema.validate(_success_doc(), schema)

    def test_success_missing_commit_sha_invalid(self, schema):
        doc = _success_doc()
        del doc["commit_sha"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_success_commit_sha_too_short_invalid(self, schema):
        doc = _success_doc()
        doc["commit_sha"] = "abc123"  # 6 chars — below minLength 7
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_success_commit_sha_exactly_7_chars_valid(self, schema):
        doc = _success_doc()
        doc["commit_sha"] = "abc1234"
        jsonschema.validate(doc, schema)

    def test_success_commit_sha_full_40_chars_valid(self, schema):
        doc = _success_doc()
        doc["commit_sha"] = "a" * 40
        jsonschema.validate(doc, schema)


class TestRejectOutcome:
    def test_reject_without_commit_sha_valid(self, schema):
        jsonschema.validate(_reject_doc(), schema)

    def test_reject_with_commit_sha_valid(self, schema):
        doc = _reject_doc()
        doc["commit_sha"] = "abc1234"
        jsonschema.validate(doc, schema)
