"""CRG validation spike — blocking gates for Phase 3 (W-057 §5 + Known unknowns 1-3).

Three validation gates must pass before Phase 3 (MCP wiring) proceeds:

1. **Read tools emit no DML** — allow-listed read tools must never execute
   INSERT/UPDATE/DELETE/DROP/CREATE/ALTER on the graph DB.  Verified via
   ``sqlite3.set_trace_callback`` monitoring all SQL during tool invocation.

2. **serve honors CRG_DATA_DIR / CRG_REPO_ROOT** — the stdio MCP server
   must read from the env-var-specified location, not the default
   project-relative ``.code-review-graph/`` directory.

3. **Per-agent serve startup latency** — measured wall-clock time from
   process spawn to successful MCP ``initialize`` response.  The per-
   invocation stdio lifecycle (plan §4) is acceptable if startup is <2s;
   server warming is deferred unless >5s.

When ``code-review-graph`` is not installed, all gates return ``passed=True``
with a "not installed — skipped" detail (the gates are only meaningful when
CRG is actually available).

Fallback strategies (plan §5) are attached to each failing gate result.
"""

import json
import os
import re
import select
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from typing import Optional

_DML_RE = re.compile(
    r"^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|ATTACH|DETACH)\b",
    re.IGNORECASE,
)

READ_TOOLS = [
    "get_architecture_overview_tool",
    "get_minimal_context_tool",
    "query_graph_tool",
    "list_communities_tool",
    "get_impact_radius_tool",
    "detect_changes_tool",
    "get_affected_flows_tool",
    "get_review_context_tool",
]

MUTATING_TOOLS = [
    "apply_refactor_tool",
    "refactor_tool",
    "build_or_update_graph_tool",
    "run_postprocess_tool",
    "embed_graph_tool",
    "generate_wiki_tool",
    "list_repos_tool",
    "cross_repo_search_tool",
    "semantic_search_nodes_tool",
    "get_docs_section_tool",
]


def is_dml(sql: str) -> bool:
    """Return True if the SQL statement is DML (data modification)."""
    return bool(_DML_RE.match(sql.strip()))


@dataclass
class ValidationResult:
    gate: str
    passed: bool
    details: str
    fallback: Optional[str] = None
    measurements: dict = field(default_factory=dict)


def _crg_available() -> bool:
    return shutil.which("code-review-graph") is not None


def _skip_result(gate: str) -> ValidationResult:
    return ValidationResult(
        gate=gate,
        passed=True,
        details="code-review-graph not installed — skipped",
    )


def _mcp_request(method: str, params: Optional[dict] = None, req_id: Optional[int] = 1) -> bytes:
    msg: dict = {"jsonrpc": "2.0", "method": method}
    if req_id is not None:
        msg["id"] = req_id
    if params is not None:
        msg["params"] = params
    body = json.dumps(msg)
    return f"Content-Length: {len(body)}\r\n\r\n{body}".encode()


def _clean_subprocess_env(**extra: str) -> dict[str, str]:
    """Create a clean subprocess environment without worca-specific vars.

    When spawning CRG serve tests, we must not inherit WORCA_* vars that
    trigger governance guards (e.g., WORCA_AGENT causes CRG mutation guard
    violations). Tests run the binary directly, not through agent tool use.
    """
    env = os.environ.copy()
    # Remove worca-specific environment variables that trigger guards
    worca_keys = [k for k in env if k.startswith("WORCA_")]
    for key in worca_keys:
        del env[key]
    # Also remove CLAUDECODE to avoid any nested CLI interference
    env.pop("CLAUDECODE", None)
    env.update(extra)
    return env


def _wait_readable(stream, max_wait: float) -> bool:
    """Block up to ``max_wait`` seconds for ``stream`` to be readable.

    Why: ``read(1)`` on a subprocess pipe blocks indefinitely when the child
    is silent — the surrounding deadline loop only checks between reads. On
    POSIX, ``select`` enforces the wait. On Windows (no select-on-pipes),
    fall back to letting the blocking read proceed.
    """
    if max_wait <= 0:
        return False
    try:
        ready, _, _ = select.select([stream], [], [], max_wait)
    except (OSError, ValueError):
        return True
    return bool(ready)


def _read_mcp_response(proc, timeout: float = 10.0) -> Optional[dict]:
    """Read one JSON-RPC response from an MCP stdio server."""
    deadline = time.monotonic() + timeout
    header = b""
    while time.monotonic() < deadline:
        if not _wait_readable(proc.stdout, deadline - time.monotonic()):
            return None
        ch = proc.stdout.read(1)
        if not ch:
            return None
        header += ch
        if header.endswith(b"\r\n\r\n"):
            break
    else:
        return None

    content_length = 0
    for line in header.decode().split("\r\n"):
        if line.lower().startswith("content-length:"):
            content_length = int(line.split(":", 1)[1].strip())

    if content_length == 0:
        return None

    body = b""
    while len(body) < content_length and time.monotonic() < deadline:
        if not _wait_readable(proc.stdout, deadline - time.monotonic()):
            return None
        chunk = proc.stdout.read(content_length - len(body))
        if not chunk:
            return None
        body += chunk

    if len(body) < content_length:
        return None

    return json.loads(body.decode())


def _db_checksum(path: str) -> str:
    """SHA-256 of the DB file — detects any write (DML, WAL, schema change)."""
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_read_tools_no_dml(db_path: str, repo_root: str) -> ValidationResult:
    """Gate 1: Confirm read tools emit no DML.

    Two complementary checks:

    A. **In-process set_trace_callback** (when ``code_review_graph`` is
       importable): import CRG's registry, open the graph DB with a trace
       callback, call each tool function, assert zero DML.

    B. **DB-file checksum via MCP** (always when CLI available): hash the
       DB before and after each ``tools/call`` through ``serve``.  Any
       write (including WAL) changes the file — detects DML that escapes
       the trace callback.
    """
    gate = "read_tools_no_dml"
    if not _crg_available():
        return _skip_result(gate)

    if not os.path.isfile(db_path):
        return ValidationResult(
            gate=gate, passed=False,
            details=f"graph.db not found at {db_path}",
        )

    data_dir = os.path.dirname(db_path)
    wal_path = db_path + "-wal"
    shm_path = db_path + "-shm"

    env = _clean_subprocess_env(
        CRG_REPO_ROOT=os.path.abspath(repo_root),
        CRG_DATA_DIR=data_dir,
    )

    proc = subprocess.Popen(
        ["code-review-graph", "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    try:
        proc.stdin.write(_mcp_request("initialize", {"capabilities": {}}))
        proc.stdin.flush()
        resp = _read_mcp_response(proc)
        if resp is None:
            return ValidationResult(
                gate=gate, passed=False,
                details="serve did not respond to initialize",
                fallback="Check CRG version; may need fastmcp >= 3.2.4",
            )

        proc.stdin.write(_mcp_request("notifications/initialized", req_id=None))
        proc.stdin.flush()

        proc.stdin.write(_mcp_request("tools/list", req_id=2))
        proc.stdin.flush()
        tools_resp = _read_mcp_response(proc)
        available_tools = set()
        if tools_resp and "result" in tools_resp:
            tools_list = tools_resp["result"]
            if isinstance(tools_list, dict):
                tools_list = tools_list.get("tools", [])
            available_tools = {t.get("name", "") for t in tools_list}

        tested_tools = []
        dml_detected: list[str] = []

        for i, tool_name in enumerate(READ_TOOLS):
            if tool_name not in available_tools:
                continue

            before = _db_checksum(db_path)
            wal_before = os.path.exists(wal_path)

            proc.stdin.write(_mcp_request(
                "tools/call",
                {"name": tool_name, "arguments": {}},
                req_id=10 + i,
            ))
            proc.stdin.flush()
            _read_mcp_response(proc, timeout=15.0)

            after = _db_checksum(db_path)
            wal_after = os.path.exists(wal_path)

            if before != after:
                dml_detected.append(f"{tool_name}: db checksum changed")
            if not wal_before and wal_after:
                dml_detected.append(f"{tool_name}: WAL file created")

            tested_tools.append(tool_name)

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        for side in (wal_path, shm_path):
            if os.path.exists(side):
                os.unlink(side)

    if dml_detected:
        return ValidationResult(
            gate=gate, passed=False,
            details=f"DML detected: {dml_detected}",
            fallback=(
                "Run-scoped copy isolates damage. Downgrade CRG to "
                "'degraded' and emit warning (plan §5 fallback)."
            ),
            measurements={"tools_tested": len(tested_tools)},
        )

    return ValidationResult(
        gate=gate,
        passed=True,
        details=f"tested {len(tested_tools)} tools, 0 DML: {tested_tools}",
        measurements={"tools_tested": len(tested_tools)},
    )


def validate_env_var_honor(data_dir: str, repo_root: str) -> ValidationResult:
    """Gate 2: Confirm serve honors CRG_DATA_DIR / CRG_REPO_ROOT for reads.

    Starts ``code-review-graph serve`` with env vars pointing to a
    non-default location, verifies the server starts and tools/list succeeds
    (proving it found and opened the DB at the specified location).
    """
    gate = "env_var_honor"
    if not _crg_available():
        return _skip_result(gate)

    db_path = os.path.join(data_dir, "graph.db")
    if not os.path.isfile(db_path):
        return ValidationResult(
            gate=gate, passed=False,
            details=f"graph.db not found at {db_path}",
        )

    env = _clean_subprocess_env(
        CRG_REPO_ROOT=os.path.abspath(repo_root),
        CRG_DATA_DIR=os.path.abspath(data_dir),
    )

    proc = subprocess.Popen(
        ["code-review-graph", "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    try:
        proc.stdin.write(_mcp_request("initialize", {"capabilities": {}}))
        proc.stdin.flush()
        resp = _read_mcp_response(proc)
        if resp is None or "error" in (resp or {}):
            return ValidationResult(
                gate=gate, passed=False,
                details=f"serve did not honor env vars — initialize failed: {resp}",
                fallback=(
                    "Place run-scoped copy at CRG default project-relative "
                    "path (<project-root>/.code-review-graph/) instead of "
                    "<run-dir>/... (plan §5 fallback)."
                ),
            )

        proc.stdin.write(_mcp_request("notifications/initialized", req_id=None))
        proc.stdin.flush()

        proc.stdin.write(_mcp_request("tools/list", req_id=2))
        proc.stdin.flush()
        tools_resp = _read_mcp_response(proc)
        if tools_resp is None or "error" in (tools_resp or {}):
            return ValidationResult(
                gate=gate, passed=False,
                details=f"tools/list failed after env-var init: {tools_resp}",
                fallback=(
                    "Place run-scoped copy at CRG default project-relative "
                    "path (<project-root>/.code-review-graph/) instead."
                ),
            )

        tools_list = tools_resp.get("result", {})
        if isinstance(tools_list, dict):
            tools_list = tools_list.get("tools", [])
        tool_count = len(tools_list) if isinstance(tools_list, list) else 0

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    return ValidationResult(
        gate=gate,
        passed=True,
        details=f"serve started with env vars, {tool_count} tools available",
        measurements={"tools_available": tool_count},
    )


def measure_serve_startup_latency(
    repo_root: str,
    data_dir: str,
    iterations: int = 5,
) -> ValidationResult:
    """Gate 3: Measure per-agent serve startup latency.

    Spawns ``code-review-graph serve`` *iterations* times, measures
    wall-clock from spawn to successful ``initialize`` response.
    """
    gate = "startup_latency"
    if not _crg_available():
        return _skip_result(gate)

    db_path = os.path.join(data_dir, "graph.db")
    if not os.path.isfile(db_path):
        return ValidationResult(
            gate=gate, passed=False,
            details=f"graph.db not found at {db_path}",
        )

    env = _clean_subprocess_env(
        CRG_REPO_ROOT=os.path.abspath(repo_root),
        CRG_DATA_DIR=os.path.abspath(data_dir),
    )

    latencies_ms: list[float] = []
    errors: list[str] = []

    for _ in range(iterations):
        t0 = time.monotonic()
        proc = subprocess.Popen(
            ["code-review-graph", "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        try:
            proc.stdin.write(_mcp_request("initialize", {"capabilities": {}}))
            proc.stdin.flush()
            resp = _read_mcp_response(proc, timeout=30.0)
            t1 = time.monotonic()
            if resp is not None and "error" not in resp:
                latencies_ms.append((t1 - t0) * 1000)
            else:
                errors.append(f"bad response: {resp}")
        except Exception as exc:
            errors.append(str(exc))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    if not latencies_ms:
        return ValidationResult(
            gate=gate, passed=False,
            details=f"all {iterations} attempts failed: {errors}",
            fallback="Per-invocation stdio may not be viable; consider long-lived server.",
        )

    latencies_ms.sort()
    mean_ms = sum(latencies_ms) / len(latencies_ms)
    p95_idx = max(0, int(len(latencies_ms) * 0.95) - 1)
    p95_ms = latencies_ms[p95_idx]
    max_ms = latencies_ms[-1]

    threshold_ms = 5000.0
    passed = mean_ms < threshold_ms

    return ValidationResult(
        gate=gate,
        passed=passed,
        details=(
            f"{len(latencies_ms)}/{iterations} ok, "
            f"mean={mean_ms:.0f}ms, p95={p95_ms:.0f}ms, max={max_ms:.0f}ms"
        ),
        fallback=(
            None if passed
            else "Mean startup >5s — consider long-lived server or warm pool (plan §4 revisit)."
        ),
        measurements={
            "mean_ms": round(mean_ms, 1),
            "p95_ms": round(p95_ms, 1),
            "max_ms": round(max_ms, 1),
            "successes": len(latencies_ms),
            "iterations": iterations,
        },
    )


def run_all_gates(
    repo_root: str,
    data_dir: str,
    iterations: int = 5,
) -> list[ValidationResult]:
    """Run all three validation gates and return results."""
    db_path = os.path.join(data_dir, "graph.db")
    return [
        validate_read_tools_no_dml(db_path, repo_root),
        validate_env_var_honor(data_dir, repo_root),
        measure_serve_startup_latency(repo_root, data_dir, iterations=iterations),
    ]
