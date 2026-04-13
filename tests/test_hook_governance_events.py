"""Tests for governance event emission in hook scripts.

Covers:
  - pipeline.hook.blocked  → pre_tool_use after guard blocks
  - pipeline.hook.test_gate → post_tool_use after test gate blocks
  - pipeline.hook.dispatch_blocked → subagent_start when dispatch denied
"""
import importlib
import io
import json
import os
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# pre_tool_use — pipeline.hook.blocked
# ---------------------------------------------------------------------------


class TestPreToolUseBlockedEvent:
    """pre_tool_use emits pipeline.hook.blocked when guard blocks."""

    def setup_method(self):
        for k in ["WORCA_EVENTS_PATH", "WORCA_RUN_ID", "WORCA_AGENT"]:
            os.environ.pop(k, None)

    def teardown_method(self):
        for k in ["WORCA_EVENTS_PATH", "WORCA_RUN_ID", "WORCA_AGENT"]:
            os.environ.pop(k, None)

    def _call_main(self, stdin_data):
        import worca.claude_hooks.pre_tool_use as m
        importlib.reload(m)
        with patch("sys.stdin", io.StringIO(stdin_data)):
            with pytest.raises(SystemExit) as exc:
                m.main()
        return exc.value.code

    def test_emits_hook_blocked_when_guard_blocks(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"
        os.environ["WORCA_AGENT"] = "implementer"

        data = json.dumps({"tool_name": "Bash", "tool_input": {"command": "rm -rf /tmp/x"}})
        code = self._call_main(data)

        assert code == 2
        assert os.path.exists(events_file)
        events = [json.loads(line) for line in open(events_file).readlines() if line.strip()]
        assert len(events) == 1
        e = events[0]
        assert e["event_type"] == "pipeline.hook.blocked"
        assert e["payload"]["agent"] == "implementer"
        assert e["payload"]["tool"] == "Bash"
        assert "reason" in e["payload"]

    def test_blocked_event_has_envelope_fields(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-abc"
        os.environ["WORCA_AGENT"] = "implementer"

        data = json.dumps({"tool_name": "Bash", "tool_input": {"command": "rm -rf /tmp/x"}})
        self._call_main(data)

        e = json.loads(open(events_file).read())
        assert e["schema_version"] == "1"
        assert "event_id" in e
        assert "timestamp" in e
        assert e["run_id"] == "run-abc"

    def test_no_event_when_guard_allows(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"tool_name": "Bash", "tool_input": {"command": "echo hello"}})
        code = self._call_main(data)

        assert code == 0
        assert not os.path.exists(events_file)

    def test_emit_noop_when_events_path_missing(self):
        """No crash when WORCA_EVENTS_PATH is not set — guard still blocks."""
        os.environ["WORCA_RUN_ID"] = "run-001"
        os.environ["WORCA_AGENT"] = "implementer"

        data = json.dumps({"tool_name": "Bash", "tool_input": {"command": "rm -rf /tmp/x"}})
        code = self._call_main(data)

        assert code == 2  # Still blocked, emit silently skipped

    def test_blocked_payload_reason_describes_violation(self, tmp_path):
        """Reason in payload describes the guard violation."""
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"
        os.environ["WORCA_AGENT"] = "coordinator"

        data = json.dumps({
            "tool_name": "Write",
            "tool_input": {"file_path": "src/main.py"}
        })
        code = self._call_main(data)

        assert code == 2
        events = [json.loads(line) for line in open(events_file).readlines() if line.strip()]
        e = events[0]
        assert "coordinator" in e["payload"]["reason"].lower() or "read-only" in e["payload"]["reason"].lower()


# ---------------------------------------------------------------------------
# post_tool_use — pipeline.hook.test_gate
# ---------------------------------------------------------------------------


class TestPostToolUseTestGateEvent:
    """post_tool_use emits pipeline.hook.test_gate when test gate blocks."""

    def setup_method(self):
        for k in ["WORCA_EVENTS_PATH", "WORCA_RUN_ID", "WORCA_AGENT"]:
            os.environ.pop(k, None)
        from worca.hooks import test_gate
        test_gate._state["strikes"] = 0

    def teardown_method(self):
        for k in ["WORCA_EVENTS_PATH", "WORCA_RUN_ID", "WORCA_AGENT"]:
            os.environ.pop(k, None)
        from worca.hooks import test_gate
        test_gate._state["strikes"] = 0

    def _call_main(self, stdin_data):
        import worca.claude_hooks.post_tool_use as m
        importlib.reload(m)
        with patch("sys.stdin", io.StringIO(stdin_data)):
            with pytest.raises(SystemExit) as exc:
                m.main()
        return exc.value.code

    def test_emits_test_gate_event_when_gate_blocks(self, tmp_path):
        """Event emitted on second consecutive test failure (code != 0)."""
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"
        os.environ["WORCA_AGENT"] = "tester"

        from worca.hooks import test_gate
        test_gate._state["strikes"] = 1  # Pre-seed: already one strike

        data = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "pytest tests/"},
            "tool_response": {"exit_code": 1},
        })
        code = self._call_main(data)

        assert code == 2
        assert os.path.exists(events_file)
        events = [json.loads(line) for line in open(events_file).readlines() if line.strip()]
        test_gate_events = [e for e in events if e["event_type"] == "pipeline.hook.test_gate"]
        assert len(test_gate_events) == 1
        e = test_gate_events[0]
        assert e["payload"]["agent"] == "tester"
        assert e["payload"]["strike"] >= 2

    def test_test_gate_event_envelope_fields(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-xyz"
        os.environ["WORCA_AGENT"] = "tester"

        from worca.hooks import test_gate
        test_gate._state["strikes"] = 1

        data = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "pytest tests/"},
            "tool_response": {"exit_code": 1},
        })
        self._call_main(data)

        e = json.loads(open(events_file).read())
        assert e["schema_version"] == "1"
        assert "event_id" in e
        assert e["run_id"] == "run-xyz"

    def test_no_event_on_passing_tests(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "pytest tests/"},
            "tool_response": {"exit_code": 0},
        })
        code = self._call_main(data)

        assert code == 0
        assert not os.path.exists(events_file)

    def test_no_event_for_non_pytest_command(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "ls -la"},
            "tool_response": {"exit_code": 1},
        })
        code = self._call_main(data)

        assert code == 0
        assert not os.path.exists(events_file)

    def test_no_event_on_first_failure_warning(self, tmp_path):
        """First failure is a warning (code 0) — no event emitted."""
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"
        # _state["strikes"] == 0 (fresh)

        data = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "pytest tests/"},
            "tool_response": {"exit_code": 1},
        })
        code = self._call_main(data)

        assert code == 0  # Warning, not block
        assert not os.path.exists(events_file)

    def test_emit_noop_when_events_path_missing(self):
        """No crash when WORCA_EVENTS_PATH is not set — gate still blocks."""
        os.environ["WORCA_RUN_ID"] = "run-001"

        from worca.hooks import test_gate
        test_gate._state["strikes"] = 1

        data = json.dumps({
            "tool_name": "Bash",
            "tool_input": {"command": "pytest tests/"},
            "tool_response": {"exit_code": 1},
        })
        code = self._call_main(data)

        assert code == 2


# ---------------------------------------------------------------------------
# subagent_start — pipeline.hook.dispatch_blocked
# ---------------------------------------------------------------------------


class TestSubagentStartDispatchBlockedEvent:
    """subagent_start emits pipeline.hook.dispatch_blocked when denied."""

    def setup_method(self):
        for k in ["WORCA_EVENTS_PATH", "WORCA_RUN_ID", "WORCA_AGENT"]:
            os.environ.pop(k, None)

    def teardown_method(self):
        for k in ["WORCA_EVENTS_PATH", "WORCA_RUN_ID", "WORCA_AGENT"]:
            os.environ.pop(k, None)

    def _call_main(self, stdin_data, agent=None):
        if agent is not None:
            os.environ["WORCA_AGENT"] = agent
        import worca.claude_hooks.subagent_start as m
        importlib.reload(m)
        with patch("sys.stdin", io.StringIO(stdin_data)):
            with pytest.raises(SystemExit) as exc:
                m.main()
        return exc.value.code

    def test_emits_dispatch_blocked_when_denied(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "general-purpose"})
        code = self._call_main(data, agent="coordinator")

        assert code == 2
        assert os.path.exists(events_file)
        events = [json.loads(line) for line in open(events_file).readlines() if line.strip()]
        assert len(events) == 1
        e = events[0]
        assert e["event_type"] == "pipeline.hook.dispatch_blocked"
        assert e["payload"]["agent"] == "coordinator"
        assert e["payload"]["subagent_type"] == "general-purpose"
        assert "reason" in e["payload"]

    def test_dispatch_blocked_event_envelope_fields(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-xyz"

        data = json.dumps({"agent_type": "general-purpose"})
        self._call_main(data, agent="tester")

        e = json.loads(open(events_file).read())
        assert e["schema_version"] == "1"
        assert "event_id" in e
        assert e["run_id"] == "run-xyz"

    def test_no_event_when_dispatch_allowed(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "explore"})
        code = self._call_main(data, agent="implementer")

        assert code == 0
        assert os.path.exists(events_file)
        events = [json.loads(line) for line in open(events_file).readlines() if line.strip()]
        assert len(events) == 1
        assert events[0]["event_type"] == "pipeline.hook.dispatch_allowed"

    def test_no_event_in_interactive_mode(self, tmp_path):
        """Interactive mode (WORCA_AGENT not set) allows all dispatches."""
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "general-purpose"})
        code = self._call_main(data)  # No agent set

        assert code == 0
        assert not os.path.exists(events_file)

    def test_dispatch_blocked_payload_reason_names_child_agent(self, tmp_path):
        """Reason string in payload mentions the blocked child agent."""
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "general-purpose"})
        self._call_main(data, agent="coordinator")

        events = [json.loads(line) for line in open(events_file).readlines() if line.strip()]
        e = events[0]
        assert "general-purpose" in e["payload"]["reason"]

    def test_emit_noop_when_events_path_missing(self):
        """No crash when WORCA_EVENTS_PATH is not set — dispatch still blocked."""
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "general-purpose"})
        code = self._call_main(data, agent="coordinator")

        assert code == 2


# ---------------------------------------------------------------------------
# subagent_start — pipeline.hook.dispatch_allowed
# ---------------------------------------------------------------------------


class TestSubagentStartDispatchAllowedEvent:
    """subagent_start emits pipeline.hook.dispatch_allowed on successful dispatch."""

    def setup_method(self):
        for k in ["WORCA_EVENTS_PATH", "WORCA_RUN_ID", "WORCA_AGENT"]:
            os.environ.pop(k, None)

    def teardown_method(self):
        for k in ["WORCA_EVENTS_PATH", "WORCA_RUN_ID", "WORCA_AGENT"]:
            os.environ.pop(k, None)

    def _call_main(self, stdin_data, agent=None):
        if agent is not None:
            os.environ["WORCA_AGENT"] = agent
        import worca.claude_hooks.subagent_start as m
        importlib.reload(m)
        with patch("sys.stdin", io.StringIO(stdin_data)):
            with pytest.raises(SystemExit) as exc:
                m.main()
        return exc.value.code

    def test_emits_dispatch_allowed_on_success(self, tmp_path):
        """Event emitted when dispatch is allowed (code == 0)."""
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "explore"})
        code = self._call_main(data, agent="implementer")

        assert code == 0
        assert os.path.exists(events_file)
        events = [json.loads(line) for line in open(events_file).readlines() if line.strip()]
        assert len(events) == 1
        e = events[0]
        assert e["event_type"] == "pipeline.hook.dispatch_allowed"
        assert e["payload"]["agent"] == "implementer"
        assert e["payload"]["subagent_type"] == "explore"

    def test_dispatch_allowed_event_envelope_fields(self, tmp_path):
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-xyz"

        data = json.dumps({"agent_type": "explore"})
        self._call_main(data, agent="tester")

        e = json.loads(open(events_file).read())
        assert e["schema_version"] == "1"
        assert "event_id" in e
        assert e["run_id"] == "run-xyz"

    def test_no_dispatch_allowed_event_in_interactive_mode(self, tmp_path):
        """Interactive mode (no WORCA_AGENT) does not emit dispatch_allowed."""
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "explore"})
        code = self._call_main(data)  # No WORCA_AGENT set

        assert code == 0
        assert not os.path.exists(events_file)

    def test_no_dispatch_allowed_event_when_blocked(self, tmp_path):
        """When dispatch is blocked, only dispatch_blocked event is emitted."""
        events_file = str(tmp_path / "events.jsonl")
        os.environ["WORCA_EVENTS_PATH"] = events_file
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "general-purpose"})
        code = self._call_main(data, agent="coordinator")

        assert code == 2
        events = [json.loads(line) for line in open(events_file).readlines() if line.strip()]
        event_types = [e["event_type"] for e in events]
        assert "pipeline.hook.dispatch_allowed" not in event_types
        assert "pipeline.hook.dispatch_blocked" in event_types

    def test_dispatch_allowed_noop_when_events_path_missing(self):
        """No crash when WORCA_EVENTS_PATH is not set — dispatch still succeeds."""
        os.environ["WORCA_RUN_ID"] = "run-001"

        data = json.dumps({"agent_type": "explore"})
        code = self._call_main(data, agent="implementer")

        assert code == 0  # Still allowed, emit silently skipped
