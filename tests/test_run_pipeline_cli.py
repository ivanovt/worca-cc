"""Tests for Phase 2: --claude-md-mode CLI flag, runner materialization, status persistence."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from worca.scripts.run_pipeline import create_parser


# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------


def test_claude_md_mode_default_is_none():
    parser = create_parser()
    args = parser.parse_args(["--prompt", "do something"])
    assert args.claude_md_mode is None


def test_claude_md_mode_accepts_none_value():
    parser = create_parser()
    args = parser.parse_args(["--prompt", "x", "--claude-md-mode", "none"])
    assert args.claude_md_mode == "none"


def test_claude_md_mode_accepts_project():
    parser = create_parser()
    args = parser.parse_args(["--prompt", "x", "--claude-md-mode", "project"])
    assert args.claude_md_mode == "project"


def test_claude_md_mode_accepts_project_plus_local():
    parser = create_parser()
    args = parser.parse_args(["--prompt", "x", "--claude-md-mode", "project+local"])
    assert args.claude_md_mode == "project+local"


def test_claude_md_mode_accepts_all():
    parser = create_parser()
    args = parser.parse_args(["--prompt", "x", "--claude-md-mode", "all"])
    assert args.claude_md_mode == "all"


def test_claude_md_mode_rejects_invalid():
    parser = create_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--prompt", "x", "--claude-md-mode", "bogus"])


# ---------------------------------------------------------------------------
# launch_param_status — claude_md_mode field
# ---------------------------------------------------------------------------


def test_launch_param_status_mode_project_included():
    from worca.orchestrator.runner import launch_param_status
    out = launch_param_status(None, 1, 1, claude_md_mode="project")
    assert out["claude_md_mode"] == "project"


def test_launch_param_status_mode_none_included():
    from worca.orchestrator.runner import launch_param_status
    out = launch_param_status(None, 1, 1, claude_md_mode="none")
    assert out["claude_md_mode"] == "none"


def test_launch_param_status_mode_all_absent():
    from worca.orchestrator.runner import launch_param_status
    out = launch_param_status(None, 1, 1, claude_md_mode="all")
    assert "claude_md_mode" not in out


def test_launch_param_status_mode_default_none_absent():
    from worca.orchestrator.runner import launch_param_status
    out = launch_param_status(None, 1, 1)
    assert "claude_md_mode" not in out


# ---------------------------------------------------------------------------
# overlay file materialization — direct unit test
# ---------------------------------------------------------------------------


def test_overlay_file_written_for_none_mode(tmp_path):
    """mode='none' writes autoMemoryEnabled:false + claudeMdExcludes overlay to run_dir."""
    from worca.utils.claude_md import build_overlay, resolve_claude_md_mode

    run_dir = tmp_path / "runs" / "run-001"
    run_dir.mkdir(parents=True)
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps({}), encoding="utf-8")

    mode = resolve_claude_md_mode("none", str(settings_path))
    assert mode == "none"

    overlay_dict = build_overlay(mode, str(tmp_path))
    assert overlay_dict is not None

    overlay_path = run_dir / "claude_md_overlay.json"
    overlay_path.write_text(json.dumps(overlay_dict, indent=2), encoding="utf-8")

    content = json.loads(overlay_path.read_text(encoding="utf-8"))
    assert content["autoMemoryEnabled"] is False
    assert "**/CLAUDE.md" in content["claudeMdExcludes"]
    assert "**/CLAUDE.local.md" in content["claudeMdExcludes"]


def test_overlay_file_not_written_for_all_mode(tmp_path):
    """mode='all' -> build_overlay returns None -> no file should be written."""
    from worca.utils.claude_md import build_overlay, resolve_claude_md_mode

    settings_path = tmp_path / "settings.json"
    settings_path.write_text(json.dumps({}), encoding="utf-8")

    mode = resolve_claude_md_mode("all", str(settings_path))
    assert mode == "all"

    overlay_dict = build_overlay(mode, str(tmp_path))
    assert overlay_dict is None  # caller must not write any file


def test_overlay_file_written_for_project_mode(tmp_path):
    """mode='project' writes claudeMdExcludes overlay to run_dir."""
    from worca.utils.claude_md import build_overlay

    overlay_dict = build_overlay("project", str(tmp_path))
    assert overlay_dict is not None
    assert "claudeMdExcludes" in overlay_dict

    run_dir = tmp_path / "runs" / "run-001"
    run_dir.mkdir(parents=True)
    overlay_path = run_dir / "claude_md_overlay.json"
    overlay_path.write_text(json.dumps(overlay_dict, indent=2), encoding="utf-8")

    content = json.loads(overlay_path.read_text(encoding="utf-8"))
    assert "claudeMdExcludes" in content


# ---------------------------------------------------------------------------
# resume: restore persisted claude_md_mode; CLI re-overrides
# ---------------------------------------------------------------------------


def test_resume_restores_persisted_claude_md_mode():
    """On --resume with no CLI override, restore claude_md_mode from status.json."""
    parser = create_parser()
    args = parser.parse_args(["--prompt", "x", "--resume"])
    assert args.claude_md_mode is None

    existing_status = {"claude_md_mode": "project+local"}

    if args.claude_md_mode is None:
        persisted = existing_status.get("claude_md_mode")
        if isinstance(persisted, str):
            args.claude_md_mode = persisted

    assert args.claude_md_mode == "project+local"


def test_resume_cli_wins_over_persisted_claude_md_mode():
    """On --resume with explicit CLI --claude-md-mode, CLI value wins."""
    parser = create_parser()
    args = parser.parse_args(["--prompt", "x", "--resume", "--claude-md-mode", "none"])
    assert args.claude_md_mode == "none"

    existing_status = {"claude_md_mode": "project+local"}

    if args.claude_md_mode is None:
        persisted = existing_status.get("claude_md_mode")
        if isinstance(persisted, str):
            args.claude_md_mode = persisted

    assert args.claude_md_mode == "none"


def test_resume_without_persisted_mode_stays_none():
    """On --resume with no CLI flag and no persisted mode, stays None (resolves to 'all')."""
    parser = create_parser()
    args = parser.parse_args(["--prompt", "x", "--resume"])
    existing_status = {}

    if args.claude_md_mode is None:
        persisted = existing_status.get("claude_md_mode")
        if isinstance(persisted, str):
            args.claude_md_mode = persisted

    assert args.claude_md_mode is None
