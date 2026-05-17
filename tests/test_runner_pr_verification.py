"""Unit tests for PRVerification namedtuple and _verify_pr_stage() in runner.py.

Covers:
- success: HEAD changed, all fields present, sha matches
- no-commit: HEAD did not change from baseline
- missing-fields: commit_sha / pr_url / pr_number absent
- sha-mismatch: reported commit_sha doesn't match actual HEAD
- non-dict result: stage output is not a dict
- gh lookup: PR existence + URL match via gh pr view
- wiring: _verify_pr_stage is called inside run_pipeline with retry/halt logic
"""
import inspect

from unittest.mock import patch


from worca.orchestrator.runner import PRVerification, _verify_pr_stage, _verify_pr_via_gh
from worca.orchestrator import runner as _runner_module


SHA_BASELINE = "aaa0000000000000000000000000000000000000"
SHA_NEW = "bbb1111111111111111111111111111111111111"


def _no_gh(_pr_number, _expected_url):
    """Stub gh_lookup that opts out of the network check."""
    return None


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
            result = _verify_pr_stage(_full_output(), SHA_BASELINE, gh_lookup=_no_gh)
        assert result.ok is True

    def test_reason_empty_string_on_success(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE, gh_lookup=_no_gh)
        assert result.reason == ""

    def test_returns_prverification_instance(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE, gh_lookup=_no_gh)
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


class TestVerifyPRStageDeferred:
    """Deferred case: workspace child guardian short-circuits PR creation.

    The runner must accept a stage_output that carries `deferred: true` and
    `commit_sha` but is missing `pr_number` / `pr_url`, since the parent
    workspace orchestrator creates the PR centrally after integration tests.
    """

    def _deferred_output(self):
        return {
            "outcome": "success",
            "deferred": True,
            "commit_sha": SHA_NEW,
        }

    def test_deferred_output_passes_with_only_commit_sha(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(self._deferred_output(), SHA_BASELINE)
        assert result.ok is True
        assert result.reason == ""

    def test_deferred_output_still_requires_commit_sha(self):
        output = self._deferred_output()
        del output["commit_sha"]
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is False
        assert "commit_sha" in result.reason

    def test_deferred_output_still_requires_head_to_move(self):
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_BASELINE):
            result = _verify_pr_stage(self._deferred_output(), SHA_BASELINE)
        assert result.ok is False
        assert "commit" in result.reason.lower()

    def test_deferred_output_still_verifies_sha_matches_head(self):
        output = self._deferred_output()
        output["commit_sha"] = "ccc2222222"
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is False

    def test_deferred_output_does_not_call_gh(self):
        """gh_lookup must never be invoked for deferred outputs — no PR exists
        yet for `gh pr view` to find."""
        gh_calls = []

        def _record_gh(pr_number, expected_url):
            gh_calls.append((pr_number, expected_url))
            return PRVerification(ok=True, reason="")

        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(self._deferred_output(), SHA_BASELINE, gh_lookup=_record_gh)
        assert result.ok is True
        assert gh_calls == []

    def test_deferred_false_is_treated_as_non_deferred(self):
        """`deferred: false` must require pr_number/pr_url just like an
        absent `deferred` field — only `deferred: true` opts into the
        relaxed contract."""
        output = {
            "outcome": "success",
            "deferred": False,
            "commit_sha": SHA_NEW,
        }
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(output, SHA_BASELINE)
        assert result.ok is False
        assert "pr_url" in result.reason or "pr_number" in result.reason

    def test_deferred_truthy_non_bool_does_not_relax_contract(self):
        """Only the literal `True` opts in. `deferred: 1` or `deferred: "yes"`
        must NOT relax the contract — keeps the discriminator
        unambiguous."""
        for truthy in (1, "yes", "true", "1"):
            output = {
                "outcome": "success",
                "deferred": truthy,
                "commit_sha": SHA_NEW,
            }
            with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
                result = _verify_pr_stage(output, SHA_BASELINE)
            assert result.ok is False, (
                f"deferred={truthy!r} must NOT bypass pr_number/pr_url requirement"
            )


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
            result = _verify_pr_stage(output, SHA_BASELINE, gh_lookup=_no_gh)
        assert result.ok is True


class TestVerifyPRStageGhLookup:
    """Defense-in-depth: gh pr view confirms PR exists and URL matches."""

    def test_gh_failure_propagates_as_verification_failure(self):
        def gh_says_mismatch(_n, _u):
            return PRVerification(ok=False, reason="PR URL mismatch: gh has 'X', guardian reported 'Y'")
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE, gh_lookup=gh_says_mismatch)
        assert result.ok is False
        assert "mismatch" in result.reason.lower()

    def test_gh_success_keeps_overall_ok(self):
        def gh_ok(_n, _u):
            return PRVerification(ok=True, reason="")
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE, gh_lookup=gh_ok)
        assert result.ok is True

    def test_gh_none_means_skip_check(self):
        """Returning None (transport failure / unavailable) does not fail verification."""
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            result = _verify_pr_stage(_full_output(), SHA_BASELINE, gh_lookup=lambda n, u: None)
        assert result.ok is True

    def test_gh_lookup_called_with_pr_number_and_url(self):
        captured = {}
        def capture(n, u):
            captured["n"] = n
            captured["u"] = u
            return None
        with patch("worca.orchestrator.runner.get_current_git_head", return_value=SHA_NEW):
            _verify_pr_stage(_full_output(), SHA_BASELINE, gh_lookup=capture)
        assert captured["n"] == 42
        assert captured["u"] == "https://github.com/org/repo/pull/42"


class TestVerifyPrViaGh:
    """Direct unit tests for the default gh_lookup implementation."""

    def _stub_run(self, returncode=0, stdout="", stderr=""):
        class _R:
            def __init__(self, rc, out, err):
                self.returncode = rc
                self.stdout = out
                self.stderr = err
        return _R(returncode, stdout, stderr)

    def test_gh_not_installed_returns_none(self):
        with patch("worca.orchestrator.runner.subprocess.run", side_effect=FileNotFoundError()):
            assert _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42") is None

    def test_gh_timeout_returns_none(self):
        import subprocess as _sp
        with patch(
            "worca.orchestrator.runner.subprocess.run",
            side_effect=_sp.TimeoutExpired(cmd="gh", timeout=10),
        ):
            assert _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42") is None

    def test_gh_no_auth_returns_none(self):
        r = self._stub_run(returncode=1, stderr="To authenticate, please run: gh auth login")
        with patch("worca.orchestrator.runner.subprocess.run", return_value=r):
            assert _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42") is None

    def test_gh_no_remote_returns_none(self):
        r = self._stub_run(returncode=1, stderr="no default remote repository is set")
        with patch("worca.orchestrator.runner.subprocess.run", return_value=r):
            assert _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42") is None

    def test_gh_returns_matching_pr(self):
        r = self._stub_run(
            returncode=0,
            stdout='{"number": 42, "url": "https://github.com/org/repo/pull/42"}',
        )
        with patch("worca.orchestrator.runner.subprocess.run", return_value=r):
            result = _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42")
        assert result is not None
        assert result.ok is True

    def test_gh_returns_url_mismatch(self):
        r = self._stub_run(
            returncode=0,
            stdout='{"number": 42, "url": "https://github.com/org/repo/pull/99"}',
        )
        with patch("worca.orchestrator.runner.subprocess.run", return_value=r):
            result = _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42")
        assert result is not None
        assert result.ok is False
        assert "mismatch" in result.reason.lower()

    def test_gh_returns_different_pr_number(self):
        r = self._stub_run(
            returncode=0,
            stdout='{"number": 7, "url": "https://github.com/org/repo/pull/7"}',
        )
        with patch("worca.orchestrator.runner.subprocess.run", return_value=r):
            result = _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42")
        assert result is not None
        assert result.ok is False
        assert "#7" in result.reason or "#42" in result.reason

    def test_gh_pr_not_found_is_real_failure(self):
        r = self._stub_run(
            returncode=1,
            stderr="GraphQL: Could not resolve to a PullRequest with the number of 42",
        )
        with patch("worca.orchestrator.runner.subprocess.run", return_value=r):
            result = _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42")
        assert result is not None
        assert result.ok is False

    def test_gh_invalid_json_returns_none(self):
        r = self._stub_run(returncode=0, stdout="not json")
        with patch("worca.orchestrator.runner.subprocess.run", return_value=r):
            assert _verify_pr_via_gh(42, "https://github.com/org/repo/pull/42") is None


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

    def test_pr_baseline_captured_once_per_stage(self):
        """Baseline must be captured only when _pr_baseline_head is None.

        Recapturing per-iteration would let a partial commit on iter_1 corrupt
        the baseline that iter_2 verifies against.
        """
        src = self._pipeline_source()
        assert "_pr_baseline_head is None" in src, (
            "Baseline guard 'is None' missing — capture would happen every iteration"
        )
