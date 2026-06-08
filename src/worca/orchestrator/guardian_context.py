"""Compute deterministic guardian template variables from the run environment.

Replaces the env-var inspection prose that used to live in
``src/worca/agents/core/guardian.md``. The fleet (W-040), workspace (W-047),
and defer-PR (W-047) decisions are all derived here so the guardian agent
prompt can render the resolved values directly via the overlay template
engine (``{{pr_title_prefix}}``, ``{{pr_footer}}``, ``{{#if defer_pr}}``).

Issue: https://github.com/SinishaDjukic/worca-cc/issues/165
"""
from __future__ import annotations

from typing import Mapping


def _short_id(full_id: str) -> str:
    """Return the trailing segment of an ID like f_<ts>_<rand> or ws_<ts>_<rand>."""
    return full_id.rsplit("_", 1)[-1]


def compute_pr_title_prefix(env: Mapping[str, str]) -> str:
    """Return the PR title prefix for this run, or "" if standalone.

    Fleet and workspace IDs are mutually exclusive (enforced upstream by
    ``register_pipeline``). If both are set we prefer the fleet prefix to
    match historical pre-W-047 behavior.
    """
    fleet_id = env.get("WORCA_FLEET_ID") or ""
    workspace_id = env.get("WORCA_WORKSPACE_ID") or ""
    if fleet_id:
        return f"[fleet:{_short_id(fleet_id)}]"
    if workspace_id:
        return f"[workspace:{_short_id(workspace_id)}]"
    return ""


def compute_pr_footer(env: Mapping[str, str]) -> str:
    """Return the PR body footer block for this run, or "" if standalone.

    Trailing newline is included so the agent can splice verbatim without
    fiddling with separators.
    """
    fleet_id = env.get("WORCA_FLEET_ID") or ""
    workspace_id = env.get("WORCA_WORKSPACE_ID") or ""
    if fleet_id:
        return (
            "---\n"
            f"Fleet manifest: `~/.worca/fleet-runs/{fleet_id}.json`\n"
        )
    if workspace_id:
        workspace_name = env.get("WORCA_WORKSPACE_NAME") or "(unnamed)"
        return (
            "---\n"
            f"**Workspace:** {workspace_name} (`{workspace_id}`)\n"
        )
    return ""


def compute_defer_pr(env: Mapping[str, str]) -> bool:
    """Return True only when WORCA_DEFER_PR is exactly "1".

    Matches the shell convention used by ``dag_executor.py`` when setting
    the var — any other value (including "0", "true", "yes") is treated
    as false to avoid silently deferring PR creation on misconfiguration.
    """
    return env.get("WORCA_DEFER_PR") == "1"


def compute_revise_pr(env: Mapping[str, str]) -> int | None:
    """Return the PR number to revise, or None if not in revision mode.

    WORCA_REVISE_PR must be a positive integer string (the PR number).
    Any other value — absent, empty, non-numeric, zero, negative — returns
    None so misconfigured values never silently activate revision mode.
    """
    raw = env.get("WORCA_REVISE_PR", "").strip()
    if not raw:
        return None
    try:
        n = int(raw)
    except ValueError:
        return None
    return n if n > 0 else None


def build_guardian_context(env: Mapping[str, str]) -> dict:
    """Bundle the guardian template variables for ``_render_agent_templates``.

    Precedence: revise_pr > defer_pr.  When ``WORCA_REVISE_PR`` is set to a
    valid PR number the PR already exists, so ``WORCA_DEFER_PR`` is a no-op —
    defer_pr is forced to False regardless of its own env var.
    """
    revise_pr = compute_revise_pr(env)
    # revise_pr takes precedence: an existing PR cannot be deferred.
    defer_pr = False if revise_pr is not None else compute_defer_pr(env)
    return {
        "defer_pr": defer_pr,
        "revise_pr": revise_pr,
        "pr_title_prefix": compute_pr_title_prefix(env),
        "pr_footer": compute_pr_footer(env),
    }
