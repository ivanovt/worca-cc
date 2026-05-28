"""Graphify CLI detection and effective config resolution.

Provides detect_graphify() to probe for the graphify CLI and
effective_graphify_config() to resolve the two-tier (global + project)
settings into a single EffectiveGraphifyConfig.
"""

import os
from dataclasses import dataclass
from typing import Optional

from worca.utils.ast_cache import (
    ast_snapshot_dir,
)
from worca.utils.tool_detect import probe_cli

_VALID_MODES = frozenset({"structural", "full"})

_BACKEND_ENV_KEYS = (
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OLLAMA_BASE_URL",
    "GEMINI_API_KEY",
)

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
    "version_range": ">=0.8.16,<1",
    "preflight_timeout_seconds": 300,
    # "clean_only": cache the per-commit snapshot only when the working tree is
    # clean (dirty runs build a run-scoped throwaway). "base_sha": always
    # use/build the <commit-sha> snapshot regardless of working-tree state.
    "freshness": "clean_only",
}

_VALID_FRESHNESS = frozenset({"clean_only", "base_sha"})


@dataclass(frozen=True)
class GraphifyDetect:
    installed: bool
    version: Optional[str]
    compatible: bool
    backend_env_present: list[str]
    error: Optional[str]


def detect_graphify(version_range: str = ">=0.8.16,<1") -> GraphifyDetect:
    """Probe for the graphify CLI. Cached at call sites — never call per-tool-use."""
    backend_env = [k for k in _BACKEND_ENV_KEYS if os.environ.get(k)]
    probe = probe_cli("graphify", version_range=version_range)

    return GraphifyDetect(
        installed=probe.installed,
        version=probe.version,
        compatible=probe.compatible,
        backend_env_present=backend_env,
        error=probe.error,
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
    freshness: str = "clean_only"
    reason: Optional[str] = None


def effective_graphify_config(
    global_settings: dict,
    project_settings: dict,
) -> EffectiveGraphifyConfig:
    """Resolve two-tier graphify config into a single effective config.

    global_settings and project_settings are full settings dicts (with the
    "worca" key). Enablement is project-level: the project must opt in via
    ``graphify.enabled: true``. Global ``graphify.enabled`` is purely a
    kill-switch — an *explicit* global ``false`` disables graphify everywhere
    (admin / fleet / security lever); any other global value (``true`` or
    unset) defers entirely to the project. Global non-enable fields (mode,
    version_range, …) still serve as defaults that the project can override.
    """
    g_graphify = (
        global_settings.get("worca", {}).get("graphify", {})
    )
    p_graphify = (
        project_settings.get("worca", {}).get("graphify", {})
    )

    defaults = dict(_GRAPHIFY_DEFAULTS)
    defaults_update_on = dict(defaults["update_on"])

    # Explicit global ``enabled: false`` is the only global value that disables;
    # ``true`` and unset both defer to the project's own opt-in.
    if g_graphify.get("enabled") is False:
        return _disabled_config(defaults, defaults_update_on, reason="global-off")

    project_enabled = p_graphify.get("enabled", False)
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

    freshness = merged.get("freshness", defaults["freshness"])
    if freshness not in _VALID_FRESHNESS:
        raise ValueError(
            f"invalid graphify freshness {freshness!r}, "
            f"expected one of {sorted(_VALID_FRESHNESS)}"
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
        freshness=freshness,
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
        freshness=defaults["freshness"],
        reason=reason,
    )


def build_graph_cmd(
    cfg: EffectiveGraphifyConfig, project_root: str = "."
) -> list[str]:
    """Build the ``graphify update <path>`` argv for a per-commit snapshot.

    The graphifyy CLI re-extracts the code graph with ``graphify update <path>``
    — there is no ``build`` subcommand, and ``--no-llm`` / ``--backend`` are not
    real flags. ``update`` is pure code extraction (no LLM) by default;
    structural mode relies on that. Full mode runs the *same* command — the
    semantic pass activates when a provider key (e.g. ``GEMINI_API_KEY`` /
    ``GOOGLE_API_KEY``) is present in the subprocess env, which
    build_subprocess_env injects from the configured ``model_profile``.

    ``project_root`` is passed as the path argument (absolute, in practice) and
    the process is run from a cache dir, NOT the project — graphify drops a
    ``graphify-out/manifest.json`` relative to its cwd regardless of
    ``GRAPHIFY_OUT``, so running from the project would dirty the working tree
    (see _run_build). Output is redirected via the ``GRAPHIFY_OUT`` env. Shared
    by the preflight phase and the post-guardian cache-warm so they never drift.
    """
    return ["graphify", "update", project_root]


def build_subprocess_env(
    cfg: EffectiveGraphifyConfig,
    settings: dict,
    base_env: Optional[dict] = None,
    graphify_out: Optional[str] = None,
) -> dict:
    """Build the subprocess env for a graphify invocation.

    Merges the ``worca.models[model_profile]`` env (provider routing) over a
    copy of ``base_env`` (defaults to ``os.environ``). When ``graphify_out`` is
    given, sets ``GRAPHIFY_OUT`` so graphify reads/writes the per-commit cache
    snapshot instead of a ``graphify-out/`` dir in the repo.
    """
    from worca.utils.settings import resolve_model

    env = dict(base_env if base_env is not None else os.environ)
    if cfg.model_profile:
        models_cfg = settings.get("worca", {}).get("models", {})
        _, model_env = resolve_model(cfg.model_profile, models_cfg)
        env.update(model_env)
    if graphify_out:
        env["GRAPHIFY_OUT"] = graphify_out
    return env


# ─── Per-commit snapshot cache layout ──────────────────────────────────────
# <cache>/ast/<repo-id>/<commit-sha>/
#     graphify/            <- GRAPHIFY_OUT (GRAPH_REPORT.md, graph.json, graph.html)
#     .complete            <- written only after a successful, full build
#     .lock                <- flock for single-writer coordination
#
# Core primitives (ast_snapshot_dir, snapshot_lock, is_snapshot_complete,
# mark_snapshot_complete) live in ast_cache.py. Re-exported here for
# backwards compatibility.


def graphify_snapshot_dir(
    repo_id_value: str, commit_sha: str, cache_dir: Optional[str] = None
) -> str:
    """Absolute path to the per-commit snapshot dir for a repo+sha."""
    return ast_snapshot_dir(repo_id_value, commit_sha, cache_dir=cache_dir)


def graphify_out_path(snapshot_dir: str) -> str:
    """The GRAPHIFY_OUT dir (``graphify/``) inside a snapshot dir."""
    return os.path.join(snapshot_dir, "graphify")


def graphify_report_path(snapshot_dir: str) -> str:
    """Absolute path to GRAPH_REPORT.md inside a snapshot dir."""
    return os.path.join(graphify_out_path(snapshot_dir), "GRAPH_REPORT.md")
