"""Tests for worca.utils.claude_cli - Claude CLI wrapper."""

import json
import subprocess
from io import StringIO
from unittest.mock import patch, MagicMock

from worca.utils.claude_cli import (
    AgentSubprocessError,
    build_command,
    process_stream,
    run_agent,
)


# --- WORCA_CLAUDE_BIN env var override ---

def test_claude_bin_default(monkeypatch):
    monkeypatch.delenv("WORCA_CLAUDE_BIN", raising=False)
    cmd, _ = build_command("prompt", agent="planner")
    assert cmd[0] == "claude"


def test_claude_bin_env_override(monkeypatch):
    monkeypatch.setenv("WORCA_CLAUDE_BIN", "/usr/local/bin/my-claude")
    cmd, _ = build_command("prompt", agent="planner")
    assert cmd[0] == "/usr/local/bin/my-claude"


def test_claude_bin_multiword(monkeypatch):
    monkeypatch.setenv("WORCA_CLAUDE_BIN", "python3 /path/to/mock_claude.py")
    cmd, _ = build_command("prompt", agent="planner")
    assert cmd[0] == "python3"
    assert cmd[1] == "/path/to/mock_claude.py"
    assert "-p" in cmd


# --- build_command ---

def test_build_command_basic():
    cmd, pf = build_command("do stuff", agent="planner")
    assert pf is None
    assert cmd[0] == "claude"
    assert "-p" in cmd
    assert "do stuff" in cmd
    assert "--agent" in cmd
    assert "planner" in cmd


def test_build_command_default_output_format():
    cmd, pf = build_command("prompt", agent="coder")
    assert pf is None
    assert "--output-format" in cmd
    idx = cmd.index("--output-format")
    assert cmd[idx + 1] == "stream-json"


def test_build_command_with_json_schema():
    cmd, pf = build_command("prompt", agent="coder", json_schema='{"type":"object"}')
    assert pf is None
    assert "--json-schema" in cmd
    idx = cmd.index("--json-schema")
    assert cmd[idx + 1] == '{"type":"object"}'


def test_build_command_without_json_schema():
    cmd, pf = build_command("prompt", agent="coder")
    assert pf is None
    assert "--json-schema" not in cmd


def test_build_command_includes_dangerously_skip_permissions():
    cmd, pf = build_command("prompt", agent="planner")
    assert pf is None
    assert "--dangerously-skip-permissions" in cmd


def test_build_command_includes_no_session_persistence():
    cmd, pf = build_command("prompt", agent="planner")
    assert pf is None
    assert "--no-session-persistence" in cmd


def test_build_command_with_model():
    cmd, pf = build_command("prompt", agent="coder", model="claude-sonnet-4-6")
    assert pf is None
    assert "--model" in cmd
    idx = cmd.index("--model")
    assert cmd[idx + 1] == "claude-sonnet-4-6"


def test_build_command_without_model():
    cmd, pf = build_command("prompt", agent="coder")
    assert pf is None
    assert "--model" not in cmd


def test_build_command_no_max_turns():
    """max-turns is not a valid claude CLI flag."""
    cmd, pf = build_command("prompt", agent="planner")
    assert pf is None
    assert "--max-turns" not in cmd


def test_build_command_custom_output_format():
    cmd, pf = build_command("prompt", agent="planner", output_format="text")
    assert pf is None
    idx = cmd.index("--output-format")
    assert cmd[idx + 1] == "text"


def test_build_command_reads_schema_file(tmp_path):
    schema_file = tmp_path / "schema.json"
    schema_file.write_text('{"type":"object","required":["name"]}')
    cmd, pf = build_command("prompt", agent="coder", json_schema=str(schema_file))
    assert pf is None
    idx = cmd.index("--json-schema")
    assert cmd[idx + 1] == '{"type":"object","required":["name"]}'


# --- run_agent ---

def _make_mock_popen(result_event, returncode=0):
    """Create a mock Popen that yields a stream-json result event on stdout."""
    mock_proc = MagicMock()
    mock_proc.returncode = returncode
    mock_proc.pid = 12345
    # stdout yields NDJSON lines
    result_line = json.dumps({"type": "result", **result_event})
    mock_proc.stdout = iter([result_line + "\n"])
    mock_proc.stderr = iter([])
    mock_proc.wait.return_value = returncode
    return mock_proc


def test_run_agent_parses_json():
    result_event = {"result": "success", "output": "done"}
    mock_proc = _make_mock_popen(result_event)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        result = run_agent("do stuff", agent="planner", max_turns=40)
    assert result["result"] == "success"
    assert result["type"] == "result"


def test_run_agent_raises_on_failure():
    result_event = {"is_error": True, "result": "agent failed"}
    mock_proc = _make_mock_popen(result_event, returncode=1)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        try:
            run_agent("fail", agent="planner", max_turns=5)
            assert False, "Should have raised"
        except RuntimeError as e:
            assert "agent failed" in str(e)


def test_run_agent_raises_on_invalid_json():
    mock_proc = MagicMock()
    mock_proc.returncode = 0
    mock_proc.pid = 12345
    mock_proc.stdout = iter(["not valid json {{\n"])
    mock_proc.stderr = iter([])
    mock_proc.wait.return_value = 0
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        try:
            run_agent("prompt", agent="planner", max_turns=5)
            assert False, "Should have raised"
        except RuntimeError as e:
            assert "result" in str(e).lower() or "stream" in str(e).lower()


def test_run_agent_passes_correct_command():
    result_event = {"ok": True}
    mock_proc = _make_mock_popen(result_event)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc) as mock_popen:
        run_agent("my prompt", agent="implementer", max_turns=20, json_schema='{"type":"object"}')
    args = mock_popen.call_args[0][0]
    assert args[0] == "claude"
    assert "--agent" in args
    assert "implementer" in args
    assert "--json-schema" in args


def test_run_agent_max_turns_accepted_but_ignored():
    """max_turns is accepted for API compatibility but not passed to CLI."""
    result_event = {"ok": True}
    mock_proc = _make_mock_popen(result_event)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc) as mock_popen:
        run_agent("prompt", agent="planner", max_turns=999)
    args = mock_popen.call_args[0][0]
    assert "--max-turns" not in args


def test_run_agent_passes_model_to_cli():
    result_event = {"ok": True}
    mock_proc = _make_mock_popen(result_event)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc) as mock_popen:
        run_agent("prompt", agent="implementer", model="claude-sonnet-4-6")
    args = mock_popen.call_args[0][0]
    assert "--model" in args
    idx = args.index("--model")
    assert args[idx + 1] == "claude-sonnet-4-6"


def test_run_agent_omits_model_when_none():
    result_event = {"ok": True}
    mock_proc = _make_mock_popen(result_event)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc) as mock_popen:
        run_agent("prompt", agent="planner")
    args = mock_popen.call_args[0][0]
    assert "--model" not in args


# ---------------------------------------------------------------------------
# AgentSubprocessError + signal-aware exception classification
# ---------------------------------------------------------------------------


def test_agent_subprocess_error_subclasses_runtimeerror():
    """Existing callers that catch RuntimeError must continue to work."""
    err = AgentSubprocessError("agent failed (exit 7)", returncode=7)
    assert isinstance(err, RuntimeError)
    assert err.returncode == 7
    assert "agent failed" in str(err)


def test_run_agent_raises_subprocess_error_with_returncode_for_real_failures():
    """Positive non-zero returncode -> AgentSubprocessError carries returncode.

    Guardrail #1: real agent failures must remain classified as failures
    (not interruptions). Returncode 1 is a real failure; the typed exception
    preserves it so downstream telemetry (and the runner's classifier) can
    distinguish it from a signal-induced exit.
    """
    result_event = {"is_error": True, "result": "agent failed"}
    mock_proc = _make_mock_popen(result_event, returncode=1)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        try:
            run_agent("fail", agent="planner", max_turns=5)
            assert False, "Should have raised"
        except AgentSubprocessError as e:
            assert e.returncode == 1
            assert "agent failed" in str(e)


def test_run_agent_raises_interrupted_when_subprocess_killed_mid_stream():
    """Race coverage: process_stream throws AND subprocess.returncode is
    negative (killed by signal). Must produce InterruptedError, not a
    RuntimeError that would be misclassified as a stage failure.

    Reproduces the failure mode of the W-044 signal-test flake: when the
    agent dies before emitting a `result` event, process_stream raises
    `RuntimeError("No result event found...")` and the negative-returncode
    branch at end of run_agent is never reached.
    """
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    # Stream ends with no result event — process_stream will raise.
    mock_proc.stdout = iter(["{\"type\":\"system\",\"subtype\":\"init\"}\n"])
    mock_proc.stderr = iter([])
    # Subprocess died from SIGTERM (-15) — must be observable via wait().
    mock_proc.returncode = -15
    mock_proc.wait.return_value = -15
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        try:
            run_agent("prompt", agent="planner", max_turns=5)
            assert False, "Should have raised InterruptedError"
        except InterruptedError as e:
            # Message should mention the signal so logs are useful.
            assert "15" in str(e) or "signal" in str(e).lower()


def test_run_agent_waits_briefly_for_returncode_when_stream_throws():
    """When process_stream throws and returncode is not yet set, run_agent
    must call proc.wait() with a bounded timeout so the returncode is
    definitive before classifying the failure.
    """
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_proc.stdout = iter([])  # empty stream -> process_stream raises
    mock_proc.stderr = iter([])
    # Simulate the race: returncode unset at exception time, set after wait().
    state = {"returncode": None}

    def _wait(timeout=None):
        # Once wait() is called the kernel has reaped the process; pretend
        # it died from SIGTERM.
        state["returncode"] = -15
        mock_proc.returncode = -15
        return -15

    type(mock_proc).returncode = property(lambda self: state["returncode"])
    mock_proc.wait.side_effect = _wait
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        try:
            run_agent("prompt", agent="planner", max_turns=5)
            assert False, "Should have raised InterruptedError"
        except InterruptedError:
            pass
    # wait() was called at least once to nail down the returncode.
    assert mock_proc.wait.called


def test_run_agent_stream_failure_with_clean_exit_still_raises_subprocess_error():
    """If process_stream throws but the subprocess actually exited 0
    (unusual — partial output, normal exit), the failure is real (no
    result event) and should surface as AgentSubprocessError, not get
    silently reclassified as an interruption.

    Guardrail #2: only `returncode < 0` reclassifies — clean exits stay
    as failures.
    """
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_proc.stdout = iter([])
    mock_proc.stderr = iter([])
    mock_proc.returncode = 0
    mock_proc.wait.return_value = 0
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        try:
            run_agent("prompt", agent="planner", max_turns=5)
            assert False, "Should have raised"
        except InterruptedError:
            assert False, "Clean exit must NOT be reclassified as interrupted"
        except (AgentSubprocessError, RuntimeError):
            pass  # Expected: real failure, no result event found.


def test_run_agent_merges_model_env_into_subprocess_env():
    """model_env keys are merged into the subprocess env."""
    result_event = {"ok": True}
    mock_proc = _make_mock_popen(result_event)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc) as mock_popen:
        run_agent(
            "prompt", agent="planner",
            model_env={"ANTHROPIC_BASE_URL": "http://x", "API_TIMEOUT_MS": "5000"},
        )
    env = mock_popen.call_args[1]["env"]
    assert env["ANTHROPIC_BASE_URL"] == "http://x"
    assert env["API_TIMEOUT_MS"] == "5000"


def test_run_agent_filters_reserved_keys_from_model_env(capsys):
    """Reserved keys in model_env are stripped; non-reserved pass through."""
    result_event = {"ok": True}
    mock_proc = _make_mock_popen(result_event)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc) as mock_popen:
        run_agent(
            "prompt", agent="planner",
            model_env={"WORCA_FOO": "1", "ANTHROPIC_BASE_URL": "http://x"},
        )
    env = mock_popen.call_args[1]["env"]
    assert env["ANTHROPIC_BASE_URL"] == "http://x"
    assert "WORCA_FOO" not in env
    captured = capsys.readouterr()
    assert "WORCA_FOO" in captured.err


def test_run_agent_model_env_none_is_safe():
    """model_env=None (default) does not break anything."""
    result_event = {"ok": True}
    mock_proc = _make_mock_popen(result_event)
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        result = run_agent("prompt", agent="planner", model_env=None)
    assert result["ok"] is True


def test_run_agent_handles_wait_timeout_after_stream_failure():
    """If proc.wait times out (subprocess is wedged after stream failure),
    run_agent must not hang forever — kill and re-wait.
    """
    mock_proc = MagicMock()
    mock_proc.pid = 12345
    mock_proc.stdout = iter([])
    mock_proc.stderr = iter([])
    mock_proc.returncode = None
    wait_calls = []

    def _wait(timeout=None):
        wait_calls.append(timeout)
        if timeout is not None and len(wait_calls) == 1:
            # First bounded wait times out
            raise subprocess.TimeoutExpired(cmd="claude", timeout=timeout)
        # Second wait (after kill) succeeds — subprocess died with -SIGKILL
        mock_proc.returncode = -9
        return -9

    mock_proc.wait.side_effect = _wait
    with patch("worca.utils.claude_cli.subprocess.Popen", return_value=mock_proc):
        try:
            run_agent("prompt", agent="planner", max_turns=5)
        except InterruptedError:
            pass  # acceptable
        except (AgentSubprocessError, RuntimeError):
            pass  # also acceptable
    # Critical: kill() was called, and wait() ran at least twice.
    assert mock_proc.kill.called
    assert len(wait_calls) >= 2


# ---------------------------------------------------------------------------
# process_stream: sticky structured_output across multiple result events
# (Regression coverage for issue #163 — task-notification auto-resume.)
# ---------------------------------------------------------------------------


def _stream(*events) -> StringIO:
    """Wrap a list of event dicts into an NDJSON StringIO for process_stream."""
    return StringIO("\n".join(json.dumps(e) for e in events) + "\n")


def test_process_stream_preserves_structured_output_across_task_notification_resume():
    """Bug #163: when the tester dispatches long pytest runs as
    `run_in_background` Bash tasks, the Claude CLI auto-resumes the session
    on each task-notification, emitting an extra `result` event with no
    `structured_output`. The previous implementation overwrote result_event
    every time, so the silent task-notification event clobbered the real one
    and downstream code defaulted `passed=False` / `failures=[]`.
    """
    first = {
        "type": "result",
        "structured_output": {"passed": True, "failures": []},
        "total_cost_usd": 0.12,
        "num_turns": 8,
    }
    task_notification_resume = {
        "type": "result",
        "origin": {"kind": "task-notification"},
        "total_cost_usd": 0.13,
        "num_turns": 9,
        # NOTE: no structured_output — this is the bug trigger.
    }
    result = process_stream(_stream(first, task_notification_resume))

    # structured_output must stick from the first result event
    assert result["structured_output"] == {"passed": True, "failures": []}
    # but cost / turns continue updating from the latest event
    assert result["total_cost_usd"] == 0.13
    assert result["num_turns"] == 9


def test_process_stream_single_result_with_structured_output_passthrough():
    """Sanity: the single-result happy path is unchanged."""
    event = {
        "type": "result",
        "structured_output": {"passed": True, "failures": []},
        "total_cost_usd": 0.05,
    }
    result = process_stream(_stream(event))
    assert result["structured_output"] == {"passed": True, "failures": []}
    assert result["total_cost_usd"] == 0.05


def test_process_stream_no_structured_output_in_any_result():
    """If no result event ever carries structured_output, we must NOT
    invent one — the returned envelope simply lacks the key, exactly as
    before. Stages that depend on it (e.g. Guardian prose fallback) will
    handle it themselves.
    """
    first = {"type": "result", "total_cost_usd": 0.01}
    second = {"type": "result", "total_cost_usd": 0.02}
    result = process_stream(_stream(first, second))
    assert "structured_output" not in result
    # latest envelope wins for cost / turns
    assert result["total_cost_usd"] == 0.02


def test_process_stream_latest_structured_output_wins_when_both_have_one():
    """If a later result event also carries a structured_output, it must
    win — stickiness only kicks in when later events LACK one. Otherwise
    we'd freeze the first SO forever and break legitimate updates.
    """
    first = {
        "type": "result",
        "structured_output": {"passed": False, "failures": ["x"]},
        "total_cost_usd": 0.10,
    }
    second = {
        "type": "result",
        "structured_output": {"passed": True, "failures": []},
        "total_cost_usd": 0.20,
    }
    result = process_stream(_stream(first, second))
    assert result["structured_output"] == {"passed": True, "failures": []}
    assert result["total_cost_usd"] == 0.20


def test_process_stream_third_event_with_new_structured_output_wins():
    """Three-result sequence: SO present, SO absent, SO present again.
    The third event's SO wins — stickiness only fills the gap when later
    events lack one, it doesn't permanently pin the first.
    """
    first = {
        "type": "result",
        "structured_output": {"passed": True, "failures": []},
    }
    second = {
        "type": "result",
        "origin": {"kind": "task-notification"},
    }
    third = {
        "type": "result",
        "structured_output": {"passed": False, "failures": ["regressed"]},
        "total_cost_usd": 0.30,
    }
    result = process_stream(_stream(first, second, third))
    assert result["structured_output"] == {"passed": False, "failures": ["regressed"]}
    assert result["total_cost_usd"] == 0.30
