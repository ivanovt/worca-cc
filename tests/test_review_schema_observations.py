"""Tests for observations array in review.json schema."""
import json
import os

import jsonschema
import pytest

import worca

SCHEMA_PATH = os.path.join(os.path.dirname(worca.__file__), "schemas", "review.json")


@pytest.fixture
def schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def test_review_schema_accepts_observations(schema):
    doc = {
        "outcome": "approve",
        "observations": [
            {"file": "src/foo.py", "line": 10, "severity": "minor", "description": "Note something"},
        ],
    }
    jsonschema.validate(doc, schema)


def test_review_schema_observations_optional(schema):
    doc = {"outcome": "approve"}
    jsonschema.validate(doc, schema)
