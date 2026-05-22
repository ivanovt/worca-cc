"""Graphify CLI detection and effective config resolution.

Provides detect_graphify() to probe for the graphify CLI and
effective_graphify_config() to resolve the two-tier (global + project)
settings into a single EffectiveGraphifyConfig.
"""

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Optional

_VALID_MODES = frozenset({"structural", "full"})

_BACKEND_ENV_KEYS = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OLLAMA_BASE_URL",
    "GEMINI_API_KEY",
)

_VERSION_RE = re.compile(r"(\d+\.\d+\.\d+)")
_SPEC_RE = re.compile(r"(>=|<=|>|<|==|!=)\s*(\d+(?:\.\d+)*)")


def _version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def _check_version_range(version: str, spec_str: str) -> bool:
    """Check whether version satisfies a comma-separated specifier string.

    Supports: >=, <=, >, <, ==, != with dotted version numbers.
    Example: _check_version_range("4.2.1", ">=4,<5") -> True
    """
    ver = _version_tuple(version)
    for clause in spec_str.split(","):
        clause = clause.strip()
        if not clause:
            continue
        m = _SPEC_RE.fullmatch(clause)
        if not m:
            return False
        op, bound_str = m.group(1), m.group(2)
        bound = _version_tuple(bound_str)
        # pad to equal length for comparison
        maxlen = max(len(ver), len(bound))
        vp = ver + (0,) * (maxlen - len(ver))
        bp = bound + (0,) * (maxlen - len(bound))
        if op == ">=" and not (vp >= bp):
            return False
        elif op == "<=" and not (vp <= bp):
            return False
        elif op == ">" and not (vp > bp):
            return False
        elif op == "<" and not (vp < bp):
            return False
        elif op == "==" and not (vp == bp):
            return False
        elif op == "!=" and not (vp != bp):
            return False
    return True

_GRAPHIFY_DEFAULTS = {
    "enabled": False,
    "mode": "structural",
    "backend": None,
    "model_profile": None,
    "out_dir": "graphify-out",
    "update_on": {
        "preflight": True,
        "guardian_post_commit": True,
    },
    "min_repo_files": 100,
    "version_range": ">=4,<5",
    "preflight_timeout_seconds": 300,
}


@dataclass(frozen=True)
class GraphifyDetect:
    installed: bool
    version: Optional[str]
    compatible: bool
    backend_env_present: list[str]
    error: Optional[str]


def detect_graphify(version_range: str = ">=4,<5") -> GraphifyDetect:
    """Probe for the graphify CLI. Cached at call sites — never call per-tool-use."""
    backend_env = [k for k in _BACKEND_ENV_KEYS if os.environ.get(k)]

    if shutil.which("graphify") is None:
        return GraphifyDetect(
            installed=False,
            version=None,
            compatible=False,
            backend_env_present=backend_env,
            error="graphify CLI not found on PATH",
        )

    try:
        proc = subprocess.run(
            ["graphify", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception as exc:
        return GraphifyDetect(
            installed=True,
            version=None,
            compatible=False,
            backend_env_present=backend_env,
            error=str(exc),
        )

    if proc.returncode != 0:
        return GraphifyDetect(
            installed=True,
            version=None,
            compatible=False,
            backend_env_present=backend_env,
            error=f"graphify --version exited {proc.returncode}: {proc.stderr.strip()}",
        )

    match = _VERSION_RE.search(proc.stdout)
    if not match:
        return GraphifyDetect(
            installed=True,
            version=None,
            compatible=False,
            backend_env_present=backend_env,
            error=f"could not parse version from: {proc.stdout.strip()!r}",
        )

    version = match.group(1)
    compatible = _check_version_range(version, version_range)

    return GraphifyDetect(
        installed=True,
        version=version,
        compatible=compatible,
        backend_env_present=backend_env,
        error=None if compatible else f"version {version} not in {version_range}",
    )


@dataclass(frozen=True)
class EffectiveGraphifyConfig:
    enabled: bool
    mode: str
    backend: Optional[str]
    model_profile: Optional[str]
    out_dir: str
    update_on_preflight: bool
    update_on_guardian_post_commit: bool
    min_repo_files: int
    version_range: str
    preflight_timeout_seconds: int = 300
    reason: Optional[str] = None


def effective_graphify_config(
    global_settings: dict,
    project_settings: dict,
) -> EffectiveGraphifyConfig:
    """Resolve two-tier graphify config into a single effective config.

    global_settings and project_settings are full settings dicts (with the
    "worca" key). Global enabled=false is a hard kill-switch — project
    cannot override it.
    """
    g_graphify = (
        global_settings.get("worca", {}).get("graphify", {})
    )
    p_graphify = (
        project_settings.get("worca", {}).get("graphify", {})
    )

    defaults = dict(_GRAPHIFY_DEFAULTS)
    defaults_update_on = dict(defaults["update_on"])

    global_enabled = g_graphify.get("enabled", defaults["enabled"])

    if not global_enabled:
        return _disabled_config(defaults, defaults_update_on, reason="global-off")

    project_enabled = p_graphify.get("enabled", global_enabled)
    if not project_enabled:
        return _disabled_config(defaults, defaults_update_on, reason="project-off")

    merged = dict(defaults)
    merged.update({k: v for k, v in g_graphify.items() if v is not None or k == "enabled"})
    merged.update({k: v for k, v in p_graphify.items() if v is not None or k == "enabled"})

    update_on = dict(defaults_update_on)
    if "update_on" in g_graphify and isinstance(g_graphify["update_on"], dict):
        update_on.update(g_graphify["update_on"])
    if "update_on" in p_graphify and isinstance(p_graphify["update_on"], dict):
        update_on.update(p_graphify["update_on"])

    mode = merged.get("mode", defaults["mode"])
    if mode not in _VALID_MODES:
        raise ValueError(
            f"invalid graphify mode {mode!r}, expected one of {sorted(_VALID_MODES)}"
        )

    return EffectiveGraphifyConfig(
        enabled=True,
        mode=mode,
        backend=merged.get("backend"),
        model_profile=merged.get("model_profile"),
        out_dir=merged.get("out_dir", defaults["out_dir"]),
        update_on_preflight=update_on.get("preflight", True),
        update_on_guardian_post_commit=update_on.get("guardian_post_commit", True),
        min_repo_files=merged.get("min_repo_files", defaults["min_repo_files"]),
        version_range=merged.get("version_range", defaults["version_range"]),
        preflight_timeout_seconds=merged.get(
            "preflight_timeout_seconds", defaults["preflight_timeout_seconds"]
        ),
        reason=None,
    )


def _disabled_config(
    defaults: dict, defaults_update_on: dict, *, reason: str
) -> EffectiveGraphifyConfig:
    return EffectiveGraphifyConfig(
        enabled=False,
        mode=defaults["mode"],
        backend=defaults.get("backend"),
        model_profile=defaults.get("model_profile"),
        out_dir=defaults["out_dir"],
        update_on_preflight=defaults_update_on.get("preflight", True),
        update_on_guardian_post_commit=defaults_update_on.get(
            "guardian_post_commit", True
        ),
        min_repo_files=defaults["min_repo_files"],
        version_range=defaults["version_range"],
        preflight_timeout_seconds=defaults["preflight_timeout_seconds"],
        reason=reason,
    )


def build_update_cmd(cfg: EffectiveGraphifyConfig) -> list[str]:
    """Build the ``graphify --update`` argv for an effective config.

    Shared by the preflight phase and the post-guardian refresh so the two
    paths never drift (e.g. one forgetting ``--backend``).
    """
    cmd = ["graphify", "--update"]
    if cfg.mode == "structural":
        cmd.append("--no-llm")
    if cfg.backend:
        cmd.extend(["--backend", cfg.backend])
    return cmd


def build_subprocess_env(
    cfg: EffectiveGraphifyConfig,
    settings: dict,
    base_env: Optional[dict] = None,
) -> dict:
    """Build the subprocess env for a graphify invocation.

    Merges the ``worca.models[model_profile]`` env (provider routing) over a
    copy of ``base_env`` (defaults to ``os.environ``). Shared by the preflight
    phase and the post-guardian refresh.
    """
    from worca.utils.settings import resolve_model

    env = dict(base_env if base_env is not None else os.environ)
    if cfg.model_profile:
        models_cfg = settings.get("worca", {}).get("models", {})
        _, model_env = resolve_model(cfg.model_profile, models_cfg)
        env.update(model_env)
    return env
