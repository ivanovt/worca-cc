"""Tests for the pr.json schema — required fields and optional fields."""
import json
import os

import jsonschema
import pytest

import worca

SCHEMA_PATH = os.path.join(os.path.dirname(worca.__file__), "schemas", "pr.json")

PROVIDER_ENUM = ["github", "gitlab", "bitbucket", "azure_devops", "gitea", "gerrit", "other"]


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

    def test_schema_has_source_branch_property(self, schema):
        assert "source_branch" in schema["properties"]

    def test_source_branch_is_string(self, schema):
        assert schema["properties"]["source_branch"]["type"] == "string"

    def test_source_branch_not_in_required(self, schema):
        # Branches are runner-derived; agents may omit them.
        assert "source_branch" not in schema["required"]

    def test_schema_has_target_branch_property(self, schema):
        assert "target_branch" in schema["properties"]

    def test_target_branch_is_string(self, schema):
        assert schema["properties"]["target_branch"]["type"] == "string"

    def test_target_branch_not_in_required(self, schema):
        assert "target_branch" not in schema["required"]

    def test_schema_has_provider_property(self, schema):
        assert "provider" in schema["properties"]

    def test_provider_is_string_enum(self, schema):
        prop = schema["properties"]["provider"]
        assert prop["type"] == "string"
        assert "enum" in prop

    def test_provider_enum_values(self, schema):
        assert schema["properties"]["provider"]["enum"] == PROVIDER_ENUM

    def test_provider_not_in_required(self, schema):
        assert "provider" not in schema["required"]

    def test_is_draft_not_present(self, schema):
        # is_draft was removed; reintroduce only when there's a producer.
        assert "is_draft" not in schema["properties"]


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

    def test_success_without_branches_valid(self, schema):
        # Branches are optional — runner fills them.
        doc = _success_doc()
        jsonschema.validate(doc, schema)

    def test_success_with_branches_valid(self, schema):
        doc = _success_doc()
        doc["source_branch"] = "feature/x"
        doc["target_branch"] = "main"
        jsonschema.validate(doc, schema)

    def test_success_with_valid_provider_valid(self, schema):
        doc = _success_doc()
        doc["provider"] = "github"
        jsonschema.validate(doc, schema)

    def test_success_with_invalid_provider_rejected(self, schema):
        doc = _success_doc()
        doc["provider"] = "unknown_host"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_success_all_optional_fields_valid(self, schema):
        doc = _success_doc()
        doc["source_branch"] = "feature/x"
        doc["target_branch"] = "main"
        doc["provider"] = "gitlab"
        doc["review_status"] = "pending"
        jsonschema.validate(doc, schema)


class TestDeferredOutcome:
    """Workspace child guardian short-circuits PR creation (WORCA_DEFER_PR=1).
    Schema must accept `deferred: true` outputs that have commit_sha but no
    pr_number/pr_url, while still rejecting non-deferred success outputs
    that are missing those fields."""

    def _deferred_doc(self):
        return {
            "outcome": "success",
            "deferred": True,
            "commit_sha": "abc1234",
        }

    def test_deferred_success_without_pr_fields_valid(self, schema):
        jsonschema.validate(self._deferred_doc(), schema)

    def test_deferred_success_still_requires_commit_sha(self, schema):
        doc = self._deferred_doc()
        del doc["commit_sha"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_deferred_success_must_not_include_pr_number(self, schema):
        """Belt-and-suspenders: `deferred: true` semantically means no PR
        was created here. Including pr_number would contradict the
        discriminator. Schema enforces 'not' to catch a misbehaving agent."""
        doc = self._deferred_doc()
        doc["pr_number"] = 7
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_deferred_success_must_not_include_pr_url(self, schema):
        doc = self._deferred_doc()
        doc["pr_url"] = "https://github.com/org/repo/pull/7"
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_deferred_false_requires_pr_fields_like_normal_success(self, schema):
        """`deferred: false` must NOT relax the contract — only `true` opts
        in. Catches a misconfigured guardian that emits the flag without
        actually deferring."""
        doc = {
            "outcome": "success",
            "deferred": False,
            "commit_sha": "abc1234",
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_non_deferred_success_still_requires_pr_fields(self, schema):
        """Regression: dropping deferred entirely must still require
        pr_number + pr_url for outcome=success."""
        doc = {
            "outcome": "success",
            "commit_sha": "abc1234",
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_deferred_property_documented(self, schema):
        assert "deferred" in schema["properties"]
        assert schema["properties"]["deferred"]["type"] == "boolean"


class TestRejectOutcome:
    def test_reject_without_commit_sha_valid(self, schema):
        jsonschema.validate(_reject_doc(), schema)

    def test_reject_with_commit_sha_valid(self, schema):
        doc = _reject_doc()
        doc["commit_sha"] = "abc1234"
        jsonschema.validate(doc, schema)

    def test_reject_without_branches_valid(self, schema):
        # Reject path: agent typically can't compute branches anyway.
        jsonschema.validate(_reject_doc(), schema)


class TestProviderEnum:
    @pytest.mark.parametrize("provider", PROVIDER_ENUM)
    def test_each_valid_provider_accepted(self, schema, provider):
        doc = _success_doc()
        doc["provider"] = provider
        jsonschema.validate(doc, schema)

    def test_empty_string_provider_rejected(self, schema):
        doc = _success_doc()
        doc["provider"] = ""
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)

    def test_numeric_provider_rejected(self, schema):
        doc = _success_doc()
        doc["provider"] = 1
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, schema)
