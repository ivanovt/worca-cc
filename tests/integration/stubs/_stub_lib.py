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


def run_stub(binary: str, response_env_var: str) -> int:
    """Execute the stub: log the call, emit a canned response, exit."""
    argv = sys.argv[1:]
    _log_invocation(binary, argv)

    responses = _load_responses(response_env_var)
    response = _pick_response(responses, argv)

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
