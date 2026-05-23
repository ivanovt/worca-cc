"""Tests for the advisory graphify nudge (PreToolUse)."""
import pytest

from worca.hooks import graphify_nudge as gn


@pytest.fixture
def ready_graph(tmp_path, monkeypatch):
    """GRAPHIFY_OUT pointing at a dir with graph.json + a run dir for throttle."""
    g = tmp_path / "g"
    g.mkdir()
    (g / "graph.json").write_text("{}")
    run = tmp_path / "run"
    run.mkdir()
    monkeypatch.setenv("GRAPHIFY_OUT", str(g))
    monkeypatch.setenv("WORCA_RUN_DIR", str(run))
    monkeypatch.delenv("WORCA_AGENT", raising=False)
    return g, run


def _ctx(cmd):
    return gn.graphify_nudge_context("Bash", {"command": cmd})


class TestSearchMatching:
    @pytest.mark.parametrize(
        "cmd",
        [
            "grep -r foo .",
            "rg foo",
            "ripgrep foo",
            "find . -name y",
            "fd x",
            "ack q",
            "ag q",
            "cd /proj && grep foo src/",  # cd-prefix stripped
        ],
    )
    def test_search_commands_nudge(self, cmd, ready_graph, monkeypatch):
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "every")
        assert _ctx(cmd) is not None

    @pytest.mark.parametrize(
        "cmd",
        ["ls -la", "cat file.py", "git status", "pytest tests/", 'graphify query "x"'],
    )
    def test_non_search_commands_no_nudge(self, cmd, ready_graph, monkeypatch):
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "every")
        assert _ctx(cmd) is None

    def test_non_bash_tool_no_nudge(self, ready_graph, monkeypatch):
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "every")
        assert gn.graphify_nudge_context("Write", {"file_path": "a"}) is None


class TestReadinessGate:
    def test_no_graphify_out_no_nudge(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GRAPHIFY_OUT", raising=False)
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "every")
        assert _ctx("grep -r foo .") is None

    def test_graphify_out_without_graph_json_no_nudge(self, tmp_path, monkeypatch):
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setenv("GRAPHIFY_OUT", str(empty))
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "every")
        assert _ctx("grep -r foo .") is None


class TestModeAndThrottle:
    def test_off_mode_suppresses(self, ready_graph, monkeypatch):
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "off")
        assert _ctx("grep -r foo .") is None

    def test_every_mode_always_nudges(self, ready_graph, monkeypatch):
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "every")
        assert _ctx("grep a .") is not None
        assert _ctx("grep b .") is not None  # not throttled

    def test_run_mode_once_per_run(self, ready_graph, monkeypatch):
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "run")
        monkeypatch.setenv("WORCA_AGENT", "plan-planner-iter-1")
        assert _ctx("grep a .") is not None  # first → nudge
        assert _ctx("grep b .") is None  # second → suppressed (same run)
        # even a different stage stays suppressed under run mode
        monkeypatch.setenv("WORCA_AGENT", "implement-implementer-iter-1")
        assert _ctx("grep c .") is None

    def test_stage_mode_once_per_iteration(self, ready_graph, monkeypatch):
        monkeypatch.setattr(gn, "_nudge_mode", lambda: "stage")
        monkeypatch.setenv("WORCA_AGENT", "plan-planner-iter-1")
        assert _ctx("grep a .") is not None  # first in this stage → nudge
        assert _ctx("grep b .") is None  # second in same stage → suppressed
        # a different stage/iteration nudges again
        monkeypatch.setenv("WORCA_AGENT", "implement-implementer-iter-1")
        assert _ctx("grep c .") is not None


class TestNudgeModeDefault:
    def test_unknown_mode_falls_back_to_every(self, tmp_path, monkeypatch):
        # _nudge_mode reads settings; with no .claude/settings.json it defaults.
        monkeypatch.chdir(tmp_path)
        assert gn._nudge_mode() == "every"
