"""Tests for workspace event type constants and payload builders.

Covers all 18 workspace event types and their payload builders. Mirrors
tests/test_fleet_events.py's TestPayloadBuilders coverage for fleet.
"""


from worca.events import types


class TestWorkspaceEventConstants:
    """Workspace event type strings exist and follow the naming convention."""

    def test_workspace_launched(self):
        assert types.WORKSPACE_LAUNCHED == "workspace.launched"

    def test_workspace_completed(self):
        assert types.WORKSPACE_COMPLETED == "workspace.completed"

    def test_workspace_failed(self):
        assert types.WORKSPACE_FAILED == "workspace.failed"

    def test_workspace_halted(self):
        assert types.WORKSPACE_HALTED == "workspace.halted"

    def test_workspace_paused(self):
        assert types.WORKSPACE_PAUSED == "workspace.paused"

    def test_workspace_resumed(self):
        assert types.WORKSPACE_RESUMED == "workspace.resumed"

    def test_workspace_plan_started(self):
        assert types.WORKSPACE_PLAN_STARTED == "workspace.plan.started"

    def test_workspace_plan_completed(self):
        assert types.WORKSPACE_PLAN_COMPLETED == "workspace.plan.completed"

    def test_workspace_plan_failed(self):
        assert types.WORKSPACE_PLAN_FAILED == "workspace.plan.failed"

    def test_workspace_tier_started(self):
        assert types.WORKSPACE_TIER_STARTED == "workspace.tier.started"

    def test_workspace_tier_completed(self):
        assert types.WORKSPACE_TIER_COMPLETED == "workspace.tier.completed"

    def test_workspace_tier_failed(self):
        assert types.WORKSPACE_TIER_FAILED == "workspace.tier.failed"

    def test_workspace_integration_started(self):
        assert (
            types.WORKSPACE_INTEGRATION_STARTED
            == "workspace.integration_test.started"
        )

    def test_workspace_integration_passed(self):
        assert (
            types.WORKSPACE_INTEGRATION_PASSED
            == "workspace.integration_test.passed"
        )

    def test_workspace_integration_failed(self):
        assert (
            types.WORKSPACE_INTEGRATION_FAILED
            == "workspace.integration_test.failed"
        )

    def test_workspace_umbrella_issue_created(self):
        assert (
            types.WORKSPACE_UMBRELLA_ISSUE_CREATED
            == "workspace.umbrella_issue.created"
        )

    def test_workspace_circuit_breaker_tripped(self):
        assert (
            types.WORKSPACE_CIRCUIT_BREAKER_TRIPPED
            == "workspace.circuit_breaker.tripped"
        )

    def test_guide_conflict(self):
        assert types.GUIDE_CONFLICT == "workspace.guide_conflict"


class TestWorkspaceLaunchedPayload:
    def test_minimal(self):
        p = types.workspace_launched_payload(
            projects=["repo-a", "repo-b"],
            workspace_name="my-ws",
        )
        assert p["projects"] == ["repo-a", "repo-b"]
        assert p["workspace_name"] == "my-ws"
        assert p["guide_attached"] is False
        assert p["skip_planning"] is False

    def test_all_fields(self):
        p = types.workspace_launched_payload(
            projects=["repo-a"],
            workspace_name="my-ws",
            branch_template="workspace/{slug}/{project}",
            guide_attached=True,
            max_parallel=3,
            skip_planning=True,
            tier_count=2,
        )
        assert p["branch_template"] == "workspace/{slug}/{project}"
        assert p["guide_attached"] is True
        assert p["max_parallel"] == 3
        assert p["skip_planning"] is True
        assert p["tier_count"] == 2

    def test_omits_none_optionals(self):
        p = types.workspace_launched_payload(
            projects=["repo-a"],
            workspace_name="my-ws",
        )
        assert "branch_template" not in p
        assert "max_parallel" not in p
        assert "tier_count" not in p


class TestWorkspaceCompletedPayload:
    def test_basic(self):
        p = types.workspace_completed_payload(
            "my-ws",
            tier_count=3,
            child_count=5,
            integration_passed=True,
        )
        assert p["workspace_name"] == "my-ws"
        assert p["tier_count"] == 3
        assert p["child_count"] == 5
        assert p["integration_passed"] is True

    def test_with_duration_and_umbrella(self):
        p = types.workspace_completed_payload(
            "my-ws",
            tier_count=2,
            child_count=3,
            integration_passed=True,
            duration_ms=12345,
            umbrella_issue_url="https://github.com/org/repo/issues/42",
        )
        assert p["duration_ms"] == 12345
        assert (
            p["umbrella_issue_url"] == "https://github.com/org/repo/issues/42"
        )

    def test_omits_none_optionals(self):
        p = types.workspace_completed_payload(
            "my-ws",
            tier_count=2,
            child_count=3,
            integration_passed=True,
        )
        assert "duration_ms" not in p
        assert "umbrella_issue_url" not in p


class TestWorkspaceFailedPayload:
    def test_basic(self):
        p = types.workspace_failed_payload(
            "my-ws",
            tier_count=3,
            completed_count=1,
            failed_count=2,
        )
        assert p["workspace_name"] == "my-ws"
        assert p["tier_count"] == 3
        assert p["completed_count"] == 1
        assert p["failed_count"] == 2

    def test_with_optional_fields(self):
        p = types.workspace_failed_payload(
            "my-ws",
            tier_count=3,
            completed_count=1,
            failed_count=2,
            duration_ms=5000,
            failed_tier=1,
            failed_projects=["repo-b", "repo-c"],
        )
        assert p["duration_ms"] == 5000
        assert p["failed_tier"] == 1
        assert p["failed_projects"] == ["repo-b", "repo-c"]


class TestWorkspaceHaltedPayload:
    def test_required(self):
        p = types.workspace_halted_payload("my-ws", halt_reason="user")
        assert p["workspace_name"] == "my-ws"
        assert p["halt_reason"] == "user"

    def test_with_counts(self):
        p = types.workspace_halted_payload(
            "my-ws",
            halt_reason="circuit_breaker",
            completed_tiers=1,
            pending_tiers=2,
        )
        assert p["completed_tiers"] == 1
        assert p["pending_tiers"] == 2


class TestWorkspacePausedPayload:
    def test_minimal(self):
        p = types.workspace_paused_payload("my-ws")
        assert p["workspace_name"] == "my-ws"
        assert "reason" not in p

    def test_with_reason(self):
        p = types.workspace_paused_payload("my-ws", reason="user")
        assert p["reason"] == "user"


class TestWorkspaceResumedPayload:
    def test_minimal(self):
        p = types.workspace_resumed_payload("my-ws")
        assert p["workspace_name"] == "my-ws"
        assert "from_state" not in p

    def test_with_counts(self):
        p = types.workspace_resumed_payload(
            "my-ws",
            from_state="halted",
            redispatch_count=2,
            skip_count=1,
        )
        assert p["from_state"] == "halted"
        assert p["redispatch_count"] == 2
        assert p["skip_count"] == 1


class TestWorkspacePlanPayloads:
    def test_started_minimal(self):
        p = types.workspace_plan_started_payload("my-ws")
        assert p["workspace_name"] == "my-ws"
        assert "project_count" not in p

    def test_started_with_count(self):
        p = types.workspace_plan_started_payload(
            "my-ws", project_count=3, model="opus",
        )
        assert p["project_count"] == 3
        assert p["model"] == "opus"

    def test_completed(self):
        p = types.workspace_plan_completed_payload(
            "my-ws", project_count=3, skipped_count=1, duration_ms=4500,
        )
        assert p["project_count"] == 3
        assert p["skipped_count"] == 1
        assert p["duration_ms"] == 4500

    def test_failed(self):
        p = types.workspace_plan_failed_payload(
            "my-ws", "schema validation: missing required field 'projects'",
            error_type="ValidationError", duration_ms=2000,
        )
        assert p["error"].startswith("schema validation:")
        assert p["error_type"] == "ValidationError"


class TestWorkspaceTierPayloads:
    def test_started(self):
        p = types.workspace_tier_started_payload(
            workspace_name="my-ws", tier=0, projects=["a", "b"],
        )
        assert p["workspace_name"] == "my-ws"
        assert p["tier"] == 0
        assert p["projects"] == ["a", "b"]

    def test_completed(self):
        p = types.workspace_tier_completed_payload(
            workspace_name="my-ws", tier=0, projects=["a"],
            status="completed", duration_ms=3000,
        )
        assert p["status"] == "completed"
        assert p["duration_ms"] == 3000

    def test_failed(self):
        p = types.workspace_tier_failed_payload(
            workspace_name="my-ws",
            tier=1,
            failed_projects=["b"],
            blocked_projects=["c"],
            duration_ms=2500,
        )
        assert p["failed_projects"] == ["b"]
        assert p["blocked_projects"] == ["c"]
        assert p["duration_ms"] == 2500


class TestWorkspaceIntegrationPayloads:
    def test_started(self):
        p = types.workspace_integration_started_payload(
            "my-ws", command="docker compose run tests", working_dir=".",
        )
        assert p["command"] == "docker compose run tests"
        assert p["working_dir"] == "."

    def test_passed(self):
        p = types.workspace_integration_passed_payload(
            "my-ws", duration_ms=12000, log_path="/abs/log.txt",
        )
        assert p["duration_ms"] == 12000
        assert p["log_path"] == "/abs/log.txt"

    def test_failed(self):
        p = types.workspace_integration_failed_payload(
            "my-ws",
            exit_code=1,
            duration_ms=8000,
            log_path="/abs/log.txt",
            log_tail="FAIL: test_thing\n",
        )
        assert p["exit_code"] == 1
        assert p["log_tail"] == "FAIL: test_thing\n"

    def test_failed_log_tail_capped(self):
        big = "x" * 4096
        p = types.workspace_integration_failed_payload(
            "my-ws", log_tail=big,
        )
        # Cap at 2 KB per payload builder docstring.
        assert len(p["log_tail"]) == 2048


class TestWorkspaceUmbrellaIssuePayload:
    def test_minimal(self):
        p = types.workspace_umbrella_issue_created_payload(
            "my-ws", issue_url="https://github.com/org/repo/issues/42",
        )
        assert p["workspace_name"] == "my-ws"
        assert p["issue_url"].endswith("/issues/42")

    def test_full(self):
        p = types.workspace_umbrella_issue_created_payload(
            "my-ws",
            issue_url="https://github.com/org/repo/issues/42",
            issue_number=42,
            nwo="org/repo",
            child_pr_count=3,
        )
        assert p["issue_number"] == 42
        assert p["nwo"] == "org/repo"
        assert p["child_pr_count"] == 3


class TestWorkspaceCircuitBreakerPayload:
    def test_computes_ratio(self):
        p = types.workspace_circuit_breaker_tripped_payload(
            "my-ws",
            failed_count=3, terminal_count=4, total_count=5, threshold=0.30,
        )
        assert p["failure_ratio"] == 0.75
        assert p["threshold"] == 0.30
        assert p["workspace_name"] == "my-ws"

    def test_handles_zero_terminal(self):
        p = types.workspace_circuit_breaker_tripped_payload(
            "my-ws",
            failed_count=0, terminal_count=0, total_count=5, threshold=0.30,
        )
        assert p["failure_ratio"] == 0.0  # no zero-division


class TestGuideConflictPayload:
    def test_basic(self):
        p = types.guide_conflict_payload(
            run_id="run-123",
            stage="plan",
            message="Description requests X but guide forbids it",
            source="description",
        )
        assert p["run_id"] == "run-123"
        assert p["stage"] == "plan"
        assert p["message"] == "Description requests X but guide forbids it"
        assert p["source"] == "description"

    def test_with_workspace_id_and_name(self):
        p = types.guide_conflict_payload(
            run_id="run-123",
            stage="review",
            message="conflict",
            source="plan",
            workspace_id="ws-456",
            workspace_name="my-platform",
        )
        assert p["workspace_id"] == "ws-456"
        assert p["workspace_name"] == "my-platform"
        assert "fleet_id" not in p

    def test_with_fleet_id(self):
        p = types.guide_conflict_payload(
            run_id="run-123",
            stage="test",
            message="conflict",
            source="plan",
            fleet_id="f-789",
        )
        assert p["fleet_id"] == "f-789"
        assert "workspace_id" not in p
