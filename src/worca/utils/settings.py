"""Shared settings loader with .local.json deep-merge support.

All pipeline code should use load_settings() instead of reading settings.json
directly. This merges the base settings.json with a sibling settings.local.json
(if it exists), letting developers keep machine-specific config (webhooks, etc.)
out of version control.
"""

import importlib.resources
import json
import os
import sys

_schema = json.loads(
    importlib.resources.files("worca.schemas").joinpath("keys.json").read_text()
)
GLOBAL_ONLY_KEYS = [tuple(k) for k in _schema["global_only_keys"]]
NORMALIZE_SKIP_KEYS = [tuple(k) for k in _schema["normalize_skip_keys"]]
GLOBAL_DEFAULTS = _schema["defaults"]["global"]
PROJECT_DEFAULTS = _schema["defaults"]["project"]


def deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into base, returning a new dict.

    - Dicts are merged recursively.
    - Lists and scalars in override replace base values entirely.
    - Neither input dict is mutated.
    """
    result = dict(base)
    for key, val in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(val, dict):
            result[key] = deep_merge(result[key], val)
        else:
            result[key] = val
    return result


def _local_path_for(settings_path: str) -> str:
    """Derive the .local.json sibling path from a base settings path."""
    root, ext = os.path.splitext(settings_path)
    return root + ".local" + ext


def load_settings(settings_path: str) -> dict:
    """Load base settings and deep-merge any sibling .local.json over them.

    - If settings_path does not exist, returns {}.
    - If the .local.json sibling does not exist, returns the base as-is.
    - If .local.json has invalid JSON, logs a warning and returns the base.
    """
    try:
        with open(settings_path) as f:
            base = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

    local_path = _local_path_for(settings_path)
    if not os.path.exists(local_path):
        return base

    try:
        with open(local_path) as f:
            local = json.load(f)
    except json.JSONDecodeError:
        print(
            f"[settings] Warning: {local_path} contains invalid JSON, ignoring local overrides",
            file=sys.stderr,
        )
        return base
    except Exception:
        return base

    return deep_merge(base, local)


def _default_global_path() -> str:
    return os.path.expanduser("~/.worca/settings.json")


def load_settings_with_global_fallback(
    settings_path: str,
    *,
    global_path: str | None = None,
) -> dict:
    """Load project settings deep-merged over global (~/.worca/settings.json).

    Global values form the base; project values win on overlap.
    Missing or malformed global file is silently tolerated (warning on bad JSON).
    """
    if global_path is None:
        global_path = _default_global_path()

    try:
        with open(global_path) as f:
            global_blob = json.load(f)
    except FileNotFoundError:
        global_blob = {}
    except json.JSONDecodeError:
        print(
            f"[settings] Warning: {global_path} contains invalid JSON, ignoring global preferences",
            file=sys.stderr,
        )
        global_blob = {}

    project = load_settings(settings_path)
    if not global_blob:
        return project

    return deep_merge(global_blob, project)
