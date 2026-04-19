# W-044: Pipeline Integration Test Harness with Mock Claude Process

**Status:** Draft
**Priority:** P1
**Area:** cc
**Date:** 2026-04-19
**Depends on:** None (W-043 benefits from this but is not a prerequisite)

## Problem

The pipeline orchestrator (`runner.py`) has no integration tests that exercise the full process lifecycle — signal handling, control file polling, event emission, status.json mutations, and webhook dispatch all happen across process boundaries that unit tests cannot reach. The W-043 plan identifies a 56-cell state × action matrix (7 states × 8 actions) that must be validated, but there is no test infrastructure to do so.

Today, `run_agent()` at `claude_cli.py:282` spawns a real `claude` subprocess via `subprocess.Popen`. Tests either mock `run_agent()` at the Python level (skipping process-boundary behavior) or don't exist. This means:

- Signal handler behavior (`runner.py:432–457`) is untested end-to-end
- Control file stop/pause/abort (`runner.py:163–190`) is tested in isolation but not through the full pipeline flow
- Event emission and dispatch (`emitter.py:209–260`) during terminal transitions is untested
- The `PipelineInterrupted` exception handler (`runner.py:2641–2650`) racing with signal handlers is untested
- `status.json` state transitions across process boundaries are unvalidated

## Proposal

Create a mock Claude binary (`mock_claude`) that reads scenario directives from a JSON file and simulates Claude CLI responses at the process level. The pipeline runs `mock_claude` instead of `claude` via the existing `CLAUDE_BIN` env var override or a `--claude-bin` flag. Integration tests use `run_pipeline.py` as the entry point, exercising the real orchestrator with controlled agent outcomes. A parametrized test suite validates all 56 state × action transitions plus event/webhook assertions.

## Design

### 1. Mock Claude Binary

**Current state:** `claude_cli.py:83–108` constructs a command starting with `"claude"`. The binary name is hardcoded.

**Obstacle:** No mechanism to substitute the binary without patching source code.

**Resolution:** Add a `WORCA_CLAUDE_BIN` env var override. When set, `claude_cli.py` uses it instead of `"claude"`.

```python
# claude_cli.py — command construction
def _build_cmd(prompt, agent, model, output_format, json_schema, max_turns):
    bin_name = os.environ.get("WORCA_CLAUDE_BIN", "claude")
    cmd = [bin_name, "-p", prompt, "--agent", agent,
           "--output-format", output_format, ...]
    return cmd
```

The mock binary is a Python script (`tests/mock_claude/mock_claude.py`) that:

1. Reads a **scenario file** path from `MOCK_CLAUDE_SCENARIO` env var
2. Identifies the current agent from `--agent <name>` in its argv
3. Looks up the agent's directive in the scenario file
4. Emits stream-JSON events to stdout matching Claude CLI output format
5. Exits with the specified exit code

```python
#!/usr/bin/env python3
"""Mock Claude CLI for integration testing."""
import json, os, sys, time, signal

def main():
    scenario_path = os.environ["MOCK_CLAUDE_SCENARIO"]
    scenario = json.load(open(scenario_path))

    # Parse --agent from argv
    agent = None
    for i, arg in enumerate(sys.argv):
        if arg == "--agent" and i + 1 < len(sys.argv):
            agent = sys.argv[i + 1]
            break

    directive = scenario.get("agents", {}).get(agent, scenario.get("default", {}))
    action = directive.get("action", "succeed")
    delay = directive.get("delay_s", 0.5)

    # Emit system.init event
    print(json.dumps({"type": "system", "subtype": "init",
                       "model": "mock-model", "session_id": "mock-session"}))
    sys.stdout.flush()

    time.sleep(delay)

    if action == "succeed":
        result_text = directive.get("result_text", "Done.")
        print(json.dumps({"type": "result", "subtype": "success",
                           "result": result_text, "num_turns": 1,
                           "total_cost_usd": 0.001, "duration_ms": int(delay * 1000)}))
    elif action == "fail":
        error_msg = directive.get("error", "Mock failure")
        print(json.dumps({"type": "result", "subtype": "error_max_turns",
                           "result": error_msg, "num_turns": 1,
                           "total_cost_usd": 0.001, "duration_ms": int(delay * 1000)}))
        sys.exit(1)
    elif action == "hang":
        # Block until killed — tests signal/control-file handling
        signal.pause() if hasattr(signal, "pause") else time.sleep(3600)
    elif action == "crash":
        os._exit(directive.get("exit_code", 137))
    elif action == "slow":
        # Simulate a long-running API call
        time.sleep(directive.get("slow_s", 30))
        print(json.dumps({"type": "result", "subtype": "success",
                           "result": "Done after delay.", "num_turns": 1,
                           "total_cost_usd": 0.01, "duration_ms": int(delay * 1000)}))

    sys.stdout.flush()

if __name__ == "__main__":
    main()
```

### 2. Scenario File Schema

Each test provides a scenario JSON that controls mock behavior per agent:

```json
{
  "agents": {
    "planner": { "action": "succeed", "delay_s": 0.3,
                 "result_text": "{\"plan\": \"test plan\"}" },
    "coordinator": { "action": "succeed", "delay_s": 0.2 },
    "implementer": { "action": "hang" },
    "tester": { "action": "fail", "error": "Tests failed" },
    "reviewer": { "action": "succeed" },
    "guardian": { "action": "succeed" }
  },
  "default": { "action": "succeed", "delay_s": 0.1 }
}
```

**Action enum:**

| Action | Behavior | Use case |
|--------|----------|----------|
| `succeed` | Emit success result, exit 0 | Happy path |
| `fail` | Emit error result, exit 1 | Stage failure |
| `hang` | Block forever (signal.pause) | Test signal/stop/cancel |
| `crash` | `os._exit(N)` with no output | Test crash recovery |
| `slow` | Sleep `slow_s` then succeed | Test timeout/control-file polling |

### 3. Test Fixture: Pipeline Runner

A pytest fixture wraps `run_pipeline.py` execution in a temporary project directory with controlled `.claude/settings.json`, `.claude/worca/` runtime, and scenario files:

```python
# tests/integration/conftest.py

@pytest.fixture
def pipeline_env(tmp_path):
    """Create a minimal project directory with mock claude wired up."""
    project = tmp_path / "project"
    project.mkdir()

    # Minimal worca runtime (copy from src/worca/ or use worca init)
    worca_dir = project / ".worca"
    worca_dir.mkdir()
    (worca_dir / "runs").mkdir()

    # Settings with all stages enabled, fast timeouts
    settings = {
        "worca": {
            "stages": {
                "plan_review": {"enabled": False},
                "learn": {"enabled": False},
            },
            "agents": {
                "planner": {"max_turns": 5},
                "coordinator": {"max_turns": 5},
                "implementer": {"max_turns": 5},
                "tester": {"max_turns": 5},
                "reviewer": {"max_turns": 5},
                "guardian": {"max_turns": 5},
            }
        }
    }
    settings_path = project / ".claude" / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings))

    # Wire up mock claude
    mock_bin = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"

    def run(scenario, prompt="test task", timeout=30, extra_args=None):
        scenario_path = tmp_path / "scenario.json"
        scenario_path.write_text(json.dumps(scenario))

        env = {
            **os.environ,
            "WORCA_CLAUDE_BIN": f"python3 {mock_bin}",
            "MOCK_CLAUDE_SCENARIO": str(scenario_path),
            "WORCA_AGENT": "",  # Not in pipeline mode for hooks
        }

        cmd = ["python3", "run_pipeline.py", "--prompt", prompt]
        if extra_args:
            cmd.extend(extra_args)

        result = subprocess.run(
            cmd, cwd=str(project), env=env,
            capture_output=True, text=True, timeout=timeout
        )

        # Read outputs
        status = _find_status_json(worca_dir)
        events = _read_events_jsonl(worca_dir)
        return PipelineResult(
            returncode=result.returncode,
            status=status,
            events=events,
            stdout=result.stdout,
            stderr=result.stderr,
        )

    return PipelineEnv(project=project, worca_dir=worca_dir, run=run)
```

### 4. Transition Action Helpers

To test stop/cancel/signal actions mid-pipeline, tests need to apply actions while the pipeline is running. The `hang` mock action keeps the pipeline blocked at a known stage, giving the test time to act:

```python
def run_and_act(pipeline_env, scenario, action_fn, act_after_stage=None):
    """Run pipeline in background, apply action, collect results."""
    proc = subprocess.Popen(...)

    if act_after_stage:
        # Poll status.json until the target stage starts
        _wait_for_stage(pipeline_env.worca_dir, act_after_stage, timeout=10)

    action_fn(proc, pipeline_env)

    proc.wait(timeout=15)
    return _collect_results(pipeline_env)
```

Action functions:

```python
def send_sigterm(proc, env):
    os.kill(proc.pid, signal.SIGTERM)

def send_sigint(proc, env):
    os.kill(proc.pid, signal.SIGINT)

def write_control_stop(proc, env):
    control = env.worca_dir / "runs" / _active_run_id(env) / "control.json"
    control.write_text(json.dumps({"action": "stop"}))

def write_control_pause(proc, env):
    control = env.worca_dir / "runs" / _active_run_id(env) / "control.json"
    control.write_text(json.dumps({"action": "pause"}))

def send_sigkill(proc, env):
    os.kill(proc.pid, signal.SIGKILL)
```

### 5. State × Action Matrix Tests

The 56-cell matrix from W-043 is encoded as parametrized tests:

```python
# Canonical states
STATES = ["pending", "running", "paused", "completed", "failed", "interrupted", "cancelled"]

# Actions that can be applied
ACTIONS = ["run", "stop", "cancel", "pause", "resume", "signal_term", "signal_kill", "crash"]

EXPECTED_TRANSITIONS = {
    # (state, action) → (new_state, expected_events, should_dispatch)
    ("running", "stop"):       ("interrupted", ["pipeline.run.interrupted"], True),
    ("running", "signal_term"):("interrupted", ["pipeline.run.interrupted"], True),
    ("running", "signal_kill"):("interrupted", ["pipeline.run.interrupted"], False),  # reconciler
    ("running", "cancel"):     ("cancelled",   ["pipeline.run.cancelled"],   True),
    ("running", "crash"):      ("failed",      ["pipeline.run.interrupted"], False),  # reconciler
    ("paused",  "stop"):       ("interrupted", ["pipeline.run.interrupted"], True),
    ("paused",  "cancel"):     ("cancelled",   ["pipeline.run.cancelled"],   True),
    ("paused",  "resume"):     ("running",     [],                           False),
    # Terminal states reject mutations
    ("completed", "stop"):     ("completed",   [],                           False),
    ("completed", "cancel"):   ("completed",   [],                           False),
    ("failed",    "stop"):     ("failed",      [],                           False),
    ("interrupted","stop"):    ("interrupted",  [],                          False),
    ("cancelled", "stop"):     ("cancelled",   [],                           False),
    # ... remaining cells
}

@pytest.mark.parametrize("state,action", [
    (s, a) for s in STATES for a in ACTIONS
    if (s, a) in EXPECTED_TRANSITIONS
])
def test_state_transition(pipeline_env, state, action):
    expected = EXPECTED_TRANSITIONS[(state, action)]
    scenario = build_scenario_for_state(state)
    result = apply_action(pipeline_env, scenario, state, action)

    assert result.status["pipeline_status"] == expected[0]
    for event_type in expected[1]:
        assert any(e["type"] == event_type for e in result.events)
```

### 6. WORCA_CLAUDE_BIN Env Var

**Current state:** `claude_cli.py:83` hardcodes `"claude"` as the binary name.

**Resolution:** Read from env var with fallback:

```python
# claude_cli.py:83
CLAUDE_BIN = os.environ.get("WORCA_CLAUDE_BIN", "claude")

def _build_cmd(prompt, agent, ...):
    cmd = shlex.split(CLAUDE_BIN) + ["-p", prompt, "--agent", agent, ...]
    return cmd
```

Using `shlex.split()` supports `WORCA_CLAUDE_BIN="python3 /path/to/mock_claude.py"` (multi-word values).

### 7. Webhook Verification

Tests that assert on webhook dispatch use a tiny HTTP server fixture:

```python
@pytest.fixture
def webhook_server():
    """Start a local HTTP server that records received webhook POSTs."""
    received = []
    server = _start_webhook_server(received, port=0)  # OS-assigned port
    yield WebhookCapture(url=f"http://127.0.0.1:{server.port}/hook", received=received)
    server.shutdown()
```

The test's `settings.json` configures a webhook pointing at this server. After the pipeline completes, the test asserts which events were delivered:

```python
def test_stop_dispatches_webhook(pipeline_env, webhook_server):
    pipeline_env.add_webhook(webhook_server.url)
    result = run_and_act(pipeline_env, scenario, send_sigterm, act_after_stage="implement")

    assert result.status["pipeline_status"] == "interrupted"
    assert any(e["event"] == "pipeline.run.interrupted" for e in webhook_server.received)
```

## Implementation Plan

### Phase 1: Mock Claude Binary + Env Var Override

**Files:** `tests/mock_claude/mock_claude.py`, `src/worca/utils/claude_cli.py`

**Tasks:**
1. Add `WORCA_CLAUDE_BIN` env var support to `claude_cli.py:83` with `shlex.split()`
2. Create `tests/mock_claude/mock_claude.py` with `succeed`, `fail`, `hang`, `crash`, `slow` actions
3. Create `tests/mock_claude/__init__.py` (empty)
4. Add `tests/mock_claude/conftest.py` with scenario file helpers

### Phase 2: Test Fixture Infrastructure

**Files:** `tests/integration/conftest.py`, `tests/integration/helpers.py`

**Tasks:**
1. Create `pipeline_env` fixture — sets up temp project, worca runtime, settings
2. Create `run_and_act()` helper for background pipeline + mid-run actions
3. Create action functions (sigterm, sigint, sigkill, control-stop, control-pause)
4. Create `PipelineResult` dataclass with status, events, returncode
5. Create `webhook_server` fixture with HTTP capture server
6. Create `_wait_for_stage()` polling helper

### Phase 3: Core Transition Tests

**Files:** `tests/integration/test_pipeline_transitions.py`

**Tasks:**
1. Define `EXPECTED_TRANSITIONS` matrix (all 56 cells)
2. Implement `build_scenario_for_state()` — generates scenario JSON to reach a given state
3. Implement `apply_action()` — runs pipeline and applies the specified action
4. Write parametrized `test_state_transition` covering all reachable cells
5. Mark unreachable cells as `pytest.mark.skip` with rationale

### Phase 4: Event & Webhook Dispatch Tests

**Files:** `tests/integration/test_pipeline_dispatch.py`

**Tasks:**
1. Test: stop emits `pipeline.run.interrupted` event to `events.jsonl`
2. Test: stop delivers webhook when configured
3. Test: cancel emits `pipeline.run.cancelled` event (post-W-043)
4. Test: crash → reconciler writes synthetic event
5. Test: completed pipeline delivers `pipeline.run.completed` webhook
6. Test: no webhook configured → no delivery attempt, no error

### Phase 5: Edge Case Tests

**Files:** `tests/integration/test_pipeline_edge_cases.py`

**Tasks:**
1. Test: signal during `hang` mock (agent blocked in long call)
2. Test: double-signal (SIGTERM + SIGTERM) — no duplicate events
3. Test: control-file stop while paused
4. Test: signal + exception handler race (signal arrives mid-stage-transition)
5. Test: pipeline with all stages disabled except one

### Files Changed Summary

| File | Change | Phase |
|------|--------|-------|
| `src/worca/utils/claude_cli.py` | Add `WORCA_CLAUDE_BIN` env var override | 1 |
| `tests/mock_claude/__init__.py` | New empty module | 1 |
| `tests/mock_claude/mock_claude.py` | New mock binary | 1 |
| `tests/mock_claude/conftest.py` | Scenario helpers | 1 |
| `tests/integration/conftest.py` | `pipeline_env`, `webhook_server` fixtures | 2 |
| `tests/integration/helpers.py` | `run_and_act`, action functions, polling | 2 |
| `tests/integration/test_pipeline_transitions.py` | 56-cell matrix tests | 3 |
| `tests/integration/test_pipeline_dispatch.py` | Event/webhook dispatch tests | 4 |
| `tests/integration/test_pipeline_edge_cases.py` | Signal races, edge cases | 5 |

## Considerations

- **Test speed:** Each test spawns a Python subprocess (`run_pipeline.py`) which spawns mock claude subprocesses. With `delay_s: 0.1` per mock stage, a full 7-stage pipeline takes ~1s. The full 56-cell matrix runs in ~60s. Tests using `hang` + signal add ~2-3s per test for the action + teardown.

- **CI isolation:** Tests create temp directories and bind to ephemeral ports (webhook server). No shared state between tests. Safe for parallel execution with `pytest-xdist` if the `hang`-based tests are marked `serial`.

- **Platform coverage:** `signal.pause()` is Unix-only. On Windows, the `hang` action falls back to `time.sleep(3600)`. Control-file-based stop tests work on all platforms. SIGTERM tests should be marked `@pytest.mark.skipif(sys.platform == "win32")`.

- **No production code changes beyond env var:** The only production code change is the `WORCA_CLAUDE_BIN` override in `claude_cli.py`. All other changes are in `tests/`.

- **W-043 synergy:** Once W-043 lands, the transition matrix updates (e.g., `cancelled` state, `control_webhook` stop reason). The harness is designed to make those changes a matrix table update, not a structural change.

- **Breaking changes:** None. The `WORCA_CLAUDE_BIN` env var defaults to `"claude"` — existing behavior is unchanged.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_claude_bin_env_override` | `WORCA_CLAUDE_BIN` is respected in command construction |
| Python | `test_claude_bin_default` | Default `"claude"` when env var unset |
| Python | `test_claude_bin_multiword` | `shlex.split` handles `"python3 /path/to/mock.py"` |

### Integration Tests

| Test File | Scope | Validates |
|-----------|-------|-----------|
| `test_pipeline_transitions.py` | 56 parametrized cases | Full state × action matrix |
| `test_pipeline_dispatch.py` | 6 tests | Event emission + webhook delivery |
| `test_pipeline_edge_cases.py` | 5 tests | Signal races, double-signal, edge cases |

### Done Criteria

1. `pytest tests/integration/test_pipeline_transitions.py` passes all non-skipped cells
2. `pytest tests/integration/test_pipeline_dispatch.py` passes with webhook assertions
3. Mock claude binary handles all 5 action types without flakiness
4. Tests complete in under 120s total on CI

## Out of Scope

- **Windows CI matrix** — Platform-specific tests are marked with skip decorators; adding a Windows CI runner is out of scope.
- **Performance benchmarking** — The harness validates correctness, not performance.
- **UI integration tests** — The harness tests the Python pipeline only, not the worca-ui server.
- **W-043 implementation** — This plan provides the test infrastructure; W-043 provides the state model changes.
- **Mock Claude for multi-pipeline (run_multi.py)** — Only single-pipeline `run_pipeline.py` is in scope.
