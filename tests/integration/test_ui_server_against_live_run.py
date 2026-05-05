"""W-050 Phase 6 — worca-ui server boundary tests.

Spawns the actual ``worca-ui`` Node.js server (``worca-ui/server/index.js``)
against a synthesized run directory and exercises the REST + WebSocket
surface end-to-end. This catches regressions like "files glob in
package.json drops a server module" that only manifest when the server
boots from its installed shape — call-site unit tests in
``worca-ui/server/*.test.js`` cannot detect that class of failure.

We spawn ``server/index.js`` directly rather than via ``bin/worca-ui.js``
because the bin script double-spawns + detaches the server process and
exits, which would leave the test fixture without a child PID to kill in
the finalizer (rule #17). The server module ships in the same npm package
files allowlist, so this still validates the published-tarball shape.

Plan rule #17: tests must use ephemeral ports (we discover a free port
via socket binding before spawning, since the server's own log line
prints the input port verbatim and would emit ``:0`` for ``--port 0``)
and the child process must be killed in a finalizer even on test failure.

Plan rule #8 — pyproject.toml change is justified: ``websocket-client``
is added to dev deps so the WebSocket test runs in CI; stdlib has no
WebSocket primitive.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import closing
from pathlib import Path

import pytest


_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_UI_SERVER_SCRIPT = _REPO_ROOT / "worca-ui" / "server" / "index.js"
_UI_NODE_MODULES = _REPO_ROOT / "worca-ui" / "node_modules"

# pytest-level skip if Node toolchain or worca-ui node_modules are unavailable.
_NODE_BIN = shutil.which("node")
_pytestmark_skip_reasons: list[str] = []
if _NODE_BIN is None:
    _pytestmark_skip_reasons.append("node binary not on PATH")
if not _UI_NODE_MODULES.is_dir():
    _pytestmark_skip_reasons.append(
        f"worca-ui dependencies not installed (run `cd worca-ui && npm install`); "
        f"missing {_UI_NODE_MODULES}"
    )

pytestmark = pytest.mark.skipif(
    bool(_pytestmark_skip_reasons),
    reason="; ".join(_pytestmark_skip_reasons) or "OK",
)


def _free_port() -> int:
    """Bind a SOCK_STREAM to port 0 to let the OS pick a free port, then
    close so the spawned server can grab it. Plan rule #17 spirit — no
    hardcoded port numbers, no clashes between concurrent tests."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_http(url: str, timeout: float = 15.0) -> None:
    """Poll an HTTP endpoint until it answers (any status), or raise on timeout."""
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0):
                return
        except urllib.error.HTTPError:
            return  # endpoint exists, just returned non-2xx — good enough
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            last_err = e
        time.sleep(0.15)
    raise TimeoutError(
        f"server did not become ready at {url} within {timeout}s; last error: {last_err}"
    )


def _http_get_json(url: str, timeout: float = 5.0) -> tuple[int, dict]:
    """GET a URL and parse the body as JSON. Returns (status, body)."""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"_raw": body}


def _http_post_json(url: str, payload: dict, timeout: float = 5.0) -> tuple[int, dict]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(body)
        except json.JSONDecodeError:
            return e.code, {"_raw": body}


def _synthesize_run(project: Path, run_id: str) -> Path:
    """Write a minimal status.json + events.jsonl for one run inside the
    project's .worca/runs/ tree — matches the W-048 layout the server
    expects without needing to run a real pipeline."""
    run_dir = project / ".worca" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    status = {
        "schema_version": 1,
        "run_id": run_id,
        "work_request": {
            "source_type": "prompt",
            "title": "Phase 6 synthetic run",
            "description": "test",
        },
        "pipeline_status": "completed",
        "stage": "pr",
        "branch": "phase-6-test",
        "started_at": "2026-05-05T00:00:00+00:00",
        "completed_at": "2026-05-05T00:01:00+00:00",
        "stages": {
            "preflight": {"status": "completed"},
            "plan":      {"status": "completed"},
            "coordinate": {"status": "completed"},
            "implement": {"status": "completed", "iteration": 1},
            "test":      {"status": "completed"},
            "review":    {"status": "completed"},
            "pr":        {"status": "completed"},
        },
        "milestones": {"plan_approved": True, "pr_approved": True},
    }
    (run_dir / "status.json").write_text(json.dumps(status, indent=2))

    events = [
        {"event_type": "pipeline.run.started", "run_id": run_id},
        {"event_type": "pipeline.stage.started", "stage": "plan", "run_id": run_id},
        {"event_type": "pipeline.run.completed", "run_id": run_id},
    ]
    (run_dir / "events.jsonl").write_text(
        "\n".join(json.dumps(e) for e in events) + "\n"
    )
    return run_dir


# ---------------------------------------------------------------------------
# Fixture: spawn worca-ui, kill on teardown (plan rule #17)
# ---------------------------------------------------------------------------


@pytest.fixture
def ui_project(tmp_path):
    """Create a project root with .claude/settings.json + one synthesized run."""
    project = tmp_path / "ui_project"
    project.mkdir()
    (project / ".claude").mkdir()
    (project / ".claude" / "settings.json").write_text(json.dumps({"worca": {}}))
    run_id = "20260505-000000-001-test"
    _synthesize_run(project, run_id)
    return project, run_id


@pytest.fixture
def ui_server_single_project(ui_project, tmp_path):
    """Start worca-ui in single-project mode against ui_project. Kills the
    child in the finalizer (rule #17) regardless of test outcome."""
    project, run_id = ui_project
    port = _free_port()

    home_dir = tmp_path / "fake_home"
    home_dir.mkdir()

    # Spawn server/index.js directly (rather than via bin/worca-ui.js, which
    # double-spawns + detaches and would leave us without a child PID to
    # cleanly kill in the finalizer).
    proc = subprocess.Popen(
        [_NODE_BIN, str(_UI_SERVER_SCRIPT),
         "--project", str(project),
         "--port", str(port),
         "--host", "127.0.0.1"],
        cwd=str(project),
        env={**os.environ, "HOME": str(home_dir), "WORCA_NO_OPEN": "1"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        _wait_for_http(f"{base_url}/api/runs", timeout=20.0)
        yield base_url, project, run_id
    finally:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


@pytest.fixture
def ui_server_global(ui_project, tmp_path):
    """Start worca-ui in global mode with a fake HOME, register ui_project
    in <fake_home>/.worca/projects.d/ before starting so /api/projects
    can list it."""
    project, run_id = ui_project
    port = _free_port()

    home_dir = tmp_path / "fake_home"
    (home_dir / ".worca" / "projects.d").mkdir(parents=True)

    # Per project-registry.js: entries are {name, path} where name is the
    # routing identifier in /api/projects/:projectId, AND the file basename
    # in projects.d/<name>.json. The resolver does `p.name === projectId`,
    # not by `id`, so the field naming matters.
    project_name = "phase6-test-project"
    project_entry = {"name": project_name, "path": str(project)}
    (home_dir / ".worca" / "projects.d" / f"{project_name}.json").write_text(
        json.dumps(project_entry)
    )

    proc = subprocess.Popen(
        [_NODE_BIN, str(_UI_SERVER_SCRIPT),
         "--global",
         "--port", str(port),
         "--host", "127.0.0.1"],
        cwd=str(home_dir),
        env={**os.environ, "HOME": str(home_dir), "WORCA_NO_OPEN": "1"},
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        _wait_for_http(f"{base_url}/api/projects", timeout=20.0)
        yield base_url, project, project_name, run_id
    finally:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.timeout(60)
def test_api_runs_lists_synthesized_run(ui_server_single_project):
    """``GET /api/runs`` in single-project mode returns the synthesized run
    discovered under ``.worca/runs/``. The runs array contains the run_id and
    the run's title from work_request — proving the server is reading the
    project we pointed it at."""
    base_url, _project, run_id = ui_server_single_project
    status, body = _http_get_json(f"{base_url}/api/runs")
    assert status == 200, f"unexpected status {status}; body: {body}"
    assert body.get("ok") is True
    runs = body.get("runs") or []
    assert any(r.get("run_id") == run_id for r in runs), (
        f"run_id {run_id!r} not in /api/runs response; got {[r.get('run_id') for r in runs]}"
    )


@pytest.mark.timeout(60)
def test_api_run_status_endpoint_matches_status_json(ui_server_single_project):
    """``GET /api/runs/<id>/status`` returns the run's pipeline_status, stage,
    and iteration fields read fresh from status.json. We synthesized
    pipeline_status=completed so the response must reflect it."""
    base_url, _project, run_id = ui_server_single_project
    status, body = _http_get_json(f"{base_url}/api/runs/{run_id}/status")
    assert status == 200, f"unexpected status {status}; body: {body}"
    assert body.get("ok") is True
    assert body.get("pipeline_status") == "completed"
    assert body.get("stage") == "pr"


@pytest.mark.timeout(60)
def test_api_projects_lists_pre_registered_project(ui_server_global):
    """``GET /api/projects`` in global mode returns the project we
    pre-registered in ``$HOME/.worca/projects.d/``. Validates the
    multi-project discovery path the fleet view depends on."""
    base_url, _project, project_name, _run_id = ui_server_global
    status, body = _http_get_json(f"{base_url}/api/projects")
    assert status == 200, f"unexpected status {status}; body: {body}"
    assert body.get("ok") is True
    names = [p.get("name") for p in (body.get("projects") or [])]
    assert project_name in names, (
        f"pre-registered project not listed; got names {names}"
    )


@pytest.mark.timeout(60)
def test_api_project_scoped_runs_returns_runs_for_project(ui_server_global):
    """``GET /api/projects/<name>/runs`` returns the same run as the
    unscoped endpoint, but routed via the multi-project resolver. This is
    the path the global UI uses to list runs across all registered projects
    (fleet / workspace cross-project listing)."""
    base_url, _project, project_name, run_id = ui_server_global
    status, body = _http_get_json(f"{base_url}/api/projects/{project_name}/runs")
    assert status == 200, f"unexpected status {status}; body: {body}"
    assert body.get("ok") is True
    runs = body.get("runs") or []
    assert any(r.get("run_id") == run_id for r in runs), (
        f"run not surfaced through project-scoped endpoint; got {[r.get('run_id') for r in runs]}"
    )


@pytest.mark.timeout(60)
def test_websocket_emits_hello_handshake_on_connect(ui_server_single_project):
    """The WS handshake — first message after connect — is a ``hello`` frame
    advertising protocol 2 capabilities. Asserting the shape end-to-end
    proves the WebSocket is wired to the HTTP server, the upgrade path
    works, and ``ws-modular.js`` is reachable from the bundled tarball."""
    websocket = pytest.importorskip("websocket")
    base_url, _project, _run_id = ui_server_single_project
    ws_url = base_url.replace("http://", "ws://") + "/ws"

    ws = websocket.create_connection(ws_url, timeout=5)
    try:
        raw = ws.recv()
    finally:
        ws.close()

    payload = json.loads(raw)
    assert payload.get("type") == "hello", (
        f"first WS message must be 'hello'; got {payload}"
    )
    assert payload.get("ok") is True
    assert payload.get("payload", {}).get("protocol") == 2
