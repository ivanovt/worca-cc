"""Unit tests for PRVerification namedtuple and _verify_pr_stage() in runner.py.

Covers:
- success: HEAD changed, all fields present, sha matches
- no-commit: HEAD did not change from baseline
- missing-fields: commit_sha / pr_url / pr_number absent
- sha-mismatch: reported commit_sha doesn't match actual HEAD
- non-dict result: stage output is not a dict
- wiring: _verify_pr_stage is called inside run_pipeline with retry/halt logic
"""
import inspect

from unittest.mock import patch


from worca.orchestrator.runner import PRVerification, _verify_pr_stage
from worca.orchestrator import runner as _runner_module


SHA_BASELINE = "aaa0000000000000000000000000000000000000"
SHA_NEW = "bbb1111111111111111111111111111111111111"


def _full_output():
    return {
        "outcome": "success",
        "commit_sha": SHA_NEW,
        "pr_url": "https://github.com/org/repo/pull/42",
        "pr_number": 42,
    }


class TestPRVerificationNamedtuple:
    def test_has_ok_field(self):
        v = PRVerification(ok=True, reason="all good")
        assert v.ok is True

    def test_has_reason_field(self):
        v = PRVerification(ok=False, reason="no commit")
        assert v.reason == "no commit"

    def test_is_namedtuple(self):
        assert isinstance(PRVerification(True, ""), tuple)
        assert hasattr(PRVerification, "_fields")
        assert PRVerification._fields == ("ok", "reason")


class TestVerifyPRStageSuccess:
    def test_returns_ok_true_on_success(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE)
        assert result.ok is True

    def test_reason_empty_string_on_success(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE)
        assert result.reason == ""

    def test_returns_prverification_instance(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE)
        assert isinstance(result, PRVerification)


class TestVerifyPRStageNoCommit:
    def test_ok_false_when_head_unchanged(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_BASELINE):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE)
        assert result.ok is False

    def test_reason_mentions_no_new_commit(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_BASELINE):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE)
        assert "commit" in result.reason.lower()


class TestVerifyPRStageMissingFields:
    def test_missing_commit_sha(self):
        output = _full_output()
        del output["commit_sha"]
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is False
        assert "commit_sha" in result.reason

    def test_missing_pr_url(self):
        output = _full_output()
        del output["pr_url"]
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is False
        assert "pr_url" in result.reason

    def test_missing_pr_number(self):
        output = _full_output()
        del output["pr_number"]
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is False
        assert "pr_number" in result.reason

    def test_missing_all_required_fields(self):
        output = {"outcome": "success"}
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is False


class TestVerifyPRStageShaMismatch:
    def test_ok_false_when_reported_sha_differs_from_head(self):
        output = _full_output()
        output["commit_sha"] = "ccc2222222"  # not SHA_NEW
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is False

    def test_reason_mentions_sha_mismatch(self):
        output = _full_output()
        output["commit_sha"] = "ccc2222222"
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert "sha" in result.reason.lower() or "commit" in result.reason.lower()

    def test_sha_prefix_match_accepted(self):
        """Reported SHA may be a 7+ char prefix of the full 40-char HEAD SHA."""
        output = _full_output()
        output["commit_sha"] = SHA_NEW[:12]
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is True


class TestVerifyPRStageNonDictResult:
    def test_ok_false_when_result_is_none(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(None, SHA_BASELINE)
        assert result.ok is False

    def test_ok_false_when_result_is_string(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage("some prose", SHA_BASELINE)
        assert result.ok is False

    def test_reason_mentions_structured_output(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage("prose", SHA_BASELINE)
        assert "structured" in result.reason.lower() or "dict" in result.reason.lower()

    def test_ok_false_when_result_is_list(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage([], SHA_BASELINE)
        assert result.ok is False


class TestPRStageHandlerWiring:
    """Sentinel tests: fail until _verify_pr_stage is wired into run_pipeline."""

    def _pipeline_source(self):
        return inspect.getsource(_runner_module.run_pipeline)

    def test_verify_pr_stage_called_inside_run_pipeline(self):
        assert "_verify_pr_stage(" in self._pipeline_source(), (
            "_verify_pr_stage is not called inside run_pipeline — wiring missing"
        )

    def test_pr_verification_retry_counter_in_run_pipeline(self):
        assert "pr_verification_retry" in self._pipeline_source(), (
            "Loop counter 'pr_verification_retry' not found in run_pipeline — wiring missing"
        )

    def test_pr_verified_milestone_set_in_run_pipeline(self):
        assert '"pr_verified"' in self._pipeline_source(), (
            "Milestone 'pr_verified' is not set inside run_pipeline — wiring missing"
        )
