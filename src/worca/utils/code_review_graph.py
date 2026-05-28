"""Code-review-graph (CRG) detection and effective config resolution.

Mirrors the two-tier (global + project) resolution pattern from
graphify.py. CRG is off by default; the project must opt in.
"""

import json
from dataclasses import dataclass
from typing import Optional

from worca.utils.tool_detect import probe_cli

_VALID_FRESHNESS = frozenset({"clean_only", "base_sha"})

CRG_MUTATING_TOOLS = frozenset({
    "apply_refactor_tool",
    "refactor_tool",
    "build_or_update_graph_tool",
    "run_postprocess_tool",
    "embed_graph_tool",
    "generate_wiki_tool",
    "list_repos_tool",
    "cross_repo_search_tool",
    "semantic_search_nodes_tool",
    "get_docs_section_tool",
})

_DEFAULT_STAGE_TOOLS: dict[str, list[str]] = {
    "planner": [
        "get_architecture_overview_tool",
        "get_minimal_context_tool",
        "query_graph_tool",
        "list_communities_tool",
    ],
    "coordinator": [
        "get_architecture_overview_tool",
        "get_minimal_context_tool",
        "query_graph_tool",
        "list_communities_tool",
    ],
    "implementer": [
        "get_minimal_context_tool",
        "get_impact_radius_tool",
        "query_graph_tool",
    ],
    "tester": [
        "get_impact_radius_tool",
        "detect_changes_tool",
        "get_affected_flows_tool",
    ],
    "reviewer": [
        "detect_changes_tool",
        "get_review_context_tool",
        "get_impact_radius_tool",
        "query_graph_tool",
    ],
    "guardian": [
        "detect_changes_tool",
    ],
}


def crg_tools_for_stage(
    role: str,
    *,
    stage_tools: dict | None = None,
) -> list[str]:
    """Return the CRG MCP tools allow-list for a given agent role.

    When *stage_tools* is None (the default), uses the built-in per-stage map.
    When provided, it overrides the defaults for the roles it covers.
    Mutating tools are always stripped regardless of source.
    """
    if stage_tools is not None and role in stage_tools:
        tools = list(stage_tools[role])
    else:
        tools = list(_DEFAULT_STAGE_TOOLS.get(role, []))
    return [t for t in tools if t not in CRG_MUTATING_TOOLS]

_CRG_DEFAULTS = {
    "enabled": False,
    "embeddings": False,
    "update_on": {
        "preflight": True,
        "post_implement": True,
        "guardian_post_commit": True,
    },
    "freshness": "clean_only",
    "min_repo_files": 100,
    "version_range": ">=2,<3",
    "fastmcp_min": "3.2.4",
    "preflight_timeout_seconds": 300,
    "stage_tools": None,
}


@dataclass(frozen=True)
class CrgDetect:
    installed: bool
    version: Optional[str]
    compatible: bool
    fastmcp_ok: bool
    error: Optional[str]


def detect_code_review_graph(
    version_range: str = ">=2,<3",
    fastmcp_min: str = "3.2.4",
) -> CrgDetect:
    """Probe ``code-review-graph --version`` + fastmcp floor."""
    crg = probe_cli("code-review-graph", version_range=version_range)

    if not crg.installed or not crg.compatible:
        return CrgDetect(
            installed=crg.installed,
            version=crg.version,
            compatible=crg.compatible,
            fastmcp_ok=False,
            error=crg.error,
        )

    fmcp = probe_cli("fastmcp", version_range=f">={fastmcp_min}")
    if not fmcp.installed or not fmcp.compatible:
        return CrgDetect(
            installed=True,
            version=crg.version,
            compatible=True,
            fastmcp_ok=False,
            error=f"fastmcp {fmcp.version or 'not installed'}: {fmcp.error}",
        )

    return CrgDetect(
        installed=True,
        version=crg.version,
        compatible=True,
        fastmcp_ok=True,
        error=None,
    )


def crg_mcp_config(repo_root: str, data_dir: str, crg_tools: list[str]) -> str:
    """Inline JSON for a single stdio CRG MCP server, scoped to one agent."""
    return json.dumps({"mcpServers": {"code-review-graph": {
        "type": "stdio",
        "command": "code-review-graph",
        "args": ["serve"],
        "env": {
            "CRG_REPO_ROOT": repo_root,
            "CRG_DATA_DIR": data_dir,
            "CRG_TOOLS": ",".join(crg_tools),
        },
    }}})


@dataclass(frozen=True)
class EffectiveCrgConfig:
    enabled: bool
    embeddings: bool
    update_on_preflight: bool
    update_on_post_implement: bool
    update_on_guardian_post_commit: bool
    min_repo_files: int
    version_range: str
    fastmcp_min: str
    preflight_timeout_seconds: int
    freshness: str
    stage_tools: Optional[dict]
    reason: Optional[str] = None


def effective_crg_config(
    global_settings: dict,
    project_settings: dict,
) -> EffectiveCrgConfig:
    """Resolve two-tier CRG config into a single effective config.

    Enablement semantics mirror graphify: the project must opt in;
    an explicit global ``enabled: false`` is a kill-switch.
    """
    g_crg = global_settings.get("worca", {}).get("code_review_graph", {})
    p_crg = project_settings.get("worca", {}).get("code_review_graph", {})

    defaults = dict(_CRG_DEFAULTS)
    defaults_update_on = dict(defaults["update_on"])

    if g_crg.get("enabled") is False:
        return _disabled_config(defaults, defaults_update_on, reason="global-off")

    if not p_crg.get("enabled", False):
        return _disabled_config(defaults, defaults_update_on, reason="project-off")

    merged = dict(defaults)
    merged.update({k: v for k, v in g_crg.items() if v is not None or k == "enabled"})
    merged.update({k: v for k, v in p_crg.items() if v is not None or k == "enabled"})

    update_on = dict(defaults_update_on)
    if "update_on" in g_crg and isinstance(g_crg["update_on"], dict):
        update_on.update(g_crg["update_on"])
    if "update_on" in p_crg and isinstance(p_crg["update_on"], dict):
        update_on.update(p_crg["update_on"])

    freshness = merged.get("freshness", defaults["freshness"])
    if freshness not in _VALID_FRESHNESS:
        raise ValueError(
            f"invalid code_review_graph freshness {freshness!r}, "
            f"expected one of {sorted(_VALID_FRESHNESS)}"
        )

    return EffectiveCrgConfig(
        enabled=True,
        embeddings=merged.get("embeddings", defaults["embeddings"]),
        update_on_preflight=update_on.get("preflight", True),
        update_on_post_implement=update_on.get("post_implement", True),
        update_on_guardian_post_commit=update_on.get("guardian_post_commit", True),
        min_repo_files=merged.get("min_repo_files", defaults["min_repo_files"]),
        version_range=merged.get("version_range", defaults["version_range"]),
        fastmcp_min=merged.get("fastmcp_min", defaults["fastmcp_min"]),
        preflight_timeout_seconds=merged.get(
            "preflight_timeout_seconds", defaults["preflight_timeout_seconds"]
        ),
        freshness=freshness,
        stage_tools=merged.get("stage_tools"),
        reason=None,
    )


def _disabled_config(
    defaults: dict, defaults_update_on: dict, *, reason: str
) -> EffectiveCrgConfig:
    return EffectiveCrgConfig(
        enabled=False,
        embeddings=defaults["embeddings"],
        update_on_preflight=defaults_update_on.get("preflight", True),
        update_on_post_implement=defaults_update_on.get("post_implement", True),
        update_on_guardian_post_commit=defaults_update_on.get(
            "guardian_post_commit", True
        ),
        min_repo_files=defaults["min_repo_files"],
        version_range=defaults["version_range"],
        fastmcp_min=defaults["fastmcp_min"],
        preflight_timeout_seconds=defaults["preflight_timeout_seconds"],
        freshness=defaults["freshness"],
        stage_tools=defaults.get("stage_tools"),
        reason=reason,
    )
