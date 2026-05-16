"""Tests for workspace event type constants and payload builders (W-047-20)."""


from worca.events import types


class TestWorkspaceEventConstants:
    """Workspace event type strings exist and follow the naming convention."""

    def test_workspace_launched(self):
        assert types.WORKSPACE_LAUNCHED == "workspace.launched"

    def test_workspace_halted(self):
        assert types.WORKSPACE_HALTED == "workspace.halted"

    def test_workspace_completed(self):
        assert types.WORKSPACE_COMPLETED == "workspace.completed"

    def test_workspace_failed(self):
        assert types.WORKSPACE_FAILED == "workspace.failed"

    def test_workspace_tier_started(self):
        assert types.WORKSPACE_TIER_STARTED == "workspace.tier.started"

    def test_workspace_tier_completed(self):
        assert types.WORKSPACE_TIER_COMPLETED == "workspace.tier.completed"

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
        assert "guide_attached" in p
        assert p["guide_attached"] is False

    def test_all_fields(self):
        p = types.workspace_launched_payload(
            projects=["repo-a"],
            workspace_name="my-ws",
            branch_template="workspace/{slug}/{repo}",
            guide_attached=True,
            max_parallel=3,
            skip_planning=True,
            tier_count=2,
        )
        assert p["branch_template"] == "workspace/{slug}/{repo}"
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


class TestWorkspaceHaltedPayload:
    def test_required(self):
        p = types.workspace_halted_payload(halt_reason="user")
        assert p["halt_reason"] == "user"

    def test_with_counts(self):
        p = types.workspace_halted_payload(
            halt_reason="circuit_breaker",
            completed_tiers=1,
            pending_tiers=2,
        )
        assert p["completed_tiers"] == 1
        assert p["pending_tiers"] == 2


class TestWorkspaceCompletedPayload:
    def test_basic(self):
        p = types.workspace_completed_payload(
            tier_count=3,
            child_count=5,
            integration_passed=True,
        )
        assert p["tier_count"] == 3
        assert p["child_count"] == 5
        assert p["integration_passed"] is True

    def test_with_duration(self):
        p = types.workspace_completed_payload(
            tier_count=2,
            child_count=3,
            integration_passed=True,
            duration_ms=12345,
        )
        assert p["duration_ms"] == 12345

    def test_omits_none_duration(self):
        p = types.workspace_completed_payload(
            tier_count=2,
            child_count=3,
            integration_passed=True,
        )
        assert "duration_ms" not in p


class TestWorkspaceFailedPayload:
    def test_basic(self):
        p = types.workspace_failed_payload(
            tier_count=3,
            completed_count=1,
            failed_count=2,
        )
        assert p["tier_count"] == 3
        assert p["completed_count"] == 1
        assert p["failed_count"] == 2

    def test_with_optional_fields(self):
        p = types.workspace_failed_payload(
            tier_count=3,
            completed_count=1,
            failed_count=2,
            duration_ms=5000,
            failed_tier=1,
        )
        assert p["duration_ms"] == 5000
        assert p["failed_tier"] == 1


class TestWorkspaceTierStartedPayload:
    def test_basic(self):
        p = types.workspace_tier_started_payload(
            tier=0,
            projects=["repo-a", "repo-b"],
        )
        assert p["tier"] == 0
        assert p["projects"] == ["repo-a", "repo-b"]


class TestWorkspaceTierCompletedPayload:
    def test_basic(self):
        p = types.workspace_tier_completed_payload(
            tier=0,
            projects=["repo-a"],
            status="completed",
        )
        assert p["tier"] == 0
        assert p["projects"] == ["repo-a"]
        assert p["status"] == "completed"

    def test_with_duration(self):
        p = types.workspace_tier_completed_payload(
            tier=1,
            projects=["repo-b"],
            status="failed",
            duration_ms=3000,
        )
        assert p["duration_ms"] == 3000


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

    def test_with_workspace_id(self):
        p = types.guide_conflict_payload(
            run_id="run-123",
            stage="review",
            message="conflict",
            source="plan",
            workspace_id="ws-456",
        )
        assert p["workspace_id"] == "ws-456"
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
