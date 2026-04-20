# W-044: Pipeline Integration Test Harness with Mock Claude Process

**Status:** Revised
**Priority:** P1
**Area:** cc
**Date:** 2026-04-19
**Depends on:** None (W-043 benefits from this but is not a prerequisite)

## Problem

The pipeline orchestrator (`runner.py`) has no integration tests that exercise the full process lifecycle — signal handling, control file polling, event emission, status.json mutations, and webhook dispatch all happen across process boundaries that unit tests cannot reach. The W-043 plan identifies a 56-cell state × action matrix (7 states × 8 actions) that must be validated, but there is no test infrastructure to do so.

Today, `run_agent()` at `claude_cli.py:282` spawns a real `claude` subprocess via `subprocess.Popen`. Tests either mock `run_agent()` at the Python level (skipping process-boundary behavior) or don't exist. This means:

- Signal handler behavior (`runner.py:435–461`) is untested end-to-end
- Control file stop/pause (`runner.py:125–166`) is tested in isolation but not through the full pipeline flow
- Event emission and dispatch (`emitter.py:162–242`) during terminal transitions is untested
- The `PipelineInterrupted` exception handler racing with signal handlers is untested
- `status.json` state transitions across process boundaries are unvalidated

## Proposal

Create a mock Claude binary (`mock_claude`) that reads scenario directives from a JSON file and simulates Claude CLI responses at the process level. The pipeline runs `mock_claude` instead of `claude` via a new `WORCA_CLAUDE_BIN` env var. Integration tests invoke `python -m worca.scripts.run_pipeline` as the entry point, exercising the real orchestrator with controlled agent outcomes. A parametrized test suite validates state × action transitions (split into tier-1 cells testable now and tier-2 cells requiring W-043) plus event/webhook assertions.

## Design

### 1. Mock Claude Binary

**Current state:** `claude_cli.py:83–94` constructs a command starting with the hardcoded string `"claude"`:

```python
cmd = [
    "claude",
    "-p", cli_prompt,
    "--agent", agent,
    "--output-format", output_format,
    "--no-session-persistence",
    "--dangerously-skip-permissions",
    "--disallowedTools", "Skill,EnterPlanMode,EnterWorktree,TodoWrite",
]
```

**Obstacle:** No mechanism to substitute the binary without patching source code.

**Resolution:** Add a `WORCA_CLAUDE_BIN` env var override. When set, `claude_cli.py` uses it instead of `"claude"`.

```python
# claude_cli.py — command construction (line 83)
CLAUDE_BIN = os.environ.get("WORCA_CLAUDE_BIN", "claude")

cmd = shlex.split(CLAUDE_BIN) + [
    "-p", cli_prompt,
    "--agent", agent,
    "--output-format", output_format,
    ...
]
```

Using `shlex.split()` supports multi-word values like `WORCA_CLAUDE_BIN="python3 /path/to/mock_claude.py"`.

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
| `hang` | Block forever (signal.pause) | Test signal/stop |
| `crash` | `os._exit(N)` with no output | Test crash recovery |
| `slow` | Sleep `slow_s` then succeed | Test timeout/control-file polling |

### 3. Pipeline Invocation Strategy

**Review issue #1 (critical):** `run_pipeline.py` cannot be invoked from a temp directory — the script lives at `src/worca/scripts/run_pipeline.py` and uses `sys.path.insert(0, ...)` assuming it's inside the source tree.

**Resolution:** Invoke via `python -m worca.scripts.run_pipeline` instead of `python3 run_pipeline.py`. Since the `worca` package is pip-installed in editable mode (`pip install -e ".[dev]"`), `python -m worca.scripts.run_pipeline` resolves through the package system regardless of `cwd`. The `run_pipeline.py` module's `sys.path` manipulation (line 11) is redundant under editable install and harmless.

```python
cmd = [sys.executable, "-m", "worca.scripts.run_pipeline", "--prompt", prompt]
```

This means tests can run from any `cwd` — the temp project directory — without the script needing to be present there.

### 4. Test Fixture: Pipeline Environment

**Review issue #3 (major):** The temp directory needs more than `settings.json` to run. The pipeline requires agent templates (`agents/core/*.md`), JSON schemas (`schemas/`), a git repo (preflight checks), and the `.claude/worca/` runtime copy.

**Resolution:** The fixture runs `worca init .` in the temp directory to copy the full runtime, then initializes a git repo. This is the simplest approach and most closely matches real usage.

```python
# tests/integration/conftest.py

@dataclass
class PipelineResult:
    returncode: int
    status: dict
    events: list[dict]
    stdout: str
    stderr: str

@dataclass
class PipelineEnv:
    project: Path
    worca_dir: Path
    run: Callable
    run_background: Callable
    add_webhook: Callable

@pytest.fixture
def pipeline_env(tmp_path):
    """Create a minimal project directory with full worca runtime and mock claude."""
    project = tmp_path / "project"
    project.mkdir()

    # 1. Initialize a git repo (preflight requires it)
    subprocess.run(["git", "init"], cwd=str(project), check=True,
                   capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"],
                   cwd=str(project), check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"],
                   cwd=str(project), check=True, capture_output=True)
    # Create initial commit so branch exists
    (project / "README.md").write_text("test")
    subprocess.run(["git", "add", "."], cwd=str(project), check=True,
                   capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=str(project),
                   check=True, capture_output=True)

    # 2. Run worca init to copy full runtime
    subprocess.run([sys.executable, "-m", "worca.cli", "init", "."],
                   cwd=str(project), check=True, capture_output=True)

    # 3. Override settings for fast test execution
    settings_path = project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})
    settings["worca"]["stages"] = {
        "plan_review": {"enabled": False},
        "learn": {"enabled": False},
    }
    settings["worca"]["agents"] = {
        "planner": {"max_turns": 5},
        "coordinator": {"max_turns": 5},
        "implementer": {"max_turns": 5},
        "tester": {"max_turns": 5},
        "reviewer": {"max_turns": 5},
        "guardian": {"max_turns": 5},
    }
    settings_path.write_text(json.dumps(settings, indent=2))

    worca_dir = project / ".worca"
    mock_bin = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"

    def _base_env(scenario_path):
        return {
            **os.environ,
            "WORCA_CLAUDE_BIN": f"{sys.executable} {mock_bin}",
            "MOCK_CLAUDE_SCENARIO": str(scenario_path),
            "WORCA_AGENT": "",  # Not in agent mode for hooks
        }

    _scenario_counter = [0]

    def run(scenario, prompt="test task", timeout=30, extra_args=None):
        _scenario_counter[0] += 1
        scenario_path = tmp_path / f"scenario_{_scenario_counter[0]}.json"
        scenario_path.write_text(json.dumps(scenario))

        cmd = [sys.executable, "-m", "worca.scripts.run_pipeline",
               "--prompt", prompt]
        if extra_args:
            cmd.extend(extra_args)

        result = subprocess.run(
            cmd, cwd=str(project), env=_base_env(scenario_path),
            capture_output=True, text=True, timeout=timeout
        )

        status = _find_latest_status(worca_dir)
        events = _read_events_jsonl(worca_dir)
        return PipelineResult(
            returncode=result.returncode,
            status=status, events=events,
            stdout=result.stdout, stderr=result.stderr,
        )

    def run_background(scenario, prompt="test task", extra_args=None):
        """Start pipeline as a background Popen — caller controls lifecycle."""
        _scenario_counter[0] += 1
        scenario_path = tmp_path / f"scenario_{_scenario_counter[0]}.json"
        scenario_path.write_text(json.dumps(scenario))

        cmd = [sys.executable, "-m", "worca.scripts.run_pipeline",
               "--prompt", prompt]
        if extra_args:
            cmd.extend(extra_args)

        return subprocess.Popen(
            cmd, cwd=str(project), env=_base_env(scenario_path),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,  # match runner.py's new session behavior
        )

    def add_webhook(url):
        """Add a webhook URL to settings for event dispatch testing.

        emitter.py:105 reads worca.webhooks as a flat list of dicts,
        each with a "url" key. _validate_webhook (emitter.py:46) only
        accepts https:// or http://localhost prefixes — so the
        webhook_server fixture must bind to localhost, not 127.0.0.1.
        """
        s = json.loads(settings_path.read_text())
        s.setdefault("worca", {})
        s["worca"]["webhooks"] = [{"url": url}]
        settings_path.write_text(json.dumps(s, indent=2))

    return PipelineEnv(
        project=project, worca_dir=worca_dir,
        run=run, run_background=run_background, add_webhook=add_webhook,
    )
```

Helper functions for reading results:

```python
def _find_latest_status(worca_dir: Path) -> dict:
    """Find the most recent run's status.json."""
    runs_dir = worca_dir / "runs"
    if not runs_dir.exists():
        return {}
    run_dirs = sorted(runs_dir.iterdir(), key=lambda p: p.name, reverse=True)
    for run_dir in run_dirs:
        status_path = run_dir / "status.json"
        if status_path.exists():
            return json.loads(status_path.read_text())
    return {}

def _read_events_jsonl(worca_dir: Path) -> list[dict]:
    """Read all events from the latest run's events.jsonl."""
    runs_dir = worca_dir / "runs"
    if not runs_dir.exists():
        return []
    run_dirs = sorted(runs_dir.iterdir(), key=lambda p: p.name, reverse=True)
    for run_dir in run_dirs:
        events_path = run_dir / "events.jsonl"
        if events_path.exists():
            lines = events_path.read_text().strip().split("\n")
            return [json.loads(line) for line in lines if line.strip()]
    return []

def _active_run_id(env: PipelineEnv) -> str:
    """Read the active run ID from .worca/active_run."""
    return (env.worca_dir / "active_run").read_text().strip()
```

### 5. Transition Action Helpers

To test stop/signal actions mid-pipeline, tests use the `hang` mock action to block the pipeline at a known stage, giving the test time to act:

```python
# tests/integration/helpers.py

def run_and_act(pipeline_env, scenario, action_fn, act_after_stage=None, timeout=15):
    """Run pipeline in background, apply action at the right moment, collect results."""
    proc = pipeline_env.run_background(scenario)

    try:
        if act_after_stage:
            _wait_for_stage(pipeline_env.worca_dir, act_after_stage, timeout=10)

        action_fn(proc, pipeline_env)
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

    status = _find_latest_status(pipeline_env.worca_dir)
    events = _read_events_jsonl(pipeline_env.worca_dir)
    return PipelineResult(
        returncode=proc.returncode,
        status=status, events=events,
        stdout=proc.stdout.read() if proc.stdout else "",
        stderr=proc.stderr.read() if proc.stderr else "",
    )

def _wait_for_stage(worca_dir, stage_name, timeout=10):
    """Poll status.json until the named stage is in_progress."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = _find_latest_status(worca_dir)
        stage_data = status.get("stages", {}).get(stage_name, {})
        if stage_data.get("status") == "in_progress":
            return
        time.sleep(0.1)
    raise TimeoutError(f"Stage {stage_name} did not start within {timeout}s")
```

Action functions:

```python
# Signals target the process group (os.killpg) because the pipeline spawns
# child processes. run_background() uses start_new_session=True to isolate
# the pipeline into its own process group, so no other processes are affected.

def send_sigterm(proc, env):
    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)

def send_sigint(proc, env):
    os.killpg(os.getpgid(proc.pid), signal.SIGINT)

def write_control_stop(proc, env):
    """Write a stop control file — uses current control.py protocol."""
    run_id = _active_run_id(env.worca_dir)
    control = env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({
        "action": "stop",
        "requested_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "test",
    }))

def write_control_pause(proc, env):
    """Write a pause control file — uses current control.py protocol."""
    run_id = _active_run_id(env.worca_dir)
    control = env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({
        "action": "pause",
        "requested_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "test",
    }))

def send_sigkill(proc, env):
    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
```

### 6. State × Action Matrix — Two-Tier Design

**Review issue #2 (major):** `control.py:13` defines `VALID_ACTIONS = {"pause", "stop"}`. There is no `cancel` action in the current codebase — `cancelled` state is a W-043 addition.

**Review issue #4 (major):** Terminal-state tests need an explicit design. Once a pipeline finishes in a terminal state (completed, failed, interrupted), the process has exited — there is no running process to send signals to. These require a fundamentally different test pattern.

**Resolution:** Split the matrix into two tiers and design three distinct test patterns for different state categories.

#### Tier 1: Testable now (current codebase)

Uses only current `VALID_ACTIONS = {"pause", "stop"}` and existing states:

```python
# Current states (no 'cancelled' — that's W-043)
STATES_TIER1 = ["pending", "running", "paused", "completed", "failed", "interrupted"]

# Current actions (no 'cancel' or 'resume' via control file — those are W-043)
ACTIONS_TIER1 = ["stop", "pause", "signal_term", "signal_int", "signal_kill", "crash"]
```

#### Tier 2: Requires W-043

```python
STATES_TIER2 = ["cancelled"]
ACTIONS_TIER2 = ["cancel", "resume"]
```

All tier-2 cells are marked `@pytest.mark.skip(reason="requires W-043: cancel action and cancelled state")`.

#### Test Pattern A: Mid-run actions (running/paused states)

For states where the pipeline process is alive, use `run_and_act()` with `hang` mock:

```python
def test_running_stop(pipeline_env):
    """Running + control-stop → interrupted."""
    scenario = {"default": {"action": "succeed", "delay_s": 0.1},
                "agents": {"implementer": {"action": "hang"}}}
    result = run_and_act(pipeline_env, scenario, write_control_stop,
                         act_after_stage="implement")
    assert result.status["pipeline_status"] == "interrupted"
    assert any(e["event_type"] == RUN_INTERRUPTED for e in result.events)
```

To test from `paused` state: run pipeline with `hang` at a stage, write `control-pause` to pause it, then apply the second action:

```python
def test_paused_stop(pipeline_env):
    """Paused + control-stop → interrupted."""
    scenario = {"default": {"action": "succeed", "delay_s": 0.1},
                "agents": {"implementer": {"action": "hang"}}}

    def pause_then_stop(proc, env):
        write_control_pause(proc, env)
        # Wait for pipeline to persist paused status and exit
        proc.wait(timeout=10)
        assert _find_latest_status(env.worca_dir)["pipeline_status"] == "paused"
        # Now resume and apply stop — but paused pipeline has already exited,
        # so we test via a second run with --resume plus immediate stop
        proc2 = env.run_background(scenario, extra_args=["--resume"])
        _wait_for_stage(env.worca_dir, "implement", timeout=10)
        write_control_stop(proc2, env)
        proc2.wait(timeout=10)

    run_and_act(pipeline_env, scenario, pause_then_stop,
                act_after_stage="implement")
    assert _find_latest_status(pipeline_env.worca_dir)["pipeline_status"] == "interrupted"
```

**Important nuance:** When the pipeline is paused, it exits with status 0 and sets `pipeline_status="paused"`. To test actions on a paused pipeline, the test must resume it (via `--resume`) and then apply the action. This mirrors real-world usage where a paused pipeline is a persisted state waiting for external resume.

#### Test Pattern B: Terminal-state immutability (completed/failed/interrupted)

Terminal states are tested *after* the pipeline process has exited. The test verifies that:
1. The pipeline reaches the expected terminal state
2. Attempting to mutate it (via control file write, or starting a new run without `--resume`) does not change the persisted state

```python
def test_completed_rejects_stop(pipeline_env):
    """Completed pipeline ignores control-stop — state is immutable."""
    scenario = {"default": {"action": "succeed", "delay_s": 0.1}}
    result = pipeline_env.run(scenario)
    assert result.status["pipeline_status"] == "completed"

    # Write a stop control file to the completed run's directory
    run_id = _active_run_id(pipeline_env)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "stop", "source": "test"}))

    # Status remains completed — no process is reading the control file
    status = _find_latest_status(pipeline_env.worca_dir)
    assert status["pipeline_status"] == "completed"

def test_failed_rejects_stop(pipeline_env):
    """Failed pipeline ignores control-stop."""
    scenario = {"agents": {"planner": {"action": "fail", "error": "Planned fail"}},
                "default": {"action": "succeed", "delay_s": 0.1}}
    result = pipeline_env.run(scenario)
    assert result.status["pipeline_status"] == "failed"

    run_id = _active_run_id(pipeline_env)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "stop", "source": "test"}))
    status = _find_latest_status(pipeline_env.worca_dir)
    assert status["pipeline_status"] == "failed"

def test_interrupted_rejects_stop(pipeline_env):
    """Interrupted pipeline ignores control-stop."""
    scenario = {"default": {"action": "succeed", "delay_s": 0.1},
                "agents": {"implementer": {"action": "hang"}}}
    result = run_and_act(pipeline_env, scenario, send_sigterm,
                         act_after_stage="implement")
    assert result.status["pipeline_status"] == "interrupted"

    run_id = _active_run_id(pipeline_env)
    control = pipeline_env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({"action": "stop", "source": "test"}))
    status = _find_latest_status(pipeline_env.worca_dir)
    assert status["pipeline_status"] == "interrupted"
```

**Rationale:** Terminal-state immutability is enforced by the process not running — there is no control file polling loop to consume the file. The test confirms the status.json file on disk is not modified. This is the correct assertion: a dead process cannot change state, and no reconciler exists that would process stale control files.

For signal-based actions on terminal states, there is no process to signal — these cells are marked `skip(reason="no process to signal after terminal state")`.

#### Full Transition Matrix

```python
EXPECTED_TRANSITIONS = {
    # --- Tier 1: Testable now ---

    # Pattern A: Mid-run actions on running state
    ("running", "stop"):         ("interrupted", [RUN_INTERRUPTED], True,  "A"),
    ("running", "pause"):        ("paused",      [RUN_PAUSED],     True,  "A"),
    ("running", "signal_term"):  ("interrupted", [RUN_INTERRUPTED], True,  "A"),
    ("running", "signal_int"):   ("interrupted", [RUN_INTERRUPTED], True,  "A"),
    ("running", "signal_kill"):  ("interrupted", [],                False, "A"),  # no event from SIGKILL
    ("running", "crash"):        ("failed",      [RUN_FAILED],     False, "A"),  # agent crash → stage fail

    # Pattern A: Mid-run actions on paused state (resume then act)
    ("paused",  "stop"):         ("interrupted", [RUN_INTERRUPTED], True,  "A"),
    ("paused",  "signal_term"):  ("interrupted", [RUN_INTERRUPTED], True,  "A"),

    # Pattern B: Terminal-state immutability
    ("completed",  "stop"):      ("completed",   [], False, "B"),
    ("completed",  "pause"):     ("completed",   [], False, "B"),
    ("failed",     "stop"):      ("failed",      [], False, "B"),
    ("failed",     "pause"):     ("failed",      [], False, "B"),
    ("interrupted","stop"):      ("interrupted",  [], False, "B"),
    ("interrupted","pause"):     ("interrupted",  [], False, "B"),

    # Skip: no process to signal for terminal states
    # ("completed", "signal_*"): skip — no process
    # ("failed",    "signal_*"): skip — no process
    # ("interrupted","signal_*"):skip — no process

    # --- Tier 2: Requires W-043 ---
    # ("running", "cancel"):     ("cancelled", [RUN_CANCELLED], True,  "A"),
    # ("paused",  "cancel"):     ("cancelled", [RUN_CANCELLED], True,  "A"),
    # ("paused",  "resume"):     ("running",   [RUN_RESUMED],   False, "A"),
    # ("cancelled","stop"):      ("cancelled", [],               False, "B"),
    # ("cancelled","cancel"):    ("cancelled", [],               False, "B"),
}

# Cells that can't be tested — no process to signal
SKIPPED_NO_PROCESS = [
    (terminal, sig)
    for terminal in ["completed", "failed", "interrupted"]
    for sig in ["signal_term", "signal_int", "signal_kill", "crash"]
]

# Cells that require W-043
SKIPPED_W043 = [
    ("running", "cancel"), ("paused", "cancel"), ("paused", "resume"),
    ("cancelled", "stop"), ("cancelled", "pause"), ("cancelled", "cancel"),
    ("cancelled", "signal_term"), ("cancelled", "signal_int"),
    ("cancelled", "signal_kill"), ("cancelled", "crash"),
]
```

### 7. WORCA_CLAUDE_BIN Env Var

**Current state:** `claude_cli.py:83` hardcodes `"claude"` as the binary name.

**Resolution:** Read from env var at call-time inside `build_command()`, not at module level. This ensures `monkeypatch.setenv()` in tests takes effect without module-reload tricks:

```python
# claude_cli.py:84 — inside build_command()
_claude_bin = shlex.split(os.environ.get("WORCA_CLAUDE_BIN", "claude"))
cmd = [
    *_claude_bin,
    "-p", cli_prompt,
    "--agent", agent,
    "--output-format", output_format,
    ...
]
```

Using `shlex.split()` supports `WORCA_CLAUDE_BIN="python3 /path/to/mock_claude.py"` (multi-word values).

### 8. Webhook Verification

Tests that assert on webhook dispatch use a tiny HTTP server fixture:

```python
@pytest.fixture
def webhook_server():
    """Start a local HTTP server that records received webhook POSTs."""
    received = []
    server = _start_webhook_server(received, port=0)  # OS-assigned port
    yield WebhookCapture(url=f"http://localhost:{server.port}/hook", received=received)
    server.shutdown()
```

The test's `settings.json` configures a webhook pointing at this server. After the pipeline completes, the test asserts which events were delivered:

```python
def test_stop_dispatches_webhook(pipeline_env, webhook_server):
    pipeline_env.add_webhook(webhook_server.url)
    scenario = {"default": {"action": "succeed", "delay_s": 0.1},
                "agents": {"implementer": {"action": "hang"}}}
    result = run_and_act(pipeline_env, scenario, send_sigterm,
                         act_after_stage="implement")

    assert result.status["pipeline_status"] == "interrupted"
    assert any(e["event_type"] == "pipeline.run.interrupted"
               for e in webhook_server.received)
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

**Files:** `tests/integration/__init__.py`, `tests/integration/conftest.py`, `tests/integration/helpers.py`

**Tasks:**
1. Create `pipeline_env` fixture:
   - Initialize git repo with initial commit in tmp_path
   - Run `worca init .` to copy full runtime (agents, schemas, hooks, etc.)
   - Override settings.json for fast execution (disable plan_review/learn, low max_turns)
   - Wire `WORCA_CLAUDE_BIN` to mock binary via `sys.executable`
   - Provide `run()` (blocking) and `run_background()` (Popen) methods
   - Invoke pipeline via `python -m worca.scripts.run_pipeline` (not relative path)
2. Create `run_and_act()` helper for background pipeline + mid-run actions
3. Create action functions (sigterm, sigint, sigkill, control-stop, control-pause)
4. Create `PipelineResult` and `PipelineEnv` dataclasses
5. Create `webhook_server` fixture with HTTP capture server
6. Create `_wait_for_stage()` polling helper
7. Create `_find_latest_status()` and `_read_events_jsonl()` result readers

### Phase 3: Core Transition Tests

**Files:** `tests/integration/test_pipeline_transitions.py`

**Tasks:**
1. Define `EXPECTED_TRANSITIONS` matrix — tier-1 cells only (current VALID_ACTIONS)
2. Define `SKIPPED_NO_PROCESS` list — terminal state × signal combinations with rationale
3. Define `SKIPPED_W043` list — cancel/resume/cancelled cells with skip markers
4. Implement Pattern A tests: mid-run actions using `run_and_act()` with `hang` mock
5. Implement Pattern B tests: terminal-state immutability after pipeline exits
   - Run pipeline to completion (succeed/fail/signal)
   - Write control file to finished run
   - Assert status.json unchanged
6. Implement paused-state tests: pause via control file, pipeline exits, resume + act
7. Each tier-1 cell is covered by a named test function; skip-marked stubs document remaining cells

### Phase 4: Event & Webhook Dispatch Tests

**Files:** `tests/integration/test_pipeline_dispatch.py`

**Tasks:**
1. Test: control-stop emits `pipeline.run.interrupted` event to `events.jsonl`
2. Test: control-stop delivers webhook when configured
3. Test: SIGTERM emits interrupted event to `events.jsonl`
4. Test: completed pipeline delivers `pipeline.run.completed` webhook
5. Test: no webhook configured → no delivery attempt, no error
6. Mark test for cancel → `pipeline.run.cancelled` webhook as `skip(reason="requires W-043")`

### Phase 5: Edge Case Tests

**Files:** `tests/integration/test_pipeline_edge_cases.py`

**Tasks:**
1. Test: signal during `hang` mock (agent blocked in long call)
2. Test: double-signal (SIGTERM + SIGTERM) — no duplicate events
3. Test: control-file stop while paused (pause, then stop before resume)
4. Test: signal + exception handler race (signal arrives mid-stage-transition)
5. Test: pipeline with all stages disabled except one

### Files Changed Summary

| File | Change | Phase |
|------|--------|-------|
| `src/worca/utils/claude_cli.py` | Add `WORCA_CLAUDE_BIN` env var override | 1 |
| `tests/mock_claude/__init__.py` | New empty module | 1 |
| `tests/mock_claude/mock_claude.py` | New mock binary | 1 |
| `tests/mock_claude/conftest.py` | Scenario helpers | 1 |
| `tests/integration/__init__.py` | New empty module | 2 |
| `tests/integration/conftest.py` | `pipeline_env`, `webhook_server` fixtures | 2 |
| `tests/integration/helpers.py` | `run_and_act`, action functions, polling | 2 |
| `tests/integration/test_pipeline_transitions.py` | Tier-1 matrix tests + tier-2 skip stubs | 3 |
| `tests/integration/test_pipeline_dispatch.py` | Event/webhook dispatch tests | 4 |
| `tests/integration/test_pipeline_edge_cases.py` | Signal races, edge cases | 5 |

## Considerations

- **Test speed:** Each test spawns a Python subprocess (`run_pipeline.py`) which spawns mock claude subprocesses. With `delay_s: 0.1` per mock stage, a full pipeline takes ~1s. Tests using `hang` + signal add ~2-3s per test. Total suite: ~60-120s.

- **CI isolation:** Tests create temp directories and bind to ephemeral ports (webhook server). No shared state between tests. Safe for parallel execution with `pytest-xdist` if the `hang`-based tests are marked `serial`.

- **Platform coverage:** `signal.pause()` is Unix-only. On Windows, the `hang` action falls back to `time.sleep(3600)`. Control-file-based stop tests work on all platforms. SIGTERM tests should be marked `@pytest.mark.skipif(sys.platform == "win32")`.

- **No production code changes beyond env var:** The only production code change is the `WORCA_CLAUDE_BIN` override in `claude_cli.py`. All other changes are in `tests/`.

- **W-043 synergy:** Tier-2 cells (cancel action, cancelled state, resume action) are pre-defined as skip-marked stubs. When W-043 lands, remove the skip markers and fill in expected transitions. The harness design makes this a matrix table update, not a structural change.

- **Editable install dependency:** Tests require `pip install -e ".[dev]"` so that `python -m worca.scripts.run_pipeline` resolves. This is already a documented developer setup prerequisite in CLAUDE.md. CI should ensure the editable install is in place before running integration tests.

- **worca init in fixture:** Running `worca init .` per test is ~0.5s overhead (file copy) but ensures the runtime matches the current source exactly. Since the editable install points at `src/worca/`, the copied runtime in `.claude/worca/` will match. If init overhead becomes a problem, a session-scoped fixture can prepare a template directory that per-test fixtures copy from.

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
| `test_pipeline_transitions.py` | ~20 tier-1 parametrized + skip stubs | State × action matrix (current actions only) |
| `test_pipeline_dispatch.py` | 5-6 tests | Event emission + webhook delivery |
| `test_pipeline_edge_cases.py` | 5 tests | Signal races, double-signal, edge cases |

### Done Criteria

1. `pytest tests/integration/test_pipeline_transitions.py` passes all tier-1 cells
2. `pytest tests/integration/test_pipeline_dispatch.py` passes with webhook assertions
3. Mock claude binary handles all 5 action types without flakiness
4. Tests complete in under 120s total on CI
5. Tier-2 (W-043) cells are present as skip-marked stubs

## Out of Scope

- **Windows CI matrix** — Platform-specific tests are marked with skip decorators; adding a Windows CI runner is out of scope.
- **Performance benchmarking** — The harness validates correctness, not performance.
- **UI integration tests** — The harness tests the Python pipeline only, not the worca-ui server.
- **W-043 implementation** — This plan provides the test infrastructure; W-043 provides the state model changes. Cancel action, cancelled state, and resume action are tier-2 skip stubs.
- **Mock Claude for multi-pipeline (run_multi.py)** — Only single-pipeline `run_pipeline.py` is in scope.
