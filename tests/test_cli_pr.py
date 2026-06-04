"""Unit tests for worca pr create CLI (W-065 §4).

Tests cover:
- reconcile-existing-PR (gh pr list finds one → skip gh pr create)
- stale-lock-reclaim (in_progress but > 5min → proceed)
- idempotent-when-pr_url-set (pr_url already present → exit 0)
- lock-block-shape (fresh in_progress lock → exit 1)
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_status(
    *,
    deferred: bool = True,
    pr_url: str | None = None,
    pr_creation: dict | None = None,
    pr_title: str = "feat: my feature",
    pr_body: str = "## Summary\n- added feature",
    base_branch: str = "main",
    head_branch: str = "worca/my-feature-20260604",
) -> dict:
    stages: dict = {}
    if deferred:
        stages["pr"] = {
            "outcome": "success",
            "deferred": True,
            "commit_sha": "abc1234",
            "pr_title": pr_title,
            "pr_body": pr_body,
            "base_branch": base_branch,
            "source_branch": head_branch,
        }
    status = {
        "run_id": "20260604-151817-268-abc",
        "status": "completed",
        "branch": head_branch,
        "stages": stages,
    }
    if pr_url is not None:
        status["pr_url"] = pr_url
    if pr_creation is not None:
        status["pr_creation"] = pr_creation
    return status


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestIdempotentWhenPrUrlSet:
    """If pr_url is already in status.json, pr create is a no-op."""

    def test_exits_zero_when_pr_url_already_set(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        status = _make_status(pr_url="https://github.com/owner/repo/pull/42")
        status_path.write_text(json.dumps(status))

        with patch("worca.cli.pr.get_pipeline") as mock_get:
            mock_get.return_value = {"worktree_path": worktree}
            result = _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        assert result == 0

    def test_prints_existing_pr_url(self, tmp_path, capsys):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        pr_url = "https://github.com/owner/repo/pull/42"
        status = _make_status(pr_url=pr_url)
        status_path.write_text(json.dumps(status))

        with patch("worca.cli.pr.get_pipeline") as mock_get:
            mock_get.return_value = {"worktree_path": worktree}
            _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        captured = capsys.readouterr()
        assert pr_url in captured.out


class TestLockBlockShape:
    """Fresh in_progress lock (< 5min) → exit 1 with clear message."""

    def test_fresh_lock_blocks(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        now_iso = datetime.now(timezone.utc).isoformat()
        status = _make_status(
            pr_creation={"state": "in_progress", "started_at": now_iso}
        )
        status_path.write_text(json.dumps(status))

        with patch("worca.cli.pr.get_pipeline") as mock_get:
            mock_get.return_value = {"worktree_path": worktree}
            result = _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        assert result == 1

    def test_fresh_lock_message_mentions_in_progress(self, tmp_path, capsys):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        now_iso = datetime.now(timezone.utc).isoformat()
        status = _make_status(
            pr_creation={"state": "in_progress", "started_at": now_iso}
        )
        status_path.write_text(json.dumps(status))

        with patch("worca.cli.pr.get_pipeline") as mock_get:
            mock_get.return_value = {"worktree_path": worktree}
            _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        captured = capsys.readouterr()
        assert "in_progress" in captured.err or "in progress" in captured.err.lower()


class TestStaleLockReclaim:
    """Stale in_progress lock (> 5min) → proceed with PR creation."""

    def _stale_lock(self) -> dict:
        stale_time = datetime.now(timezone.utc) - timedelta(minutes=10)
        return {"state": "in_progress", "started_at": stale_time.isoformat()}

    def test_stale_lock_proceeds(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        status = _make_status(pr_creation=self._stale_lock())
        status_path.write_text(json.dumps(status))

        def fake_run(cmd, **kwargs):
            m = MagicMock()
            if "pr" in cmd and "list" in cmd:
                m.returncode = 0
                m.stdout = "[]"
            elif "pr" in cmd and "create" in cmd:
                m.returncode = 0
                m.stdout = "https://github.com/owner/repo/pull/99\n"
                m.stderr = ""
            else:
                m.returncode = 0
                m.stdout = ""
                m.stderr = ""
            return m

        with patch("worca.cli.pr.get_pipeline") as mock_get, \
             patch("subprocess.run", side_effect=fake_run):
            mock_get.return_value = {"worktree_path": worktree}
            result = _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        assert result == 0

    def test_stale_lock_writes_pr_url_to_status(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        status = _make_status(pr_creation=self._stale_lock())
        status_path.write_text(json.dumps(status))

        def fake_run(cmd, **kwargs):
            m = MagicMock()
            if "pr" in cmd and "list" in cmd:
                m.returncode = 0
                m.stdout = "[]"
            elif "pr" in cmd and "create" in cmd:
                m.returncode = 0
                m.stdout = "https://github.com/owner/repo/pull/99\n"
                m.stderr = ""
            else:
                m.returncode = 0
                m.stdout = ""
                m.stderr = ""
            return m

        with patch("worca.cli.pr.get_pipeline") as mock_get, \
             patch("subprocess.run", side_effect=fake_run):
            mock_get.return_value = {"worktree_path": worktree}
            _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        updated = json.loads(status_path.read_text())
        assert updated.get("pr_url") == "https://github.com/owner/repo/pull/99"


class TestReconcileExistingPR:
    """gh pr list finds an existing PR → use it, skip gh pr create."""

    def test_reconcile_skips_gh_pr_create(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        status = _make_status()
        status_path.write_text(json.dumps(status))

        existing_pr = [{"number": 55, "url": "https://github.com/owner/repo/pull/55"}]

        def fake_run(cmd, **kwargs):
            m = MagicMock()
            if "pr" in cmd and "list" in cmd:
                m.returncode = 0
                m.stdout = json.dumps(existing_pr)
            else:
                # gh pr create should NOT be called — if it is, fail test
                raise AssertionError(f"unexpected subprocess.run call: {cmd}")
            return m

        with patch("worca.cli.pr.get_pipeline") as mock_get, \
             patch("subprocess.run", side_effect=fake_run):
            mock_get.return_value = {"worktree_path": worktree}
            result = _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        assert result == 0

    def test_reconcile_writes_existing_pr_url(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        status = _make_status()
        status_path.write_text(json.dumps(status))

        existing_pr = [{"number": 55, "url": "https://github.com/owner/repo/pull/55"}]

        def fake_run(cmd, **kwargs):
            m = MagicMock()
            if "pr" in cmd and "list" in cmd:
                m.returncode = 0
                m.stdout = json.dumps(existing_pr)
            else:
                raise AssertionError(f"unexpected subprocess.run call: {cmd}")
            return m

        with patch("worca.cli.pr.get_pipeline") as mock_get, \
             patch("subprocess.run", side_effect=fake_run):
            mock_get.return_value = {"worktree_path": worktree}
            _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        updated = json.loads(status_path.read_text())
        assert updated.get("pr_url") == "https://github.com/owner/repo/pull/55"

    def test_reconcile_writes_pr_creation_block_done(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        status = _make_status()
        status_path.write_text(json.dumps(status))

        existing_pr = [{"number": 55, "url": "https://github.com/owner/repo/pull/55"}]

        def fake_run(cmd, **kwargs):
            m = MagicMock()
            if "pr" in cmd and "list" in cmd:
                m.returncode = 0
                m.stdout = json.dumps(existing_pr)
            else:
                raise AssertionError(f"unexpected call: {cmd}")
            return m

        with patch("worca.cli.pr.get_pipeline") as mock_get, \
             patch("subprocess.run", side_effect=fake_run):
            mock_get.return_value = {"worktree_path": worktree}
            _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        updated = json.loads(status_path.read_text())
        pr_creation = updated.get("pr_creation", {})
        assert pr_creation.get("state") == "done"
        assert "completed_at" in pr_creation
        assert pr_creation.get("pr_url") == "https://github.com/owner/repo/pull/55"


class TestDryRun:
    """--dry-run prints what would happen without executing gh commands."""

    def test_dry_run_exits_zero(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        status = _make_status()
        status_path.write_text(json.dumps(status))

        with patch("worca.cli.pr.get_pipeline") as mock_get, \
             patch("subprocess.run") as mock_subprocess:
            mock_get.return_value = {"worktree_path": worktree}
            result = _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=True,
                status_path=str(status_path),
            )

        assert result == 0
        mock_subprocess.assert_not_called()


class TestNotDeferred:
    """Run where deferred is not set → exit 1 with clear message."""

    def test_non_deferred_run_exits_nonzero(self, tmp_path):
        from worca.cli.pr import _run_pr_create

        status_path = tmp_path / "status.json"
        worktree = str(tmp_path)
        # No deferred:true in stages.pr
        status = _make_status(deferred=False)
        status_path.write_text(json.dumps(status))

        with patch("worca.cli.pr.get_pipeline") as mock_get:
            mock_get.return_value = {"worktree_path": worktree}
            result = _run_pr_create(
                run_id="20260604-151817-268-abc",
                project=str(tmp_path),
                dry_run=False,
                status_path=str(status_path),
            )

        assert result == 1
