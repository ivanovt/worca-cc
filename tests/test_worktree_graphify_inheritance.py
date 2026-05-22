"""Tests for worktree graphify inheritance.

Verifies that run_worktree materializes the parent project's graphify
config into worktree settings so worktrees:
1. Read the parent's GRAPH_REPORT.md via absolute path
2. Never run `graphify --update` (single-writer invariant)
3. Correctly resolve the parent's out_dir to an absolute path
"""

import json
import os
from unittest.mock import patch

import pytest

from worca.scripts.run_worktree import _materialize_graphify_for_worktree
from worca.utils.graphify import EffectiveGraphifyConfig


def _make_config(
    enabled=True,
    mode="structural",
    out_dir="graphify-out",
    update_on_preflight=True,
    update_on_guardian_post_commit=True,
    **kwargs,
):
    return EffectiveGraphifyConfig(
        enabled=enabled,
        mode=mode,
        backend=kwargs.get("backend"),
        model_profile=kwargs.get("model_profile"),
        out_dir=out_dir,
        update_on_preflight=update_on_preflight,
        update_on_guardian_post_commit=update_on_guardian_post_commit,
        min_repo_files=kwargs.get("min_repo_files", 100),
        version_range=kwargs.get("version_range", ">=4,<5"),
        reason=kwargs.get("reason"),
    )


@pytest.fixture
def parent_worktree(tmp_path):
    """Create a parent + worktree directory pair with settings.json."""
    parent = tmp_path / "parent"
    worktree = tmp_path / "worktree"
    parent.mkdir()
    worktree.mkdir()

    parent_claude = parent / ".claude"
    parent_claude.mkdir()
    parent_claude.joinpath("settings.json").write_text(json.dumps({
        "worca": {
            "graphify": {
                "enabled": True,
                "mode": "structural",
                "out_dir": "graphify-out",
            }
        }
    }))

    wt_claude = worktree / ".claude"
    wt_claude.mkdir()
    wt_claude.joinpath("settings.json").write_text(json.dumps({
        "worca": {
            "graphify": {
                "enabled": True,
                "mode": "structural",
            }
        }
    }))

    return parent, worktree


class TestMaterializeGraphifyGlobalKillSwitch:

    def test_global_off_overrides_project_enabled(self, tmp_path):
        """Global graphify.enabled=false prevents materialization even when parent project has enabled=true."""
        parent = tmp_path / "parent"
        worktree = tmp_path / "worktree"
        parent.mkdir()
        worktree.mkdir()

        parent_claude = parent / ".claude"
        parent_claude.mkdir()
        parent_claude.joinpath("settings.json").write_text(json.dumps({
            "worca": {"graphify": {"enabled": True, "mode": "structural"}}
        }))

        wt_claude = worktree / ".claude"
        wt_claude.mkdir()
        original_content = json.dumps({"worca": {"graphify": {"enabled": True}}})
        wt_claude.joinpath("settings.json").write_text(original_content)

        global_settings = {"worca": {"graphify": {"enabled": False}}}

        with patch(
            "worca.scripts.run_worktree.load_global_settings",
            return_value=global_settings,
        ):
            _materialize_graphify_for_worktree(str(parent), str(worktree))

        assert (worktree / ".claude" / "settings.json").read_text() == original_content

    def test_global_settings_passed_as_first_arg(self, tmp_path):
        """effective_graphify_config receives global settings, not parent settings twice."""
        parent = tmp_path / "parent"
        worktree = tmp_path / "worktree"
        parent.mkdir()
        worktree.mkdir()

        parent_claude = parent / ".claude"
        parent_claude.mkdir()
        parent_claude.joinpath("settings.json").write_text(json.dumps({
            "worca": {"graphify": {"enabled": True}}
        }))

        wt_claude = worktree / ".claude"
        wt_claude.mkdir()
        wt_claude.joinpath("settings.json").write_text(json.dumps({"worca": {}}))

        sentinel_global = {"worca": {"graphify": {"enabled": True}}}
        cfg = _make_config(enabled=True)

        with patch(
            "worca.scripts.run_worktree.load_global_settings",
            return_value=sentinel_global,
        ) as mock_load_global, patch(
            "worca.scripts.run_worktree.effective_graphify_config",
            return_value=cfg,
        ) as mock_effective:
            _materialize_graphify_for_worktree(str(parent), str(worktree))

        mock_load_global.assert_called_once()
        call_args = mock_effective.call_args
        assert call_args[0][0] is sentinel_global


class TestMaterializeGraphifyForWorktree:

    def test_worktree_reads_parent_graph_path(self, parent_worktree):
        """Worktree settings get parent's graphify-out/ as absolute path."""
        parent, worktree = parent_worktree

        cfg = _make_config(enabled=True, out_dir="graphify-out")
        with patch(
            "worca.scripts.run_worktree.effective_graphify_config",
            return_value=cfg,
        ):
            _materialize_graphify_for_worktree(str(parent), str(worktree))

        wt_settings = json.loads(
            (worktree / ".claude" / "settings.json").read_text()
        )
        out_dir = wt_settings["worca"]["graphify"]["out_dir"]
        expected = os.path.join(os.path.abspath(str(parent)), "graphify-out")
        assert out_dir == expected
        assert os.path.isabs(out_dir)

    def test_worktree_preflight_skips_update(self, parent_worktree):
        """Worktree graphify config disables both update_on flags."""
        parent, worktree = parent_worktree

        cfg = _make_config(enabled=True)
        with patch(
            "worca.scripts.run_worktree.effective_graphify_config",
            return_value=cfg,
        ):
            _materialize_graphify_for_worktree(str(parent), str(worktree))

        wt_settings = json.loads(
            (worktree / ".claude" / "settings.json").read_text()
        )
        update_on = wt_settings["worca"]["graphify"]["update_on"]
        assert update_on["preflight"] is False
        assert update_on["guardian_post_commit"] is False

    def test_parent_path_correctly_resolved(self, parent_worktree):
        """Relative out_dir in parent config resolved to absolute path."""
        parent, worktree = parent_worktree

        cfg = _make_config(enabled=True, out_dir="custom-graph-dir")
        with patch(
            "worca.scripts.run_worktree.effective_graphify_config",
            return_value=cfg,
        ):
            _materialize_graphify_for_worktree(str(parent), str(worktree))

        wt_settings = json.loads(
            (worktree / ".claude" / "settings.json").read_text()
        )
        out_dir = wt_settings["worca"]["graphify"]["out_dir"]
        expected = os.path.join(os.path.abspath(str(parent)), "custom-graph-dir")
        assert out_dir == expected

    def test_absolute_out_dir_preserved(self, parent_worktree):
        """Already-absolute out_dir is passed through unchanged."""
        parent, worktree = parent_worktree

        cfg = _make_config(enabled=True, out_dir="/shared/graph-out")
        with patch(
            "worca.scripts.run_worktree.effective_graphify_config",
            return_value=cfg,
        ):
            _materialize_graphify_for_worktree(str(parent), str(worktree))

        wt_settings = json.loads(
            (worktree / ".claude" / "settings.json").read_text()
        )
        assert wt_settings["worca"]["graphify"]["out_dir"] == "/shared/graph-out"

    def test_graphify_disabled_no_materialization(self, parent_worktree):
        """If graphify is disabled in parent, worktree settings unchanged."""
        parent, worktree = parent_worktree

        original = (worktree / ".claude" / "settings.json").read_text()

        cfg = _make_config(enabled=False, reason="global-off")
        with patch(
            "worca.scripts.run_worktree.effective_graphify_config",
            return_value=cfg,
        ):
            _materialize_graphify_for_worktree(str(parent), str(worktree))

        assert (worktree / ".claude" / "settings.json").read_text() == original

    def test_worktree_missing_settings_is_noop(self, tmp_path):
        """No crash when worktree has no settings.json."""
        parent = tmp_path / "parent"
        worktree = tmp_path / "worktree"
        parent.mkdir()
        worktree.mkdir()

        parent_claude = parent / ".claude"
        parent_claude.mkdir()
        parent_claude.joinpath("settings.json").write_text('{"worca": {}}')

        cfg = _make_config(enabled=True)
        with patch(
            "worca.scripts.run_worktree.effective_graphify_config",
            return_value=cfg,
        ):
            _materialize_graphify_for_worktree(str(parent), str(worktree))

    def test_preserves_existing_worktree_settings(self, parent_worktree):
        """Materialization preserves non-graphify settings in worktree."""
        parent, worktree = parent_worktree

        wt_settings_path = worktree / ".claude" / "settings.json"
        wt_settings_path.write_text(json.dumps({
            "worca": {
                "stages": {"plan_review": {"enabled": True}},
                "graphify": {"enabled": True},
            }
        }))

        cfg = _make_config(enabled=True)
        with patch(
            "worca.scripts.run_worktree.effective_graphify_config",
            return_value=cfg,
        ):
            _materialize_graphify_for_worktree(str(parent), str(worktree))

        result = json.loads(wt_settings_path.read_text())
        assert result["worca"]["stages"]["plan_review"]["enabled"] is True
        assert result["worca"]["graphify"]["update_on"]["preflight"] is False


class TestPreflightReadsExistingReportWithoutUpdate:
    """Preflight returns existing GRAPH_REPORT.md even when update_on_preflight=False.

    This is the worktree contract: read the parent's snapshot as-is without
    running graphify --update.
    """

    def test_returns_ready_when_report_exists(self, tmp_path):
        """When update disabled but report file exists, returns ready + path."""
        from worca.scripts.graphify_preflight import run_graphify_preflight
        from worca.utils.graphify import GraphifyDetect

        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        out_dir = tmp_path / "graphify-out"
        out_dir.mkdir()
        report = out_dir / "GRAPH_REPORT.md"
        report.write_text("# Graph Report\nstructure data here")

        cfg = _make_config(
            enabled=True,
            update_on_preflight=False,
            out_dir=str(out_dir),
        )
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
        ) as mock_run:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "ready"
        assert result["report_path"] == str(report)
        mock_run.assert_not_called()

    def test_returns_skipped_when_no_report(self, tmp_path):
        """When update disabled and no report file, returns skipped."""
        from worca.scripts.graphify_preflight import run_graphify_preflight
        from worca.utils.graphify import GraphifyDetect

        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        cfg = _make_config(
            enabled=True,
            update_on_preflight=False,
            out_dir=str(tmp_path / "graphify-out"),
        )
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
        ) as mock_run:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "skipped"
        assert "update_on_preflight" in result["reason"]
        mock_run.assert_not_called()
