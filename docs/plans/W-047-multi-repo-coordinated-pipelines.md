# W-047: Multi-Repo Coordinated Pipelines

**Status:** Draft
**Priority:** P3
**Area:** cc + ui
**Date:** 2026-04-26
**Depends on:** #82 (worktree-based pipeline isolation — `pipelines.d/` registry, unified `discoverRuns`, `active_run` removal), W-040 / #101 (fleet runs — cross-repository fan-out, `fleet_id` grouping, manifest, circuit breaker, `--resume`, guide injection)

## Problem

Fleet runs (W-040) fan out a single work-request to N independent repos — every child gets the same prompt and runs in isolation. This solves migrations and compliance sweeps but cannot handle the common case where a **single feature requires coordinated changes across interdependent repos**: a backend adds an API endpoint, a shared-lib adds a type, and a frontend consumes both. Today there is no mechanism to:

1. **Decompose** one prompt into repo-specific sub-prompts. Fleet sends the same prompt everywhere (`src/worca/scripts/run_fleet.py` — from W-040 design §1); a multi-repo feature needs different work in each repo.
2. **Order** child pipelines by dependency. Fleet uses `ThreadPoolExecutor` for all-at-once parallel dispatch (`run_fleet.py` — W-040 design §1); cross-repo features need `shared-lib` to finish before `backend`, and `backend` before `frontend`.
3. **Test across repo boundaries.** Each child's tester stage (`src/worca/orchestrator/stages/test.py`) runs tests within one repo. There is no post-completion phase that validates the combined changes work together.
4. **Link PRs with dependency metadata.** Fleet's guardian prepends `[fleet:<id>]` to PR titles (W-040 design §11) but creates no cross-references. Reviewers must manually discover that `backend#42` must merge before `frontend#43`.

All repos are assumed to be siblings in a shared parent directory (e.g., `/code/platform/{backend,frontend,shared-lib}/`).

## Proposal

Add a **workspace coordinator** that extends fleet infrastructure with four capabilities: a master planner that decomposes a prompt into per-repo sub-prompts, a DAG executor that replaces parallel dispatch with dependency-ordered execution, a cross-repo integration test phase, and linked PR creation with explicit dependency annotations. The workspace is defined by a manifest in the parent directory. Child pipelines remain standard worca runs dispatched via `run_worktree.py` — all existing governance, hooks, and stage machinery are unchanged.

## Design

### 1. Workspace Definition

- **Current state:** Fleet targets are passed as CLI args (`--projects` / `--projects-file`) with no persistent definition of which repos form a group or how they relate. `~/.worca/projects.d/` registers individual projects but has no grouping concept.
- **Obstacle:** A coordinated multi-repo feature needs a stable definition of which repos participate, their roles, and their dependency relationships. Passing this on every invocation is error-prone.
- **Resolution:** A `workspace.json` file in the parent directory:

```json
{
  "name": "my-platform",
  "repos": [
    {
      "name": "shared-lib",
      "path": "shared-lib",
      "role": "library",
      "depends_on": []
    },
    {
      "name": "backend",
      "path": "backend",
      "role": "service",
      "depends_on": ["shared-lib"]
    },
    {
      "name": "frontend",
      "path": "frontend",
      "role": "app",
      "depends_on": ["backend"]
    }
  ],
  "integration_test": {
    "command": "cd backend && npm run test:integration",
    "working_dir": "."
  }
}
```

Fields:
- `name`: workspace display name (used in UI, PR annotations, branch templates).
- `repos[].path`: relative path from workspace root to the repo directory. Must contain a `.git/` directory.
- `repos[].role`: freeform label injected into the master planner prompt for context (e.g., "library", "service", "app", "infra"). Not used for dispatch logic.
- `repos[].depends_on`: list of repo names that must complete before this repo's pipeline starts. Forms a DAG — validated for cycles at launch.
- `integration_test`: optional. Command and working directory for cross-repo integration tests run after all children complete.

The workspace is **not** registered in `~/.worca/projects.d/` — it is not a worca project. Individual repos within it may or may not be registered there independently.

A `worca workspace init /path/to/parent` command scaffolds `workspace.json` by scanning child directories for `.git/`, populating `repos` with defaults (`depends_on: []`), and prompting for dependency relationships.

### 2. Master Planner

- **Current state:** Fleet either sends the same prompt to every child, injects a shared `--plan`, or uses `--plan-first` where one child's planner output is reused by all others (W-040 design §6). None of these decompose a prompt into repo-specific work.
- **Obstacle:** A prompt like "add user profiles with avatar upload" requires different work in each repo: the backend adds an API + storage, the frontend adds a profile page + upload widget, the shared-lib adds a `UserProfile` type. Sending the same prompt produces incoherent results.
- **Resolution:** Add a **master planner stage** that runs before child dispatch. It is a new Opus agent (template: `src/worca/agents/core/workspace_planner.md`) that:

  1. Reads `workspace.json` to understand the repo topology and dependency graph.
  2. Reads `CLAUDE.md` from each repo for project-specific context.
  3. Receives the user's prompt.
  4. Produces a **workspace plan** — a structured output containing:
     - A high-level summary of the cross-repo change.
     - Per-repo sub-plans: each is a self-contained work description that a standard worca pipeline can execute independently.
     - Dependency annotations: which repo's changes are prerequisites for which (confirming or refining the static `depends_on` in `workspace.json`).
     - Integration test expectations: what the cross-repo test should validate.

  The workspace plan is written to `{workspace_root}/.worca/workspace-runs/{run_id}/workspace-plan.md` and also as individual `{repo}-plan.md` files. Each child pipeline receives its repo-specific plan via `--plan`.

**Workspace plan schema:**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["summary", "repos", "integration_expectations"],
  "properties": {
    "summary": { "type": "string" },
    "repos": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "description", "acceptance_criteria"],
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "acceptance_criteria": {
            "type": "array",
            "items": { "type": "string" }
          },
          "depends_on": {
            "type": "array",
            "items": { "type": "string" }
          },
          "skip": {
            "type": "boolean",
            "description": "true if this repo needs no changes for this feature"
          }
        }
      }
    },
    "integration_expectations": {
      "type": "array",
      "items": { "type": "string" },
      "description": "What the cross-repo integration test should validate"
    }
  }
}
```

The master planner may refine the static `depends_on` graph from `workspace.json` — e.g., if a particular feature doesn't touch `shared-lib`, it can mark it `skip: true` and remove it from dependency chains. The refined graph is used for dispatch ordering.

### 3. DAG Executor

- **Current state:** Fleet dispatches all children in parallel via `ThreadPoolExecutor` with `--max-parallel` (W-040 design §1). No ordering.
- **Obstacle:** If `backend` depends on `shared-lib` changes (e.g., a new type), it must not start until `shared-lib`'s pipeline has committed those changes to its worktree branch. Otherwise the backend implementer can't import the new type.
- **Resolution:** Replace parallel dispatch with a **tier-based DAG executor** in `src/worca/scripts/run_workspace.py`:

  1. Parse the dependency graph (from workspace plan or `workspace.json`).
  2. Validate: no cycles (topological sort); all `depends_on` names exist in `repos`.
  3. Compute tiers: repos with no dependencies are tier 0; repos whose dependencies are all in earlier tiers are in the next tier.
  4. Execute tier by tier: all repos in a tier run in parallel (via `ThreadPoolExecutor`); the executor waits for all to complete before starting the next tier.
  5. Between tiers, commit child changes: after a tier completes, each child's guardian has committed and pushed to its worktree branch. The next tier's children can `git fetch` the dependency repo's branch to see changes. The master coordinator injects a `--guide` into each child with the dependency repo's branch name and diff summary so the implementer knows what changed.

```
Tier 0: [shared-lib]        ← runs first, in parallel (just 1 here)
         ↓ commit + push
Tier 1: [backend]           ← starts after shared-lib completes
         ↓ commit + push
Tier 2: [frontend]          ← starts after backend completes
         ↓ commit + push
Integration test phase       ← runs after all tiers complete
```

  If a child in tier N fails, repos in tier N+1 that depend on it are skipped (marked `blocked`). Repos in tier N+1 that don't depend on the failed child still run. The fleet-level circuit breaker from W-040 applies across all tiers.

### 4. Cross-Repo Context Injection

- **Current state:** Each child pipeline operates in isolation. An implementer in `backend/` cannot see uncommitted changes in `shared-lib/`.
- **Obstacle:** Even with DAG ordering, a tier-1 implementer needs to know what tier-0 produced. Relying on `git fetch` alone is fragile — the implementer must know which branch to fetch and what changed.
- **Resolution:** Between tiers, `run_workspace.py` generates a **context artifact** for each dependency edge:

  1. After `shared-lib` completes, extract: `git diff main..HEAD --stat` + `git diff main..HEAD` (full diff) from the worktree.
  2. Summarize into a context block (truncated to 8KB per dependency to control token cost).
  3. Inject into the next tier's child via `--guide`:

```markdown
## Dependency Context: shared-lib

Branch: `workspace/my-feature/shared-lib` (committed, pushed)

### Changes summary
- Added `UserProfile` type in `src/types/user.ts`
- Exported from `src/index.ts`

### Full diff
<truncated diff>
```

This gives the implementer concrete context without requiring it to `git fetch` or navigate to a sibling directory.

### 5. Cross-Repo Integration Test Phase

- **Current state:** Each child's tester stage runs tests within its own repo. No mechanism for cross-repo validation.
- **Obstacle:** Per-repo tests pass individually but the combined changes may be incompatible (API contract mismatch, type version skew, missing exports).
- **Resolution:** After all tiers complete successfully, `run_workspace.py` runs an optional integration test phase:

  1. Read `workspace.json` `integration_test.command` and `integration_test.working_dir`.
  2. Set up the environment: for each child repo, ensure its worktree branch is checked out (or the changes are accessible via the branch).
  3. Execute the command with `cwd = workspace_root / working_dir`.
  4. Capture stdout/stderr into `{workspace_run_dir}/integration-test.log`.
  5. If the test fails, mark the workspace run as `integration_failed` — child PRs are **not** pushed. The user can inspect logs and re-run.
  6. If no `integration_test` is configured, skip this phase with a warning.

  The integration test command is user-defined and opaque to worca — it could be `docker-compose up && pytest tests/integration/`, a Makefile target, or a script. Worca only runs it and checks the exit code.

### 6. Linked PR Creation

- **Current state:** Fleet's guardian prepends `[fleet:<id>]` to PR titles (W-040 design §11). No cross-references between PRs.
- **Obstacle:** A reviewer looking at `backend#42` has no way to know that `shared-lib#15` must merge first, or that `frontend#43` depends on this PR.
- **Resolution:** Extend the guardian stage with workspace-aware PR creation:

  1. Each child's guardian creates its PR as normal.
  2. After all PRs are created, `run_workspace.py` post-processes them:
     - For each PR, add a comment listing its dependencies and dependents:
       ```
       ## Workspace: my-platform
       **Depends on:** org/shared-lib#15 (must merge first)
       **Blocks:** org/frontend#43
       **Workspace run:** `ws_20260426_abc123`
       ```
     - Optionally create an **umbrella issue** that links all PRs:
       ```
       ## Workspace PR Set: Add user profiles
       - [ ] org/shared-lib#15 — Add UserProfile type
       - [ ] org/backend#42 — Add /api/profile endpoint
       - [ ] org/frontend#43 — Add profile page
       ```
  3. PR numbers are captured from each child's guardian output (parsed from `gh pr create` stdout) and stored in the workspace manifest.

  Merge order is documented but **not enforced** — worca does not auto-merge. The checklist in the umbrella issue serves as a manual coordination tool.

### 7. Workspace State & Manifest

- **Current state:** Fleet manifest at `~/.worca/fleet-runs/<fleet_id>.json` tracks fleet-level state. Per-child state in `pipelines.d/`.
- **Obstacle:** Workspace runs need additional state: the workspace plan, DAG structure, tier execution progress, integration test results, and PR cross-references.
- **Resolution:** Workspace runs use `{workspace_root}/.worca/workspace-runs/{run_id}/` as the run directory:

```
.worca/workspace-runs/{run_id}/
  workspace-manifest.json   # workspace-level state (extends fleet manifest)
  workspace-plan.md         # master planner output (human-readable)
  workspace-plan.json       # structured plan (machine-readable)
  {repo}-plan.md            # per-repo sub-plan passed to child --plan
  integration-test.log      # integration test output (if run)
  context/
    {repo}-diff.md          # context artifact generated between tiers
```

**Workspace manifest schema** (extends fleet manifest):

```json
{
  "workspace_id": "ws_<yyyymmddhhmm>_<rand>",
  "workspace_name": "my-platform",
  "workspace_root": "/abs/path/to/parent",
  "created_at": "<iso8601>",
  "work_request": { "title": "...", "description": "...", "source": "..." },
  "guide": { "paths": ["..."], "bytes": 12345, "filenames": ["..."] },
  "status": "planning|running|integration_testing|completed|failed|integration_failed",
  "dag": {
    "tiers": [
      { "tier": 0, "repos": ["shared-lib"], "status": "completed" },
      { "tier": 1, "repos": ["backend"], "status": "completed" },
      { "tier": 2, "repos": ["frontend"], "status": "running" }
    ]
  },
  "children": [
    {
      "repo_name": "shared-lib",
      "project_path": "/abs/path/to/shared-lib",
      "branch": "workspace/user-profiles/shared-lib",
      "run_id": "r_...",
      "tier": 0,
      "pr_number": 15,
      "pr_url": "https://github.com/org/shared-lib/pull/15"
    }
  ],
  "integration_test": {
    "status": "passed|failed|skipped",
    "exit_code": 0,
    "log_path": "integration-test.log"
  },
  "umbrella_issue": {
    "url": "https://github.com/org/platform-meta/issues/7"
  }
}
```

### 8. Entry Point & CLI

- **Current state:** `run_fleet.py` accepts `--projects`, `--prompt`, `--guide`, `--plan`, `--branch`. No workspace-aware entry point.
- **Resolution:** Add `src/worca/scripts/run_workspace.py`:

```
worca workspace run /path/to/parent --prompt "Add user profiles with avatar upload"
worca workspace run /path/to/parent --source gh:issue:42
worca workspace run /path/to/parent --prompt "..." --guide migration-spec.md
worca workspace run /path/to/parent --resume ws_20260426_abc123
```

Flags:
- `--prompt` / `--source`: work request (same as `run_fleet.py`).
- `--guide`: shared reference context (reuses W-040's `attach_guide()`).
- `--branch <template>`: branch template with `{workspace}` / `{repo}` / `{slug}` placeholders. Default: `workspace/{slug}/{repo}`.
- `--skip-integration`: skip the integration test phase.
- `--skip-planning`: skip the master planner; use `--plan` per-repo instead (advanced).
- `--resume <workspace_id>`: resume a failed/halted workspace run.
- `--max-parallel`: max concurrent children within a tier (default 5).
- `--dry-run`: produce the workspace plan and print the DAG without launching children.

`run_workspace.py` internally reuses fleet primitives: `worca init --upgrade` per repo, `run_worktree.py` dispatch, `pipelines.d/` registration (with `workspace_id` in the `fleet_id` field), W-040's circuit breaker logic.

### 9. `worca workspace init`

- **Current state:** `worca init` operates on a single git repo.
- **Resolution:** Add `worca workspace init /path/to/parent`:

  1. Scan child directories for `.git/`.
  2. Read each repo's `CLAUDE.md` (if present) for role hints.
  3. Generate `workspace.json` with all discovered repos, `depends_on: []`, and no integration test.
  4. Create `{workspace_root}/.worca/` directory.
  5. Run `worca init --upgrade` in each child repo.
  6. Print the workspace definition and prompt the user to edit `depends_on` relationships and add an integration test command.

### 10. UI Integration

- **Current state:** W-040 adds fleet grouping to the dashboard — collapsible headers, aggregate progress. `discoverRuns` fans out across `pipelines.d/`.
- **Resolution:** Workspace runs appear in the UI as an enhanced fleet group:

  **Dashboard:**
  - Workspace header shows: workspace name, status, current tier, overall progress.
  - Below the header, children are grouped by tier with tier labels. Within each tier, children render as standard run cards.
  - Tier status indicators: completed (green), running (blue), blocked (gray), failed (red).
  - Integration test status badge after the last tier.

  **Workspace detail view** (new):
  - DAG visualization: repos as nodes, `depends_on` as edges, colored by status.
  - Workspace plan viewer (markdown).
  - Per-repo context artifacts (the diff summaries injected between tiers).
  - Integration test log viewer.
  - PR link table with merge-order annotations.

  **API:**
  - `GET /api/workspace-runs` — list workspace manifests from `~/.worca/fleet-runs/` (workspace manifests have a `workspace_id` field distinguishing them from plain fleet manifests).
  - `GET /api/workspace-runs/:id` — workspace manifest + enriched child status from `pipelines.d/`.
  - `POST /api/workspace-runs` — launch from UI.
  - `DELETE /api/workspace-runs/:id` — halt.
  - `GET /api/workspace-runs/:id/plan` — workspace plan markdown.
  - `GET /api/workspace-runs/:id/integration-log` — integration test output.

  **WS:** Workspace manifest changes emit `fleet-update` events (reuses W-040's mechanism). The client distinguishes workspace vs fleet by the presence of `workspace_id` in the payload.

## Implementation Plan

### Phase 1: Workspace definition & CLI scaffold

**Files:** `src/worca/workspace/manifest.py` (new), `src/worca/cli/workspace.py` (new), `src/worca/scripts/run_workspace.py` (new)

**Tasks:**
1. Define `workspace.json` schema in `src/worca/schemas/workspace.json`.
2. Add `Workspace` dataclass in `src/worca/workspace/manifest.py` — load, validate, cycle-detect in dependency graph, compute tiers.
3. Add `worca workspace init /path` command in `src/worca/cli/workspace.py` — scan for `.git/` children, generate `workspace.json`, create `.worca/`.
4. Scaffold `run_workspace.py` with arg parsing, workspace loading, and `--dry-run` (prints DAG, no dispatch).

### Phase 2: Master planner

**Files:** `src/worca/agents/core/workspace_planner.md` (new), `src/worca/schemas/workspace_plan.json` (new), `src/worca/scripts/run_workspace.py`

**Tasks:**
1. Write `workspace_planner.md` agent template — reads workspace.json + per-repo CLAUDE.md + user prompt, produces structured workspace plan.
2. Add `workspace_plan.json` schema for structured planner output.
3. Integrate master planner into `run_workspace.py` — run before dispatch, write plan files to workspace run directory, extract per-repo plans.
4. Add `--skip-planning` flag for cases where the user provides per-repo plans directly.

### Phase 3: DAG executor

**Files:** `src/worca/workspace/dag_executor.py` (new), `src/worca/scripts/run_workspace.py`

**Tasks:**
1. Implement `DagExecutor` class — accepts tiers from phase 1, dispatches each tier via `ThreadPoolExecutor` calling `run_worktree.py` with `cwd=repo_dir` and `--fleet-id workspace_id`.
2. Between tiers: extract context artifacts (diff summary) from completed children, generate `--guide` content for next tier's children.
3. Handle child failures: mark dependent children as `blocked`, continue non-dependent children in the same tier.
4. Integrate W-040's circuit breaker — apply across all tiers.
5. Write tier status updates to workspace manifest.

### Phase 4: Cross-repo integration test

**Files:** `src/worca/workspace/integration_test.py` (new), `src/worca/scripts/run_workspace.py`

**Tasks:**
1. After all tiers complete, read `integration_test` from `workspace.json`.
2. Execute command with `cwd = workspace_root / working_dir`, capture output to `integration-test.log`.
3. On failure: set workspace status to `integration_failed`, do not push PRs.
4. On success or skip: proceed to PR phase.

### Phase 5: Linked PR creation

**Files:** `src/worca/workspace/pr_linker.py` (new), `src/worca/agents/core/guardian.md`, `src/worca/scripts/run_workspace.py`

**Tasks:**
1. After all children complete and integration tests pass, collect PR URLs from each child's guardian output.
2. Post dependency comments on each PR via `gh pr comment`.
3. Optionally create umbrella issue via `gh issue create` with checklist of all PRs in merge order.
4. Update guardian.md with workspace-aware instructions: when `WORCA_WORKSPACE_ID` is set, include workspace name and repo role in PR description.

### Phase 6: Resume & error recovery

**Files:** `src/worca/scripts/run_workspace.py`, `src/worca/workspace/dag_executor.py`

**Tasks:**
1. `--resume <workspace_id>` reads manifest, determines which tiers/repos are incomplete.
2. For partially completed tiers: re-run only failed/blocked children (skip completed ones).
3. For unstarted tiers: re-run from that tier forward.
4. Re-generate context artifacts from already-completed children before resuming.
5. If integration test failed: `--resume` re-runs only the integration test (children are already complete).

### Phase 7: UI integration

**Files:** `worca-ui/server/workspace-routes.js` (new), `worca-ui/app/views/workspace-detail.js` (new), `worca-ui/app/views/dashboard.js`, `worca-ui/server/ws-modular.js`

**Tasks:**
1. Add workspace REST endpoints in `workspace-routes.js`.
2. Extend dashboard fleet grouping to show tier structure for workspace runs.
3. Build workspace detail view — DAG visualization, plan viewer, context artifacts, integration log, PR table.
4. Add workspace manifest watcher in `ws-modular.js` (reuses fleet-update event).
5. Add "Start workspace run" launcher variant to `fleet-launcher.js`.

### Phase 8: Dogfooding and release

1. End-to-end workspace run on a synthetic 3-repo fixture (shared-lib → backend → frontend).
2. Test resume after tier-1 failure.
3. Test integration test failure → no PR push.
4. Release note in `MIGRATION.md`.
5. User-facing walkthrough in `docs/workspace-runs.md`.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/schemas/workspace.json` | **New** — workspace.json schema |
| `src/worca/schemas/workspace_plan.json` | **New** — structured workspace plan schema |
| `src/worca/workspace/__init__.py` | **New** — workspace package |
| `src/worca/workspace/manifest.py` | **New** — workspace loading, validation, DAG computation |
| `src/worca/workspace/dag_executor.py` | **New** — tier-based dispatch with context injection |
| `src/worca/workspace/integration_test.py` | **New** — cross-repo test runner |
| `src/worca/workspace/pr_linker.py` | **New** — PR cross-reference and umbrella issue creation |
| `src/worca/cli/workspace.py` | **New** — `worca workspace init`, `worca workspace run` CLI |
| `src/worca/scripts/run_workspace.py` | **New** — workspace run entry point |
| `src/worca/agents/core/workspace_planner.md` | **New** — master planner agent template |
| `src/worca/agents/core/guardian.md` | Workspace-aware PR description when `WORCA_WORKSPACE_ID` set |
| `.claude/worca/settings.json` | Add `worca.workspace.*` defaults |
| `worca-ui/server/workspace-routes.js` | **New** — workspace REST endpoints |
| `worca-ui/server/ws-modular.js` | Workspace manifest watcher |
| `worca-ui/app/views/workspace-detail.js` | **New** — DAG view, plan viewer, integration log, PR table |
| `worca-ui/app/views/dashboard.js` | Workspace tier grouping in fleet section |
| `worca-ui/app/views/fleet-launcher.js` | Workspace launcher variant |
| `CLAUDE.md` | Workspace Runs section |
| `MIGRATION.md` | Release note |
| `docs/workspace-runs.md` | **New** — user-facing walkthrough |

## Considerations

- **Fleet reuse, not replacement.** Workspace runs build on fleet infrastructure — `fleet_id` in `pipelines.d/`, `run_worktree.py` dispatch, circuit breaker, `--resume`, guide injection, UI grouping. Fleet continues to serve its purpose (same-prompt fan-out) unchanged.
- **Child pipelines are standard.** Each repo's pipeline runs the full stage sequence with all existing governance. No hooks, agents, or stage machinery are modified (except guardian gaining workspace-aware PR descriptions).
- **DAG ordering is tier-based, not fine-grained.** Repos in the same tier run in parallel. This is simpler than a full DAG scheduler and sufficient for typical multi-repo topologies (which are usually shallow: 2–3 tiers).
- **Context injection is one-way.** Tier N's output is injected as read-only context into tier N+1. There is no back-channel — if tier 1 discovers that tier 0's API is wrong, the workspace run must be restarted. This is a deliberate simplification; iterative cross-tier negotiation would require fundamentally different agent architecture.
- **Integration test is opaque.** Worca runs the user's command and checks the exit code. It does not parse test output, identify failing tests, or retry. The user is responsible for providing a working integration test command.
- **PR merge order is advisory, not enforced.** The umbrella issue documents merge order. Worca does not auto-merge or block out-of-order merges. Enforcement would require GitHub branch protection rules or a merge bot, which is out of scope.
- **Workspace root is not a git repo.** The parent directory does not need its own `.git/`. `workspace.json` and `.worca/` live there but are not version-controlled (unless the user chooses to create a meta-repo). This avoids forcing a monorepo structure.
- **Breaking changes:** **None.** Workspace is a new entry point and new agents. Existing fleet and pipeline flows are unchanged. The `fleet_id` field in `pipelines.d/` entries serves double duty for workspace runs (using `workspace_id` as the value).
- **Token cost.** The master planner adds one Opus call per workspace run. Context injection adds guide content proportional to diff size (capped at 8KB per dependency edge). For a 3-repo workspace with 2 tiers, overhead is ~1 planner call + ~16KB of guide content — modest.
- **Governance.** Existing per-repo governance is preserved. Additionally, the master planner cannot write files (it only produces a plan). The workspace coordinator cannot commit (only the guardian in each child can). No new governance bypass paths are introduced.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `tests/test_workspace_manifest.py::test_load_valid` | Parses workspace.json, resolves paths, computes tiers |
| Python | `tests/test_workspace_manifest.py::test_cycle_detection` | Circular `depends_on` raises clear error |
| Python | `tests/test_workspace_manifest.py::test_tier_computation` | Linear chain → N tiers; diamond → 3 tiers; independent → 1 tier |
| Python | `tests/test_workspace_manifest.py::test_missing_dep_name` | `depends_on` referencing non-existent repo raises |
| Python | `tests/test_dag_executor.py::test_tier_ordering` | Tier 0 dispatches first; tier 1 waits; tier 2 waits |
| Python | `tests/test_dag_executor.py::test_blocked_on_failure` | Failed child in tier 0 → dependent children in tier 1 marked `blocked` |
| Python | `tests/test_dag_executor.py::test_non_dependent_continues` | Failed child in tier 0 → non-dependent children in tier 1 still run |
| Python | `tests/test_dag_executor.py::test_context_injection` | Tier 0 diff summary appears in tier 1 child's `--guide` |
| Python | `tests/test_dag_executor.py::test_context_truncation` | Diff summary exceeding 8KB is truncated with marker |
| Python | `tests/test_integration_test.py::test_pass` | Exit code 0 → workspace status `completed` |
| Python | `tests/test_integration_test.py::test_fail` | Exit code 1 → workspace status `integration_failed`, PRs not pushed |
| Python | `tests/test_integration_test.py::test_skip` | No `integration_test` in workspace.json → skipped with warning |
| Python | `tests/test_pr_linker.py::test_dependency_comments` | Each PR gets a comment listing deps and dependents |
| Python | `tests/test_pr_linker.py::test_umbrella_issue` | Umbrella issue created with checklist in merge order |
| Python | `tests/test_workspace_resume.py::test_resume_partial_tier` | Only failed/blocked children in incomplete tier re-launched |
| Python | `tests/test_workspace_resume.py::test_resume_integration_only` | All children complete, integration failed → re-runs only integration test |
| UI (vitest) | `worca-ui/server/workspace-routes.test.js` | REST endpoint contract |
| UI (vitest) | `worca-ui/app/views/workspace-detail.test.js` | DAG render, tier status, integration badge |

### Integration / E2E Tests

- **Synthetic 3-repo workspace (pytest fixture).** `shared-lib → backend → frontend` topology. Mock claude produces minimal changes per repo. Asserts: 3 tiers execute in order, context artifacts generated between tiers, integration test runs, 3 PRs created with dependency comments, umbrella issue created.
- **Diamond dependency (pytest fixture).** `lib → [svc-a, svc-b] → gateway`. Asserts: tier 0 = lib, tier 1 = [svc-a, svc-b] (parallel), tier 2 = gateway (after both complete).
- **Failure propagation.** Mock `backend` to fail. Assert: `frontend` marked `blocked`, `shared-lib` completed, workspace status `failed`, `--resume` re-runs only `backend` + `frontend`.
- **Playwright (`--workers=1`).** Launch workspace via UI, observe tier-grouped progress, inspect workspace detail view (DAG, plan, integration log).

### Existing Tests to Update

- W-040's `run_fleet.py` tests — verify that `fleet_id` field in `pipelines.d/` also works when the value is a `workspace_id` (string format is compatible).
- Guardian agent tests — verify workspace-aware PR description is emitted when `WORCA_WORKSPACE_ID` is set and standard description when it is not.

## Files to Create/Modify

See **Files Changed Summary** table in Implementation Plan above.

## Out of Scope

- **Iterative cross-tier negotiation.** If tier 1 discovers tier 0's output is wrong, the run must be restarted. No back-channel or automatic retry across tiers.
- **Automatic PR merging.** Merge order is documented, not enforced. No merge bot integration.
- **Cross-machine distribution.** All repos must be local siblings in one parent directory.
- **Per-repo prompt customization within workspace.** The master planner decomposes automatically; manual per-repo overrides are not supported (use fleet + individual pipelines instead).
- **Workspace-level cost budgets.** Per-child budgets apply; no aggregate cap.
- **Monorepo support.** This feature is for multi-repo projects. Monorepos are already handled by the single-repo pipeline.
- **Dynamic repo discovery.** The workspace is static — `workspace.json` must be updated manually if repos are added or removed.

## Future Work

- **Iterative planning.** If a child pipeline's reviewer rejects changes with cross-repo implications, feed the rejection back to the master planner for re-decomposition.
- **Workspace templates.** Pre-defined workspace.json templates for common topologies (microservices, monorepo-split, library + consumers).
- **Cross-repo code navigation.** Inject workspace-level `CLAUDE.md` that maps the full architecture so agents can reason about cross-repo structure even within single-repo pipelines.
- **Merge orchestration.** Integration with GitHub merge queues or a lightweight merge-order enforcer that auto-merges PRs in dependency order once all are approved.
- **Remote workspace execution.** Distribute workspace tiers across multiple machines for large workspaces (10+ repos).
