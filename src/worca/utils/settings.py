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
    importlib.resources.files("worca.schemas").joinpath("keys.json").read_text(encoding="utf-8")
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
        with open(settings_path, encoding="utf-8") as f:
            base = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

    local_path = _local_path_for(settings_path)
    if not os.path.exists(local_path):
        return base

    try:
        with open(local_path, encoding="utf-8") as f:
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


_DEFAULT_MODEL_MAP = {
    "opus": "claude-opus-4-6",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5-20251001",
}


def normalize_model_entry(value):
    """Canonicalize a worca.models entry to {id, env} form.

    - String value -> {"id": value, "env": {}}
    - Dict value -> must contain "id" (str); "env" defaults to {}; extra keys ignored.
    - Anything else -> raise ValueError.
    """
    if isinstance(value, str):
        return {"id": value, "env": {}}
    if isinstance(value, dict) and isinstance(value.get("id"), str):
        env = value.get("env") or {}
        if not isinstance(env, dict):
            raise ValueError(f"model env must be a dict, got {type(env).__name__}")
        return {"id": value["id"], "env": dict(env)}
    raise ValueError("model entry must be a string ID or {id, env} object")


def resolve_model(name, models_cfg):
    """Look up a model shorthand in a worca.models config dict.

    Returns (resolved_id, env_dict).  When the name is not in models_cfg,
    falls back to _DEFAULT_MODEL_MAP, then treats it as an opaque
    pass-through ID.
    """
    if name is None:
        return None, {}
    raw = models_cfg.get(name, _DEFAULT_MODEL_MAP.get(name))
    if raw is None:
        return name, {}
    entry = normalize_model_entry(raw)
    return entry["id"], entry["env"]


def _default_global_path() -> str:
    from worca.utils.paths import worca_home
    return os.path.join(worca_home(), "settings.json")


def load_global_settings(*, global_path: str | None = None) -> dict:
    """Load global settings from ~/.worca/settings.json (with .local.json merge).

    Returns {} if the file doesn't exist or contains invalid JSON.
    """
    if global_path is None:
        global_path = _default_global_path()
    return load_settings(global_path)


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
        with open(global_path, encoding="utf-8") as f:
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
