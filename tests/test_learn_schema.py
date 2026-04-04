"""Tests for the LearnOutput JSON schema (.claude/worca/schemas/learn.json)."""
import json
import os

import jsonschema
import pytest

import worca
SCHEMA_PATH = os.path.join(
    os.path.dirname(worca.__file__), "schemas", "learn.json",
)


@pytest.fixture
def schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def _valid_learn_output():
    """Return a minimal valid LearnOutput document."""
    return {
        "observations": [
            {
                "category": "test_loop",
                "importance": "high",
                "description": "Tests failed 3 times on import errors",
                "evidence": "iterations 2-4 all had ModuleNotFoundError",
                "occurrences": 3,
            }
        ],
        "suggestions": [
            {
                "target": "config:loops",
                "description": "Increase test-fix loop limit",
                "rationale": "Loop exhausted before root cause addressed",
                "based_on_observations": [0],
            }
        ],
        "recurring_patterns": {
            "cross_bead": [],
            "test_fix_loops": [
                {
                    "pattern": "import errors",
                    "loop_iterations": 3,
                    "resolved": True,
                }
            ],
            "review_fix_loops": [],
        },
        "run_summary": {
            "termination": "success",
            "total_iterations": 5,
            "test_fix_loops": 1,
            "review_fix_loops": 0,
            "plan_restarts": 0,
        },
    }


class TestSchemaFileExists:
    def test_schema_file_exists(self):
        assert os.path.isfile(SCHEMA_PATH), f"Schema file not found at {SCHEMA_PATH}"

    def test_schema_is_valid_json(self, schema):
        assert isinstance(schema, dict)

    def test_schema_has_draft07_meta(self, schema):
        assert schema.get("$schema") == "http://json-schema.org/draft-07/schema#"

    def test_schema_title_is_learn_output(self, schema):
        assert schema.get("title") == "LearnOutput"

    def test_schema_type_is_object(self, schema):
        assert schema.get("type") == "object"

    def test_schema_required_fields(self, schema):
        required = schema.get("required", [])
        assert set(required) == {
            "observations", "suggestions", "recurring_patterns", "run_summary"
        }


class TestSchemaValidatesValidDocuments:
    def test_full_valid_document(self, schema):
        doc = _valid_learn_output()
        jsonschema.validate(doc, schema)

    def test_minimal_observation(self, schema):
        doc = _valid_learn_output()
        doc["observations"] = [{
            "category": "planning",
            "importance": "low",
            "description": "Plan was adequate",
            "evidence": "No plan restarts",
        }]
        jsonschema.validate(doc, schema)

    def test_minimal_suggestion(self, schema):
        doc = _valid_learn_output()
        doc["suggestions"] = [{
            "target": "prompt:planner",
            "description": "Add more context",
            "rationale": "Plan missed edge cases",
        }]
        jsonschema.validate(doc, schema)

    def test_minimal_run_summary(self, schema):
        doc = _valid_learn_output()
        doc["run_summary"] = {
            "termination": "failure",
            "total_iterations": 2,
        }
        jsonschema.validate(doc, schema)

    def test_empty_arrays(self, schema):
        doc = {
            "observations": [],
            "suggestions": [],
            "recurring_patterns": {},
            "run_summary": {
                "termination": "success",
                "total_iterations": 1,
            },
        }
        jsonschema.validate(doc, schema)


class TestSchemaRejectsInvalidDocuments:
    def test_missing_observations(self, schema):
        doc = _valid_learn_output()
        del doc["observations"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_missing_suggestions(self, schema):
        doc = _valid_learn_output()
        del doc["suggestions"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_missing_recurring_patterns(self, schema):
        doc = _valid_learn_output()
        del doc["recurring_patterns"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_missing_run_summary(self, schema):
        doc = _valid_learn_output()
        del doc["run_summary"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_invalid_observation_category(self, schema):
        doc = _valid_learn_output()
        doc["observations"][0]["category"] = "unknown_category"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_invalid_observation_importance(self, schema):
        doc = _valid_learn_output()
        doc["observations"][0]["importance"] = "urgent"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_observation_missing_required_category(self, schema):
        doc = _valid_learn_output()
        del doc["observations"][0]["category"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_observation_missing_required_description(self, schema):
        doc = _valid_learn_output()
        del doc["observations"][0]["description"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_observation_occurrences_below_minimum(self, schema):
        doc = _valid_learn_output()
        doc["observations"][0]["occurrences"] = 0
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_invalid_suggestion_target(self, schema):
        doc = _valid_learn_output()
        doc["suggestions"][0]["target"] = "invalid:target"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_suggestion_missing_required_target(self, schema):
        doc = _valid_learn_output()
        del doc["suggestions"][0]["target"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_invalid_termination_type(self, schema):
        doc = _valid_learn_output()
        doc["run_summary"]["termination"] = "cancelled"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_run_summary_missing_termination(self, schema):
        doc = _valid_learn_output()
        del doc["run_summary"]["termination"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_run_summary_missing_total_iterations(self, schema):
        doc = _valid_learn_output()
        del doc["run_summary"]["total_iterations"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)


class TestAllSuggestionTargetsAccepted:
    """Each valid target enum value should pass validation."""

    VALID_TARGETS = [
        "prompt:planner", "prompt:coordinator", "prompt:implementer",
        "prompt:tester", "prompt:guardian",
        "config:loops", "config:agents", "config:governance",
        "plan_template", "spec_template",
    ]

    @pytest.mark.parametrize("target", VALID_TARGETS)
    def test_valid_target(self, schema, target):
        doc = _valid_learn_output()
        doc["suggestions"][0]["target"] = target
        jsonschema.validate(doc, schema)


class TestAllObservationCategoriesAccepted:
    """Each valid category enum value should pass validation."""

    VALID_CATEGORIES = [
        "test_loop", "review_loop", "implementation",
        "planning", "coordination", "configuration",
    ]

    @pytest.mark.parametrize("category", VALID_CATEGORIES)
    def test_valid_category(self, schema, category):
        doc = _valid_learn_output()
        doc["observations"][0]["category"] = category
        jsonschema.validate(doc, schema)


class TestAllTerminationTypesAccepted:
    """Each valid termination enum value should pass validation."""

    VALID_TERMINATIONS = ["success", "failure", "loop_exhausted", "rejected"]

    @pytest.mark.parametrize("termination", VALID_TERMINATIONS)
    def test_valid_termination(self, schema, termination):
        doc = _valid_learn_output()
        doc["run_summary"]["termination"] = termination
        jsonschema.validate(doc, schema)
