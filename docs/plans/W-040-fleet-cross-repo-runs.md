# W-040: Fleet Runs — Cross-Repository Fan-Out of a Single Work-Request

**Status:** Draft
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-04-14 (revised 2026-04-25)
**Depends on:** W-032 (global multi-project worca-ui — `~/.worca/projects.d/` semantics), W-039 (workspace batch add projects — prerequisite registration path for fleet launches from the UI), W-048 (worktree-based pipeline isolation — `pipelines.d/` registry, unified `discoverRuns`, `active_run` removal)

## Problem

There is no first-class way to apply a single work-request to many independent project repositories in parallel. Existing parallel runners are intra-repo only: `src/worca/scripts/run_parallel.py` and `src/worca/utils/git.py:create_pipeline_worktree` are built on `git worktree add`, which cannot span distinct `.git/` directories. W-048's `run_worktree.py` (replacing `run_multi.py`) launches isolated pipelines within a single repo via git worktrees — it cannot target a different repo. Users who want to roll a migration, compliance change, or repo-hygiene task across 5–20 registered projects must launch pipelines N times by hand, with no shared guide, no branch-template, no grouped observability in the dashboard, and no aggregate circuit breaker. Shared normative context (a migration guide, RFC, or spec) also has no pinning mechanism today: `src/worca/orchestrator/work_request.py` only carries a single `description`, and `CLAUDE.md` is the wrong lifecycle for per-run authoritative material.

## Proposal

Add a `run_fleet.py` entry point that accepts N target project paths, one prompt (or `--source`), an optional repeatable `--guide`, an optional `--plan`, and a `--branch <template>`, then launches N isolated pipelines — one per target repo — under a shared `fleet_id`. Each fleet child is dispatched via W-048's `run_worktree.py`, giving it worktree isolation within its target repo (the user's working tree is not dirtied). Per-project pipelines stay independent (own `.claude/worca/`, own branch, own PR) but register under the common `fleet_id` in W-048's `pipelines.d/` registry so the UI, CLI, and cleanup scripts treat the fleet as a single unit. A new `attach_guide()` helper in `work_request.py` prepends guide content to `description` under a normative header and is wired into every entry script (not fleet-only). A lightweight fleet manifest at `~/.worca/fleet-runs/<fleet_id>.json` tracks fleet-level state (status, circuit breaker, plan mode) while per-child pipeline state is tracked by `pipelines.d/` and `discoverRuns` — no parallel tracking system.

## Design

### 1. Cross-Repository Runner

- **Current state:** W-048 introduces `src/worca/scripts/run_worktree.py` as the default single-pipeline launcher. It creates a git worktree within the current repo, copies `.claude/worca/` into it, registers in `pipelines.d/`, and spawns `run_pipeline.py --worktree` inside the worktree. `src/worca/scripts/run_parallel.py` handles intra-repo parallelism. No entry point accepts N absolute project paths targeting distinct git repos.
- **Obstacle:** `run_worktree.py` creates worktrees via `git worktree add`, which is intrinsically intra-repository. It cannot target a different `.git/` directory.
- **Resolution:** Add `src/worca/scripts/run_fleet.py`. For each target project, `run_fleet.py` invokes `run_worktree.py` with `cwd=project_dir`. This reuses W-048's full isolation flow: worktree creation, `.claude/worca/` copy, `pipelines.d/` registration, and detached `run_pipeline.py` spawn — all within the target repo. `run_fleet.py` itself only manages fleet-level concerns: target resolution, provisioning, branch templating, manifest, circuit breaker, and plan-mode dispatch.

```
run_fleet.py (fleet orchestrator)
  → manual dispatch loop (--max-parallel children, circuit breaker checked before each batch)
    → worca init --upgrade (per target, if needed)
    → run_worktree.py (cwd=project_dir)
      → git worktree add (isolates within target repo)
      → copies .claude/worca/ into worktree
      → registers in pipelines.d/ (with fleet_id)
      → run_pipeline.py --worktree (inside the worktree)
```

**Assumed `run_worktree.py` interface (from W-048 / #82):** `run_worktree.py` must accept at minimum: `--prompt`/`--source`, `--plan <path>`, `--branch <name>`, `--fleet-id <id>`, `--guide <path>`. It must register in `pipelines.d/` via `register_pipeline(..., fleet_id=<id>)`, create a worktree, and exit immediately after spawning `run_pipeline.py` (fire-and-forget). W-048 §3 defines this interface — if its implementation diverges, fleet dispatch code must adapt.

### 2. Target-Repo Runtime Provisioning

- **Current state:** `src/worca/cli/init.py` creates `.claude/worca/` on demand; target repos in a fleet may never have had `worca init` run.
- **Obstacle:** Without `.claude/worca/`, hooks, agent templates, and settings are missing and the pipeline cannot start. Manually running `worca init` N times is error-prone.
- **Resolution:** `run_fleet.py` calls `worca init <project_dir> --upgrade` for every target before launching. The `--upgrade` path is already non-destructive (preserves user `settings.json`, updates only worca-owned files under `.claude/worca/`, idempotent). Failures are marked `setup_failed` in the manifest; the fleet continues with the rest.

  **Version compatibility:** `worca init --upgrade` overwrites hooks and agent templates but preserves `settings.json`. If the target repo used an older worca version with a different settings schema, the new hooks may expect keys that don't exist. To mitigate: add a `schema_version` field to `.claude/worca/settings.json`; `init --upgrade` performs schema migration (adds missing keys with defaults, warns about removed keys). The fleet manifest records the worca version used for provisioning.

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

Because `prompt_builder.py` already routes `wr.description` into every stage, no stage-level change is needed. The helper is wired into `run_pipeline.py`, `run_parallel.py`, `run_worktree.py`, and `run_fleet.py` so `--guide` is a universal flag.

**Path resolution:** `run_fleet.py` resolves all `--guide` paths to absolute paths before dispatching children. Guide paths are relative to the fleet launcher's CWD, not the child's. This is critical because children run with `cwd=project_dir` — a relative path like `./migration-spec.md` would fail to resolve in the child's context.

### 4. Branch-Name Templating

- **Current state:** `src/worca/scripts/run_parallel.py._slugify` derives branch names from the work-request title. A fleet shares one work-request, so all children would slug to the same branch.
- **Obstacle:** Collision across the fleet — indistinguishable PRs in GitHub's PR list.
- **Resolution:** `run_fleet.py` accepts `--branch <template>` with placeholders `{project}` (slugified basename), `{fleet_id}`, `{slug}`, `{yyyymmdd}`, `{yyyymmddhhmm}`. If no placeholder is present, `/{project}` is appended automatically. Slugification reuses `_slugify`, extracted into `src/worca/utils/branch_naming.py` for sharing. Post-substitution the full branch set is checked for uniqueness before any child launches; conflicts fail fast with the colliding pair reported.

### 5. Environment Isolation for Fleet Children

- **Current state:** `src/worca/orchestrator/stages/*.py` and `src/worca/claude_hooks/pre_tool_use.py` depend on `WORCA_AGENT` / `WORCA_STAGE` / `WORCA_RUN_ID` being set per-stage. Children spawn as `subprocess.Popen`.
- **Obstacle:** Stale env vars from the parent (e.g., `WORCA_AGENT` from a launcher, or `CLAUDECODE=1` when launched from inside Claude Code) leak in and cause hooks to misclassify the child.
- **Resolution:** `run_fleet.py` builds a per-child env from `os.environ.copy()` then `env.pop()` on an explicit scrub list: `WORCA_AGENT`, `WORCA_STAGE`, `WORCA_RUN_ID`, `WORCA_PROJECT_ROOT`, `CLAUDECODE`. `WORCA_PROJECT_ROOT` must be scrubbed because the CWD-lock hook in `pre_tool_use.py:35` reads it to prefix all Bash commands with `cd $root &&` — if it inherits the fleet launcher's directory instead of the child's worktree path, every hook invocation in every child will misfire. Children set these vars themselves as stages fire.

### 6. Plan Stage Modes

- **Current state:** `src/worca/orchestrator/stages/plan.py` runs Planner per pipeline. In a fleet without explicit plan handling, every child runs its own Planner.
- **Obstacle:** N projects produce N different strategies (defeating the point of a fleet) and burn N× Planner tokens.
- **Resolution:** Two flags:
  - `--plan <path>` (explicit): every child receives the same plan; Planner is skipped in every child. **Recommended for fleet work.**
  - `--plan-first [project-name]` (derived): a designated reference project runs Planner first; once its plan is written, the plan file is copied to a fleet-scoped temp directory (`~/.worca/fleet-runs/<fleet_id>/shared-plan.md`) and the remaining N−1 children launch with that plan attached via `--plan`. If no project name is given, the first in the `--projects` list is used. If the reference Planner fails, the fleet halts before fan-out.
  - Neither flag: warn and proceed with independent Planners.

### 7. Fleet-Level Circuit Breaker

- **Current state:** `src/worca/orchestrator/circuit_breaker.py` and `src/worca/orchestrator/batch.py:CircuitBreakerError` are per-pipeline only.
- **Obstacle:** A systematic issue (bad guide, bad plan, missing tool) that fails the first 5 children will still burn through the remaining 15.
- **Resolution:** Add `fleet_failure_threshold` (default 30%) to fleet config. The `run_fleet.py` main loop tracks completed children; when `failed / completed >= threshold` and `completed >= min(3, total)`, unstarted children are cancelled and the fleet manifest is marked `halted`. In-flight children finish naturally — fleet-halt does not kill running subprocesses, avoiding half-written repo states.

  **Dispatch strategy:** Do not submit all children to `ThreadPoolExecutor` at once — eagerly queued futures cannot be reliably cancelled. Instead, use a manual dispatch loop: maintain a set of in-flight futures (up to `--max-parallel`), check the circuit breaker before submitting each new child, and skip remaining children if the threshold is reached. This ensures the breaker can actually prevent unstarted children from launching.

### 8. Registry Integration via `pipelines.d/`

- **Current state:** W-048 introduces `.worca/multi/pipelines.d/*.json` as the per-pipeline registry. Each entry tracks `run_id`, `worktree_path`, and status. `discoverRuns` in `watcher.js` fans out across these entries to discover all concurrent runs. The UI's `WatcherSet` watches `pipelines.d/` for changes and broadcasts run updates automatically.
- **Obstacle:** The registry has no grouping concept — fleet children would appear as unrelated individual runs.
- **Resolution:** Add an optional `fleet_id` keyword-only argument to `register_pipeline()`: `register_pipeline(..., *, fleet_id=None)`. This writes `fleet_id` into the `pipelines.d/` entry JSON. All existing callers continue to work (they don't pass it). `run_worktree.py` accepts `--fleet-id` and passes it through. The UI groups runs by `fleet_id` when present:
  - `discoverRuns` includes `fleet_id` in each run's metadata (read from the registry entry).
  - `runs-list` WS event carries `fleet_id` per run — no new event type needed.
  - Dashboard groups runs sharing a `fleet_id` under a collapsible fleet header with aggregate progress.
  - Older UI clients without fleet awareness ignore the field and see flat run lists (backward-compatible).

This replaces the originally proposed `registry.py` extension — `pipelines.d/` is now the single source of truth for per-child state. The fleet manifest (§10) only stores fleet-level concerns.

### 9. Guide Size and Token Budget

- **Current state:** `src/worca/orchestrator/prompt_builder.py` injects `description` into every stage; `.claude/settings.json` has no guide-size controls.
- **Obstacle:** A 50KB guide × ~8 stages × up to `mloops` × fleet size becomes significant cost without visibility.
- **Resolution:** Three mitigations:
  1. **Hard cap.** `worca.guide.max_bytes` (default 64KB). If combined guide content exceeds the cap, `attach_guide()` raises a clear error before any stage runs.
  2. **Token estimate.** `run_fleet.py` prints `guide_tokens × prompt_stages × fleet_size` at launch, where `guide_tokens ≈ guide_bytes / 4` and `prompt_stages` is the number of stages that inject the description into the prompt (typically 6–8, not multiplied by `mloops` since loop iterations don't re-inject the full guide). The estimate is labeled "guide input token overhead" to distinguish from output costs. User confirms (or passes `--yes`) when the estimate exceeds a visible threshold.
  3. **Sanitized UI payload.** Dashboard surfaces `hasGuide`, `guideBytes`, `guideFilenames` on the fleet header — not guide content. Full content is opt-in via `GET /api/fleet-runs/:id/guide`.

### 10. Fleet Manifest Storage

- **Current state:** No manifest format exists; a naive write would land in the launcher's cwd (often a target repo).
- **Obstacle:** Manifests accidentally committed into target repos.
- **Resolution:** Manifests always live at `~/.worca/fleet-runs/<fleet_id>.json`, alongside `~/.worca/projects.d/`. `run_fleet.py` writes nothing into any target repo's working tree. Per-child pipeline state (run status, worktree path, PID) lives in each project's `pipelines.d/` entries — the manifest does not duplicate it. The manifest tracks only fleet-level concerns: work request, guide metadata, plan mode, branch template, circuit breaker state, and the list of child `run_id` + `project_path` pairs for cross-referencing.

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
      "run_id": "r_..."
    }
  ]
}
```

Note: per-child `status`, `started_at`, `completed_at`, and `returncode` are no longer in the manifest — they are read from `pipelines.d/` entries and `status.json` at query time. The `children` array is a lightweight index mapping `run_id` to `project_path` for fleet-scoped queries.

### 11. Guardian PR Grouping

- **Current state:** `src/worca/agents/core/guardian.md` creates PRs via `gh pr create`. Without guidance, every fleet PR has the same title.
- **Obstacle:** Hard to distinguish PRs in GitHub's PR list.
- **Resolution:** When `fleet_id` is present in the pipeline env, `guardian.md` instructs the agent to prepend `[fleet:<fleet_id_short>]` to the PR title and include a footer linking the fleet manifest path. `fleet_id_short` is the random suffix portion of the fleet ID (the hex chars after the last underscore in `f_<yyyymmddhhmm>_<rand>`), generated at fleet creation time and stored in the manifest as a dedicated field for consistent display.

### 12. Resumability

- **Current state:** A fleet interrupted by Ctrl+C or crash has no recovery path.
- **Obstacle:** Re-running the same command creates a new `fleet_id` and duplicate branches.
- **Resolution:** `run_fleet.py --resume <fleet_id>` reads the manifest, resolves each child's current status from `pipelines.d/` and `status.json`, identifies children that are `pending`, `setup_failed`, or `failed`, and re-launches only those via `run_worktree.py`. Children that are `completed` or `running` are left alone.

### 13. UI Integration

- **Current state:** W-048's unified `discoverRuns` fans out across `pipelines.d/` and makes all concurrent runs (including worktree runs) visible in the dashboard. `WatcherSet` watches `pipelines.d/` for changes. The `runs-list` WS event includes all discovered runs.
- **Resolution:**
  - **Server:** Fleet-specific REST endpoints for manifest CRUD and the launcher: `POST /api/fleet-runs` (launch), `GET /api/fleet-runs`, `GET /api/fleet-runs/:id`, `DELETE /api/fleet-runs/:id` (halts unstarted children, in-flight finish naturally), `GET /api/fleet-runs/:id/guide` (opt-in content). Per-child run status is **not** served via fleet endpoints — the existing `discoverRuns` and `runs-list` WS event handle it, with `fleet_id` as a grouping key.
  - **Client:** Fleet-grouping renderer in the dashboard: header row per `fleet_id` (from `runs-list` data), aggregate progress bar, expand/collapse. "Start fleet run" launcher: registered-project multi-select, prompt/source input, guide upload, branch template, plan-mode toggle.
  - **WS:** No new event types. `runs-list` event already carries all runs; the client groups by `fleet_id` field. Fleet manifest changes (status, circuit breaker halt) are pushed via a new `fleet-update` event from `run_fleet.py` writing to the manifest, watched by the server.

## Implementation Plan

### Phase 1: Shared guide injection (foundation)

**Files:** `src/worca/orchestrator/work_request.py`, `src/worca/scripts/run_pipeline.py`, `src/worca/scripts/run_parallel.py`, `src/worca/scripts/run_worktree.py`, `.claude/worca/settings.json`, `CLAUDE.md`

**Tasks:**
1. Add `attach_guide(wr, guide_paths)` in `work_request.py` with the normative header.
2. Add `worca.guide.max_bytes` default (64KB) to `settings.json`.
3. Wire `--guide PATH` (repeatable) into `run_pipeline.py`, `run_parallel.py`, `run_worktree.py`; call after `normalize(...)`.
4. Document precedence **plan > guide > description** in `CLAUDE.md`.

### Phase 2: Fleet runner (core)

**Files:** `src/worca/scripts/run_fleet.py` (new), `src/worca/utils/branch_naming.py` (new), `src/worca/scripts/run_worktree.py`, `src/worca/scripts/run_parallel.py`

**Tasks:**
1. Add `run_fleet.py` with arg parsing, `--projects` / `--projects-file` resolution, and the branch-template engine.
2. Extract `_slugify` + `_resolve_branch_template` into `utils/branch_naming.py`; update `run_parallel.py` to import from there.
3. Add collision detection on post-substitution branch names.
4. Invoke `worca init --upgrade` per target; capture failures as `setup_failed`.
5. Add `--fleet-id` flag to `run_worktree.py`; pass through to `register_pipeline()` which writes it into the `pipelines.d/` entry.
6. Write fleet manifest to `~/.worca/fleet-runs/<fleet_id>.json`; update fleet-level status on child transitions (polled from `pipelines.d/`).
7. `ThreadPoolExecutor` dispatch with `--max-parallel` (default 5), each child calling `run_worktree.py` with `cwd=project_dir` and `--fleet-id`.
8. Fleet-level circuit breaker (`fleet_failure_threshold`, default 30%).

### Phase 3: Plan modes

**Files:** `src/worca/scripts/run_fleet.py`

**Tasks:**
1. `--plan <path>` propagation to every child via `run_worktree.py --plan`.
2. `--plan-first`: sequential Planner on reference project, then fan out.

### Phase 4: UI integration

**Files:** `worca-ui/server/fleet-routes.js` (new), `worca-ui/server/ws-modular.js`, `worca-ui/app/views/dashboard.js`, `worca-ui/app/views/fleet-launcher.js` (new)

**Tasks:**
1. Add fleet manifest file watcher to `ws-modular.js`; emit `fleet-update` events on manifest changes.
2. `POST /api/fleet-runs`, `GET /api/fleet-runs`, `GET /api/fleet-runs/:id`, `DELETE /api/fleet-runs/:id`, `GET /api/fleet-runs/:id/guide`.
3. Fleet-grouping renderer in `dashboard.js` — group `runs-list` entries by `fleet_id`, render collapsible header with aggregate progress.
4. "Start fleet run" launcher view.

### Phase 5: Guardian PR grouping and resumability

**Files:** `src/worca/agents/core/guardian.md`, `src/worca/scripts/run_fleet.py`, `CLAUDE.md`, `docs/fleet-runs.md` (new)

**Tasks:**
1. Fleet-aware PR title + footer convention in `guardian.md`.
2. `run_fleet.py --resume <fleet_id>` — reads manifest, resolves child status from `pipelines.d/`, re-launches failed/pending children.
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
| `src/worca/scripts/run_worktree.py` | Wire `--guide` flag; add `--fleet-id` flag passed to `register_pipeline()` |
| `src/worca/scripts/run_fleet.py` | **New** — fleet entry point |
| `src/worca/utils/branch_naming.py` | **New** — extracted `_slugify` + template resolver |
| `src/worca/agents/core/guardian.md` | Fleet-aware PR title + footer |
| `.claude/worca/settings.json` | Add `worca.guide.max_bytes`, `worca.fleet.*` defaults |
| `worca-ui/server/fleet-routes.js` | **New** — fleet REST endpoints |
| `worca-ui/server/ws-modular.js` | Fleet manifest file watcher + `fleet-update` event |
| `worca-ui/app/views/dashboard.js` | Fleet grouping renderer (collapsible header, aggregate progress) |
| `worca-ui/app/views/fleet-launcher.js` | **New** — "Start fleet run" view |
| `CLAUDE.md` | Fleet Runs section + guide precedence note |
| `MIGRATION.md` | Release note |
| `docs/fleet-runs.md` | **New** — user-facing walkthrough |

## Considerations

- **Per-project independence preserved.** No cross-project dependency resolution, no shared-branch/mono-PR strategy. If projects need different prompts, callers use `run_parallel.py` or launch multiple fleets.
- **Worktree isolation for fleet children.** By dispatching via `run_worktree.py`, each fleet child gets a git worktree within its target repo. The user's working tree is not dirtied — important when fleet-targeting repos where the user may have uncommitted work.
- **In-flight children finish on fleet halt.** The fleet-level circuit breaker only cancels unstarted children — killing mid-flight subprocesses risks half-written repos.
- **Single source of truth for per-child state.** Per-child pipeline status lives in `pipelines.d/` entries and `status.json`, not duplicated in the fleet manifest. The manifest only stores fleet-level concerns. This avoids state drift between two tracking systems.
- **Env scrubbing is an allowlist negation.** If future stages add new `WORCA_*` env vars, the scrub list in `run_fleet.py` must be updated; add a regression test that fails when the scrub list drifts from the set declared in `claude_hooks/`.
- **Guide cost visibility.** Users must see token overhead before launching; the `--yes` short-circuit should be reserved for CI/automation.
- **Breaking changes:** **None.** `fleet_id` is an optional field in `pipelines.d/` entries. All existing callers continue to work (omit it or pass `None`). `runs-list` WS event gains `fleet_id` per run; older UI clients ignore it.
- **Migration:** None required for existing pipelines. `worca init --upgrade` already handles the new `worca.guide.*` / `worca.fleet.*` settings additions non-destructively.
- **Governance:** Fleet children inherit existing governance unchanged (only Guardian may commit, `WORCA_AGENT` enforcement intact, plan-check hook intact). The `fleet_id` env var is informational, not a new governance key.
- **Disk space.** Each fleet child creates a git worktree — a full working copy of the target repo (git objects are shared via alternates, but the working tree is duplicated). For a fleet of 20 repos averaging 200MB, that's ~4GB of worktree copies. `run_fleet.py` should run a pre-flight disk space estimate (`git count-objects -vH` per repo) and warn if available space is insufficient.

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
| Python | `tests/test_fleet_env_isolation.py::test_scrub_list` | Child subprocess env has none of `WORCA_AGENT` / `WORCA_STAGE` / `WORCA_RUN_ID` / `WORCA_PROJECT_ROOT` / `CLAUDECODE` |
| Python | `tests/test_attach_guide.py::test_path_resolution` | Relative `--guide` paths resolved to absolute before child dispatch |
| Python | `tests/test_fleet_plan_modes.py::test_plan_explicit` | `--plan <path>` attaches same plan to every child; Planner skipped |
| Python | `tests/test_fleet_plan_modes.py::test_plan_first` | Reference child's Planner output is reused by N−1 others; failure halts fan-out |
| Python | `tests/test_fleet_circuit_breaker.py::test_halt_threshold` | ≥30% failures with ≥3 completed → unstarted children cancelled, in-flight survive |
| Python | `tests/test_fleet_resume.py::test_resume_selects_failed` | `--resume` re-launches only `pending`/`failed`/`setup_failed` children |
| Python | `tests/test_fleet_resume.py::test_resume_reads_pipelines_d` | `--resume` resolves child status from `pipelines.d/` entries, not manifest |
| UI (vitest) | `worca-ui/server/fleet-routes.test.js` | `POST/GET/DELETE /api/fleet-runs` + guide endpoint contract |
| UI (vitest) | `worca-ui/app/views/dashboard-fleet.test.js` | Fleet grouping renders header + aggregate progress + expand/collapse |

### Integration / E2E Tests

- **Synthetic 3-repo fleet (pytest fixture).** Scratch repos generated by the harness; fleet applies a trivial guide (`add HEALTH.md`); asserts 3 worktrees created (one per repo), 3 `pipelines.d/` entries with matching `fleet_id`, 3 branches, 3 PRs (mocked `gh`), fleet manifest status `completed`.
- **Playwright (`--workers=1`).** Launch a fleet via the UI, observe grouped progress on the dashboard, stop the fleet, verify `DELETE /api/fleet-runs/:id` halts unstarted children.
- **`--plan-first` happy path + failure path.** Reference Planner succeeds → fan-out; reference Planner fails → fleet halted before fan-out, manifest status `failed`.
- **Resume after partial failure.** Fleet of 3; mock one child to fail. `--resume` re-launches only the failed child; completed children untouched; `pipelines.d/` entries verified.

### Existing Tests to Update

- `tests/test_run_parallel.py` — import of `_slugify` moves from `run_parallel` to `utils.branch_naming`.
- W-048's `run_worktree.py` tests — add coverage for the new `--fleet-id` flag being written to `pipelines.d/` entries.

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
- **Fleet cost aggregation.** Sum per-child costs from `status.json` into the dashboard fleet header.
- **Partial retargeting.** `--resume` additionally accepts `--add-projects` so a fleet can expand mid-flight without starting over.
- **Cross-fleet templates.** A saved "fleet profile" (guide + plan + branch template + project list) re-launchable with one command — useful for recurring org-wide migrations.
- **Multi-repo coordination (Approach A).** Fleet infrastructure (`fleet_id` grouping, `ThreadPoolExecutor` dispatch, manifest, circuit breaker, `--resume`, UI grouping) serves as the foundation for coordinated multi-repo projects. A future "smart fleet" layer would add: a master planner that decomposes one prompt into per-repo sub-prompts, dependency ordering between children (DAG execution instead of parallel), a cross-repo integration test phase after children complete, and linked PR coordination. This extends fleet — it does not replace it.
