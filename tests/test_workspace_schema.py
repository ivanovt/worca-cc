"""Tests for the workspace.json schema — workspace definition for multi-repo coordination."""
import json
import os

import jsonschema
import pytest

import worca

SCHEMA_PATH = os.path.join(os.path.dirname(worca.__file__), "schemas", "workspace.json")


@pytest.fixture
def schema():
    with open(SCHEMA_PATH) as f:
        return json.load(f)


def _minimal_doc():
    return {
        "name": "my-platform",
        "repos": [
            {
                "name": "shared-lib",
                "path": "shared-lib",
                "role": "library",
                "depends_on": [],
            }
        ],
    }


def _full_doc():
    return {
        "name": "my-platform",
        "repos": [
            {
                "name": "shared-lib",
                "path": "shared-lib",
                "role": "library",
                "depends_on": [],
            },
            {
                "name": "backend",
                "path": "backend",
                "role": "service",
                "depends_on": ["shared-lib"],
            },
            {
                "name": "frontend",
                "path": "frontend",
                "role": "app",
                "depends_on": ["backend"],
            },
        ],
        "integration_test": {
            "command": "cd backend && npm run test:integration",
            "working_dir": ".",
        },
        "umbrella_repo": "org/platform-meta",
    }


class TestSchemaStructure:
    def test_schema_file_exists(self):
        assert os.path.isfile(SCHEMA_PATH)

    def test_schema_is_valid_json(self, schema):
        assert isinstance(schema, dict)

    def test_schema_draft_07(self, schema):
        assert schema["$schema"] == "http://json-schema.org/draft-07/schema#"

    def test_schema_title(self, schema):
        assert schema["title"] == "Workspace"

    def test_schema_type_is_object(self, schema):
        assert schema["type"] == "object"

    def test_name_and_repos_required(self, schema):
        assert "name" in schema["required"]
        assert "repos" in schema["required"]

    def test_integration_test_not_required(self, schema):
        assert "integration_test" not in schema["required"]

    def test_umbrella_repo_not_required(self, schema):
        assert "umbrella_repo" not in schema["required"]

    def test_name_is_string(self, schema):
        assert schema["properties"]["name"]["type"] == "string"

    def test_name_min_length(self, schema):
        assert schema["properties"]["name"]["minLength"] == 1

    def test_repos_is_array(self, schema):
        assert schema["properties"]["repos"]["type"] == "array"

    def test_repos_min_items(self, schema):
        assert schema["properties"]["repos"]["minItems"] == 1

    def test_repo_item_required_fields(self, schema):
        repo_schema = schema["properties"]["repos"]["items"]
        assert sorted(repo_schema["required"]) == [
            "depends_on",
            "name",
            "path",
            "role",
        ]

    def test_repo_name_is_string(self, schema):
        props = schema["properties"]["repos"]["items"]["properties"]
        assert props["name"]["type"] == "string"

    def test_repo_path_is_string(self, schema):
        props = schema["properties"]["repos"]["items"]["properties"]
        assert props["path"]["type"] == "string"

    def test_repo_role_is_string(self, schema):
        props = schema["properties"]["repos"]["items"]["properties"]
        assert props["role"]["type"] == "string"

    def test_repo_depends_on_is_array_of_strings(self, schema):
        props = schema["properties"]["repos"]["items"]["properties"]
        dep = props["depends_on"]
        assert dep["type"] == "array"
        assert dep["items"]["type"] == "string"

    def test_integration_test_is_object(self, schema):
        assert schema["properties"]["integration_test"]["type"] == "object"

    def test_integration_test_required_fields(self, schema):
        it_schema = schema["properties"]["integration_test"]
        assert sorted(it_schema["required"]) == ["command", "working_dir"]

    def test_integration_test_command_is_string(self, schema):
        props = schema["properties"]["integration_test"]["properties"]
        assert props["command"]["type"] == "string"

    def test_integration_test_working_dir_is_string(self, schema):
        props = schema["properties"]["integration_test"]["properties"]
        assert props["working_dir"]["type"] == "string"

    def test_umbrella_repo_is_string(self, schema):
        assert schema["properties"]["umbrella_repo"]["type"] == "string"

    def test_no_additional_properties_on_root(self, schema):
        assert schema["additionalProperties"] is False

    def test_no_additional_properties_on_repo(self, schema):
        repo_schema = schema["properties"]["repos"]["items"]
        assert repo_schema["additionalProperties"] is False

    def test_no_additional_properties_on_integration_test(self, schema):
        it_schema = schema["properties"]["integration_test"]
        assert it_schema["additionalProperties"] is False


class TestMinimalDoc:
    def test_minimal_valid(self, schema):
        jsonschema.validate(_minimal_doc(), schema)

    def test_missing_name_invalid(self, schema):
        doc = _minimal_doc()
        del doc["name"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_missing_repos_invalid(self, schema):
        doc = _minimal_doc()
        del doc["repos"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_empty_name_invalid(self, schema):
        doc = _minimal_doc()
        doc["name"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_empty_repos_invalid(self, schema):
        doc = _minimal_doc()
        doc["repos"] = []
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_name_not_string_invalid(self, schema):
        doc = _minimal_doc()
        doc["name"] = 123
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

    def test_umbrella_repo_present(self, schema):
        doc = _full_doc()
        assert doc["umbrella_repo"] == "org/platform-meta"
        jsonschema.validate(doc, schema)


class TestRepoValidation:
    def test_repo_missing_name_invalid(self, schema):
        doc = _minimal_doc()
        del doc["repos"][0]["name"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_missing_path_invalid(self, schema):
        doc = _minimal_doc()
        del doc["repos"][0]["path"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_missing_role_invalid(self, schema):
        doc = _minimal_doc()
        del doc["repos"][0]["role"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_missing_depends_on_invalid(self, schema):
        doc = _minimal_doc()
        del doc["repos"][0]["depends_on"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_depends_on_non_string_invalid(self, schema):
        doc = _minimal_doc()
        doc["repos"][0]["depends_on"] = [123]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_extra_property_invalid(self, schema):
        doc = _minimal_doc()
        doc["repos"][0]["unknown"] = "bar"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_name_empty_invalid(self, schema):
        doc = _minimal_doc()
        doc["repos"][0]["name"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_path_empty_invalid(self, schema):
        doc = _minimal_doc()
        doc["repos"][0]["path"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_repo_role_empty_invalid(self, schema):
        doc = _minimal_doc()
        doc["repos"][0]["role"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)


class TestIntegrationTest:
    def test_integration_test_both_fields_valid(self, schema):
        doc = _minimal_doc()
        doc["integration_test"] = {
            "command": "make test",
            "working_dir": ".",
        }
        jsonschema.validate(doc, schema)

    def test_integration_test_missing_command_invalid(self, schema):
        doc = _minimal_doc()
        doc["integration_test"] = {"working_dir": "."}
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_integration_test_missing_working_dir_invalid(self, schema):
        doc = _minimal_doc()
        doc["integration_test"] = {"command": "make test"}
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_integration_test_extra_field_invalid(self, schema):
        doc = _minimal_doc()
        doc["integration_test"] = {
            "command": "make test",
            "working_dir": ".",
            "timeout": 300,
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_integration_test_empty_command_invalid(self, schema):
        doc = _minimal_doc()
        doc["integration_test"] = {"command": "", "working_dir": "."}
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)


class TestUmbrellaRepo:
    def test_umbrella_repo_string_valid(self, schema):
        doc = _minimal_doc()
        doc["umbrella_repo"] = "org/repo"
        jsonschema.validate(doc, schema)

    def test_umbrella_repo_not_string_invalid(self, schema):
        doc = _minimal_doc()
        doc["umbrella_repo"] = 42
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_umbrella_repo_empty_invalid(self, schema):
        doc = _minimal_doc()
        doc["umbrella_repo"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)
