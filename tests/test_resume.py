"""Tests for worca.orchestrator.resume — checkpoint and resume logic."""

import json
import os

from worca.orchestrator.resume import (
    find_resume_point,
    reconstruct_context,
    can_resume,
    find_last_completed_iteration,
    get_resume_iteration,
    restore_loop_counters,
    check_git_divergence,
    backfill_prompt_context,
    _STAGE_CONTEXT_MAP,
)
from worca.orchestrator.stages import Stage


def test_finds_in_progress_stage():
    status = {
        "stages": {
            "plan": {"status": "completed"},
            "plan_review": {"status": "completed"},
            "coordinate": {"status": "completed"},
            "implement": {"status": "in_progress"},
            "test": {"status": "pending"},
            "review": {"status": "pending"},
            "pr": {"status": "pending"},
        },
        "milestones": {"plan_approved": True},
    }
    assert find_resume_point(status) == Stage.PREFLIGHT


def test_finds_pending_after_completed():
    status = {
        "stages": {
            "plan": {"status": "completed"},
            "plan_review": {"status": "completed"},
            "coordinate": {"status": "completed"},
            "implement": {"status": "pending"},
            "test": {"status": "pending"},
            "review": {"status": "pending"},
            "pr": {"status": "pending"},
        },
        "milestones": {"plan_approved": True},
    }
    assert find_resume_point(status) == Stage.PREFLIGHT


def test_finds_milestone_gate():
    status = {
        "stages": {"plan": {"status": "completed"}},
        "milestones": {"plan_approved": None},
    }
    assert find_resume_point(status) == Stage.PREFLIGHT


def test_finds_review_milestone_gate():
    status = {
        "stages": {
            "plan": {"status": "completed"},
            "plan_review": {"status": "completed"},
            "coordinate": {"status": "completed"},
            "implement": {"status": "completed"},
            "test": {"status": "completed"},
            "review": {"status": "completed"},
            "pr": {"status": "pending"},
        },
        "milestones": {"plan_approved": True, "pr_approved": None},
    }
    assert find_resume_point(status) == Stage.PREFLIGHT


def test_always_returns_preflight_when_preflight_already_completed():
    """On resume, always returns PREFLIGHT even if it completed in a prior run."""
    status = {
        "stages": {
            "preflight": {"status": "completed"},
            "plan": {"status": "completed"},
            "plan_review": {"status": "completed"},
            "coordinate": {"status": "completed"},
            "implement": {"status": "in_progress"},
            "test": {"status": "pending"},
            "review": {"status": "pending"},
            "pr": {"status": "pending"},
        },
        "milestones": {"plan_approved": True},
    }
    assert find_resume_point(status) == Stage.PREFLIGHT


def test_all_completed_returns_none():
    status = {
        "stages": {s.value: {"status": "completed"} for s in Stage},
        "milestones": {"plan_approved": True, "pr_approved": True},
    }
    assert find_resume_point(status) is None


def test_all_pending_returns_preflight():
    status = {
        "stages": {s.value: {"status": "pending"} for s in Stage},
        "milestones": {},
    }
    assert find_resume_point(status) == Stage.PREFLIGHT


def test_reconstruct_context_reads_completed_logs(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(logs_dir)

    # Write log files for completed stages
    with open(os.path.join(logs_dir, "plan.json"), "w") as f:
        json.dump({"approach": "modular"}, f)
    with open(os.path.join(logs_dir, "coordinate.json"), "w") as f:
        json.dump({"tasks": ["a", "b"]}, f)

    status = {
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "completed"},
            "implement": {"status": "in_progress"},
            "test": {"status": "pending"},
            "review": {"status": "pending"},
            "pr": {"status": "pending"},
        }
    }
    ctx = reconstruct_context(status, logs_dir)
    assert ctx["plan"] == {"approach": "modular"}
    assert ctx["coordinate"] == {"tasks": ["a", "b"]}
    assert "implement" not in ctx


def test_reconstruct_context_skips_missing_logs(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(logs_dir)
    # No log files exist

    status = {
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "pending"},
        }
    }
    ctx = reconstruct_context(status, logs_dir)
    # plan is completed but no log file, so not in context
    assert "plan" not in ctx


def test_can_resume_true(tmp_path):
    status_path = str(tmp_path / "status.json")
    status = {
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "pending"},
        }
    }
    with open(status_path, "w") as f:
        json.dump(status, f)
    assert can_resume(status_path) is True


def test_can_resume_false_no_file(tmp_path):
    missing = str(tmp_path / "nonexistent.json")
    assert can_resume(missing) is False


def test_can_resume_false_all_pending(tmp_path):
    status_path = str(tmp_path / "status.json")
    status = {
        "stages": {
            "plan": {"status": "pending"},
            "coordinate": {"status": "pending"},
        }
    }
    with open(status_path, "w") as f:
        json.dump(status, f)
    assert can_resume(status_path) is False


def test_reconstruct_context_reads_nested_logs(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "plan"))
    os.makedirs(os.path.join(logs_dir, "coordinate"))

    with open(os.path.join(logs_dir, "plan", "iter-1.json"), "w") as f:
        json.dump({"approach": "modular"}, f)
    with open(os.path.join(logs_dir, "coordinate", "iter-1.json"), "w") as f:
        json.dump({"tasks": ["a", "b"]}, f)

    status = {
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "completed"},
            "implement": {"status": "in_progress"},
        }
    }
    ctx = reconstruct_context(status, logs_dir)
    assert ctx["plan"] == {"approach": "modular"}
    assert ctx["coordinate"] == {"tasks": ["a", "b"]}
    assert "implement" not in ctx


def test_reconstruct_context_picks_latest_iteration(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "implement"))

    with open(os.path.join(logs_dir, "implement", "iter-1.json"), "w") as f:
        json.dump({"files_changed": 2}, f)
    with open(os.path.join(logs_dir, "implement", "iter-2.json"), "w") as f:
        json.dump({"files_changed": 1}, f)

    status = {
        "stages": {
            "implement": {"status": "completed"},
        }
    }
    ctx = reconstruct_context(status, logs_dir)
    assert ctx["implement"] == {"files_changed": 1}


def test_can_resume_finds_status_via_runs_scan(tmp_path):
    """can_resume finds status via runs/ directory scan (no active_run pointer needed)."""
    worca_dir = tmp_path / ".worca"
    run_id = "20260309-171545"
    run_dir = worca_dir / "runs" / run_id
    run_dir.mkdir(parents=True)

    status = {
        "run_id": run_id,
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "pending"},
        },
    }
    with open(str(run_dir / "status.json"), "w") as f:
        json.dump(status, f)

    # No active_run pointer and no flat status.json — can_resume scans runs/
    assert not (worca_dir / "active_run").exists()
    assert not (worca_dir / "status.json").exists()
    assert can_resume(str(worca_dir / "status.json")) is True


def test_reconstruct_context_uses_run_id(tmp_path, monkeypatch):
    """reconstruct_context derives logs_dir from run_id when no explicit logs_dir given."""
    monkeypatch.chdir(tmp_path)
    worca_dir = tmp_path / ".worca"
    run_id = "20260309-180000"
    logs_dir = worca_dir / "runs" / run_id / "logs"
    plan_dir = logs_dir / "plan"
    plan_dir.mkdir(parents=True)

    with open(str(plan_dir / "iter-1.json"), "w") as f:
        json.dump({"approach": "per-run"}, f)

    status = {
        "run_id": run_id,
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "pending"},
        },
    }
    ctx = reconstruct_context(status)  # No explicit logs_dir
    assert ctx["plan"] == {"approach": "per-run"}


# ---------------------------------------------------------------------------
# find_last_completed_iteration
# ---------------------------------------------------------------------------

def test_find_last_completed_iteration_no_iterations():
    assert find_last_completed_iteration({}) is None


def test_find_last_completed_iteration_empty_list():
    assert find_last_completed_iteration({"iterations": []}) is None


def test_find_last_completed_iteration_all_completed():
    stage_data = {
        "iterations": [
            {"number": 1, "status": "completed"},
            {"number": 2, "status": "completed"},
        ]
    }
    assert find_last_completed_iteration(stage_data) == 2


def test_find_last_completed_iteration_discards_in_progress():
    stage_data = {
        "iterations": [
            {"number": 1, "status": "completed"},
            {"number": 2, "status": "completed"},
            {"number": 3, "status": "in_progress"},
        ]
    }
    assert find_last_completed_iteration(stage_data) == 2


def test_find_last_completed_iteration_only_in_progress():
    stage_data = {
        "iterations": [
            {"number": 1, "status": "in_progress"},
        ]
    }
    assert find_last_completed_iteration(stage_data) is None


# ---------------------------------------------------------------------------
# get_resume_iteration
# ---------------------------------------------------------------------------

def test_get_resume_iteration_no_completed():
    assert get_resume_iteration({}) == 1


def test_get_resume_iteration_after_two_completed_one_in_progress():
    stage_data = {
        "iterations": [
            {"number": 1, "status": "completed"},
            {"number": 2, "status": "completed"},
            {"number": 3, "status": "in_progress"},
        ]
    }
    assert get_resume_iteration(stage_data) == 3


def test_get_resume_iteration_after_all_completed():
    stage_data = {
        "iterations": [
            {"number": 1, "status": "completed"},
            {"number": 2, "status": "completed"},
        ]
    }
    assert get_resume_iteration(stage_data) == 3


# ---------------------------------------------------------------------------
# restore_loop_counters
# ---------------------------------------------------------------------------

def test_restore_loop_counters_returns_from_status():
    status = {"loop_counters": {"implement_test": 3, "pr_changes": 0}}
    assert restore_loop_counters(status) == {"implement_test": 3, "pr_changes": 0}


def test_restore_loop_counters_empty_when_missing():
    assert restore_loop_counters({}) == {}


def test_restore_loop_counters_none_value():
    assert restore_loop_counters({"loop_counters": None}) == {}


# ---------------------------------------------------------------------------
# reconstruct_context — in_progress stage with completed iterations
# ---------------------------------------------------------------------------

def test_reconstruct_context_in_progress_stage_uses_last_completed_iter(tmp_path):
    """in_progress stage with completed iterations yields context from last completed iter."""
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "implement"))

    with open(os.path.join(logs_dir, "implement", "iter-1.json"), "w") as f:
        json.dump({"files_changed": ["a.py"]}, f)
    with open(os.path.join(logs_dir, "implement", "iter-2.json"), "w") as f:
        json.dump({"files_changed": ["a.py", "b.py"]}, f)
    # iter-3 is in_progress (no log file yet)

    status = {
        "stages": {
            "implement": {
                "status": "in_progress",
                "iterations": [
                    {"number": 1, "status": "completed"},
                    {"number": 2, "status": "completed"},
                    {"number": 3, "status": "in_progress"},
                ],
            }
        }
    }
    ctx = reconstruct_context(status, logs_dir)
    assert ctx["implement"] == {"files_changed": ["a.py", "b.py"]}


def test_reconstruct_context_in_progress_no_completed_iters_excluded(tmp_path):
    """in_progress stage with no completed iterations is excluded from context."""
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "implement"))

    status = {
        "stages": {
            "implement": {
                "status": "in_progress",
                "iterations": [
                    {"number": 1, "status": "in_progress"},
                ],
            }
        }
    }
    ctx = reconstruct_context(status, logs_dir)
    assert "implement" not in ctx


# ---------------------------------------------------------------------------
# check_git_divergence
# ---------------------------------------------------------------------------

def test_check_git_divergence_no_divergence():
    """Same SHA in status and current HEAD → not diverged."""
    sha = "abc123def456abc123def456abc123def456abc1"
    status = {"git_head": sha}
    result = check_git_divergence(status, current_head=sha)
    assert result["diverged"] is False
    assert result["stored"] == sha
    assert result["current"] == sha


def test_check_git_divergence_diverged():
    """Different SHA in status vs current HEAD → diverged."""
    stored = "aaa0000000000000000000000000000000000001"
    current = "bbb0000000000000000000000000000000000002"
    status = {"git_head": stored}
    result = check_git_divergence(status, current_head=current)
    assert result["diverged"] is True
    assert result["stored"] == stored
    assert result["current"] == current


def test_check_git_divergence_no_stored_head():
    """No git_head in status → not diverged (can't compare)."""
    status = {"stages": {}}
    result = check_git_divergence(status, current_head="abc123")
    assert result["diverged"] is False
    assert result["stored"] is None


def test_check_git_divergence_empty_stored_head():
    """Empty git_head in status → not diverged (treated as no stored head)."""
    status = {"git_head": ""}
    result = check_git_divergence(status, current_head="abc123")
    assert result["diverged"] is False
    assert result["stored"] is None


def test_check_git_divergence_calls_get_current_git_head_when_not_injected():
    """When current_head not provided, calls get_current_git_head()."""
    from unittest.mock import patch
    sha = "deadbeef" * 5
    status = {"git_head": sha}
    with patch("worca.orchestrator.resume.get_current_git_head", return_value=sha) as mock_head:
        result = check_git_divergence(status)
    mock_head.assert_called_once()
    assert result["diverged"] is False


# ---------------------------------------------------------------------------
# PLAN_REVIEW crash and resume scenarios
# ---------------------------------------------------------------------------

def test_crash_during_plan_review_resumes_from_preflight():
    """Crash while PLAN_REVIEW is in_progress → resume starts from PREFLIGHT."""
    status = {
        "stages": {
            "plan": {"status": "completed"},
            "plan_review": {"status": "in_progress"},
            "coordinate": {"status": "pending"},
            "implement": {"status": "pending"},
            "test": {"status": "pending"},
            "review": {"status": "pending"},
            "pr": {"status": "pending"},
        },
        "milestones": {"plan_approved": True},
    }
    assert find_resume_point(status) == Stage.PREFLIGHT


def test_crash_after_plan_review_loop_back_plan_is_pending():
    """After PLAN_REVIEW loop-back atomic persist, PLAN is reset to pending.

    The runner writes context keys and resets PLAN status (skipped=False) before
    any in-memory transitions.  On crash, PLAN is pending and find_resume_point
    returns PREFLIGHT so the stage re-runs in revision mode (driven by the
    persisted plan_revision_mode context key).
    """
    status = {
        "stages": {
            "plan": {"status": "pending", "skipped": False},
            "plan_review": {"status": "completed"},
            "coordinate": {"status": "pending"},
            "implement": {"status": "pending"},
            "test": {"status": "pending"},
            "review": {"status": "pending"},
            "pr": {"status": "pending"},
        },
        "milestones": {},
        "loop_counters": {"plan_review": 1},
    }
    assert find_resume_point(status) == Stage.PREFLIGHT


def test_plan_review_loop_counter_persists_across_crash():
    """Loop counter incremented before save_status survives crash and resume.

    The runner increments loop_counters['plan_review'] and calls save_status()
    before any in-memory transitions, so the counter is durable.
    restore_loop_counters() recovers it on the next run.
    """
    status = {
        "stages": {
            "plan": {"status": "pending"},
            "plan_review": {"status": "completed"},
            "coordinate": {"status": "pending"},
            "implement": {"status": "pending"},
            "test": {"status": "pending"},
            "review": {"status": "pending"},
            "pr": {"status": "pending"},
        },
        "loop_counters": {"plan_review": 1},
    }
    counters = restore_loop_counters(status)
    assert counters["plan_review"] == 1


def test_can_resume_no_active_run(tmp_path):
    """can_resume finds status via runs/ scan without any active_run pointer."""
    worca_dir = tmp_path / ".worca"
    run_id = "20260426-120000-000-abcd"
    run_dir = worca_dir / "runs" / run_id
    run_dir.mkdir(parents=True)

    status = {
        "run_id": run_id,
        "pipeline_status": "running",
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "pending"},
        },
    }
    (run_dir / "status.json").write_text(json.dumps(status))

    assert not (worca_dir / "active_run").exists()
    assert not (worca_dir / "status.json").exists()

    assert can_resume(str(worca_dir / "status.json")) is True


def test_can_resume_with_run_id(tmp_path):
    """can_resume(run_id=...) does a direct per-run lookup."""
    worca_dir = tmp_path / ".worca"
    run_id = "20260426-120000-000-abcd"
    run_dir = worca_dir / "runs" / run_id
    run_dir.mkdir(parents=True)

    status = {
        "run_id": run_id,
        "stages": {
            "plan": {"status": "completed"},
            "coordinate": {"status": "pending"},
        },
    }
    (run_dir / "status.json").write_text(json.dumps(status))

    assert can_resume(str(worca_dir / "status.json"), run_id=run_id) is True


def test_reconstruct_context_plan_review_completed_plan_pending(tmp_path):
    """After loop-back, PLAN_REVIEW is completed and PLAN is pending.

    reconstruct_context includes the plan_review output (completed) and
    excludes plan (pending), so the revision prompt builder can read
    prior review issues from the runner-persisted context keys instead.
    """
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "plan_review"))

    review_output = {
        "outcome": "revise",
        "issues": [{"category": "completeness", "severity": "major", "description": "missing edge case"}],
        "summary": "Plan is incomplete",
    }
    with open(os.path.join(logs_dir, "plan_review", "iter-1.json"), "w") as f:
        json.dump(review_output, f)

    status = {
        "stages": {
            "plan": {"status": "pending", "skipped": False},
            "plan_review": {"status": "completed"},
        },
    }
    ctx = reconstruct_context(status, logs_dir)
    assert "plan" not in ctx
    assert ctx["plan_review"]["outcome"] == "revise"
    assert ctx["plan_review"]["summary"] == "Plan is incomplete"


# ---------------------------------------------------------------------------
# _STAGE_CONTEXT_MAP
# ---------------------------------------------------------------------------

def test_stage_context_map_covers_expected_stages():
    expected_stages = {"coordinate", "implement", "test", "review", "plan"}
    assert expected_stages <= set(_STAGE_CONTEXT_MAP.keys())


def test_stage_context_map_coordinate_entries():
    keys = dict(_STAGE_CONTEXT_MAP["coordinate"])
    assert "beads_ids" in keys
    assert "dependency_graph" in keys
    assert keys["beads_ids"] == "beads_ids"
    assert keys["dependency_graph"] == "dependency_graph"


def test_stage_context_map_implement_entries():
    keys = dict(_STAGE_CONTEXT_MAP["implement"])
    assert keys.get("files_changed") == "files_changed"
    assert keys.get("tests_added") == "tests_added"


def test_stage_context_map_test_entries():
    keys = dict(_STAGE_CONTEXT_MAP["test"])
    assert keys.get("passed") == "test_passed"
    assert keys.get("coverage_pct") == "test_coverage"
    assert keys.get("proof_artifacts") == "proof_artifacts"


def test_stage_context_map_review_entries():
    keys = dict(_STAGE_CONTEXT_MAP["review"])
    assert keys.get("issues") == "review_issues"


def test_stage_context_map_plan_entries():
    keys = dict(_STAGE_CONTEXT_MAP["plan"])
    assert keys.get("approach") == "plan_approach"
    assert keys.get("tasks_outline") == "plan_tasks_outline"


# ---------------------------------------------------------------------------
# backfill_prompt_context
# ---------------------------------------------------------------------------

class _FakePromptBuilder:
    """Minimal stand-in for PromptBuilder for backfill tests."""

    def __init__(self, initial=None):
        self._context = dict(initial or {})

    def get_context(self, key, default=None):
        return self._context.get(key, default)

    def update_context(self, key, value):
        self._context[key] = value


def test_backfill_populates_missing_keys_from_coordinate_log(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "coordinate"))
    with open(os.path.join(logs_dir, "coordinate", "iter-1.json"), "w") as f:
        json.dump({"beads_ids": ["b1", "b2"], "dependency_graph": {"b2": ["b1"]}}, f)

    status = {"stages": {"coordinate": {"status": "completed"}}}
    pb = _FakePromptBuilder()
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert pb.get_context("beads_ids") == ["b1", "b2"]
    assert pb.get_context("dependency_graph") == {"b2": ["b1"]}
    assert "beads_ids" in filled
    assert "dependency_graph" in filled


def test_backfill_does_not_overwrite_existing_keys(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "coordinate"))
    with open(os.path.join(logs_dir, "coordinate", "iter-1.json"), "w") as f:
        json.dump({"beads_ids": ["b-from-log"], "dependency_graph": {}}, f)

    status = {"stages": {"coordinate": {"status": "completed"}}}
    pb = _FakePromptBuilder({"beads_ids": ["b-already-set"]})
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert pb.get_context("beads_ids") == ["b-already-set"], "must not overwrite existing key"
    assert "beads_ids" not in filled, "already-present key must not appear in filled list"


def test_backfill_populates_test_stage_with_field_renames(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "test"))
    with open(os.path.join(logs_dir, "test", "iter-1.json"), "w") as f:
        json.dump({"passed": True, "coverage_pct": 85.0, "proof_artifacts": ["proof.txt"]}, f)

    status = {"stages": {"test": {"status": "completed"}}}
    pb = _FakePromptBuilder()
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert pb.get_context("test_passed") is True
    assert pb.get_context("test_coverage") == 85.0
    assert pb.get_context("proof_artifacts") == ["proof.txt"]
    assert "test_passed" in filled
    assert "test_coverage" in filled
    assert "proof_artifacts" in filled


def test_backfill_populates_plan_stage_with_field_renames(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "plan"))
    with open(os.path.join(logs_dir, "plan", "iter-1.json"), "w") as f:
        json.dump({"approach": "incremental", "tasks_outline": [{"title": "T1"}]}, f)

    status = {"stages": {"plan": {"status": "completed"}}}
    pb = _FakePromptBuilder()
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert pb.get_context("plan_approach") == "incremental"
    assert pb.get_context("plan_tasks_outline") == [{"title": "T1"}]
    assert "plan_approach" in filled
    assert "plan_tasks_outline" in filled


def test_backfill_populates_review_stage_issues(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "review"))
    issues = [{"severity": "critical", "description": "null deref"}]
    with open(os.path.join(logs_dir, "review", "iter-1.json"), "w") as f:
        json.dump({"outcome": "request_changes", "issues": issues}, f)

    status = {"stages": {"review": {"status": "completed"}}}
    pb = _FakePromptBuilder()
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert pb.get_context("review_issues") == issues
    assert "review_issues" in filled


def test_backfill_skips_absent_output_fields(tmp_path):
    """Stage output missing a mapped field does not set that context key."""
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "test"))
    with open(os.path.join(logs_dir, "test", "iter-1.json"), "w") as f:
        json.dump({"passed": False}, f)  # coverage_pct and proof_artifacts absent

    status = {"stages": {"test": {"status": "completed"}}}
    pb = _FakePromptBuilder()
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert pb.get_context("test_passed") is False
    assert pb.get_context("test_coverage") is None, "absent field must not set key"
    assert pb.get_context("proof_artifacts") is None
    assert "test_coverage" not in filled
    assert "proof_artifacts" not in filled


def test_backfill_returns_list_of_filled_key_names(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "implement"))
    with open(os.path.join(logs_dir, "implement", "iter-1.json"), "w") as f:
        json.dump({"files_changed": ["a.py"], "tests_added": ["test_a.py"]}, f)

    status = {"stages": {"implement": {"status": "completed"}}}
    pb = _FakePromptBuilder()
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert isinstance(filled, list)
    assert set(filled) == {"files_changed", "tests_added"}


def test_backfill_no_logs_returns_empty_list(tmp_path):
    logs_dir = str(tmp_path / "logs")
    os.makedirs(logs_dir)  # empty directory

    status = {"stages": {"implement": {"status": "completed"}}}
    pb = _FakePromptBuilder()
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert filled == []
    assert pb.get_context("files_changed") is None


def test_backfill_ignores_stages_not_in_map(tmp_path):
    """Stages not in _STAGE_CONTEXT_MAP (e.g. preflight) are silently skipped."""
    logs_dir = str(tmp_path / "logs")
    os.makedirs(os.path.join(logs_dir, "preflight"))
    with open(os.path.join(logs_dir, "preflight", "iter-1.json"), "w") as f:
        json.dump({"ok": True}, f)

    status = {"stages": {"preflight": {"status": "completed"}}}
    pb = _FakePromptBuilder()
    filled = backfill_prompt_context(pb, status, logs_dir)

    assert filled == []
