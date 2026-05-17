"""Tests for PipelineStatus, FleetStatus, WorkspaceStatus enums in worca.state.status."""

import json


# --- PipelineStatus ---

def test_pipeline_status_has_all_members():
    from worca.state.status import PipelineStatus
    expected = {
        "pending", "running", "paused", "completed", "failed",
        "interrupted", "resuming", "setup_failed", "unrecoverable", "cancelled",
    }
    assert {m.value for m in PipelineStatus} == expected


def test_pipeline_status_str_equality():
    from worca.state.status import PipelineStatus
    assert PipelineStatus.RUNNING == "running"
    assert PipelineStatus.PENDING == "pending"
    assert PipelineStatus.FAILED == "failed"


def test_pipeline_status_json_serialization():
    from worca.state.status import PipelineStatus
    data = {"pipeline_status": PipelineStatus.RUNNING}
    serialized = json.dumps(data)
    assert '"running"' in serialized
    loaded = json.loads(serialized)
    assert loaded["pipeline_status"] == PipelineStatus.RUNNING


def test_pipeline_status_in_set_comparison():
    from worca.state.status import PipelineStatus
    statuses = frozenset({PipelineStatus.RUNNING, PipelineStatus.PAUSED})
    assert "running" in statuses
    assert PipelineStatus.RUNNING in statuses


def test_pipeline_status_from_json_string_matches():
    """Values loaded from JSON (as plain strings) must compare equal to enum members."""
    from worca.state.status import PipelineStatus
    loaded = json.loads('{"status": "completed"}')
    assert loaded["status"] == PipelineStatus.COMPLETED


# --- PipelineStatus convenience sets ---

def test_pipeline_terminal_set():
    from worca.state.status import PipelineStatus, PIPELINE_TERMINAL
    assert PipelineStatus.COMPLETED in PIPELINE_TERMINAL
    assert PipelineStatus.INTERRUPTED in PIPELINE_TERMINAL
    assert PipelineStatus.RUNNING not in PIPELINE_TERMINAL
    assert len(PIPELINE_TERMINAL) == 2


def test_pipeline_failure_set():
    from worca.state.status import PipelineStatus, PIPELINE_FAILURE
    assert PipelineStatus.FAILED in PIPELINE_FAILURE
    assert PipelineStatus.SETUP_FAILED in PIPELINE_FAILURE
    assert PipelineStatus.UNRECOVERABLE in PIPELINE_FAILURE
    assert PipelineStatus.COMPLETED not in PIPELINE_FAILURE
    assert len(PIPELINE_FAILURE) == 3


def test_pipeline_all_terminal_set():
    from worca.state.status import PipelineStatus, PIPELINE_ALL_TERMINAL
    assert PipelineStatus.COMPLETED in PIPELINE_ALL_TERMINAL
    assert PipelineStatus.INTERRUPTED in PIPELINE_ALL_TERMINAL
    assert PipelineStatus.CANCELLED in PIPELINE_ALL_TERMINAL
    assert PipelineStatus.FAILED in PIPELINE_ALL_TERMINAL
    assert PipelineStatus.SETUP_FAILED in PIPELINE_ALL_TERMINAL
    assert PipelineStatus.UNRECOVERABLE in PIPELINE_ALL_TERMINAL
    assert PipelineStatus.RUNNING not in PIPELINE_ALL_TERMINAL
    assert len(PIPELINE_ALL_TERMINAL) == 6


def test_pipeline_active_set():
    from worca.state.status import PipelineStatus, PIPELINE_ACTIVE
    assert PipelineStatus.RUNNING in PIPELINE_ACTIVE
    assert PipelineStatus.RESUMING in PIPELINE_ACTIVE
    assert PipelineStatus.PAUSED in PIPELINE_ACTIVE
    assert PipelineStatus.COMPLETED not in PIPELINE_ACTIVE
    assert len(PIPELINE_ACTIVE) == 3


def test_pipeline_in_flight_set():
    from worca.state.status import PipelineStatus, PIPELINE_IN_FLIGHT
    assert PipelineStatus.RUNNING in PIPELINE_IN_FLIGHT
    assert PipelineStatus.RESUMING in PIPELINE_IN_FLIGHT
    assert PipelineStatus.PAUSED not in PIPELINE_IN_FLIGHT
    assert len(PIPELINE_IN_FLIGHT) == 2


# String lookups work against convenience sets (JSON-loaded values)
def test_pipeline_convenience_sets_accept_raw_strings():
    from worca.state.status import (
        PIPELINE_TERMINAL, PIPELINE_FAILURE, PIPELINE_ALL_TERMINAL,
        PIPELINE_ACTIVE, PIPELINE_IN_FLIGHT,
    )
    assert "completed" in PIPELINE_TERMINAL
    assert "failed" in PIPELINE_FAILURE
    assert "cancelled" in PIPELINE_ALL_TERMINAL
    assert "running" in PIPELINE_ACTIVE
    assert "resuming" in PIPELINE_IN_FLIGHT


# --- FleetStatus ---

def test_fleet_status_has_all_members():
    from worca.state.status import FleetStatus
    expected = {"running", "paused", "halted", "completed", "failed", "resuming"}
    assert {m.value for m in FleetStatus} == expected


def test_fleet_status_str_equality():
    from worca.state.status import FleetStatus
    assert FleetStatus.HALTED == "halted"
    assert FleetStatus.PAUSED == "paused"


def test_fleet_status_json_serialization():
    from worca.state.status import FleetStatus
    data = {"status": FleetStatus.HALTED}
    assert json.loads(json.dumps(data))["status"] == "halted"


def test_fleet_sticky_set():
    from worca.state.status import FleetStatus, FLEET_STICKY
    assert FleetStatus.HALTED in FLEET_STICKY
    assert FleetStatus.PAUSED in FLEET_STICKY
    assert FleetStatus.RUNNING not in FLEET_STICKY
    assert len(FLEET_STICKY) == 2


def test_fleet_sticky_accepts_raw_strings():
    from worca.state.status import FLEET_STICKY
    assert "halted" in FLEET_STICKY
    assert "paused" in FLEET_STICKY


# --- WorkspaceStatus ---

def test_workspace_status_has_all_members():
    from worca.state.status import WorkspaceStatus
    expected = {
        "planning", "running", "paused", "halted", "completed", "failed",
        "integration_testing", "integration_failed", "blocked",
    }
    assert {m.value for m in WorkspaceStatus} == expected


def test_workspace_status_has_workspace_specific_values():
    from worca.state.status import WorkspaceStatus
    assert WorkspaceStatus.PLANNING == "planning"
    assert WorkspaceStatus.INTEGRATION_TESTING == "integration_testing"
    assert WorkspaceStatus.INTEGRATION_FAILED == "integration_failed"
    assert WorkspaceStatus.BLOCKED == "blocked"


def test_workspace_status_str_equality():
    from worca.state.status import WorkspaceStatus
    assert WorkspaceStatus.RUNNING == "running"
    assert WorkspaceStatus.BLOCKED == "blocked"


def test_workspace_status_json_serialization():
    from worca.state.status import WorkspaceStatus
    data = {"status": WorkspaceStatus.INTEGRATION_TESTING}
    assert json.loads(json.dumps(data))["status"] == "integration_testing"


def test_workspace_terminal_set():
    from worca.state.status import WorkspaceStatus, WORKSPACE_TERMINAL
    assert WorkspaceStatus.COMPLETED in WORKSPACE_TERMINAL
    assert WorkspaceStatus.FAILED in WORKSPACE_TERMINAL
    assert WorkspaceStatus.INTEGRATION_FAILED in WORKSPACE_TERMINAL
    assert WorkspaceStatus.HALTED in WORKSPACE_TERMINAL
    assert WorkspaceStatus.RUNNING not in WORKSPACE_TERMINAL
    assert len(WORKSPACE_TERMINAL) == 4


def test_workspace_terminal_accepts_raw_strings():
    from worca.state.status import WORKSPACE_TERMINAL
    assert "completed" in WORKSPACE_TERMINAL
    assert "integration_failed" in WORKSPACE_TERMINAL
    assert "halted" in WORKSPACE_TERMINAL


def test_fleet_terminal_set():
    from worca.state.status import FleetStatus, FLEET_TERMINAL
    assert FleetStatus.COMPLETED in FLEET_TERMINAL
    assert FleetStatus.FAILED in FLEET_TERMINAL
    assert FleetStatus.HALTED in FLEET_TERMINAL
    assert FleetStatus.RUNNING not in FLEET_TERMINAL
    assert FleetStatus.PAUSED not in FLEET_TERMINAL
    assert len(FLEET_TERMINAL) == 3


def test_fleet_terminal_accepts_raw_strings():
    from worca.state.status import FLEET_TERMINAL
    assert "completed" in FLEET_TERMINAL
    assert "failed" in FLEET_TERMINAL
    assert "halted" in FLEET_TERMINAL


# --- resolve_status with enums ---

def test_resolve_status_returns_value_comparable_to_enum():
    from worca.state.status import PipelineStatus, resolve_status
    assert resolve_status("in_progress") == PipelineStatus.RUNNING
    assert resolve_status("error") == PipelineStatus.FAILED


# --- init_status uses enum ---

def test_init_status_pipeline_status_is_enum_compatible():
    from worca.state.status import PipelineStatus, init_status
    wr = {"title": "Test"}
    result = init_status(wr, "feat/test")
    assert result["pipeline_status"] == PipelineStatus.PENDING
    assert result["pipeline_status"] == "pending"
