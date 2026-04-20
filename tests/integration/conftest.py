"""Pytest fixtures for integration tests: pipeline_env and webhook_server."""
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from tests.integration.helpers import (
    PipelineEnv,
    PipelineResult,
    WebhookCapture,
    _find_latest_status,
    _read_events_jsonl,
)

MOCK_CLAUDE_BIN = Path(__file__).parent.parent / "mock_claude" / "mock_claude.py"


# ---------------------------------------------------------------------------
# pipeline_env fixture
# ---------------------------------------------------------------------------

@pytest.fixture
def pipeline_env(tmp_path):
    """Create a minimal project directory with full worca runtime and mock claude."""
    project = tmp_path / "project"
    project.mkdir()

    # 1. Initialize a git repo with an initial commit (preflight requires it)
    subprocess.run(["git", "init"], cwd=str(project), check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@test.com"],
                   cwd=str(project), check=True, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"],
                   cwd=str(project), check=True, capture_output=True)
    (project / "README.md").write_text("test")
    subprocess.run(["git", "add", "."], cwd=str(project), check=True, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=str(project),
                   check=True, capture_output=True)

    # 2. Run worca init to copy full runtime (agents, schemas, hooks, scripts)
    subprocess.run(
        [sys.executable, "-m", "worca.cli.main", "init"],
        cwd=str(project), check=True, capture_output=True,
    )

    # 3. Override settings for fast test execution
    settings_path = project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})
    settings["worca"]["stages"] = {
        "preflight": {"enabled": False},
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

    def _base_env(scenario_path: Path) -> dict:
        return {
            **os.environ,
            "WORCA_CLAUDE_BIN": f"{sys.executable} {MOCK_CLAUDE_BIN}",
            "MOCK_CLAUDE_SCENARIO": str(scenario_path),
            "WORCA_AGENT": "",  # not in agent mode — hooks should not enforce agent guards
        }

    def run(scenario: dict, prompt: str = "test task",
            timeout: int = 60, extra_args=None) -> PipelineResult:
        scenario_path = tmp_path / "scenario.json"
        scenario_path.write_text(json.dumps(scenario))

        cmd = [sys.executable, "-m", "worca.scripts.run_pipeline",
               "--prompt", prompt]
        if extra_args:
            cmd.extend(extra_args)

        result = subprocess.run(
            cmd, cwd=str(project), env=_base_env(scenario_path),
            capture_output=True, text=True, timeout=timeout,
        )

        status = _find_latest_status(worca_dir)
        events = _read_events_jsonl(worca_dir)
        return PipelineResult(
            returncode=result.returncode,
            status=status,
            events=events,
            stdout=result.stdout,
            stderr=result.stderr,
        )

    def run_background(scenario: dict, prompt: str = "test task",
                       extra_args=None) -> subprocess.Popen:
        """Start the pipeline as a background Popen — caller controls lifecycle."""
        scenario_path = tmp_path / "scenario.json"
        scenario_path.write_text(json.dumps(scenario))

        cmd = [sys.executable, "-m", "worca.scripts.run_pipeline",
               "--prompt", prompt]
        if extra_args:
            cmd.extend(extra_args)

        return subprocess.Popen(
            cmd, cwd=str(project), env=_base_env(scenario_path),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,  # own process group so signals target full tree
        )

    def add_webhook(url: str) -> None:
        """Add a webhook URL to settings for event dispatch testing.

        emitter.py _validate_webhook only accepts https:// or http://localhost
        prefixes — so the webhook_server fixture must bind to localhost.
        """
        s = json.loads(settings_path.read_text())
        s.setdefault("worca", {})
        s["worca"]["webhooks"] = [{"url": url}]
        settings_path.write_text(json.dumps(s, indent=2))

    return PipelineEnv(
        project=project,
        worca_dir=worca_dir,
        run=run,
        run_background=run_background,
        add_webhook=add_webhook,
    )


# ---------------------------------------------------------------------------
# webhook_server fixture
# ---------------------------------------------------------------------------

def _start_webhook_server(received: list, port: int = 0) -> HTTPServer:
    """Start an HTTP server that captures webhook POST bodies."""

    class _Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                received.append(json.loads(body))
            except json.JSONDecodeError:
                received.append({"_raw": body.decode()})
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass  # suppress default request logging

    server = HTTPServer(("localhost", port), _Handler)
    server.port = server.server_address[1]  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


@pytest.fixture
def webhook_server():
    """Start a local HTTP server that records received webhook POSTs."""
    received: list = []
    server = _start_webhook_server(received, port=0)
    yield WebhookCapture(url=f"http://localhost:{server.port}/hook", received=received)
    server.shutdown()
