"""
worca.events.types — event type constants and payload builder helpers.

All 52 event type strings are defined as module-level constants grouped by
category. One typed payload builder function exists per event type, ensuring
consistent dict structure at every call site.

No external runtime dependencies (stdlib only).
"""

# ---------------------------------------------------------------------------
# Pipeline lifecycle (6 events)
# ---------------------------------------------------------------------------

RUN_STARTED      = "pipeline.run.started"
RUN_COMPLETED    = "pipeline.run.completed"
RUN_FAILED       = "pipeline.run.failed"
RUN_INTERRUPTED  = "pipeline.run.interrupted"
RUN_CANCELLED    = "pipeline.run.cancelled"
RUN_RESUMED      = "pipeline.run.resumed"

# ---------------------------------------------------------------------------
# Stage lifecycle (4 events)
# ---------------------------------------------------------------------------

STAGE_STARTED     = "pipeline.stage.started"
STAGE_COMPLETED   = "pipeline.stage.completed"
STAGE_FAILED      = "pipeline.stage.failed"
STAGE_INTERRUPTED = "pipeline.stage.interrupted"

# ---------------------------------------------------------------------------
# Agent telemetry (5 events)
# ---------------------------------------------------------------------------

AGENT_SPAWNED     = "pipeline.agent.spawned"
AGENT_TOOL_USE    = "pipeline.agent.tool_use"
AGENT_TOOL_RESULT = "pipeline.agent.tool_result"
AGENT_TEXT        = "pipeline.agent.text"
AGENT_COMPLETED   = "pipeline.agent.completed"

# ---------------------------------------------------------------------------
# Bead lifecycle (6 events)
# ---------------------------------------------------------------------------

BEAD_CREATED   = "pipeline.bead.created"
BEAD_ASSIGNED  = "pipeline.bead.assigned"
BEAD_COMPLETED = "pipeline.bead.completed"
BEAD_FAILED    = "pipeline.bead.failed"
BEAD_LABELED   = "pipeline.bead.labeled"
BEAD_NEXT      = "pipeline.bead.next"

# ---------------------------------------------------------------------------
# Git operations (4 events)
# ---------------------------------------------------------------------------

GIT_BRANCH_CREATED = "pipeline.git.branch_created"
GIT_COMMIT         = "pipeline.git.commit"
GIT_PR_CREATED     = "pipeline.git.pr_created"
GIT_PR_MERGED      = "pipeline.git.pr_merged"

# ---------------------------------------------------------------------------
# Test detail (4 events)
# ---------------------------------------------------------------------------

TEST_SUITE_STARTED = "pipeline.test.suite_started"
TEST_SUITE_PASSED  = "pipeline.test.suite_passed"
TEST_SUITE_FAILED  = "pipeline.test.suite_failed"
TEST_FIX_ATTEMPT   = "pipeline.test.fix_attempt"

# ---------------------------------------------------------------------------
# Review detail (3 events)
# ---------------------------------------------------------------------------

REVIEW_STARTED     = "pipeline.review.started"
REVIEW_VERDICT     = "pipeline.review.verdict"
REVIEW_FIX_ATTEMPT = "pipeline.review.fix_attempt"

# ---------------------------------------------------------------------------
# Circuit breaker (4 events)
# ---------------------------------------------------------------------------

CB_FAILURE_RECORDED = "pipeline.circuit_breaker.failure_recorded"
CB_RETRY            = "pipeline.circuit_breaker.retry"
CB_TRIPPED          = "pipeline.circuit_breaker.tripped"
CB_RESET            = "pipeline.circuit_breaker.reset"

# ---------------------------------------------------------------------------
# Cost & token tracking (3 events)
# ---------------------------------------------------------------------------

COST_STAGE_TOTAL    = "pipeline.cost.stage_total"
COST_RUNNING_TOTAL  = "pipeline.cost.running_total"
COST_BUDGET_WARNING = "pipeline.cost.budget_warning"

# ---------------------------------------------------------------------------
# Milestone & loop events (3 events)
# ---------------------------------------------------------------------------

MILESTONE_SET    = "pipeline.milestone.set"
LOOP_TRIGGERED   = "pipeline.loop.triggered"
LOOP_EXHAUSTED   = "pipeline.loop.exhausted"

# ---------------------------------------------------------------------------
# Hook & governance events (3 events)
# ---------------------------------------------------------------------------

HOOK_BLOCKED          = "pipeline.hook.blocked"
HOOK_TEST_GATE        = "pipeline.hook.test_gate"
HOOK_DISPATCH_BLOCKED = "pipeline.hook.dispatch_blocked"
HOOK_DISPATCH_ALLOWED = "pipeline.hook.dispatch_allowed"

# ---------------------------------------------------------------------------
# Preflight events (2 events)
# ---------------------------------------------------------------------------

PREFLIGHT_COMPLETED = "pipeline.preflight.completed"
PREFLIGHT_SKIPPED   = "pipeline.preflight.skipped"

# ---------------------------------------------------------------------------
# Learn stage events (2 events)
# ---------------------------------------------------------------------------

LEARN_COMPLETED = "pipeline.learn.completed"
LEARN_FAILED    = "pipeline.learn.failed"

# ---------------------------------------------------------------------------
# Control events — inbound responses (4 events)
# ---------------------------------------------------------------------------

CONTROL_MILESTONE_APPROVE = "control.milestone.approve"
CONTROL_PIPELINE_PAUSE    = "control.pipeline.pause"
CONTROL_PIPELINE_RESUME   = "control.pipeline.resume"
CONTROL_PIPELINE_ABORT    = "control.pipeline.abort"

# ---------------------------------------------------------------------------
# Pause/resume state events (2 events)
# ---------------------------------------------------------------------------

RUN_PAUSED              = "pipeline.run.paused"
RUN_RESUMED_FROM_PAUSE  = "pipeline.run.resumed_from_pause"


# ---------------------------------------------------------------------------
# Fleet (multi-project fan-out) lifecycle events (5 events)
# ---------------------------------------------------------------------------
# These complement the per-child pipeline.run.* events with fleet-level
# transitions a subscriber would otherwise have to aggregate manually.
# See src/worca/events/fleet_emitter.py for the emit path.

FLEET_LAUNCHED                  = "fleet.launched"
FLEET_HALTED                    = "fleet.halted"
FLEET_COMPLETED                 = "fleet.completed"
FLEET_FAILED                    = "fleet.failed"
FLEET_CIRCUIT_BREAKER_TRIPPED   = "fleet.circuit_breaker.tripped"


# ---------------------------------------------------------------------------
# Workspace (multi-repo coordinated pipeline) lifecycle events (7 events)
# ---------------------------------------------------------------------------
# Workspace events are separate from fleet events (W-040 §13.5) — never
# multiplexed with fleet-update. See ws-workspace-manifest-watcher.js for
# the JS-side broadcast path.

WORKSPACE_LAUNCHED       = "workspace.launched"
WORKSPACE_HALTED         = "workspace.halted"
WORKSPACE_COMPLETED      = "workspace.completed"
WORKSPACE_FAILED         = "workspace.failed"
WORKSPACE_TIER_STARTED   = "workspace.tier.started"
WORKSPACE_TIER_COMPLETED = "workspace.tier.completed"
GUIDE_CONFLICT           = "workspace.guide_conflict"


# ===========================================================================
# Payload builder helpers
# ===========================================================================
# Each function takes exactly the fields defined in the JSON schema as keyword
# arguments (required fields are positional-or-keyword; optional fields have
# default values). Returns a plain dict — no validation overhead at runtime.
# ===========================================================================

# ---------------------------------------------------------------------------
# Pipeline lifecycle payload builders
# ---------------------------------------------------------------------------

def run_started_payload(
    resume: bool,
    started_at: str,
    plan_file=None,
    settings_snapshot=None,
) -> dict:
    p: dict = {"resume": resume, "started_at": started_at}
    if plan_file is not None:
        p["plan_file"] = plan_file
    if settings_snapshot is not None:
        p["settings_snapshot"] = settings_snapshot
    return p


def run_completed_payload(
    duration_ms: int,
    total_cost_usd: float,
    total_turns: int,
    total_tokens: int,
    stages_completed: list,
) -> dict:
    return {
        "duration_ms": duration_ms,
        "total_cost_usd": total_cost_usd,
        "total_turns": total_turns,
        "total_tokens": total_tokens,
        "stages_completed": stages_completed,
    }


def run_failed_payload(
    error: str,
    failed_stage,
    error_type: str,
    loop_counters: dict = None,
) -> dict:
    p: dict = {
        "error": error,
        "failed_stage": failed_stage,
        "error_type": error_type,
    }
    if loop_counters is not None:
        p["loop_counters"] = loop_counters
    return p


def run_interrupted_payload(
    interrupted_stage: str, elapsed_ms: int, source: str = "orchestrator"
) -> dict:
    return {
        "interrupted_stage": interrupted_stage,
        "elapsed_ms": elapsed_ms,
        "source": source,
    }


def run_cancelled_payload(
    cancelled_stage: str,
    elapsed_ms: int,
    source: str,
    reason: str = None,
) -> dict:
    p: dict = {
        "cancelled_stage": cancelled_stage,
        "elapsed_ms": elapsed_ms,
        "source": source,
    }
    if reason is not None:
        p["reason"] = reason
    return p


def run_resumed_payload(
    resume_stage: str,
    previous_stages_completed: list,
) -> dict:
    return {
        "resume_stage": resume_stage,
        "previous_stages_completed": previous_stages_completed,
    }


# ---------------------------------------------------------------------------
# Stage lifecycle payload builders
# ---------------------------------------------------------------------------

def stage_started_payload(
    stage: str,
    iteration: int,
    agent: str,
    model: str,
    trigger: str,
    max_turns: int,
) -> dict:
    return {
        "stage": stage,
        "iteration": iteration,
        "agent": agent,
        "model": model,
        "trigger": trigger,
        "max_turns": max_turns,
    }


def stage_completed_payload(
    stage: str,
    iteration: int,
    duration_ms: int,
    cost_usd: float,
    turns: int,
    outcome: str,
    token_usage: dict = None,
) -> dict:
    p: dict = {
        "stage": stage,
        "iteration": iteration,
        "duration_ms": duration_ms,
        "cost_usd": cost_usd,
        "turns": turns,
        "outcome": outcome,
    }
    if token_usage is not None:
        p["token_usage"] = token_usage
    return p


def stage_failed_payload(
    stage: str,
    iteration: int,
    error: str,
    error_type: str,
    elapsed_ms: int,
) -> dict:
    return {
        "stage": stage,
        "iteration": iteration,
        "error": error,
        "error_type": error_type,
        "elapsed_ms": elapsed_ms,
    }


def stage_interrupted_payload(
    stage: str,
    iteration: int,
    elapsed_ms: int,
) -> dict:
    return {"stage": stage, "iteration": iteration, "elapsed_ms": elapsed_ms}


# ---------------------------------------------------------------------------
# Agent telemetry payload builders
# ---------------------------------------------------------------------------

def agent_spawned_payload(
    stage: str,
    iteration: int,
    agent: str,
    model: str,
    max_turns: int,
    pid: int = None,
) -> dict:
    p: dict = {
        "stage": stage,
        "iteration": iteration,
        "agent": agent,
        "model": model,
        "max_turns": max_turns,
    }
    if pid is not None:
        p["pid"] = pid
    return p


def agent_tool_use_payload(
    stage: str,
    iteration: int,
    tool: str,
    tool_input_summary: str,
    turn: int,
) -> dict:
    return {
        "stage": stage,
        "iteration": iteration,
        "tool": tool,
        "tool_input_summary": tool_input_summary,
        "turn": turn,
    }


def agent_tool_result_payload(
    stage: str,
    iteration: int,
    tool: str,
    is_error: bool,
    turn: int,
) -> dict:
    return {
        "stage": stage,
        "iteration": iteration,
        "tool": tool,
        "is_error": is_error,
        "turn": turn,
    }


def agent_text_payload(
    stage: str,
    iteration: int,
    text_length: int,
    turn: int,
) -> dict:
    return {
        "stage": stage,
        "iteration": iteration,
        "text_length": text_length,
        "turn": turn,
    }


def agent_completed_payload(
    stage: str,
    iteration: int,
    turns: int,
    cost_usd: float,
    duration_ms: int,
    exit_code: int,
) -> dict:
    return {
        "stage": stage,
        "iteration": iteration,
        "turns": turns,
        "cost_usd": cost_usd,
        "duration_ms": duration_ms,
        "exit_code": exit_code,
    }


# ---------------------------------------------------------------------------
# Bead lifecycle payload builders
# ---------------------------------------------------------------------------

def bead_created_payload(
    bead_id: str,
    title: str,
    run_label: str = None,
) -> dict:
    p: dict = {"bead_id": bead_id, "title": title}
    if run_label is not None:
        p["run_label"] = run_label
    return p


def bead_assigned_payload(
    bead_id: str,
    title: str,
    iteration: int,
) -> dict:
    return {"bead_id": bead_id, "title": title, "iteration": iteration}


def bead_completed_payload(bead_id: str, reason: str) -> dict:
    return {"bead_id": bead_id, "reason": reason}


def bead_failed_payload(bead_id: str, error: str) -> dict:
    return {"bead_id": bead_id, "error": error}


def bead_labeled_payload(bead_ids: list, label: str) -> dict:
    return {"bead_ids": bead_ids, "label": label}


def bead_next_payload(
    next_bead_id: str,
    bead_iteration: int,
    max_beads: int = None,
) -> dict:
    p: dict = {"next_bead_id": next_bead_id, "bead_iteration": bead_iteration}
    if max_beads is not None:
        p["max_beads"] = max_beads
    return p


# ---------------------------------------------------------------------------
# Git operation payload builders
# ---------------------------------------------------------------------------

def git_branch_created_payload(branch: str, base_ref: str = None) -> dict:
    p: dict = {"branch": branch}
    if base_ref is not None:
        p["base_ref"] = base_ref
    return p


def git_commit_payload(
    stage: str,
    commit_hash: str,
    message_summary: str,
) -> dict:
    return {
        "stage": stage,
        "commit_hash": commit_hash,
        "message_summary": message_summary,
    }


def git_pr_created_payload(
    pr_url: str,
    pr_number: int,
    title: str,
    commit_sha: str = None,
    source_branch: str = None,
    target_branch: str = None,
    provider: str = None,
) -> dict:
    return {
        "pr_url": pr_url,
        "pr_number": pr_number,
        "title": title,
        "commit_sha": commit_sha,
        "source_branch": source_branch,
        "target_branch": target_branch,
        "provider": provider,
    }


def git_pr_merged_payload(pr_url: str, pr_number: int) -> dict:
    return {"pr_url": pr_url, "pr_number": pr_number}


# ---------------------------------------------------------------------------
# Test detail payload builders
# ---------------------------------------------------------------------------

def test_suite_started_payload(
    stage: str,
    iteration: int,
    trigger: str,
) -> dict:
    return {"stage": stage, "iteration": iteration, "trigger": trigger}


def test_suite_passed_payload(
    iteration: int,
    coverage_pct=None,
    proof_artifacts: list = None,
) -> dict:
    p: dict = {"iteration": iteration}
    if coverage_pct is not None:
        p["coverage_pct"] = coverage_pct
    if proof_artifacts is not None:
        p["proof_artifacts"] = proof_artifacts
    return p


def test_suite_failed_payload(
    iteration: int,
    failure_count: int,
    failures: list,
) -> dict:
    return {
        "iteration": iteration,
        "failure_count": failure_count,
        "failures": failures[:10],  # cap at 10 per schema
    }


def test_fix_attempt_payload(
    attempt: int,
    limit: int,
    failures_summary: str,
) -> dict:
    return {
        "attempt": attempt,
        "limit": limit,
        "failures_summary": failures_summary,
    }


# ---------------------------------------------------------------------------
# Review detail payload builders
# ---------------------------------------------------------------------------

def review_started_payload(
    iteration: int,
    files_under_review: list = None,
) -> dict:
    p: dict = {"iteration": iteration}
    if files_under_review is not None:
        p["files_under_review"] = files_under_review
    return p


def review_verdict_payload(
    outcome: str,
    issue_count: int,
    critical_count: int,
) -> dict:
    return {
        "outcome": outcome,
        "issue_count": issue_count,
        "critical_count": critical_count,
    }


def review_fix_attempt_payload(
    attempt: int,
    limit: int,
    critical_issues: list = None,
) -> dict:
    p: dict = {"attempt": attempt, "limit": limit}
    if critical_issues is not None:
        p["critical_issues"] = critical_issues
    return p


# ---------------------------------------------------------------------------
# Circuit breaker payload builders
# ---------------------------------------------------------------------------

def cb_failure_recorded_payload(
    stage: str,
    error: str,
    category: str,
    retriable: bool,
    consecutive_failures: int,
) -> dict:
    return {
        "stage": stage,
        "error": error,
        "category": category,
        "retriable": retriable,
        "consecutive_failures": consecutive_failures,
    }


def cb_retry_payload(
    stage: str,
    attempt: int,
    delay_seconds: float,
    consecutive_failures: int,
) -> dict:
    return {
        "stage": stage,
        "attempt": attempt,
        "delay_seconds": delay_seconds,
        "consecutive_failures": consecutive_failures,
    }


def cb_tripped_payload(
    reason: str,
    consecutive_failures: int,
    category: str,
) -> dict:
    return {
        "reason": reason,
        "consecutive_failures": consecutive_failures,
        "category": category,
    }


def cb_reset_payload(stage: str, previous_consecutive_failures: int) -> dict:
    return {
        "stage": stage,
        "previous_consecutive_failures": previous_consecutive_failures,
    }


# ---------------------------------------------------------------------------
# Cost & token tracking payload builders
# ---------------------------------------------------------------------------

def cost_stage_total_payload(
    stage: str,
    iteration: int,
    cost_usd: float,
    input_tokens: int,
    output_tokens: int,
    model: str,
    web_search_requests: int = 0,
    web_fetch_requests: int = 0,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> dict:
    p: dict = {
        "stage": stage,
        "iteration": iteration,
        "cost_usd": cost_usd,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "model": model,
    }
    if web_search_requests:
        p["web_search_requests"] = web_search_requests
    if web_fetch_requests:
        p["web_fetch_requests"] = web_fetch_requests
    if cache_creation_input_tokens:
        p["cache_creation_input_tokens"] = cache_creation_input_tokens
    if cache_read_input_tokens:
        p["cache_read_input_tokens"] = cache_read_input_tokens
    return p


def cost_running_total_payload(
    total_cost_usd: float,
    total_input_tokens: int,
    total_output_tokens: int,
    by_stage: dict = None,
    by_model: dict = None,
) -> dict:
    p: dict = {
        "total_cost_usd": total_cost_usd,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
    }
    if by_stage is not None:
        p["by_stage"] = by_stage
    if by_model is not None:
        p["by_model"] = by_model
    return p


def cost_budget_warning_payload(
    total_cost_usd: float,
    budget_usd: float,
    pct_used: float,
) -> dict:
    return {
        "total_cost_usd": total_cost_usd,
        "budget_usd": budget_usd,
        "pct_used": pct_used,
    }


# ---------------------------------------------------------------------------
# Milestone & loop payload builders
# ---------------------------------------------------------------------------

def milestone_set_payload(milestone: str, value, stage: str) -> dict:
    return {"milestone": milestone, "value": value, "stage": stage}


def loop_triggered_payload(
    loop_key: str,
    iteration: int,
    from_stage: str,
    to_stage: str,
    trigger: str,
) -> dict:
    return {
        "loop_key": loop_key,
        "iteration": iteration,
        "from_stage": from_stage,
        "to_stage": to_stage,
        "trigger": trigger,
    }


def loop_exhausted_payload(loop_key: str, iteration: int, limit: int) -> dict:
    return {"loop_key": loop_key, "iteration": iteration, "limit": limit}


# ---------------------------------------------------------------------------
# Hook & governance payload builders
# ---------------------------------------------------------------------------

def hook_blocked_payload(
    agent: str,
    tool: str,
    reason: str,
    rule: str = None,
) -> dict:
    p: dict = {"agent": agent, "tool": tool, "reason": reason}
    if rule is not None:
        p["rule"] = rule
    return p


def hook_test_gate_payload(
    agent: str,
    strike: int,
    action: str,
    command: str = None,
) -> dict:
    p: dict = {"agent": agent, "strike": strike, "action": action}
    if command is not None:
        p["command"] = command
    return p


def hook_dispatch_blocked_payload(
    agent: str,
    subagent_type: str,
    reason: str = None,
) -> dict:
    p: dict = {"agent": agent, "subagent_type": subagent_type}
    if reason is not None:
        p["reason"] = reason
    return p


def hook_dispatch_allowed_payload(agent: str, subagent_type: str) -> dict:
    return {"agent": agent, "subagent_type": subagent_type}


# ---------------------------------------------------------------------------
# Preflight payload builders
# ---------------------------------------------------------------------------

def preflight_completed_payload(checks: list, all_passed: bool) -> dict:
    return {"checks": checks, "all_passed": all_passed}


def preflight_skipped_payload(reason: str) -> dict:
    return {"reason": reason}


# ---------------------------------------------------------------------------
# Learn stage payload builders
# ---------------------------------------------------------------------------

def learn_completed_payload(termination_type: str, duration_ms: int,
                            learnings_path: str = None) -> dict:
    p: dict = {"termination_type": termination_type, "duration_ms": duration_ms}
    if learnings_path is not None:
        p["learnings_path"] = learnings_path
    return p


def learn_failed_payload(error: str, duration_ms: int,
                         error_type: str = None) -> dict:
    p: dict = {"error": error, "duration_ms": duration_ms}
    if error_type is not None:
        p["error_type"] = error_type
    return p


# ---------------------------------------------------------------------------
# Control (inbound) payload builders
# ---------------------------------------------------------------------------

def control_milestone_approve_payload(milestone: str, approved: bool) -> dict:
    return {"milestone": milestone, "approved": approved}


def control_pipeline_pause_payload(reason: str) -> dict:
    return {"reason": reason}


def control_pipeline_resume_payload(reason: str) -> dict:
    return {"reason": reason}


def control_pipeline_abort_payload(reason: str) -> dict:
    return {"reason": reason}


# ---------------------------------------------------------------------------
# Pause/resume state payload builders
# ---------------------------------------------------------------------------

def run_paused_payload(reason: str, waiting: bool = False) -> dict:
    p: dict = {"reason": reason}
    if waiting:
        p["waiting"] = waiting
    return p


def run_resumed_from_pause_payload(reason: str) -> dict:
    return {"reason": reason}


# ---------------------------------------------------------------------------
# Fleet event payload builders
# ---------------------------------------------------------------------------
# Each fleet event carries enough context that a subscriber can act on it
# without immediately re-reading the manifest: project list, plan/guide mode,
# child status counts. Builders accept None for optional fields and omit them
# from the resulting dict so the JSONL line stays compact for empty fields.


def fleet_launched_payload(
    projects: list,
    *,
    head_template: str = None,
    base_branch: str = None,
    plan_mode: str = "none",
    plan_path: str = None,
    guide_attached: bool = False,
    max_parallel: int = None,
    failure_threshold: float = None,
    child_count: int = None,
) -> dict:
    p: dict = {
        "projects": projects,
        "plan_mode": plan_mode,
        "guide_attached": guide_attached,
    }
    if head_template is not None:
        p["head_template"] = head_template
    if base_branch is not None:
        p["base_branch"] = base_branch
    if plan_path is not None:
        p["plan_path"] = plan_path
    if max_parallel is not None:
        p["max_parallel"] = max_parallel
    if failure_threshold is not None:
        p["failure_threshold"] = failure_threshold
    if child_count is not None:
        p["child_count"] = child_count
    return p


def fleet_halted_payload(
    halt_reason: str,
    *,
    in_flight_count: int = None,
    pending_count: int = None,
) -> dict:
    """halt_reason: 'stopped' | 'circuit_breaker' | 'user'."""
    p: dict = {"halt_reason": halt_reason}
    if in_flight_count is not None:
        p["in_flight_count"] = in_flight_count
    if pending_count is not None:
        p["pending_count"] = pending_count
    return p


def fleet_completed_payload(
    *,
    child_count: int,
    completed_count: int,
    duration_ms: int = None,
) -> dict:
    p: dict = {
        "child_count": child_count,
        "completed_count": completed_count,
    }
    if duration_ms is not None:
        p["duration_ms"] = duration_ms
    return p


def fleet_failed_payload(
    *,
    child_count: int,
    completed_count: int,
    failed_count: int,
    interrupted_count: int = 0,
    duration_ms: int = None,
) -> dict:
    p: dict = {
        "child_count": child_count,
        "completed_count": completed_count,
        "failed_count": failed_count,
        "interrupted_count": interrupted_count,
    }
    if duration_ms is not None:
        p["duration_ms"] = duration_ms
    return p


def fleet_circuit_breaker_tripped_payload(
    *,
    failed_count: int,
    terminal_count: int,
    total_count: int,
    threshold: float,
) -> dict:
    return {
        "failed_count": failed_count,
        "terminal_count": terminal_count,
        "total_count": total_count,
        "threshold": threshold,
        "failure_ratio": (failed_count / terminal_count) if terminal_count else 0.0,
    }


# ---------------------------------------------------------------------------
# Workspace event payload builders
# ---------------------------------------------------------------------------

def workspace_launched_payload(
    repos: list,
    workspace_name: str,
    *,
    branch_template: str = None,
    guide_attached: bool = False,
    max_parallel: int = None,
    skip_planning: bool = False,
    tier_count: int = None,
) -> dict:
    p: dict = {
        "repos": repos,
        "workspace_name": workspace_name,
        "guide_attached": guide_attached,
        "skip_planning": skip_planning,
    }
    if branch_template is not None:
        p["branch_template"] = branch_template
    if max_parallel is not None:
        p["max_parallel"] = max_parallel
    if tier_count is not None:
        p["tier_count"] = tier_count
    return p


def workspace_halted_payload(
    halt_reason: str,
    *,
    completed_tiers: int = None,
    pending_tiers: int = None,
) -> dict:
    p: dict = {"halt_reason": halt_reason}
    if completed_tiers is not None:
        p["completed_tiers"] = completed_tiers
    if pending_tiers is not None:
        p["pending_tiers"] = pending_tiers
    return p


def workspace_completed_payload(
    *,
    tier_count: int,
    child_count: int,
    integration_passed: bool,
    duration_ms: int = None,
) -> dict:
    p: dict = {
        "tier_count": tier_count,
        "child_count": child_count,
        "integration_passed": integration_passed,
    }
    if duration_ms is not None:
        p["duration_ms"] = duration_ms
    return p


def workspace_failed_payload(
    *,
    tier_count: int,
    completed_count: int,
    failed_count: int,
    duration_ms: int = None,
    failed_tier: int = None,
) -> dict:
    p: dict = {
        "tier_count": tier_count,
        "completed_count": completed_count,
        "failed_count": failed_count,
    }
    if duration_ms is not None:
        p["duration_ms"] = duration_ms
    if failed_tier is not None:
        p["failed_tier"] = failed_tier
    return p


def workspace_tier_started_payload(
    tier: int,
    repos: list,
) -> dict:
    return {"tier": tier, "repos": repos}


def workspace_tier_completed_payload(
    tier: int,
    repos: list,
    status: str,
    *,
    duration_ms: int = None,
) -> dict:
    p: dict = {"tier": tier, "repos": repos, "status": status}
    if duration_ms is not None:
        p["duration_ms"] = duration_ms
    return p


def guide_conflict_payload(
    run_id: str,
    stage: str,
    message: str,
    source: str,
    *,
    workspace_id: str = None,
    fleet_id: str = None,
) -> dict:
    p: dict = {
        "run_id": run_id,
        "stage": stage,
        "message": message,
        "source": source,
    }
    if workspace_id is not None:
        p["workspace_id"] = workspace_id
    if fleet_id is not None:
        p["fleet_id"] = fleet_id
    return p
