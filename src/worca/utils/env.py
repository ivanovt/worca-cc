"""Build enriched environment for subprocesses.

Tools like bd (nvm), uv (pipx), claude (homebrew) live in user-local
directories that may not be in PATH when claude -p spawns its Bash tool.
This module discovers those directories at import time and provides an
env dict that guarantees they're reachable.
"""

import os
import shutil


# Tools the pipeline needs available in agent subprocesses.
_TOOLS = ("bd", "claude", "uv", "python3", "node", "git")

# Discover tool directories once at import time.
_extra_dirs: list[str] = []
for _tool in _TOOLS:
    _path = shutil.which(_tool)
    if _path:
        _dir = os.path.dirname(os.path.realpath(_path))
        if _dir not in _extra_dirs:
            _extra_dirs.append(_dir)


RESERVED_ENV_KEYS = frozenset({
    "PATH",
    "CLAUDECODE",
    "WORCA_AGENT",
    "WORCA_PROJECT_ROOT",
    "WORCA_RUN_ID",
    "WORCA_RUN_DIR",
    "WORCA_PLAN_FILE",
    "WORCA_EVENTS_PATH",
    "WORCA_TARGET_BRANCH",
    "WORCA_COVERAGE",
    "WORCA_SKIP_BEADS",
    "WORCA_CLAUDE_BIN",
})
RESERVED_PREFIXES = ("WORCA_",)


def filter_model_env(model_env: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Strip reserved keys from a model env dict.

    Returns (safe_env, dropped_keys).
    """
    safe, dropped = {}, []
    for k, v in model_env.items():
        if k in RESERVED_ENV_KEYS or any(k.startswith(p) for p in RESERVED_PREFIXES):
            dropped.append(k)
            continue
        safe[k] = str(v)
    return safe, dropped


def get_env(**overrides: str) -> dict[str, str]:
    """Return os.environ copy with tool directories prepended to PATH.

    Any keyword arguments are merged as additional env vars.
    """
    env = os.environ.copy()
    # Prepend discovered tool dirs so they win over defaults
    existing = env.get("PATH", "")
    extra = os.pathsep.join(d for d in _extra_dirs if d not in existing)
    if extra:
        env["PATH"] = f"{extra}{os.pathsep}{existing}"
    # Remove CLAUDECODE to allow nested claude CLI invocations
    env.pop("CLAUDECODE", None)
    # Set project root so hooks can force cwd back after agent `cd` commands
    if "WORCA_PROJECT_ROOT" not in env:
        env["WORCA_PROJECT_ROOT"] = os.getcwd()
    env.update(overrides)
    return env
