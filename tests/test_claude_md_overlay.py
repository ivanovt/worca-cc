"""Unit tests for src/worca/utils/claude_md.py — Phase 1."""

import json
import os
import tempfile
from pathlib import Path


from worca.utils.claude_md import build_overlay, resolve_claude_md_mode


# ---------------------------------------------------------------------------
# build_overlay
# ---------------------------------------------------------------------------


def test_build_overlay_all_returns_none():
    assert build_overlay("all", "/some/project") is None


def test_build_overlay_none_disables_automemory():
    result = build_overlay("none", "/some/project")
    assert result == {"autoMemoryEnabled": False}


def test_build_overlay_project_contains_claudemd_excludes():
    result = build_overlay("project", "/some/project")
    assert isinstance(result, dict)
    assert "claudeMdExcludes" in result
    assert isinstance(result["claudeMdExcludes"], list)


def test_build_overlay_project_local_contains_claudemd_excludes():
    result = build_overlay("project+local", "/some/project")
    assert isinstance(result, dict)
    assert "claudeMdExcludes" in result


def test_build_overlay_project_excludes_user_home():
    result = build_overlay("project", "/some/project")
    excludes = result["claudeMdExcludes"]
    # Overlay paths are emitted in POSIX form on every platform, so compare
    # against the POSIX rendering of the user home dir.
    home_posix = Path.home().as_posix()
    # Should include both ~/.claude/CLAUDE.md and ~/CLAUDE.md
    assert any(p.startswith(home_posix) for p in excludes), (
        f"Expected user-home paths in excludes but got: {excludes}"
    )


def test_build_overlay_project_local_keeps_local_file():
    """project+local must NOT exclude <root>/CLAUDE.local.md."""
    root = "/some/project"
    result = build_overlay("project+local", root)
    excludes = result["claudeMdExcludes"]
    local_md = f"{root}/CLAUDE.local.md"
    assert local_md not in excludes, (
        f"project+local should NOT exclude CLAUDE.local.md but found it in: {excludes}"
    )


def test_build_overlay_project_keeps_project_claudemd():
    """project mode must NOT exclude <root>/CLAUDE.md."""
    root = "/some/project"
    result = build_overlay("project", root)
    excludes = result["claudeMdExcludes"]
    project_md = f"{root}/CLAUDE.md"
    assert project_md not in excludes, (
        f"project mode should NOT exclude project CLAUDE.md but found it in: {excludes}"
    )


def test_build_overlay_ancestor_walk():
    """build_overlay emits one entry per ancestor directory in POSIX form."""
    # Use a known deep path so we can count expected ancestors. Paths are
    # always emitted in POSIX form, so the same expectations hold on Windows.
    root = "/a/b/c/project"
    result = build_overlay("project", root)
    excludes = result["claudeMdExcludes"]

    # Ancestors of /a/b/c/project are /a/b/c, /a/b, /a, /
    # Each should have a CLAUDE.md entry
    expected_ancestors = ["/a/b/c/CLAUDE.md", "/a/b/CLAUDE.md", "/a/CLAUDE.md", "/CLAUDE.md"]
    for anc in expected_ancestors:
        assert anc in excludes, f"Expected {anc!r} in excludes, got: {excludes}"


def test_build_overlay_project_mode_excludes_local_claudemd():
    """project mode (not project+local) SHOULD exclude <root>/CLAUDE.local.md."""
    root = "/some/project"
    result = build_overlay("project", root)
    excludes = result["claudeMdExcludes"]
    local_md = f"{root}/CLAUDE.local.md"
    assert local_md in excludes, (
        f"project (not project+local) SHOULD exclude CLAUDE.local.md but not found in: {excludes}"
    )


def test_build_overlay_includes_org_policy_paths():
    """Forward-compat: org-policy paths are included regardless of OS."""
    result = build_overlay("project", "/some/project")
    excludes = result["claudeMdExcludes"]
    # At least one of the known org-policy patterns should be present
    org_patterns = [
        "/etc/claude-code/CLAUDE.md",
        "/Library/Application Support/ClaudeCode/CLAUDE.md",
        "C:/ProgramData/ClaudeCode/CLAUDE.md",
    ]
    assert any(p in excludes for p in org_patterns), (
        f"Expected at least one org-policy path in excludes, got: {excludes}"
    )


def test_build_overlay_idempotent():
    """Calling build_overlay twice with the same args returns equal results."""
    root = "/some/project"
    r1 = build_overlay("project", root)
    r2 = build_overlay("project", root)
    assert r1 == r2


def test_build_overlay_project_local_same_ancestors_as_project():
    """project+local and project should exclude the same ancestor dirs."""
    root = "/a/b/project"
    r_proj = build_overlay("project", root)
    r_local = build_overlay("project+local", root)

    # Both should exclude ancestor CLAUDE.md files identically
    ancestor_proj = {p for p in r_proj["claudeMdExcludes"] if "/a/b/project" not in p}
    ancestor_local = {p for p in r_local["claudeMdExcludes"] if "/a/b/project" not in p}
    assert ancestor_proj == ancestor_local


# ---------------------------------------------------------------------------
# resolve_claude_md_mode
# ---------------------------------------------------------------------------


def test_resolve_claude_md_mode_default_is_all():
    with tempfile.TemporaryDirectory() as d:
        settings_path = os.path.join(d, "settings.json")
        Path(settings_path).write_text(json.dumps({}), encoding="utf-8")
        result = resolve_claude_md_mode(cli_override=None, settings_path=settings_path)
        assert result == "all"


def test_resolve_claude_md_mode_no_settings_file_returns_all():
    result = resolve_claude_md_mode(cli_override=None, settings_path="/nonexistent/settings.json")
    assert result == "all"


def test_resolve_claude_md_mode_cli_wins_over_settings():
    with tempfile.TemporaryDirectory() as d:
        settings_path = os.path.join(d, "settings.json")
        Path(settings_path).write_text(
            json.dumps({"worca": {"claude_md_mode": "none"}}), encoding="utf-8"
        )
        result = resolve_claude_md_mode(cli_override="project", settings_path=settings_path)
        assert result == "project"


def test_resolve_claude_md_mode_reads_from_settings():
    with tempfile.TemporaryDirectory() as d:
        settings_path = os.path.join(d, "settings.json")
        Path(settings_path).write_text(
            json.dumps({"worca": {"claude_md_mode": "project+local"}}), encoding="utf-8"
        )
        result = resolve_claude_md_mode(cli_override=None, settings_path=settings_path)
        assert result == "project+local"


def test_resolve_claude_md_mode_all_values_accepted():
    with tempfile.TemporaryDirectory() as d:
        for mode in ("none", "project", "project+local", "all"):
            settings_path = os.path.join(d, "settings.json")
            Path(settings_path).write_text(
                json.dumps({"worca": {"claude_md_mode": mode}}), encoding="utf-8"
            )
            result = resolve_claude_md_mode(cli_override=None, settings_path=settings_path)
            assert result == mode
