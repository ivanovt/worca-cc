"""Shared runtime helpers — copy and validate the worca runtime directory.

Used by run_worktree.py and run_parallel.py so both scripts handle the
gitignored-.claude/ case the same way.
"""
import json
import os
import shutil
import sys

# Allowlist of worca-namespace keys that are derived from the parent's
# runtime (host:port of the local UI, etc.) but must follow the run into
# the worktree. Everything else in settings.local.json stays parent-only.
PROPAGATED_LOCAL_WORCA_KEYS = ("webhooks", "events")


def deep_merge(base: dict, override: dict) -> dict:
    """Dict-recursive merge — dicts merge, lists/scalars replace wholesale.

    Same semantics as worca.utils.settings.deep_merge.
    """
    result = dict(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = deep_merge(result[k], v)
        else:
            result[k] = v
    return result


def propagate_runtime_local_keys(src_dir: str, dst_dir: str) -> None:
    """Merge a narrow allowlist of worca-namespace keys from the parent's
    settings.local.json into the worktree's settings.json.

    No-op when:
    - The parent has no settings.local.json.
    - The local file has no worca-namespace runtime keys.
    - The worktree has no settings.json to augment.
    """
    src_local = os.path.join(src_dir, "settings.local.json")
    dst_settings = os.path.join(dst_dir, "settings.json")
    if not os.path.exists(src_local) or not os.path.exists(dst_settings):
        return

    try:
        with open(src_local) as f:
            local = json.load(f)
    except (OSError, json.JSONDecodeError):
        return

    local_worca = (local.get("worca") if isinstance(local, dict) else None) or {}
    overlay = {k: local_worca[k] for k in PROPAGATED_LOCAL_WORCA_KEYS if k in local_worca}
    if not overlay:
        return

    try:
        with open(dst_settings) as f:
            base = json.load(f)
    except (OSError, json.JSONDecodeError):
        base = {}
    if not isinstance(base, dict):
        base = {}

    base_worca = base.get("worca")
    if not isinstance(base_worca, dict):
        base_worca = {}

    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(base_worca.get(key), dict):
            base_worca[key] = deep_merge(base_worca[key], value)
        else:
            base_worca[key] = value

    base["worca"] = base_worca

    with open(dst_settings, "w") as f:
        json.dump(base, f, indent=2)
        f.write("\n")


def copy_claude_config(src_dir: str, dst_dir: str) -> None:
    """Copy .claude/ contents into a worktree.

    Most projects gitignore .claude/, so a fresh worktree starts with no
    .claude/ at all — preflight then fails on missing settings.json. Copy
    everything from the project's .claude/ into the worktree with three rules:

    - Skip settings.local.json (machine-specific; never propagate verbatim).
    - Never clobber files git has already placed in the worktree. Tracked
      files win.
    - Narrow exception to the local-skip rule: a small allowlist of
      worca-namespace runtime keys (webhooks, events) is merged from the
      parent's settings.local.json into the worktree's settings.json.
    """
    skip_top_level = {"settings.local.json"}
    if not os.path.isdir(src_dir):
        return
    for root, _dirs, files in os.walk(src_dir):
        rel = os.path.relpath(root, src_dir)
        if rel == ".":
            files = [f for f in files if f not in skip_top_level]
        for f in files:
            dst_file = os.path.join(dst_dir, rel, f)
            if os.path.exists(dst_file):
                continue  # tracked-files-win
            os.makedirs(os.path.dirname(dst_file), exist_ok=True)
            shutil.copy2(os.path.join(root, f), dst_file)

    propagate_runtime_local_keys(src_dir, dst_dir)


def validate_runtime(runtime_dir: str = os.path.join(".claude", "worca")) -> None:
    """Verify the worca runtime directory exists in the current project.

    Raises SystemExit(1) with the canonical error message when the directory
    is absent so callers get a clear diagnostic before any side effects.
    """
    if not os.path.isdir(runtime_dir):
        print(
            f"error: worca runtime not found at {runtime_dir}/ — run `worca init .` first",
            file=sys.stderr,
        )
        raise SystemExit(1)
