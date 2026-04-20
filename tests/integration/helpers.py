"""Integration test helpers: dataclasses, action functions, and polling utilities."""
import json
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class PipelineResult:
    returncode: int
    status: dict
    events: list
    stdout: str
    stderr: str


@dataclass
class PipelineEnv:
    project: Path
    worca_dir: Path
    run: Callable
    run_background: Callable
    add_webhook: Callable


@dataclass
class WebhookCapture:
    url: str
    received: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# Result readers
# ---------------------------------------------------------------------------

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


def _read_events_jsonl(worca_dir: Path) -> list:
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


def _active_run_id(worca_dir: Path) -> str:
    """Read the active run ID from .worca/active_run."""
    return (worca_dir / "active_run").read_text().strip()


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------

def _wait_for_stage(worca_dir: Path, stage_name: str, timeout: float = 10) -> None:
    """Poll status.json until the named stage is in_progress."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = _find_latest_status(worca_dir)
        stage_data = status.get("stages", {}).get(stage_name, {})
        if stage_data.get("status") == "in_progress":
            return
        time.sleep(0.1)
    raise TimeoutError(f"Stage {stage_name!r} did not start within {timeout}s")


def _wait_for_stage_completed(worca_dir: Path, stage_name: str, timeout: float = 10) -> None:
    """Poll status.json until the named stage has status='completed'."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = _find_latest_status(worca_dir)
        stage_data = status.get("stages", {}).get(stage_name, {})
        if stage_data.get("status") == "completed":
            return
        time.sleep(0.1)
    raise TimeoutError(f"Stage {stage_name!r} did not complete within {timeout}s")


# ---------------------------------------------------------------------------
# run_and_act
# ---------------------------------------------------------------------------

def run_and_act(
    pipeline_env: PipelineEnv,
    scenario: dict,
    action_fn: Callable,
    act_after_stage: Optional[str] = None,
    timeout: float = 15,
) -> PipelineResult:
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
        status=status,
        events=events,
        stdout=proc.stdout.read() if proc.stdout else "",
        stderr=proc.stderr.read() if proc.stderr else "",
    )


# ---------------------------------------------------------------------------
# Action functions
# ---------------------------------------------------------------------------

def send_sigterm(proc, env: PipelineEnv) -> None:
    """Send SIGTERM to the pipeline process group."""
    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)


def send_sigint(proc, env: PipelineEnv) -> None:
    """Send SIGINT to the pipeline process group."""
    os.killpg(os.getpgid(proc.pid), signal.SIGINT)


def send_sigkill(proc, env: PipelineEnv) -> None:
    """Send SIGKILL to the pipeline process group."""
    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)


def write_control_stop(proc, env: PipelineEnv) -> None:
    """Write a stop control file using the current control.py protocol."""
    run_id = _active_run_id(env.worca_dir)
    control = env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({
        "action": "stop",
        "requested_at": datetime.utcnow().isoformat() + "Z",
        "source": "test",
    }))


def write_control_pause(proc, env: PipelineEnv) -> None:
    """Write a pause control file using the current control.py protocol."""
    run_id = _active_run_id(env.worca_dir)
    control = env.worca_dir / "runs" / run_id / "control.json"
    control.write_text(json.dumps({
        "action": "pause",
        "requested_at": datetime.utcnow().isoformat() + "Z",
        "source": "test",
    }))
