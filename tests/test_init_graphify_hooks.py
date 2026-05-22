"""Tests for graphify hook integration in worca init (W-053 Phase 3)."""

from unittest.mock import patch

from worca.utils.graphify import GraphifyDetect


def _make_detect(*, installed=True, compatible=True, version="4.1.0"):
    return GraphifyDetect(
        installed=installed,
        version=version if installed else None,
        compatible=compatible,
        backend_env_present=[],
        error=None if compatible else "not compatible",
    )


def _enabled_global():
    return {"worca": {"graphify": {"enabled": True}}}


def _disabled_global():
    return {"worca": {"graphify": {"enabled": False}}}


def _patch_graphify(global_settings=None, detect=None):
    """Context manager that patches global settings and detect_graphify."""
    gs = global_settings if global_settings is not None else _enabled_global()
    det = detect if detect is not None else _make_detect()
    return (
        patch("worca.cli.init._read_global_settings", return_value=gs),
        patch("worca.utils.graphify.detect_graphify", return_value=det),
    )


class TestMergeGraphifyHooks:
    """Hook stanza injection via _merge_graphify_hooks."""

    def test_hook_present_when_enabled_and_ready(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {"worca": {"graphify": {"enabled": True}}}
        p_gs, p_det = _patch_graphify()
        with p_gs, p_det:
            changes = _merge_graphify_hooks(settings)

        pre_tool = settings["hooks"]["PreToolUse"]
        graphify_entries = [e for e in pre_tool if e.get("matcher") == "Grep|Glob"]
        assert len(graphify_entries) == 1
        assert "graphify" in graphify_entries[0]["hooks"][0]["command"]
        assert any("Grep|Glob" in c for c in changes)

    def test_hook_absent_when_disabled(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {"worca": {"graphify": {"enabled": False}}}
        with patch("worca.cli.init._read_global_settings", return_value={}):
            changes = _merge_graphify_hooks(settings)

        assert changes == []
        assert "hooks" not in settings

    def test_hook_absent_when_global_kill_switch(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {"worca": {"graphify": {"enabled": True}}}
        with patch("worca.cli.init._read_global_settings", return_value=_disabled_global()):
            changes = _merge_graphify_hooks(settings)

        assert changes == []

    def test_hook_absent_when_not_installed(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {"worca": {"graphify": {"enabled": True}}}
        det = _make_detect(installed=False, compatible=False)
        p_gs, p_det = _patch_graphify(detect=det)
        with p_gs, p_det:
            changes = _merge_graphify_hooks(settings)

        assert changes == []

    def test_hook_absent_when_incompatible(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {"worca": {"graphify": {"enabled": True}}}
        det = _make_detect(installed=True, compatible=False, version="3.0.0")
        p_gs, p_det = _patch_graphify(detect=det)
        with p_gs, p_det:
            changes = _merge_graphify_hooks(settings)

        assert changes == []

    def test_idempotent_on_reinit(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {"worca": {"graphify": {"enabled": True}}}
        p_gs, p_det = _patch_graphify()
        with p_gs, p_det:
            _merge_graphify_hooks(settings)
            changes2 = _merge_graphify_hooks(settings)

        assert changes2 == []
        pre_tool = settings["hooks"]["PreToolUse"]
        graphify_entries = [e for e in pre_tool if e.get("matcher") == "Grep|Glob"]
        assert len(graphify_entries) == 1

    def test_bash_allowlist_populated(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {"worca": {"graphify": {"enabled": True}}}
        p_gs, p_det = _patch_graphify()
        with p_gs, p_det:
            changes = _merge_graphify_hooks(settings)

        allowlist = settings["worca"]["governance"]["bash_allowlist_extra"]
        assert "graphify" in allowlist
        assert any("bash_allowlist_extra" in c for c in changes)

    def test_bash_allowlist_not_populated_when_disabled(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {"worca": {"graphify": {"enabled": False}}}
        with patch("worca.cli.init._read_global_settings", return_value={}):
            _merge_graphify_hooks(settings)

        governance = settings.get("worca", {}).get("governance", {})
        assert "bash_allowlist_extra" not in governance

    def test_coexists_with_existing_pretooluse_hooks(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash|Write|Edit",
                        "hooks": [{"type": "command", "command": "echo pre"}],
                    },
                    {
                        "matcher": "Skill",
                        "hooks": [{"type": "command", "command": "echo skill"}],
                    },
                ]
            },
            "worca": {"graphify": {"enabled": True}},
        }
        p_gs, p_det = _patch_graphify()
        with p_gs, p_det:
            _merge_graphify_hooks(settings)

        pre_tool = settings["hooks"]["PreToolUse"]
        matchers = [e.get("matcher") for e in pre_tool]
        assert "Bash|Write|Edit" in matchers
        assert "Skill" in matchers
        assert "Grep|Glob" in matchers
        assert len(pre_tool) == 3

    def test_bash_allowlist_idempotent(self):
        from worca.cli.init import _merge_graphify_hooks

        settings = {
            "worca": {
                "graphify": {"enabled": True},
                "governance": {"bash_allowlist_extra": ["graphify"]},
            }
        }
        p_gs, p_det = _patch_graphify()
        with p_gs, p_det:
            changes = _merge_graphify_hooks(settings)

        allowlist = settings["worca"]["governance"]["bash_allowlist_extra"]
        assert allowlist.count("graphify") == 1
        assert not any("bash_allowlist_extra" in c for c in changes)


class TestGraphifyGitignore:
    """graphify-out/ conditionally added to .gitignore."""

    def test_gitignore_includes_graphify_out_when_enabled(self, tmp_path):
        from worca.cli.init import _ensure_gitignore

        gitignore = tmp_path / ".gitignore"
        gitignore.write_text(".worca/\nlogs/\n.claude/settings.local.json\n")
        changes = _ensure_gitignore(tmp_path, graphify_enabled=True)
        content = gitignore.read_text()
        assert "graphify-out/" in content
        assert any("graphify-out/" in c for c in changes)

    def test_gitignore_no_graphify_out_when_disabled(self, tmp_path):
        from worca.cli.init import _ensure_gitignore

        gitignore = tmp_path / ".gitignore"
        gitignore.write_text(".worca/\nlogs/\n.claude/settings.local.json\n")
        _ensure_gitignore(tmp_path, graphify_enabled=False)
        content = gitignore.read_text()
        assert "graphify-out/" not in content

    def test_gitignore_graphify_out_idempotent(self, tmp_path):
        from worca.cli.init import _ensure_gitignore

        gitignore = tmp_path / ".gitignore"
        gitignore.write_text(".worca/\nlogs/\n.claude/settings.local.json\ngraphify-out/\n")
        changes = _ensure_gitignore(tmp_path, graphify_enabled=True)
        content = gitignore.read_text()
        assert content.count("graphify-out/") == 1
        assert not any("graphify-out/" in c for c in changes)

    def test_gitignore_default_no_graphify_out(self, tmp_path):
        """Default (no parameter) does not add graphify-out/."""
        from worca.cli.init import _ensure_gitignore

        gitignore = tmp_path / ".gitignore"
        gitignore.write_text("")
        _ensure_gitignore(tmp_path)
        content = gitignore.read_text()
        assert "graphify-out/" not in content
