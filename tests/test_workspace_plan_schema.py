"""Tests for the workspace_plan.json schema — structured master planner output."""
import json
import os

import jsonschema
import pytest

import worca

SCHEMA_PATH = os.path.join(
    os.path.dirname(worca.__file__), "schemas", "workspace_plan.json"
)


@pytest.fixture
def schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def _minimal_doc():
    return {
        "summary": "Add user profiles across all repos",
        "projects": [
            {
                "name": "shared-lib",
                "description": "Add UserProfile type",
                "acceptance_criteria": ["UserProfile type is exported"],
            }
        ],
        "integration_expectations": ["All repos compile against shared-lib"],
    }


def _full_doc():
    return {
        "summary": "Add user profiles with avatar upload",
        "projects": [
            {
                "name": "shared-lib",
                "description": "Add UserProfile type with avatar URL field",
                "acceptance_criteria": [
                    "UserProfile type is exported",
                    "Avatar URL field is optional string",
                ],
                "depends_on": [],
                "skip": False,
            },
            {
                "name": "backend",
                "description": "Add /api/profiles endpoint and avatar storage",
                "acceptance_criteria": [
                    "GET /api/profiles returns list",
                    "PUT /api/profiles/:id/avatar accepts upload",
                ],
                "depends_on": ["shared-lib"],
                "skip": False,
            },
            {
                "name": "frontend",
                "description": "Add profile page with avatar upload widget",
                "acceptance_criteria": [
                    "Profile page renders user data",
                    "Avatar upload works end-to-end",
                ],
                "depends_on": ["backend"],
                "skip": False,
            },
        ],
        "integration_expectations": [
            "Frontend can fetch profiles from backend",
            "Avatar upload round-trips through backend to storage",
        ],
    }


class TestSchemaStructure:
    def test_schema_file_exists(self):
        assert os.path.isfile(SCHEMA_PATH)

    def test_schema_is_valid_json(self, schema):
        assert isinstance(schema, dict)

    def test_schema_draft_07(self, schema):
        assert schema["$schema"] == "http://json-schema.org/draft-07/schema#"

    def test_schema_title(self, schema):
        assert schema["title"] == "WorkspacePlan"

    def test_schema_type_is_object(self, schema):
        assert schema["type"] == "object"

    def test_required_fields(self, schema):
        assert sorted(schema["required"]) == [
            "integration_expectations",
            "projects",
            "summary",
        ]

    def test_summary_is_string(self, schema):
        assert schema["properties"]["summary"]["type"] == "string"

    def test_summary_min_length(self, schema):
        assert schema["properties"]["summary"]["minLength"] == 1

    def test_projects_is_array(self, schema):
        assert schema["properties"]["projects"]["type"] == "array"

    def test_projects_min_items(self, schema):
        assert schema["properties"]["projects"]["minItems"] == 1

    def test_integration_expectations_is_array(self, schema):
        assert schema["properties"]["integration_expectations"]["type"] == "array"

    def test_integration_expectations_items_are_strings(self, schema):
        ie = schema["properties"]["integration_expectations"]
        assert ie["items"]["type"] == "string"

    def test_no_additional_properties_on_root(self, schema):
        assert schema["additionalProperties"] is False


class TestRepoItemStructure:
    def test_repo_required_fields(self, schema):
        repo_schema = schema["properties"]["projects"]["items"]
        assert sorted(repo_schema["required"]) == [
            "acceptance_criteria",
            "description",
            "name",
        ]

    def test_project_name_is_string(self, schema):
        props = schema["properties"]["projects"]["items"]["properties"]
        assert props["name"]["type"] == "string"

    def test_project_name_min_length(self, schema):
        props = schema["properties"]["projects"]["items"]["properties"]
        assert props["name"]["minLength"] == 1

    def test_repo_description_is_string(self, schema):
        props = schema["properties"]["projects"]["items"]["properties"]
        assert props["description"]["type"] == "string"

    def test_repo_description_min_length(self, schema):
        props = schema["properties"]["projects"]["items"]["properties"]
        assert props["description"]["minLength"] == 1

    def test_repo_acceptance_criteria_is_array_of_strings(self, schema):
        props = schema["properties"]["projects"]["items"]["properties"]
        ac = props["acceptance_criteria"]
        assert ac["type"] == "array"
        assert ac["items"]["type"] == "string"

    def test_repo_acceptance_criteria_min_items(self, schema):
        props = schema["properties"]["projects"]["items"]["properties"]
        assert props["acceptance_criteria"]["minItems"] == 1

    def test_project_depends_on_is_array_of_strings(self, schema):
        props = schema["properties"]["projects"]["items"]["properties"]
        dep = props["depends_on"]
        assert dep["type"] == "array"
        assert dep["items"]["type"] == "string"

    def test_repo_skip_is_boolean(self, schema):
        props = schema["properties"]["projects"]["items"]["properties"]
        assert props["skip"]["type"] == "boolean"

    def test_no_additional_properties_on_project(self, schema):
        repo_schema = schema["properties"]["projects"]["items"]
        assert repo_schema["additionalProperties"] is False


class TestMinimalDoc:
    def test_minimal_valid(self, schema):
        jsonschema.validate(_minimal_doc(), schema)

    def test_missing_summary_invalid(self, schema):
        doc = _minimal_doc()
        del doc["summary"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_missing_projects_invalid(self, schema):
        doc = _minimal_doc()
        del doc["projects"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_missing_integration_expectations_invalid(self, schema):
        doc = _minimal_doc()
        del doc["integration_expectations"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_empty_summary_invalid(self, schema):
        doc = _minimal_doc()
        doc["summary"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_empty_repos_invalid(self, schema):
        doc = _minimal_doc()
        doc["projects"] = []
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_summary_not_string_invalid(self, schema):
        doc = _minimal_doc()
        doc["summary"] = 123
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_extra_root_property_invalid(self, schema):
        doc = _minimal_doc()
        doc["unknown_field"] = "foo"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)


class TestFullDoc:
    def test_full_valid(self, schema):
        jsonschema.validate(_full_doc(), schema)

    def test_multiple_repos_with_deps_valid(self, schema):
        jsonschema.validate(_full_doc(), schema)

    def test_all_repos_have_optional_fields(self, schema):
        doc = _full_doc()
        for repo in doc["projects"]:
            assert "depends_on" in repo
            assert "skip" in repo
        jsonschema.validate(doc, schema)


class TestProjectValidation:
    def test_project_missing_name_invalid(self, schema):
        doc = _minimal_doc()
        del doc["projects"][0]["name"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_project_missing_description_invalid(self, schema):
        doc = _minimal_doc()
        del doc["projects"][0]["description"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_project_missing_acceptance_criteria_invalid(self, schema):
        doc = _minimal_doc()
        del doc["projects"][0]["acceptance_criteria"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_empty_name_invalid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["name"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_empty_description_invalid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["description"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_empty_acceptance_criteria_invalid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["acceptance_criteria"] = []
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_acceptance_criteria_non_string_invalid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["acceptance_criteria"] = [123]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_project_depends_on_non_string_invalid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["depends_on"] = [42]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_skip_non_boolean_invalid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["skip"] = "yes"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_project_extra_property_invalid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["unknown"] = "bar"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)


class TestOptionalFields:
    def test_depends_on_optional(self, schema):
        doc = _minimal_doc()
        assert "depends_on" not in doc["projects"][0]
        jsonschema.validate(doc, schema)

    def test_skip_optional(self, schema):
        doc = _minimal_doc()
        assert "skip" not in doc["projects"][0]
        jsonschema.validate(doc, schema)

    def test_integration_expectations_can_be_empty(self, schema):
        doc = _minimal_doc()
        doc["integration_expectations"] = []
        jsonschema.validate(doc, schema)

    def test_skip_true_valid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["skip"] = True
        jsonschema.validate(doc, schema)

    def test_depends_on_empty_array_valid(self, schema):
        doc = _minimal_doc()
        doc["projects"][0]["depends_on"] = []
        jsonschema.validate(doc, schema)
