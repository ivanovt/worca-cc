"""Shared logic for the bd / gh test stubs (W-050 Phase 0).

The stubs intentionally avoid depending on real `bd` or `gh` binaries so the
integration suite runs in CI without those tools installed. They exist to
*record* what the pipeline would have invoked, and to *serve* canned responses
for commands that would otherwise produce JSON the pipeline parses.

Recording protocol
------------------
If ``$WORCA_STUB_LOG`` is set, each invocation appends one JSONL record:

    {"binary": "bd", "argv": [...], "cwd": "...", "ts": "2026-05-04T12:00:00.000Z"}

Tests read this file with ``json.loads`` per line to assert what was called.

Canned responses
----------------
Each binary has a per-binary env var pointing at a JSON file:

    $WORCA_STUB_BD_RESPONSE_FILE   → bd canned responses
    $WORCA_STUB_GH_RESPONSE_FILE   → gh canned responses

The file maps subcommand keys to ``{"stdout": str, "stderr": str, "exit": int}``.
The lookup key is the joined ``argv[1:]`` prefix that matches longest, then
``"default"`` if nothing matches. Example response file::

    {
      "issue view 123 --json number,title,body,labels,state": {
        "stdout": "{\\"number\\": 123, \\"title\\": \\"...\\"}",
        "exit": 0
      },
      "default": {"stdout": "", "exit": 0}
    }

Tests that don't care about output can omit the response file — the stub
defaults to exit 0 with empty stdout.

PATH safety
-----------
Per W-050 plan rule #16, stubs are activated per-test via
``monkeypatch.setenv("PATH", ...)``. They must never modify global PATH. The
``stubs`` directory is added to the front of ``PATH`` so the stub shadows any
real ``bd`` / ``gh`` only inside the test process.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone


def _log_invocation(binary: str, argv: list[str]) -> None:
    log_path = os.environ.get("WORCA_STUB_LOG")
    if not log_path:
        return
    record = {
        "binary": binary,
        "argv": argv,
        "cwd": os.getcwd(),
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    # Append-only JSONL — multiple stub processes can write concurrently;
    # one ``write`` of a small line is atomic on POSIX-typical block sizes.
    with open(log_path, "a") as f:
        f.write(json.dumps(record) + "\n")


def _load_responses(env_var: str) -> dict:
    path = os.environ.get(env_var)
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _pick_response(responses: dict, argv_tail: list[str]) -> dict:
    """Longest-prefix match on space-joined argv, falling back to ``default``."""
    joined = " ".join(argv_tail)
    best_key = None
    best_len = -1
    for key in responses:
        if key == "default":
            continue
        if joined == key or joined.startswith(key + " "):
            if len(key) > best_len:
                best_key = key
                best_len = len(key)
    if best_key is not None:
        return responses[best_key]
    return responses.get("default", {})


def _emit(response: dict) -> int:
    """Write a response dict's stdout/stderr and return its exit code."""
    stdout = response.get("stdout", "")
    stderr = response.get("stderr", "")
    exit_code = int(response.get("exit", 0))

    if stdout:
        sys.stdout.write(stdout)
        if not stdout.endswith("\n"):
            sys.stdout.write("\n")
    if stderr:
        sys.stderr.write(stderr)
        if not stderr.endswith("\n"):
            sys.stderr.write("\n")
    return exit_code


# ---------------------------------------------------------------------------
# Stateful bead pool (opt-in via $WORCA_STUB_BEADS_FILE)
# ---------------------------------------------------------------------------
#
# Unlike the canned-response mechanism, this serves a *sequence* of beads:
# ``bd ready`` lists only beads not yet closed, ``bd close <id>`` records the
# closure to a sibling state file, and ``bd show <id>`` emits the bead with its
# ``worca-effort:`` label. This lets integration tests exercise multi-bead
# Phase-1 fan-out (one IMPLEMENT iteration per bead) — see W-052. When the env
# var is unset the stub falls through to the stateless canned responses, so
# existing tests are unaffected.


def _bead_state_path(beads_file: str) -> str:
    return beads_file + ".closed"


def _load_bead_pool() -> list | None:
    path = os.environ.get("WORCA_STUB_BEADS_FILE")
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f).get("beads", [])
    except (OSError, json.JSONDecodeError):
        return None


def _load_closed(beads_file: str) -> set:
    path = _bead_state_path(beads_file)
    if not os.path.exists(path):
        return set()
    try:
        with open(path) as f:
            return set(json.load(f))
    except (OSError, json.JSONDecodeError):
        return set()


def _save_closed(beads_file: str, closed: set) -> None:
    with open(_bead_state_path(beads_file), "w") as f:
        json.dump(sorted(closed), f)


def _render_ready(open_beads: list) -> str:
    lines = [f"\U0001f4cb Ready work ({len(open_beads)} issues with no blockers):", ""]
    for i, b in enumerate(open_beads, 1):
        pri = b.get("priority", "P2")
        typ = b.get("type", "task")
        lines.append(f"{i}. [● {pri}] [{typ}] {b['id']}: {b.get('title', '')}")
    return "\n".join(lines) + "\n"


def _render_show(bead: dict) -> str:
    pri = bead.get("priority", "P2")
    out = f"○ {bead['id']} · {bead.get('title', '')}   [● {pri} · OPEN]\n"
    effort = bead.get("effort")
    if effort:
        out += f"LABELS: worca-effort:{effort}\n"
    return out


def _handle_bd_beads(argv: list) -> dict | None:
    """Serve ready/show/close from a stateful bead pool, or None to fall through."""
    beads_file = os.environ.get("WORCA_STUB_BEADS_FILE")
    if not beads_file:
        return None
    beads = _load_bead_pool()
    if beads is None or not argv:
        return None

    sub = argv[0]
    closed = _load_closed(beads_file)

    if sub == "ready":
        open_beads = [b for b in beads if b["id"] not in closed]
        return {"stdout": _render_ready(open_beads), "exit": 0}
    if sub == "show" and len(argv) >= 2:
        for b in beads:
            if b["id"] == argv[1]:
                return {"stdout": _render_show(b), "exit": 0}
        return None  # unknown bead — let canned/default handle it
    if sub == "close" and len(argv) >= 2:
        closed.add(argv[1])
        _save_closed(beads_file, closed)
        return {"stdout": f"Closed {argv[1]}", "exit": 0}
    return None  # update / label / etc. fall through to canned responses


def run_stub(binary: str, response_env_var: str) -> int:
    """Execute the stub: log the call, emit a canned response, exit."""
    argv = sys.argv[1:]
    _log_invocation(binary, argv)

    if binary == "bd":
        bead_response = _handle_bd_beads(argv)
        if bead_response is not None:
            return _emit(bead_response)

    responses = _load_responses(response_env_var)
    return _emit(_pick_response(responses, argv))
