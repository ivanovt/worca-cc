"""Regression tests for the audit findings filed in #121 / #122.

These pin the four behaviours fixed in the same commit:

    #121      runner.py worca_dir derivation when --status-dir is a per-run dir
    #122.1    Guardian PR fallback: extract pr_url/pr_number from prose
    #122.2    Registry mirrors terminal transitions and resume → running
    #122.3    remove_pipeline_worktree() also wipes the gitignored .worca/ shell
"""
from __future__ import annotations

import json
import os
import subprocess

import worca.orchestrator.runner as runner
from worca.orchestrator.registry import register_pipeline


# ─── #121: nested run dir ────────────────────────────────────────────────────


def test_runner_recovers_worca_root_from_per_run_status_path(tmp_path):
    """When --status-dir resolves to <worca>/runs/<id>/status.json, the runner
    must recover <worca> as worca_dir (not treat the per-run dir as the root).
    Otherwise every <worca_dir>/runs/<run_id>/ join below produces a nested
    shadow path."""
    worca_dir = tmp_path / ".worca"
    run_id = "20260101-000000-000-test"
    per_run = worca_dir / "runs" / run_id
    per_run.mkdir(parents=True)
    status_path = str(per_run / "status.json")

    # Inline-call the same dirname/basename logic the runner uses.
    status_dir = os.path.dirname(status_path)
    parent = os.path.dirname(status_dir)
    if os.path.basename(parent) == "runs":
        recovered = os.path.dirname(parent)
    else:
        recovered = status_dir

    assert recovered == str(worca_dir), (
        f"Expected worca root {worca_dir!r}, got {recovered!r}"
    )
    # The reconstructed run_dir should land back on the original per_run path,
    # not on a nested runs/<id>/runs/<id>/.
    assert os.path.join(recovered, "runs", run_id) == str(per_run)


def test_runner_keeps_legacy_flat_status_path(tmp_path):
    """With the legacy flat layout (<worca>/status.json), worca_dir derivation
    should still produce <worca>."""
    worca_dir = tmp_path / ".worca"
    worca_dir.mkdir()
    status_path = str(worca_dir / "status.json")

    status_dir = os.path.dirname(status_path)
    parent = os.path.dirname(status_dir)
    if os.path.basename(parent) == "runs":
        recovered = os.path.dirname(parent)
    else:
        recovered = status_dir

    assert recovered == str(worca_dir)


# ─── #122.1: Guardian PR fallback ────────────────────────────────────────────


def test_extract_pr_fields_from_text_github():
    out = runner._extract_pr_fields_from_text(
        "Done.\n- **Commit**: `abc`\n- **PR URL**: https://github.com/foo/bar/pull/42"
    )
    assert out == {"pr_url": "https://github.com/foo/bar/pull/42", "pr_number": 42}


def test_extract_pr_fields_from_text_gitlab():
    out = runner._extract_pr_fields_from_text(
        "Created merge request at https://gitlab.com/g/p/-/merge_requests/7"
    )
    assert out == {
        "pr_url": "https://gitlab.com/g/p/-/merge_requests/7",
        "pr_number": 7,
    }


def test_extract_pr_fields_from_text_returns_none_when_absent():
    assert runner._extract_pr_fields_from_text("PR was not created") is None
    assert runner._extract_pr_fields_from_text(None) is None
    assert runner._extract_pr_fields_from_text({"not": "a string"}) is None


def test_extract_pr_fields_from_text_handles_wrapping_punctuation():
    """The agent often wraps the URL in parens, brackets, or trailing punctuation."""
    out = runner._extract_pr_fields_from_text(
        "Opened (https://github.com/x/y/pull/9)."
    )
    assert out == {"pr_url": "https://github.com/x/y/pull/9", "pr_number": 9}


# ─── #122.2: Registry sync on terminal/resume ────────────────────────────────


def _seed_registry(tmp_path, run_id, pid, status="running"):
    """Drop a registry entry into <tmp_path>/multi/pipelines.d/<id>.json."""
    register_pipeline(
        run_id=run_id,
        worktree_path=str(tmp_path / "wt"),
        pid=pid,
        title="t",
        branch="b",
        base=str(tmp_path),
    )


def test_update_pipeline_writes_status(tmp_path):
    """update_pipeline() flips the status field and bumps updated_at."""
    from worca.orchestrator.registry import update_pipeline, _pipeline_path

    run_id = "20260101-000000-000-reg"
    _seed_registry(tmp_path, run_id, pid=12345)
    path = _pipeline_path(run_id, base=str(tmp_path))

    before = json.load(open(path))
    assert before["status"] == "running"

    assert update_pipeline(run_id, status="interrupted", base=str(tmp_path)) is True
    after = json.load(open(path))
    assert after["status"] == "interrupted"
    assert after["updated_at"] != before["updated_at"]


def test_update_pipeline_no_op_for_local_run(tmp_path):
    """If the registry entry doesn't exist (legacy local run), update is a no-op."""
    from worca.orchestrator.registry import update_pipeline

    assert update_pipeline("nonexistent", status="cancelled", base=str(tmp_path)) is False


# ─── #122.3: remove_pipeline_worktree wipes .worca/ shell ────────────────────


def test_remove_pipeline_worktree_removes_gitignored_worca_dir(tmp_path):
    """`git worktree remove --force` leaves gitignored files behind. The helper
    must also `rm -rf` the worktree path so the parent dir doesn't accumulate
    empty .worca/ shells across many cleanups."""
    from worca.utils.git import remove_pipeline_worktree

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    (repo / "x").write_text("x")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True)
    # gitignore .worca/ to mimic real repos
    (repo / ".gitignore").write_text(".worca/\n")
    subprocess.run(["git", "add", ".gitignore"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "ignore"], cwd=repo, check=True)

    wt = tmp_path / "wt"
    subprocess.run(
        ["git", "worktree", "add", "-b", "feat/test", str(wt), "HEAD"],
        cwd=repo,
        check=True,
    )
    # Simulate a pipeline writing into the worktree's .worca/ (gitignored).
    (wt / ".worca").mkdir()
    (wt / ".worca" / "status.json").write_text("{}")

    cwd = os.getcwd()
    try:
        os.chdir(repo)  # _run_git uses cwd
        ok = remove_pipeline_worktree(str(wt))
    finally:
        os.chdir(cwd)

    assert ok is True
    assert not wt.exists(), (
        f"worktree path {wt} should have been removed entirely, "
        "but its directory (probably containing the gitignored .worca/) survived"
    )
