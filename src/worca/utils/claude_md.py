"""CLAUDE.md load-mode overlay primitive.

build_overlay(mode, project_root) -> Optional[dict]
    Returns the dict to write as an ephemeral overlay JSON file passed via
    ``--settings <path>`` to every claude subprocess, or None for mode 'all'
    (no flag emitted).

resolve_claude_md_mode(cli_override, settings_path) -> str
    Resolves the effective mode: CLI override > project settings > 'all'.
    Template-layer stripping is handled upstream (templates.py); this function
    sees the already-merged effective settings.
"""

import json
import os
from pathlib import Path, PurePosixPath
from typing import Optional


# Known org-policy paths emitted for forward-compat. claudeMdExcludes is a
# blocklist-only mechanism; managed/org CLAUDE.md loaded at a lower layer is
# not covered by this, but we emit the patterns anyway.
_ORG_POLICY_PATHS = [
    "/etc/claude-code/CLAUDE.md",
    "/Library/Application Support/ClaudeCode/CLAUDE.md",
    "C:/ProgramData/ClaudeCode/CLAUDE.md",
]

_VALID_MODES = frozenset({"none", "project", "project+local", "all"})


def build_overlay(mode: str, project_root: str) -> Optional[dict]:
    """Return the settings overlay dict for the given mode, or None for 'all'.

    - 'all'          -> None (no overlay file written, no --settings flag)
    - 'none'         -> {"autoMemoryEnabled": False, "claudeMdExcludes": [<broad blocklist>]}
    - 'project'      -> {"claudeMdExcludes": [<all paths except project CLAUDE.md>]}
    - 'project+local'-> {"claudeMdExcludes": [<all paths except project CLAUDE.md + CLAUDE.local.md>]}

    The 'none' mode pairs ``autoMemoryEnabled: false`` (disables auto-memory
    writes) with a broad ``claudeMdExcludes`` block. Empirically,
    ``autoMemoryEnabled: false`` alone does NOT prevent Claude Code from
    loading CLAUDE.md — those two concerns are separate (per
    ``claude --help`` for ``--bare``). The ``**/CLAUDE.md`` glob is what
    actually blocks loading; the absolute paths are belt-and-suspenders for
    layers that may not resolve the glob (user-home + org-policy paths).
    """
    if mode == "all":
        return None

    if mode == "none":
        return {
            "autoMemoryEnabled": False,
            "claudeMdExcludes": _build_none_excludes(),
        }

    if mode in ("project", "project+local"):
        excludes = _build_excludes(mode, project_root)
        return {"claudeMdExcludes": excludes}

    raise ValueError(f"Unknown claude_md_mode: {mode!r}. Valid: {sorted(_VALID_MODES)}")


def _build_none_excludes() -> list:
    """Build the claudeMdExcludes list for 'none' mode.

    Combines a broad ``**/`` glob (which Claude Code honours) with the
    same enumerated absolute paths the 'project' mode uses for user-home
    and org-policy locations, in POSIX form for cross-platform stability.
    """
    home_posix = PurePosixPath(Path.home().as_posix())
    return [
        "**/CLAUDE.md",
        "**/CLAUDE.local.md",
        str(home_posix / ".claude" / "CLAUDE.md"),
        str(home_posix / "CLAUDE.md"),
        *_ORG_POLICY_PATHS,
    ]


def _build_excludes(mode: str, project_root: str) -> list:
    """Build the claudeMdExcludes list for 'project' or 'project+local'.

    Paths are emitted in POSIX form (forward slashes) on every platform so the
    overlay JSON is portable across machines and predictable in tests. The
    Claude Code resolver accepts forward-slash paths on Windows.
    """
    excludes = []

    # Normalize project_root to a POSIX-style path for consistent output across
    # platforms. as_posix() preserves drive letters on Windows (C:/x/y).
    project_posix = PurePosixPath(Path(project_root).as_posix())

    # 1. User-home paths
    home_posix = PurePosixPath(Path.home().as_posix())
    excludes.append(str(home_posix / ".claude" / "CLAUDE.md"))
    excludes.append(str(home_posix / "CLAUDE.md"))

    # 2. Org-policy forward-compat paths
    excludes.extend(_ORG_POLICY_PATHS)

    # 3. All ancestor directories walked up from project_root to filesystem root
    for ancestor in project_posix.parents:
        excludes.append(str(ancestor / "CLAUDE.md"))

    # 4. Project-root exclusions depend on mode
    #    'project'      keeps CLAUDE.md, excludes CLAUDE.local.md
    #    'project+local' keeps both CLAUDE.md and CLAUDE.local.md
    if mode == "project":
        excludes.append(str(project_posix / "CLAUDE.local.md"))
    # For 'project+local': neither CLAUDE.md nor CLAUDE.local.md is excluded

    return excludes


def resolve_claude_md_mode(
    cli_override: Optional[str],
    settings_path: Optional[str],
) -> str:
    """Return the effective claude_md_mode. Never returns None.

    Precedence: cli_override > worca.claude_md_mode in settings > 'all'.
    Template stripping is handled upstream; this function sees the post-strip
    effective settings.
    """
    if cli_override is not None:
        return cli_override

    if settings_path:
        try:
            with open(settings_path, encoding="utf-8") as f:
                settings = json.load(f)
            mode = settings.get("worca", {}).get("claude_md_mode")
            if isinstance(mode, str) and mode in _VALID_MODES:
                return mode
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

    return "all"


def write_overlay(
    mode: str,
    run_dir: Optional[str],
    project_root: Optional[str] = None,
) -> tuple[Optional[str], Optional[dict]]:
    """Build the overlay for ``mode`` and write it into ``run_dir``.

    Returns ``(overlay_path, overlay_dict)``. Both are ``None`` when mode is
    ``"all"``, when ``run_dir`` is missing, or when ``build_overlay`` returns
    ``None``. ``project_root`` defaults to the current working directory —
    matching the runner's resolution rules at pipeline launch.
    """
    if mode == "all" or not run_dir:
        return None, None

    overlay_dict = build_overlay(mode, project_root or os.getcwd())
    if overlay_dict is None:
        return None, None

    overlay_path = os.path.join(run_dir, "claude_md_overlay.json")
    with open(overlay_path, "w", encoding="utf-8") as f:
        json.dump(overlay_dict, f, indent=2)
    return overlay_path, overlay_dict


def resolve_and_materialize(
    cli_override: Optional[str],
    settings_path: Optional[str],
    run_dir: Optional[str],
    project_root: Optional[str] = None,
) -> tuple[str, Optional[str], Optional[dict]]:
    """Resolve the effective mode and write its overlay JSON into ``run_dir``.

    Convenience wrapper that combines :func:`resolve_claude_md_mode` and
    :func:`write_overlay`. Use this when ``run_dir`` already exists at
    resolution time; otherwise call the two functions separately.
    """
    mode = resolve_claude_md_mode(cli_override, settings_path)
    overlay_path, overlay_dict = write_overlay(mode, run_dir, project_root)
    return mode, overlay_path, overlay_dict
