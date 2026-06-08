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
from pathlib import Path
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
    - 'none'         -> {"autoMemoryEnabled": False}
    - 'project'      -> {"claudeMdExcludes": [<all paths except project CLAUDE.md>]}
    - 'project+local'-> {"claudeMdExcludes": [<all paths except project CLAUDE.md + CLAUDE.local.md>]}
    """
    if mode == "all":
        return None

    if mode == "none":
        return {"autoMemoryEnabled": False}

    if mode in ("project", "project+local"):
        excludes = _build_excludes(mode, project_root)
        return {"claudeMdExcludes": excludes}

    raise ValueError(f"Unknown claude_md_mode: {mode!r}. Valid: {sorted(_VALID_MODES)}")


def _build_excludes(mode: str, project_root: str) -> list:
    """Build the claudeMdExcludes list for 'project' or 'project+local'."""
    excludes = []

    # 1. User-home paths
    home = str(Path.home())
    excludes.append(os.path.join(home, ".claude", "CLAUDE.md"))
    excludes.append(os.path.join(home, "CLAUDE.md"))

    # 2. Org-policy forward-compat paths
    excludes.extend(_ORG_POLICY_PATHS)

    # 3. All ancestor directories walked up from project_root to filesystem root
    from pathlib import PurePath
    root_pure = PurePath(project_root)
    for ancestor in root_pure.parents:
        excludes.append(str(ancestor / "CLAUDE.md"))

    # 4. Project-root exclusions depend on mode
    #    'project'      keeps CLAUDE.md, excludes CLAUDE.local.md
    #    'project+local' keeps both CLAUDE.md and CLAUDE.local.md
    if mode == "project":
        excludes.append(os.path.join(project_root, "CLAUDE.local.md"))
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
