"""Tests for worca.stages.pr.defer config → WORCA_DEFER_PR env var translation.

Design §1 of W-065: Runner reads worca.stages.pr.defer from config and, when
true, injects WORCA_DEFER_PR=1 into the subprocess env before guardian runs.
The workspace dag_executor also sets WORCA_DEFER_PR=1 (in the child process
os.environ) — the two producers compose monotonically: either can defer, but
neither can un-defer a value the other set.
"""
from __future__ import annotations

import json
import os

import jsonschema
import pytest
import worca

from worca.orchestrator.runner import (
    _apply_defer_pr_from_config,
    _pr_stage_is_deferred,
)

DEFERRED_SCHEMA_PATH = os.path.join(os.path.dirname(worca.__file__), "schemas", "pr-deferred.json")


@pytest.fixture
def deferred_schema():
    with open(DEFERRED_SCHEMA_PATH) as f:
        return json.load(f)


class TestWorkspaceChildDeferredOutput:
    """Workspace children run with WORCA_DEFER_PR=1 and the guardian uses
    pr-deferred.json. The schema now requires pr_title, pr_body, base_branch
    on outcome:success so the click-time CLI can open the PR without
    re-deriving them (W-065 §1 Consideration)."""

    def _workspace_guardian_output(self):
        return {
            "outcome": "success",
            "deferred": True,
            "commit_sha": "abc1234",
            "source_branch": "worca/ws-branch",
            "target_branch": "main",
            "provider": "github",
            "pr_title": "workspace implementation",
            "pr_body": "## Summary\n- workspace change",
            "base_branch": "main",
        }

    def test_workspace_guardian_output_valid_against_deferred_schema(self, deferred_schema):
        jsonschema.validate(self._workspace_guardian_output(), deferred_schema)

    def test_workspace_guardian_missing_pr_title_rejected(self, deferred_schema):
        doc = self._workspace_guardian_output()
        del doc["pr_title"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, deferred_schema)

    def test_workspace_guardian_missing_pr_body_rejected(self, deferred_schema):
        doc = self._workspace_guardian_output()
        del doc["pr_body"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, deferred_schema)

    def test_workspace_guardian_missing_base_branch_rejected(self, deferred_schema):
        doc = self._workspace_guardian_output()
        del doc["base_branch"]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(doc, deferred_schema)

    def test_workspace_fixture_e2e_scenario_valid(self, deferred_schema):
        """The mock scenario in test_workspace_e2e.py/_WORKSPACE_SCENARIO must
        produce output that passes pr-deferred.json validation."""
        fixture_output = {
            "outcome": "success",
            "deferred": True,
            "commit_sha": "abc1234",
            "source_branch": "worca/ws-branch",
            "target_branch": "main",
            "provider": "github",
            "pr_title": "workspace implementation",
            "pr_body": "## Summary\n- workspace change",
            "base_branch": "main",
        }
        jsonschema.validate(fixture_output, deferred_schema)

    def test_workspace_fixture_fullstack_scenario_valid(self, deferred_schema):
        """The mock scenario in test_workspace_fullstack.py/_WORKSPACE_SCENARIO must
        produce output that passes pr-deferred.json validation."""
        fixture_output = {
            "outcome": "success",
            "deferred": True,
            "commit_sha": "abc1234",
            "source_branch": "worca/ws-branch",
            "target_branch": "main",
            "provider": "github",
            "pr_title": "fullstack implementation",
            "pr_body": "## Summary\n- fullstack change",
            "base_branch": "main",
        }
        jsonschema.validate(fixture_output, deferred_schema)


class TestStatusPrDeferredFlagLifted:
    """When the PR stage output has deferred:true, runner should set
    status.pr_deferred=True and fire GIT_PR_DEFERRED event (W-065 §1 task 4)."""

    def _make_deferred_result(self):
        return {
            "outcome": "success",
            "deferred": True,
            "commit_sha": "abc1234",
            "source_branch": "worca/feat-branch",
            "target_branch": "main",
            "pr_title": "My deferred PR",
            "pr_body": "## Summary\n- change",
            "base_branch": "main",
            "provider": "github",
        }

    def test_pr_deferred_flag_set_in_status(self):
        """When result.deferred is True, status['pr_deferred'] must be set to True."""
        from worca.orchestrator.runner import _lift_pr_deferred_to_status
        status = {}
        result = self._make_deferred_result()
        _lift_pr_deferred_to_status(result, status)
        assert status.get("pr_deferred") is True

    def test_pr_deferred_flag_not_set_when_not_deferred(self):
        """When result.deferred is absent/False, status['pr_deferred'] must not be set."""
        from worca.orchestrator.runner import _lift_pr_deferred_to_status
        status = {}
        result = {"outcome": "success", "pr_url": "https://github.com/x/y/pull/1", "pr_number": 1, "commit_sha": "abc"}
        _lift_pr_deferred_to_status(result, status)
        assert "pr_deferred" not in status

    def test_git_pr_deferred_event_payload_fields(self):
        """GIT_PR_DEFERRED payload has pr_title, base_branch, head_branch, commit_sha."""
        from worca.events.types import git_pr_deferred_payload
        payload = git_pr_deferred_payload(
            pr_title="My PR",
            base_branch="main",
            head_branch="feat",
            commit_sha="abc1234",
        )
        assert payload["pr_title"] == "My PR"
        assert payload["base_branch"] == "main"
        assert payload["head_branch"] == "feat"
        assert payload["commit_sha"] == "abc1234"
        assert "pr_url" not in payload
        assert "pr_number" not in payload


class TestComputeDeferPrFromConfig:
    def test_config_true_sets_env(self):
        env = {}
        _apply_defer_pr_from_config({"stages": {"pr": {"defer": True}}}, env)
        assert env.get("WORCA_DEFER_PR") == "1"

    def test_env_already_set_by_workspace_not_overridden(self):
        """If dag_executor already set WORCA_DEFER_PR=1, config must not clear it
        even when stages.pr.defer is absent from the template config."""
        env = {"WORCA_DEFER_PR": "1"}
        _apply_defer_pr_from_config({}, env)
        assert env["WORCA_DEFER_PR"] == "1"

    def test_env_already_set_config_true_still_one(self):
        """Both producers set defer — result stays "1", not doubled or changed."""
        env = {"WORCA_DEFER_PR": "1"}
        _apply_defer_pr_from_config({"stages": {"pr": {"defer": True}}}, env)
        assert env["WORCA_DEFER_PR"] == "1"

    def test_config_false_does_not_set_env(self):
        env = {}
        _apply_defer_pr_from_config({"stages": {"pr": {"defer": False}}}, env)
        assert "WORCA_DEFER_PR" not in env

    def test_config_missing_does_not_set_env(self):
        env = {}
        _apply_defer_pr_from_config({}, env)
        assert "WORCA_DEFER_PR" not in env

    def test_config_stages_missing_does_not_set_env(self):
        env = {}
        _apply_defer_pr_from_config({"stages": {}}, env)
        assert "WORCA_DEFER_PR" not in env

    def test_config_false_does_not_clear_existing_workspace_value(self):
        """stages.pr.defer:false in a child template must NOT undo workspace deferral."""
        env = {"WORCA_DEFER_PR": "1"}
        _apply_defer_pr_from_config({"stages": {"pr": {"defer": False}}}, env)
        assert env["WORCA_DEFER_PR"] == "1"


class TestPrStageSchemaSelection:
    """run_stage selects pr-deferred.json via _pr_stage_is_deferred, which must
    resolve defer the SAME way the guardian prompt is resolved (env copy folded
    with the config toggle, then build_guardian_context).

    Regression for the config-vs-env schema seam: a project that sets
    worca.stages.pr.defer:true but does NOT have WORCA_DEFER_PR in os.environ
    must still get the deferred schema. Before the fix the schema selection read
    os.environ only, so config-only defer rendered the deferred *prompt* ("stash,
    do not open a PR") while keeping pr.json (which requires pr_number/pr_url) —
    an unsatisfiable contract under real Claude.
    """

    def _write_settings(self, tmp_path, worca_block) -> str:
        p = tmp_path / "settings.json"
        p.write_text(json.dumps({"worca": worca_block}))
        return str(p)

    def test_config_only_defer_selects_deferred(self, tmp_path):
        """THE regression: config defer:true + no WORCA_DEFER_PR in env → deferred."""
        settings = self._write_settings(
            tmp_path, {"stages": {"pr": {"defer": True}}}
        )
        assert _pr_stage_is_deferred(settings, env={}) is True

    def test_config_defer_false_not_deferred(self, tmp_path):
        settings = self._write_settings(
            tmp_path, {"stages": {"pr": {"defer": False}}}
        )
        assert _pr_stage_is_deferred(settings, env={}) is False

    def test_config_absent_not_deferred(self, tmp_path):
        settings = self._write_settings(tmp_path, {})
        assert _pr_stage_is_deferred(settings, env={}) is False

    def test_missing_settings_file_not_deferred(self, tmp_path):
        missing = str(tmp_path / "does-not-exist.json")
        assert _pr_stage_is_deferred(missing, env={}) is False

    def test_workspace_env_defer_selects_deferred(self, tmp_path):
        """Workspace child path: WORCA_DEFER_PR=1 in env, no config → deferred."""
        settings = self._write_settings(tmp_path, {})
        assert _pr_stage_is_deferred(settings, env={"WORCA_DEFER_PR": "1"}) is True

    def test_env_defer_overrides_config_false(self, tmp_path):
        """Monotonic compose: env defers even when the child template says false."""
        settings = self._write_settings(
            tmp_path, {"stages": {"pr": {"defer": False}}}
        )
        assert _pr_stage_is_deferred(settings, env={"WORCA_DEFER_PR": "1"}) is True

    def test_revise_pr_takes_precedence_over_config_defer(self, tmp_path):
        """An existing PR cannot be deferred: WORCA_REVISE_PR forces non-deferred
        even when config defer:true, matching build_guardian_context precedence."""
        settings = self._write_settings(
            tmp_path, {"stages": {"pr": {"defer": True}}}
        )
        assert (
            _pr_stage_is_deferred(settings, env={"WORCA_REVISE_PR": "42"}) is False
        )

    def test_revise_pr_takes_precedence_over_env_defer(self, tmp_path):
        settings = self._write_settings(tmp_path, {})
        assert (
            _pr_stage_is_deferred(
                settings, env={"WORCA_DEFER_PR": "1", "WORCA_REVISE_PR": "42"}
            )
            is False
        )
