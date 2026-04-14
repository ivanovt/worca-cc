# W-040: Fleet Runs — Cross-Repository Fan-Out of a Single Work-Request

**Status:** Draft
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-04-14
**Depends on:** W-030 (parallel pipeline execution — registry + multi-dashboard primitives), W-032 (global multi-project worca-ui — `~/.worca/projects.d/` semantics), W-039 (workspace batch add projects — prerequisite registration path for fleet launches from the UI)

## Problem

There is no first-class way to apply a single work-request to many independent project repositories in parallel. Existing parallel runners are intra-repo only: `src/worca/scripts/run_parallel.py` and `src/worca/utils/git.py:create_pipeline_worktree` are built on `git worktree add`, which cannot span distinct `.git/` directories. `src/worca/scripts/run_multi.py` multiplexes multiple work-requests against one repo, not one work-request across many repos. Users who want to roll a migration, compliance change, or repo-hygiene task across 5–20 registered projects must launch pipelines N times by hand, with no shared guide, no branch-template, no grouped observability in `worca-ui/app/views/multi-dashboard.js`, and no aggregate circuit breaker. Shared normative context (a migration guide, RFC, or spec) also has no pinning mechanism today: `src/worca/orchestrator/work_request.py` only carries a single `description`, and `CLAUDE.md` is the wrong lifecycle for per-run authoritative material.

## Proposal

Add a `run_fleet.py` entry point that accepts N target project paths, one prompt (or `--source`), an optional repeatable `--guide`, an optional `--plan`, and a `--branch <template>`, then launches N isolated pipelines — one per target repo — under a shared `fleet_id`. Per-project pipelines stay independent (own `.claude/worca/`, own branch, own PR) but register under the common `fleet_id` so the UI, the CLI, and cleanup scripts treat the fleet as a single unit. A new `attach_guide()` helper in `work_request.py` prepends guide content to `description` under a normative header and is wired into every entry script (not fleet-only). Execution uses `concurrent.futures.ThreadPoolExecutor` with `subprocess.Popen(cwd=project_dir)` per child; a manifest at `~/.worca/fleet-runs/<fleet_id>.json` tracks per-project status. The `worca-ui` `multi-dashboard` gains fleet grouping and a "Start fleet run" launcher.

## Design

### 1. Cross-Repository Runner

- **Current state:** `src/worca/scripts/run_parallel.py`, `src/worca/scripts/run_multi.py`, `src/worca/utils/git.py:create_pipeline_worktree` — every parallel runner is built around `git worktree add`, which shares `.git/` and is intrinsically intra-repository. No entry point accepts N absolute project paths.
- **Obstacle:** Worktree primitives cannot span distinct git repos.
- **Resolution:** Add `src/worca/scripts/run_fleet.py`. Each target is already its own repo; the isolation boundary is the filesystem (distinct `cwd` per child) plus a per-project `.claude/worca/`. `subprocess.Popen` with `cwd=project_dir` and a scrubbed `env` provides the isolation. No worktree primitives are touched.

### 2. Target-Repo Runtime Provisioning

- **Current state:** `src/worca/cli/init.py` creates `.claude/worca/` on demand; target repos in a fleet may never have had `worca init` run.
- **Obstacle:** Without `.claude/worca/`, hooks, agent templates, and settings are missing and the pipeline cannot start. Manually running `worca init` N times is error-prone.
- **Resolution:** `run_fleet.py` calls `worca init <project_dir> --upgrade` for every target before launching. The `--upgrade` path is already non-destructive (preserves user `settings.json`, updates only worca-owned files under `.claude/worca/`, idempotent). Failures are marked `setup_failed` in the manifest; the fleet continues with the rest.

### 3. Shared Reference-Context Mechanism

- **Current state:** `src/worca/orchestrator/work_request.py` carries a single `description`; `src/worca/orchestrator/prompt_builder.py` routes it into every stage's user-channel. There is no pinning mechanism for per-run normative context.
- **Obstacle:** Migration/spec-driven work needs a guide visible to every stage. Pasting into prompts is repetitive; dropping in the repo is inconsistent; `CLAUDE.md` is the wrong lifecycle.
- **Resolution:** Add `attach_guide(wr: WorkRequest, guide_paths: list[str]) -> WorkRequest` to `work_request.py`. Reads each path, concatenates contents, and prepends under an explicit normative header:

```markdown
## Reference Guide (normative)

The following guidance is authoritative for this work-request. Treat any
conflict between the guide and the task description as a bug in the task
description, and surface it rather than silently resolving it.

### <guide filename>

<contents>

---

## Task

<original description>
```

Because `prompt_builder.py` already routes `wr.description` into every stage, no stage-level change is needed. The helper is wired into `run_pipeline.py`, `run_parallel.py`, `run_multi.py`, and `run_fleet.py` so `--guide` is a universal flag.

### 4. Branch-Name Templating

- **Current state:** `src/worca/scripts/run_parallel.py._slugify` derives branch names from the work-request title. A fleet shares one work-request, so all children would slug to the same branch.
- **Obstacle:** Collision across the fleet — indistinguishable PRs in GitHub's PR list.
- **Resolution:** `run_fleet.py` accepts `--branch <template>` with placeholders `{project}` (slugified basename), `{fleet_id}`, `{slug}`, `{yyyymmdd}`, `{yyyymmddhhmm}`. If no placeholder is present, `/{project}` is appended automatically. Slugification reuses `_slugify`, extracted into `src/worca/utils/branch_naming.py` for sharing. Post-substitution the full branch set is checked for uniqueness before any child launches; conflicts fail fast with the colliding pair reported.

### 5. Environment Isolation for Fleet Children

- **Current state:** `src/worca/orchestrator/stages/*.py` and `src/worca/claude_hooks/pre_tool_use.py` depend on `WORCA_AGENT` / `WORCA_STAGE` / `WORCA_RUN_ID` being set per-stage. Children spawn as `subprocess.Popen`.
- **Obstacle:** Stale env vars from the parent (e.g., `WORCA_AGENT` from a launcher, or `CLAUDECODE=1` when launched from inside Claude Code) leak in and cause hooks to misclassify the child.
- **Resolution:** `run_fleet.py` builds a per-child env from `os.environ.copy()` then `env.pop()` on an explicit scrub list: `WORCA_AGENT`, `WORCA_STAGE`, `WORCA_RUN_ID`, `CLAUDECODE`. Children set these themselves as stages fire.

### 6. Plan Stage Modes

- **Current state:** `src/worca/orchestrator/stages/plan.py` runs Planner per pipeline. In a fleet without explicit plan handling, every child runs its own Planner.
- **Obstacle:** N projects produce N different strategies (defeating the point of a fleet) and burn N× Planner tokens.
- **Resolution:** Two flags:
  - `--plan <path>` (explicit): every child receives the same plan; Planner is skipped in every child. **Recommended for fleet work.**
  - `--plan-first` (derived): the first project runs Planner; once its plan is written, the remaining N−1 children launch with that plan attached. If the reference Planner fails, the fleet halts before fan-out.
  - Neither flag: warn and proceed with independent Planners.

### 7. Fleet-Level Circuit Breaker

- **Current state:** `src/worca/orchestrator/circuit_breaker.py` and `src/worca/orchestrator/batch.py:CircuitBreakerError` are per-pipeline only.
- **Obstacle:** A systematic issue (bad guide, bad plan, missing tool) that fails the first 5 children will still burn through the remaining 15.
- **Resolution:** Add `fleet_failure_threshold` (default 30%) to fleet config. The `run_fleet.py` main loop tracks completed children; when `failed / completed >= threshold` and `completed >= min(3, total)`, unstarted children are cancelled and the fleet manifest is marked `halted`. In-flight children finish naturally — fleet-halt does not kill running subprocesses, avoiding half-written repo states.

### 8. Registry Grouping

- **Current state:** `src/worca/orchestrator/registry.py` and `worca-ui/server/project-registry.js` key pipelines by `run_id` with no grouping field.
- **Obstacle:** The UI cannot group N fleet rows visually.
- **Resolution:** Add optional `fleet_id` to the registry schema. Python: add `fleet_id: str | None` to `register_pipeline()`; every existing caller passes `fleet_id=None` (schema-compatible). UI: `fleet_id` index in `project-registry.js`, fleet-grouping renderer in `multi-dashboard.js` (header row per fleet, collapsible children, aggregate progress bar). The existing `run-update` WS event gains an optional `fleet_id` field; older consumers ignore it.

### 9. Guide Size and Token Budget

- **Current state:** `src/worca/orchestrator/prompt_builder.py` injects `description` into every stage; `.claude/settings.json` has no guide-size controls.
- **Obstacle:** A 50KB guide × ~8 stages × up to `mloops` × fleet size becomes significant cost without visibility.
- **Resolution:** Three mitigations:
  1. **Hard cap.** `worca.guide.max_bytes` (default 64KB). If combined guide content exceeds the cap, `attach_guide()` raises a clear error before any stage runs.
  2. **Token estimate.** `run_fleet.py` prints `guide_bytes / 4 × stages × mloops × fleet_size` at launch. User confirms (or passes `--yes`) when the estimate exceeds a visible threshold.
  3. **Sanitized UI payload.** Multi-dashboard surfaces `hasGuide`, `guideBytes`, `guideFilenames` on the fleet header — not guide content. Full content is opt-in via `GET /api/fleet-runs/:id/guide`.

### 10. Fleet Manifest Storage

- **Current state:** No manifest format exists; a naive write would land in the launcher's cwd (often a target repo).
- **Obstacle:** Manifests accidentally committed into target repos.
- **Resolution:** Manifests always live at `~/.worca/fleet-runs/<fleet_id>.json`, alongside `~/.worca/projects.d/`. `run_fleet.py` writes nothing into any target repo's working tree. Stage output still lands in each project's `.worca/` as with any pipeline.

**Manifest schema:**

```json
{
  "fleet_id": "f_<yyyymmddhhmm>_<rand>",
  "created_at": "<iso8601>",
  "work_request": { "title": "...", "description": "...", "source": "..." },
  "guide": { "paths": ["..."], "bytes": 12345, "filenames": ["..."] },
  "plan": { "mode": "explicit|plan-first|none", "path": "..." },
  "branch_template": "migration/v2/{project}",
  "max_parallel": 5,
  "fleet_failure_threshold": 0.30,
  "status": "running|halted|completed|failed",
  "children": [
    {
      "project_path": "/abs/path",
      "project_slug": "proj",
      "branch": "migration/v2/proj",
      "run_id": "r_...",
      "status": "pending|running|completed|failed|setup_failed",
      "started_at": null,
      "completed_at": null,
      "returncode": null
    }
  ]
}
```

### 11. Guardian PR Grouping

- **Current state:** `src/worca/agents/core/guardian.md` creates PRs via `gh pr create`. Without guidance, every fleet PR has the same title.
- **Obstacle:** Hard to distinguish PRs in GitHub's PR list.
- **Resolution:** When `fleet_id` is present in the pipeline env, `guardian.md` instructs the agent to prepend `[fleet:<fleet_id_short>]` to the PR title and include a footer linking the fleet manifest path. `fleet_id_short` is the last 8 chars of the fleet ID — unique in practice, title-friendly.

### 12. Resumability

- **Current state:** A fleet interrupted by Ctrl+C or crash has no recovery path.
- **Obstacle:** Re-running the same command creates a new `fleet_id` and duplicate branches.
- **Resolution:** `run_fleet.py --resume <fleet_id>` reads the manifest, identifies children with status `∈ {pending, setup_failed, failed}`, and re-launches only those. Children `∈ {completed, running}` are left alone.

### 13. UI Integration

- **Current state:** `worca-ui/server/project-registry.js`, `worca-ui/server/multi-watcher.js`, `worca-ui/app/views/multi-dashboard.js` handle per-project rows with no grouping or launch affordance.
- **Resolution:**
  - **Server:** `POST /api/fleet-runs` (launch), `GET /api/fleet-runs`, `GET /api/fleet-runs/:id`, `DELETE /api/fleet-runs/:id` (fans out to stop all children), `GET /api/fleet-runs/:id/guide` (opt-in).
  - **Client:** fleet-grouping renderer in `multi-dashboard.js` (header row, aggregate progress, expand/collapse). "Start fleet run" launcher: registered-project multi-select, prompt/source input, guide upload, branch template, plan-mode toggle.
  - **WS:** `run-update` gains optional `fleet_id`; clients without fleet support ignore it.

## Implementation Plan

### Phase 1: Shared guide injection (foundation)

**Files:** `src/worca/orchestrator/work_request.py`, `src/worca/scripts/run_pipeline.py`, `src/worca/scripts/run_parallel.py`, `src/worca/scripts/run_multi.py`, `.claude/worca/settings.json`, `CLAUDE.md`

**Tasks:**
1. Add `attach_guide(wr, guide_paths)` in `work_request.py` with the normative header.
2. Add `worca.guide.max_bytes` default (64KB) to `settings.json`.
3. Wire `--guide PATH` (repeatable) into `run_pipeline.py`, `run_parallel.py`, `run_multi.py`; call after `normalize(...)`.
4. Document precedence **plan > guide > description** in `CLAUDE.md`.

### Phase 2: Fleet runner (core)

**Files:** `src/worca/scripts/run_fleet.py` (new), `src/worca/utils/branch_naming.py` (new), `src/worca/orchestrator/registry.py`, `src/worca/scripts/run_parallel.py`

**Tasks:**
1. Add `run_fleet.py` with arg parsing, `--projects` / `--projects-file` resolution, and the branch-template engine.
2. Extract `_slugify` + `_resolve_branch_template` into `utils/branch_naming.py`; update `run_parallel.py` to import from there.
3. Add collision detection on post-substitution branch names.
4. Invoke `worca init --upgrade` per target; capture failures as `setup_failed`.
5. Extend `register_pipeline()` to accept `fleet_id`; update existing callers to pass `fleet_id=None`.
6. Write manifest to `~/.worca/fleet-runs/<fleet_id>.json`; update on every child transition.
7. `ThreadPoolExecutor` dispatch with `--max-parallel` (default 5).
8. Fleet-level circuit breaker (`fleet_failure_threshold`, default 30%).

### Phase 3: Plan modes

**Files:** `src/worca/scripts/run_fleet.py`

**Tasks:**
1. `--plan <path>` propagation to every child.
2. `--plan-first`: sequential Planner on reference project, then fan out.

### Phase 4: UI integration

**Files:** `worca-ui/server/project-registry.js`, `worca-ui/server/fleet-routes.js` (new), `worca-ui/app/views/multi-dashboard.js`, `worca-ui/app/views/fleet-launcher.js` (new)

**Tasks:**
1. `fleet_id` index in `project-registry.js`.
2. `POST /api/fleet-runs`, `GET /api/fleet-runs`, `GET /api/fleet-runs/:id`, `DELETE /api/fleet-runs/:id`, `GET /api/fleet-runs/:id/guide`.
3. Fleet-grouping renderer in `multi-dashboard.js`.
4. "Start fleet run" launcher view.
5. WS `run-update` routing by `fleet_id`.

### Phase 5: Guardian PR grouping and resumability

**Files:** `src/worca/agents/core/guardian.md`, `src/worca/scripts/run_fleet.py`, `CLAUDE.md`, `docs/fleet-runs.md` (new)

**Tasks:**
1. Fleet-aware PR title + footer convention in `guardian.md`.
2. `run_fleet.py --resume <fleet_id>`.
3. "Fleet Runs" section in `CLAUDE.md` + user-facing walkthrough.

### Phase 6: Dogfooding and release

1. End-to-end fleet on a synthetic 3-repo fixture (test-harness scratch repos).
2. Real-world fleet of 5 registered projects applying a trivial guide.
3. Release note in `MIGRATION.md` describing new flags and the `fleet_id` field.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/work_request.py` | Add `attach_guide()` + normative-header constant |
| `src/worca/scripts/run_pipeline.py` | Wire `--guide` flag |
| `src/worca/scripts/run_parallel.py` | Wire `--guide`; import slugifier from `utils/branch_naming` |
| `src/worca/scripts/run_multi.py` | Wire `--guide` |
| `src/worca/scripts/run_fleet.py` | **New** — fleet entry point |
| `src/worca/utils/branch_naming.py` | **New** — extracted `_slugify` + template resolver |
| `src/worca/orchestrator/registry.py` | Add `fleet_id` to `register_pipeline()` |
| `src/worca/agents/core/guardian.md` | Fleet-aware PR title + footer |
| `.claude/worca/settings.json` | Add `worca.guide.max_bytes`, `worca.fleet.*` defaults |
| `worca-ui/server/project-registry.js` | `fleet_id` index |
| `worca-ui/server/fleet-routes.js` | **New** — fleet REST endpoints |
| `worca-ui/app/views/multi-dashboard.js` | Fleet grouping renderer |
| `worca-ui/app/views/fleet-launcher.js` | **New** — "Start fleet run" view |
| `CLAUDE.md` | Fleet Runs section + guide precedence note |
| `MIGRATION.md` | Release note |
| `docs/fleet-runs.md` | **New** — user-facing walkthrough |

## Considerations

- **Per-project independence preserved.** No cross-project dependency resolution, no shared-branch/mono-PR strategy. If projects need different prompts, callers use `run_parallel.py` or launch multiple fleets.
- **In-flight children finish on fleet halt.** The fleet-level circuit breaker only cancels unstarted children — killing mid-flight subprocesses risks half-written repos.
- **Env scrubbing is an allowlist negation.** If future stages add new `WORCA_*` env vars, the scrub list in `run_fleet.py` must be updated; add a regression test that fails when the scrub list drifts from the set declared in `claude_hooks/`.
- **Guide cost visibility.** Users must see token overhead before launching; the `--yes` short-circuit should be reserved for CI/automation.
- **Breaking changes:** **None.** `fleet_id` is an optional field everywhere. All existing `register_pipeline()` callers continue to work (pass `None`). `run-update` WS event gains an optional field; older UI clients ignore it.
- **Migration:** None required for existing pipelines. `worca init --upgrade` already handles the new `worca.guide.*` / `worca.fleet.*` settings additions non-destructively.
- **Governance:** Fleet children inherit existing governance unchanged (only Guardian may commit, `WORCA_AGENT` enforcement intact, plan-check hook intact). The `fleet_id` env var is informational, not a new governance key.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `tests/test_attach_guide.py::test_header_structure` | Normative header wraps guide content and preserves original description |
| Python | `tests/test_attach_guide.py::test_multi_file_concat` | Multiple `--guide` paths concatenate in order with per-file sub-headers |
| Python | `tests/test_attach_guide.py::test_size_cap_enforcement` | Combined size > `worca.guide.max_bytes` raises before any stage runs |
| Python | `tests/test_attach_guide.py::test_missing_file` | Missing path → clear error, no partial mutation of `WorkRequest` |
| Python | `tests/test_branch_naming.py::test_placeholder_expansion` | `{project}` / `{fleet_id}` / `{slug}` / `{yyyymmdd(hhmm)}` resolve correctly |
| Python | `tests/test_branch_naming.py::test_auto_append_project` | Template without placeholders gets `/{project}` appended |
| Python | `tests/test_branch_naming.py::test_collision_detection` | Duplicate post-substitution names fail fast with colliding pair reported |
| Python | `tests/test_run_fleet.py::test_dry_run_manifest` | `--dry-run` writes a manifest with expected children, no subprocess spawn |
| Python | `tests/test_fleet_env_isolation.py::test_scrub_list` | Child subprocess env has none of `WORCA_AGENT` / `WORCA_STAGE` / `WORCA_RUN_ID` / `CLAUDECODE` |
| Python | `tests/test_fleet_plan_modes.py::test_plan_explicit` | `--plan <path>` attaches same plan to every child; Planner skipped |
| Python | `tests/test_fleet_plan_modes.py::test_plan_first` | Reference child's Planner output is reused by N−1 others; failure halts fan-out |
| Python | `tests/test_fleet_circuit_breaker.py::test_halt_threshold` | ≥30% failures with ≥3 completed → unstarted children cancelled, in-flight survive |
| Python | `tests/test_fleet_resume.py::test_resume_selects_failed` | `--resume` re-launches only `pending`/`failed`/`setup_failed` children |
| UI (vitest) | `worca-ui/server/fleet-routes.test.js` | `POST/GET/DELETE /api/fleet-runs` + guide endpoint contract |
| UI (vitest) | `worca-ui/app/views/multi-dashboard-fleet.test.js` | Fleet grouping renders header + aggregate progress + expand/collapse |

### Integration / E2E Tests

- **Synthetic 3-repo fleet (pytest fixture).** Scratch repos generated by the harness; fleet applies a trivial guide (`add HEALTH.md`); asserts 3 branches, 3 PRs (mocked `gh`), 3 completed manifest entries, one fleet group in the UI payload.
- **Playwright (`--workers=1`).** Launch a fleet via the UI, observe grouped progress on `multi-dashboard`, stop the fleet, verify `DELETE /api/fleet-runs/:id` fans out to children.
- **`--plan-first` happy path + failure path.** Reference Planner succeeds → fan-out; reference Planner fails → fleet halted before fan-out, manifest status `failed`.

### Existing Tests to Update

- `tests/test_registry.py` — existing `register_pipeline()` callers updated to pass `fleet_id=None` (schema-compatible default).
- `tests/test_run_parallel.py` — import of `_slugify` moves from `run_parallel` to `utils.branch_naming`.
- `worca-ui/server/multi-watcher.test.js` — assertion that `run-update` payload now includes optional `fleet_id` field (backward-compatible assertion).

## Files to Create/Modify

See **Files Changed Summary** table in Implementation Plan above.

## Out of Scope

- Cross-project dependency resolution (fleet children are fully independent).
- Shared-branch or mono-PR strategies (each child creates and pushes its own PR).
- Distributed execution across multiple machines.
- Shared cost budget enforcement across fleet children (each child has its own budget; aggregate cost reported, not capped).
- Guide content deduplication or summarization (see Future Work).
- Automatic umbrella PR creation (callers can group via branch prefix in GitHub's PR list).
- Per-project prompt customization within a fleet (use `run_parallel.py` or multiple fleets).

## Future Work

- **Guide summarization.** For guides exceeding the size cap, a pre-pass that summarizes via a Claude call and uses the summary for later stages while keeping full text for Planner.
- **Umbrella PR.** Guardian-level option to create a tracking PR/issue linking all fleet-child PRs for review coordination.
- **Fleet cost aggregation.** Sum per-child costs into the manifest; surface on the fleet group header.
- **Partial retargeting.** `--resume` additionally accepts `--add-projects` so a fleet can expand mid-flight without starting over.
- **Cross-fleet templates.** A saved "fleet profile" (guide + plan + branch template + project list) re-launchable with one command — useful for recurring org-wide migrations.
