# W-053: Optional Graphify Knowledge-Graph Integration

**Status:** Draft
**Priority:** P3
**Area:** cc + ui
**Date:** 2026-05-17
**Depends on:** None (composes cleanly on top of W-051 model profiles)

## Problem

Every pipeline stage starts a fresh `claude -p` subprocess that has to re-orient itself in the repo before producing useful work — typically by running `Grep`/`Glob`/`Read` against the codebase to discover the modules, call graphs, and rationale relevant to the current task (`src/worca/utils/claude_cli.py:133-144`). Worca runs up to nine stages per pipeline (preflight → planner → plan_reviewer → coordinator → implementer ×N → tester → reviewer → guardian → learner), so this orientation tax is paid roughly 9× per run, most of it on Opus.

[Graphify](https://graphify.net/) is an MIT-licensed open-source skill that turns a repo into a pre-computed knowledge graph (Tree-sitter AST + Leiden clustering + optional LLM semantic pass over docs/PDFs/images) and ships a Claude Code PreToolUse hook on `Grep`/`Glob` that nudges agents to read `GRAPH_REPORT.md` and call `graphify query` instead of grepping raw files. Reported token savings are 8× on typical projects and up to 71× on 500+ file codebases. Worca's nine-stage pipeline is exactly the workload Graphify was designed to amplify.

User-facing impact today: pipelines burn Opus tokens on orientation work that has no useful artifact, and operators have no way to give their pipelines a persistent "mental model" of the repo across runs. Integration is currently impossible because worca passes `--disallowedTools "Skill,..."` on every agent subprocess (`src/worca/utils/claude_cli.py:143`), so `/graphify` slash-command invocations cannot reach the pipeline.

## Proposal

Add an **optional, three-state Graphify integration** controlled by a two-tier toggle (global + per-project) plus runtime detection. The integration rides on Graphify's existing PreToolUse hook (no changes to worca's `--disallowedTools`) and Bash invocations (also unrestricted), and injects `GRAPH_REPORT.md` into agent prompts via the same `attach_guide()` mechanism used today for normative reference material (`src/worca/orchestrator/work_request.py:279`). Three modes:

- `disabled` (default): nothing happens, Graphify need not be installed.
- `structural` (recommended when enabled): runs `graphify build --no-llm` — AST + clustering only, **zero outbound LLM calls**, fully local. Captures call graphs, inline `# WHY:`/`# NOTE:` rationale, and Leiden communities. Preserves worca's existing privacy posture verbatim.
- `full`: runs `graphify build` with semantic pass over Markdown/PDFs/images — adds INFERRED edges, design-rationale linkage from `docs/plans/*.md`, and vision-pass over diagrams. Opt-in, with a privacy notice on first enable.

Enablement is **project-level**: a project opts in via `worca.graphify.enabled: true`. Global `enabled` is only an **explicit kill-switch** — an explicit global `false` disables graphify everywhere (admin / fleet / security lever); `true` or unset both defer to the project, which must opt in. (Earlier revisions made global a hard gate where unset == off and projects inherited global `true`; that was changed because it blocked simple per-project enablement.) Worca gracefully degrades when Graphify is enabled but missing/incompatible — pipelines never fail because of Graphify; they just lose the optimization.

## Design

### 1. Settings schema — two-tier toggle with three modes

**Current state:** `src/worca/settings.json:140-194` — `worca.stages.preflight` exists with `enabled` + `script` + `require`; `worca.models` is a string→string map (post-W-051 it becomes polymorphic with optional `env`).

**Resolution:** add a new `worca.graphify` block. Both `settings.json` (committed) and per-project `.claude/settings.json` accept it. Project value `null` (default) means inherit the global value. Global default is `false`.

```jsonc
// src/worca/settings.json (worca-cc defaults)
"worca": {
  "graphify": {
    "enabled": false,                  // global default — opt-in
    "mode": "structural",              // "structural" | "full"
    "backend": null,                   // null = auto-detect ; "claude-cli" | "ollama" | "openai" | "gemini" | "kimi" | "bedrock" | "anthropic"
    "model_profile": null,             // null = let graphify resolve env itself ; or name of a worca.models entry
    "out_dir": "graphify-out",         // relative to project root ; parent project always owns this
    "update_on": {
      "preflight": true,               // run `graphify --update` before pipeline
      "guardian_post_commit": true     // refresh after guardian commits
    },
    "min_repo_files": 100,             // recommendation threshold for `worca graphify recommend`
    "version_range": ">=4,<5"          // pinned compatible range
  }
}
```

```jsonc
// per-project .claude/settings.json — opt in / override mode
"worca": {
  "graphify": {
    "enabled": true,                   // project opts in (no effect if global=false)
    "mode": "structural"
  }
}
```

**Effective state resolution** (single source of truth, exposed via `worca graphify status` and the UI):

```
effective = (global.enabled === true) && (project.enabled ?? global.enabled)
          ? { enabled: true, mode: project.mode ?? global.mode, ... }
          : { enabled: false, reason: "<global-off|project-off|inherit-off>" }
```

The semantics are: enablement is project-level (the project must opt in), while an *explicit* global `false` is a kill-switch that disables everything — one place to turn graphify off for security-conscious users / fleet runs, without forcing every project to enable through a global gate.

### 2. Detection layer

**New module:** `src/worca/utils/graphify.py`

```python
# src/worca/utils/graphify.py
import shutil, subprocess, re
from dataclasses import dataclass
from typing import Optional

@dataclass(frozen=True)
class GraphifyDetect:
    installed: bool
    version: Optional[str]        # e.g. "4.2.1"
    compatible: bool              # version matches worca.graphify.version_range
    backend_env_present: list[str]  # which provider env vars are set (for diagnostics)
    error: Optional[str]          # set when installed but unusable

def detect_graphify(version_range: str = ">=4,<5") -> GraphifyDetect:
    """Probe for the graphify CLI. Cached at call sites — never call per-tool-use."""
    ...
```

Detection runs **once per pipeline run** (cached into `WORCA_GRAPHIFY_*` env vars by preflight) and **once per UI server boot** (cached server-side, refreshed on explicit "Re-check" button). Never per agent stage, never per tool call.

Three runtime states the rest of the system must handle:

| State | Detection result | Pipeline behavior |
|---|---|---|
| `disabled` | (skipped) | no-op everywhere |
| `enabled-but-missing` | `installed=False` | log one warning per run, proceed without graph injection |
| `enabled-but-incompatible` | `installed=True, compatible=False` | log one warning per run, proceed without graph injection |
| `enabled-and-ready` | `installed=True, compatible=True` | full integration active |

### 3. Pipeline implication — preflight extension

**Current state:** `src/worca/orchestrator/runner.py:1209` — `run_preflight()` executes a single script `src/worca/scripts/preflight_checks.py` and parses JSON results. No notion of optional graph-building post-check.

**Resolution:** add a **graphify preflight phase** that runs *after* `preflight_checks.py` succeeds and *before* the planner stage. New file `src/worca/scripts/graphify_preflight.py`:

```python
# pseudocode
def run() -> dict:
    settings = load_settings()
    cfg = effective_graphify_config(settings)
    if not cfg.enabled:
        return {"status": "skipped", "reason": "disabled"}

    detect = detect_graphify(cfg.version_range)
    if not detect.installed or not detect.compatible:
        return {"status": "degraded", "reason": detect.error or "version_mismatch"}

    if not cfg.update_on.preflight:
        return {"status": "skipped_update"}

    cmd = ["graphify", "--update"]
    if cfg.mode == "structural":
        cmd.append("--no-llm")
    if cfg.backend:
        cmd.extend(["--backend", cfg.backend])

    env = os.environ.copy()
    if cfg.model_profile:
        env.update(resolve_model(settings, cfg.model_profile).env)

    proc = subprocess.run(cmd, cwd=parent_project_path(), env=env, ...)
    if proc.returncode != 0:
        return {"status": "degraded", "reason": "build_failed", "stderr": proc.stderr}
    return {"status": "ready", "report_path": "graphify-out/GRAPH_REPORT.md"}
```

The runner records this status in the pipeline state and exposes it to downstream stages via the `WorkRequest` context.

### 4. Pipeline implication — prompt injection

**Current state:** `src/worca/orchestrator/work_request.py:279-330` — `attach_guide()` reads guide files into `WorkRequest.guide_content`; per-stage block templates wrap it under `## Reference Guide (normative)` when `has_guide` is set.

**Resolution:** introduce a parallel `attach_graph_report()` that reads `graphify-out/GRAPH_REPORT.md` (truncated to a budget) and stores it in a new `WorkRequest.graph_context` field. Per-stage templates wrap it under `## Codebase Structure (advisory)`.

```python
def attach_graph_report(wr: WorkRequest, report_path: str, *, max_bytes: int = 32_000) -> WorkRequest:
    """Attach GRAPH_REPORT.md as advisory context. Lower authority than guide."""
    with open(report_path, "r") as f:
        content = f.read(max_bytes + 1)
    truncated = len(content) > max_bytes
    return replace(wr, graph_context=content[:max_bytes] + ("\n\n[truncated]" if truncated else ""))
```

**Authority order extended:** `guide > plan > graph_context > description`. The graph is structural orientation, not normative; the existing guide precedence rules (`CLAUDE.md` "Guide Precedence" section) are preserved.

### 5. Pipeline implication — hooks coexistence

**Current state:** `src/worca/settings.json:1-30` — worca registers `PreToolUse` hooks on `Bash|Write|Edit` and `PostToolUse` on `Bash`, all pointing at `.claude/worca/claude_hooks/*.py`.

**Resolution:** Graphify's PreToolUse hook on `Grep|Glob` lives in a **separate matcher**, so the two coexist by Claude Code's hook spec (matchers run independently, all matching hooks fire). No conflict. `worca init --upgrade` should detect when graphify-mode is enabled-and-ready and ensure the graphify hook is registered in the project's `settings.json`; if absent it copies the hook stanza from a template in `src/worca/templates/graphify-hooks.json`.

For projects where worca already restricts `Bash` via its own `pre_tool_use.py` (governance), the graphify CLI invocation needs explicit allowlist. Add to `worca.governance.bash_allowlist`:

```jsonc
"worca": {
  "governance": {
    "bash_allowlist_extra": ["graphify"]   // populated when graphify.enabled = true
  }
}
```

### 6. Pipeline implication — Bash invocation channel

**Current state:** Worca passes `--disallowedTools "Skill,..."` (`src/worca/utils/claude_cli.py:143`), so the `Skill` tool is wholesale off for all stages. The `Bash` tool is allowed.

**Resolution:** **no change to `claude_cli.py`**. Agents call `graphify query "..."` via Bash. This is the same channel they already use for `git`, `rg`, `pytest`, etc. The graphify CLI emits structured output already suitable for agent consumption. Bumping `Skill` off the disallowed list (Option B from earlier discussion) is deferred — see Out of Scope.

### 7. Worktree implication — single ownership

**Current state:** `src/worca/scripts/run_worktree.py` creates a git worktree on disk for each isolated pipeline run. Worktrees share `.git` with the parent project but have independent working trees and an independent `settings.json` (materialized at run start; W-051 already materializes secrets this way).

**Resolution:**
- `graphify-out/` lives **only in the parent project**, never in a worktree.
- Worktree pipelines read the parent's `GRAPH_REPORT.md` via absolute path (resolved at preflight, recorded in the run state).
- Worktree preflight **never runs `graphify --update`** — it reads the parent's snapshot as-is.
- This sidesteps cross-worktree race conditions. Cost: long-running parallel worktrees see a stale snapshot until they finish — acceptable contract because Coordinator already splits work into disjoint chunks.

```
parent-repo/
  graphify-out/
    GRAPH_REPORT.md         <-- single source of truth
    graph.json
    graph.html
    cache/
worktrees/
  run_abc/                  <-- reads ../parent-repo/graphify-out/ (read-only)
  run_def/                  <-- same
```

### 8. Pipeline implication — post-guardian refresh

**Current state:** Guardian is the only agent allowed to `git commit` (enforced by `pre_tool_use.py`). After a commit, the graph is stale for the next pipeline run.

**Resolution:** when `worca.graphify.update_on.guardian_post_commit` is true and the run is in the parent project (not a worktree), the runner triggers a fire-and-forget `graphify --update [--no-llm]` after a successful guardian commit. Failures are logged but never fail the pipeline.

Worktree runs intentionally **do not** refresh the parent's graph — keeps the "single writer" invariant. The next parent-project run does the refresh.

### 9. Fleet implication — per-child detection

**Current state:** `src/worca/scripts/run_fleet.py` fans out a single work-request to N project repos. Each child is an independent project with its own settings.

**Resolution:** fleet preflight honors each child's effective graphify config independently:

- Some children may have graphify ready, others not — both are fine.
- Fleet manifest records per-child graphify state (`graph_status: ready|degraded|disabled`) for the UI.
- Fleet circuit breaker (`--fleet-failure-threshold`) **does not count** graphify-degraded as a failure — degradation is silent and continues without optimization.

### 10. UI implication — settings panel + project badge + recommend

**Current state:** worca-ui has a settings panel (`worca-ui/app/views/settings.js` and related) and a project picker. No surface today for graphify.

**Resolution:** three new UI surfaces:

**A. Global settings panel** (`worca-ui/app/views/settings-graphify.js`)
- Toggle for `worca.graphify.enabled` (writes to user-scope `settings.json`).
- Mode radio: `structural` / `full` with one-line explanation each.
- Backend dropdown (auto-detect by default, dropdown with detected providers).
- "Privacy notice" inline block, expanded by default when `mode=full`, collapsed when `mode=structural`. Text:
  > **Structural mode (recommended):** no outbound LLM calls. Tree-sitter parses code locally.
  > **Full mode:** doc/PDF/diagram content is sent to your configured Graphify provider for semantic extraction. Source code is never sent.

**B. Per-project graphify badge** in the project switcher and project detail header:
- 🟢 **Ready** — installed, compatible, graph built (`graph.html` linked)
- ⚪ **Disabled** — toggle off
- 🟡 **Pending install** — enabled but graphify missing on PATH (with copy-pasteable install command)
- 🟠 **Version mismatch** — installed but outside `version_range`
- ⚠ **Degraded** — last build failed (link to log)
- Badge tooltip shows effective state breakdown (global on/off · project on/off/inherit · detection result).

**C. Graph viewer integration:**
- "View knowledge graph" link in project detail → opens `graphify-out/graph.html` in a new tab via the existing static-file route in `worca-ui/server/`.
- Optional Phase 2: embed `graph.html` in an `<iframe>` panel within run detail and highlight nodes touched by the current run's diff.

**Settings drift handling:** the UI server re-reads settings.json on every request that depends on graphify state (same pattern as existing settings reads — no file watcher needed). Detection result is cached server-side with a 60s TTL or invalidated by an explicit `POST /api/graphify/recheck`.

### 11. CLI surface

Add `worca graphify` command group in `src/worca/cli/`:

```bash
worca graphify status               # show effective config + detection result
worca graphify recommend            # survey project, suggest enable/skip (uses min_repo_files)
worca graphify enable [--mode=structural|full]   # writes project setting
worca graphify disable              # writes project setting
worca graphify rebuild [--full]     # force a clean build (deletes graphify-out/ first)
worca graphify update               # incremental update
```

`status` output shape:

```
Graphify: enabled (project override) · structural · ready
  Global:    enabled
  Project:   enabled
  Detected:  graphify 4.2.1 (compatible with >=4,<5)
  Backend:   auto-detect → claude-cli
  Graph:     graphify-out/ (last updated 7 minutes ago, 1,432 nodes / 4,109 edges)
```

### 12. Provider configuration — reuse worca.models

`worca.graphify.model_profile` references a `worca.models[name]` entry (post-W-051). When set, the preflight subprocess gets that profile's `env` merged in — same plumbing as agent stages (`src/worca/utils/env.py`).

Two common patterns:

```jsonc
// Pattern A — let graphify auto-detect (default)
"worca": {
  "graphify": { "enabled": true, "model_profile": null }
}
// graphify reads ANTHROPIC_API_KEY / claude CLI / OLLAMA_BASE_URL from process env

// Pattern B — explicit, separate provider per worca.models entry
"worca": {
  "models": {
    "graphify-llm": {
      "id": "ignored-graphify-uses-its-own",
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_MODEL": "gpt-4o-mini"
      }
    }
  },
  "graphify": { "enabled": true, "mode": "full", "backend": "openai", "model_profile": "graphify-llm" }
}
```

Reserved-env-var denylist from W-051 applies — `WORCA_*`, `PATH`, `CLAUDECODE` are stripped from graphify's env merge.

## Implementation Plan

### Phase 1: Settings + detection + CLI status (no behavior change)

**Files:**
- `src/worca/settings.json` (add `worca.graphify` defaults)
- `src/worca/utils/graphify.py` (new — `detect_graphify`, `effective_graphify_config`, `EffectiveGraphifyConfig` dataclass)
- `src/worca/utils/settings.py` (extend loader with graphify normalization + validation)
- `src/worca/cli/__init__.py` + `src/worca/cli/graphify_cmd.py` (new — `worca graphify status|recommend|enable|disable`)
- `tests/test_graphify_detect.py`, `tests/test_graphify_settings.py` (new)

**Done criteria:** `worca graphify status` works on a project with the toggle off (default), correctly reports detection state, never invokes graphify itself.

### Phase 2: Preflight integration + prompt injection

**Files:**
- `src/worca/scripts/graphify_preflight.py` (new)
- `src/worca/orchestrator/runner.py:1209-1280` (extend `run_preflight` to chain graphify preflight when applicable)
- `src/worca/orchestrator/work_request.py` (add `graph_context` field + `attach_graph_report()`)
- `src/worca/agents/core/*.md` block templates (add `{{#if has_graph}}## Codebase Structure (advisory)\n{{graph_context}}{{/if}}`)
- `src/worca/cli/graphify_cmd.py` (add `rebuild`, `update`)
- `tests/test_graphify_preflight.py`, `tests/integration/test_graphify_pipeline.py` (new, using `tests/mock_graphify/`)

**Done criteria:** Pipeline run with `mode=structural` and a stub graph produces a planner prompt containing the graph section. With `enabled=false` the pipeline behavior is byte-identical to today.

### Phase 3: Hook registration + worktree handling

**Files:**
- `src/worca/templates/graphify-hooks.json` (new — Graphify PreToolUse hook stanza)
- `src/worca/cli/init.py` (extend `worca init` to merge hook stanza when graphify enabled)
- `src/worca/scripts/run_worktree.py` (materialize parent's `GRAPH_REPORT.md` path into worktree settings; never run `--update`)
- `tests/test_init_graphify_hooks.py`, `tests/test_worktree_graphify_inheritance.py` (new)

**Done criteria:** Fresh `worca init` on a graphify-enabled project produces a `settings.json` with both worca's and graphify's hooks present and ordered correctly. Worktree pipelines read parent's graph and never write to it.

### Phase 4: Post-guardian refresh + fleet support

**Files:**
- `src/worca/orchestrator/runner.py` (post-guardian `graphify --update` hook)
- `src/worca/scripts/run_fleet.py` (per-child detection + manifest fields)
- `src/worca/orchestrator/fleet_manifest.py` (add `graph_status` per child)
- `tests/test_post_guardian_graphify.py`, `tests/test_fleet_graphify_per_child.py` (new)

**Done criteria:** Successful guardian commit triggers async `graphify --update` that doesn't block the pipeline reporting "complete". Fleet manifests record per-child graph status.

### Phase 5: UI surfaces

**Files:**
- `worca-ui/app/views/settings-graphify.js` (new)
- `worca-ui/app/views/project-badge.js` (extend to show graphify state)
- `worca-ui/app/views/dashboard.js`, `project-switcher.js` (render badge)
- `worca-ui/server/app.js` (new endpoints: `GET /api/graphify/status`, `POST /api/graphify/recheck`, `POST /api/graphify/rebuild`)
- `worca-ui/server/graphify-status.js` (new server-side detection wrapper)
- `worca-ui/app/views/graphify-tests/*.test.js` (new)
- `worca-ui/e2e/graphify-settings.spec.js` (new)

**Done criteria:** Settings panel writes to `settings.json` correctly, badge reflects live state across all three modes (`disabled`/`degraded`/`ready`), privacy notice appears when switching to `full`.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/settings.json` | + `worca.graphify` block (5 keys) |
| `src/worca/utils/graphify.py` | NEW — detect + effective config |
| `src/worca/utils/settings.py` | + graphify normalization in loader |
| `src/worca/scripts/graphify_preflight.py` | NEW — preflight subroutine |
| `src/worca/orchestrator/runner.py` | + chain graphify preflight ; + post-guardian update hook |
| `src/worca/orchestrator/work_request.py` | + `graph_context` field + `attach_graph_report()` |
| `src/worca/agents/core/*.md` (×9) | + advisory `## Codebase Structure` block |
| `src/worca/cli/graphify_cmd.py` | NEW — `worca graphify {status,recommend,enable,disable,rebuild,update}` |
| `src/worca/cli/init.py` | + merge graphify hook stanza when enabled |
| `src/worca/scripts/run_worktree.py` | + materialize parent GRAPH_REPORT path |
| `src/worca/scripts/run_fleet.py` | + per-child detection ; manifest graph_status |
| `src/worca/templates/graphify-hooks.json` | NEW |
| `worca-ui/app/views/settings-graphify.js` | NEW |
| `worca-ui/app/views/project-badge.js` | + graphify state |
| `worca-ui/server/app.js` | + 3 graphify endpoints |
| `worca-ui/server/graphify-status.js` | NEW |
| `tests/mock_graphify/` | NEW — stub CLI for integration tests |
| `tests/test_graphify_*` (×5) | NEW |
| `tests/integration/test_graphify_pipeline.py` | NEW |
| `worca-ui/app/views/graphify-tests/*.test.js` | NEW |
| `worca-ui/e2e/graphify-settings.spec.js` | NEW |

## Considerations

### Edge cases
- **Repo with no graphify-supported code** (e.g. all Rust, all COBOL): Graphify exits cleanly with an empty graph. Preflight surfaces this as `degraded` rather than `ready`. Prompt injection is suppressed.
- **First build on huge monorepo**: structural mode is still fast (no LLM), but can take minutes. Preflight has a configurable timeout (`worca.graphify.preflight_timeout_seconds`, default 300). On timeout, mark degraded and proceed.
- **Concurrent runs on same parent project** (two `worca run` invocations in the same repo): the second one sees the first's `--update` in progress and waits-or-skips via a lock file in `graphify-out/.lock`. Worktree runs always read-only so they're unaffected.
- **Settings drift between worca-cc and worca-ui**: UI re-reads settings.json on every endpoint that needs it (matches existing pattern). Detection has 60s server-side cache invalidatable via `POST /api/graphify/recheck`.
- **Effective-state confusion**: `worca graphify status` and the UI badge tooltip always show the full breakdown (global / project / detection). Three-state values are never collapsed to a single boolean in user-facing text.

### Governance and permissions
- **`Skill` tool stays disabled** — no change to `--disallowedTools` (`src/worca/utils/claude_cli.py:143`). Graphify operates exclusively via hooks (PreToolUse on Grep/Glob) and Bash (`graphify query`).
- **Bash allowlist**: when `worca.governance.bash_allowlist` is enabled in a project, graphify's CLI invocations require explicit allowlisting. The graphify hook stanza addition during `worca init` should auto-extend this.
- **Guardian remains the only committer** — graphify never commits anything. `graphify-out/` should be added to project's `.gitignore` by `worca init` when graphify is enabled.
- **Privacy**: `structural` mode is genuinely zero-network (no outbound calls at all). `full` mode sends doc/diagram **summaries** (not raw source) to the configured provider. The UI privacy notice on first `full` enable makes this explicit; CLI `worca graphify enable --mode=full` prints the same notice.

### Breaking changes
- **None.** All defaults preserve existing behavior. `worca.graphify.enabled` defaults to `false` globally; existing projects have no `worca.graphify` block in their `.claude/settings.json` so they inherit the off default.
- `worca init --upgrade` on existing projects does **not** auto-enable graphify; only the explicit `worca graphify enable` flips the per-project toggle.

### Migration
- New config keys, no removals. No migration script needed.
- For users who want to try the integration: `worca graphify enable --mode=structural` in any project, then run a pipeline.

### Known unknowns (require investigation during Phase 2)
- Whether `graphify --update --no-llm` is fully supported (CLI docs imply yes, but confirm with smoke test before committing structural as the default).
- The hook output-format bug ([safishamsi/graphify#83](https://github.com/safishamsi/graphify/issues/83)) — verify it's fixed in the pinned version range, else ship a thin wrapper hook that reformats the output.
- Per-language AST extraction quality on this repo (Python + JS) — measure token-reduction delta on a representative pipeline run before finalizing the "recommended threshold" default of 100 files.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_detect_graphify_missing` | Returns `installed=False` when CLI not on PATH |
| Python | `test_detect_graphify_version_mismatch` | Returns `compatible=False` when version outside range |
| Python | `test_effective_config_global_off_project_on` | Explicit global=false kill-switches project=true |
| Python | `test_global_unset_project_on_enables` | Unset global + project=true enables (no global gate) |
| Python | `test_global_on_project_unset_requires_opt_in` | Global=true does not auto-enable; project must opt in |
| Python | `test_attach_graph_report_truncation` | Long reports truncated at max_bytes with marker |
| Python | `test_attach_graph_report_authority_below_guide` | Guide content rendered before graph context |
| Python | `test_graphify_preflight_no_op_when_disabled` | Returns `skipped` without subprocess call |
| Python | `test_graphify_preflight_structural_uses_no_llm` | Subprocess invoked with `--no-llm` |
| Python | `test_graphify_preflight_degraded_on_missing` | Returns `degraded`, no failure |
| Python | `test_graphify_model_profile_env_merge` | Env vars from worca.models entry merged into subprocess |
| Python | `test_worktree_reads_parent_graph` | Worktree preflight resolves absolute parent path |
| Python | `test_post_guardian_update_in_parent_only` | Post-commit refresh skipped in worktrees |
| JS | `settings-graphify.test.js` | Toggle writes correctly; privacy notice shown on full mode |
| JS | `project-badge-graphify.test.js` | All five state badges render |

### Integration / E2E Tests
- `tests/integration/test_graphify_pipeline.py` — full pipeline with `mode=structural`, mock graphify CLI in `tests/mock_graphify/`. Asserts: preflight invokes mock; planner prompt contains graph section; pipeline completes successfully.
- `tests/integration/test_graphify_missing_degrades_gracefully.py` — same pipeline with `enabled=true` but mock-graphify removed from PATH. Asserts: one warning logged, pipeline completes byte-identically to disabled run.
- `tests/integration/test_graphify_fleet_mixed_states.py` — 3-child fleet, child A ready, child B missing, child C disabled. Asserts: all three children complete; manifest records distinct `graph_status` per child.
- `worca-ui/e2e/graphify-settings.spec.js` — UI flow: toggle on → recheck → badge turns green → switch to full → privacy notice appears → switch back to structural.

### Existing Tests to Update
- `tests/test_settings.py` — extend loader assertions to include `worca.graphify` defaults.
- `tests/test_runner_preflight.py` — assert graphify preflight runs after base preflight when enabled.
- `tests/integration/test_pipeline_basic.py` — confirm no behavior change with graphify disabled (regression guard).

## Files to Create/Modify

See "Files Changed Summary" table above. Estimated: ~20 new files (8 Python source, 3 JS source, 9 tests/templates) + ~10 modified files.

## Out of Scope

- **Removing `Skill` from `--disallowedTools`.** Worca will continue to use Bash + hooks as the integration channel. The two-tier toggle + detection mechanism is enough for v1; broadening the skill allowlist is a separate decision worth its own plan (call it "W-NNN: skill-tool re-enablement strategy") because it affects governance for all future skill-based integrations.
- **Auto-install of the graphify CLI.** Detection only — never run `pip install graphify` from worca. Manual install via clear UI/CLI instructions when state is `pending install`.
- **Learner-stage integration** (pre/post graph diff as learning signal). Tempting but speculative; revisit once W-053 ships and the structural mode is proven in real pipelines. Track separately.
- **In-app graph viewer embedding** (Phase 2 UI: iframe `graph.html` in run detail with diff highlighting). Initial UI ships with a simple "View knowledge graph" link only.
- **Custom worca-authored hook wrapper.** Only built if upstream issue #83 is unfixed in the pinned graphify version range. Defer the work item until Phase 2 confirms necessity.
- **Migrating graphify configuration to a worca-managed config file.** Graphify reads its own env vars; worca passes them through via `model_profile`. No central abstraction layer.
- **GitHub Actions / CI graph caching** (build graph once in CI, share across pipeline runs). Future enhancement.
