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

**Authority precedence — guide > plan > description.** When all three sources of intent are present, agents must treat the guide as authoritative, the plan as derived, and the description as task scope. The normative header in `attach_guide()` already encodes this for the guide-vs-description conflict ("treat any conflict between the guide and the task description as a bug in the task description"). Extend the same rule to plan-vs-guide: if a per-repo plan (from `--plan` or `--plan-first`) diverges from the guide on any normative point, the guide wins and the agent must surface the divergence rather than silently resolving it. Concretely:
- Planner stage: when both `--guide` and the task description are present, the Planner produces a plan that conforms to the guide. If the description requests something the guide forbids, the Planner reports the conflict.
- Implementer / Reviewer / Tester stages: if the plan tells them to do something the guide forbids, they must flag it via the standard review/tester channels rather than executing the plan.
- This precedence is documented in `CLAUDE.md` (Phase 1 task 4) and reinforced in `agents/core/planner.md`, `agents/core/reviewer.md`, and `agents/core/tester.md` instruction sections — wire those updates as part of Phase 1 alongside `attach_guide()`.

### 4. Branch-Name Templating

- **Current state:** `src/worca/scripts/run_parallel.py._slugify` derives branch names from the work-request title. A fleet shares one work-request, so all children would slug to the same branch.
- **Obstacle:** Collision across the fleet — indistinguishable PRs in GitHub's PR list.
- **Resolution:** `run_fleet.py` accepts `--branch <template>` with placeholders `{project}` (slugified basename), `{fleet_id}`, `{slug}`, `{yyyymmdd}`, `{yyyymmddhhmm}`. If no placeholder is present, `/{project}` is appended automatically. Slugification reuses `_slugify`, extracted into `src/worca/utils/branch_naming.py` for sharing. Post-substitution the full branch set is checked for uniqueness before any child launches; conflicts fail fast with the colliding pair reported.

### 5. Environment Isolation for Fleet Children

- **Current state:** Stage execution in `src/worca/orchestrator/runner.py` and the agent templates in `src/worca/agents/core/*.md` (planner.md, coordinator.md, implementer.md, tester.md, reviewer.md, guardian.md, learner.md, plan_reviewer.md) depend on `WORCA_AGENT` / `WORCA_STAGE` / `WORCA_RUN_ID` being set per-stage. The hook side enforces this in `src/worca/claude_hooks/pre_tool_use.py:65`. Children spawn as `subprocess.Popen`.
- **Obstacle:** Stale env vars from the parent (e.g., `WORCA_AGENT` from a launcher, or `CLAUDECODE=1` when launched from inside Claude Code) leak in and cause hooks to misclassify the child.
- **Resolution:** `run_fleet.py` builds a per-child env from `os.environ.copy()` then `env.pop()` on an explicit scrub list: `WORCA_AGENT`, `WORCA_STAGE`, `WORCA_RUN_ID`, `WORCA_PROJECT_ROOT`, `CLAUDECODE`. `WORCA_PROJECT_ROOT` must be scrubbed because the CWD-lock hook in `pre_tool_use.py:35` reads it to prefix all Bash commands with `cd $root &&` — if it inherits the fleet launcher's directory instead of the child's worktree path, every hook invocation in every child will misfire. Children set these vars themselves as stages fire.

### 6. Plan Stage Modes

- **Current state:** The Planner stage is dispatched by `src/worca/orchestrator/runner.py` using the prompt template at `src/worca/agents/core/planner.md`. The stage list itself lives in `src/worca/orchestrator/stages.py` (the `Stage` enum and `can_transition` helpers — there is no `stages/` package, just a single file). In a fleet without explicit plan handling, every child runs its own Planner.
- **Obstacle:** N projects produce N different strategies (defeating the point of a fleet) and burn N× Planner tokens.
- **Resolution:** Two flags:
  - `--plan <path>` (explicit): every child receives the same plan; Planner is skipped in every child. **Recommended for fleet work.**
  - `--plan-first [project-name]` (derived): a designated reference project runs Planner first; once its plan is written, the plan file is copied to a fleet-scoped temp directory (`~/.worca/fleet-runs/<fleet_id>/shared-plan.md`) and the remaining N−1 children launch with that plan attached via `--plan`. If no project name is given, the first in the `--projects` list is used. If the reference Planner fails, the fleet halts before fan-out.
  - Neither flag: warn and proceed with independent Planners.

### 7. Fleet-Level Circuit Breaker

- **Current state:** Per-pipeline circuit breaker logic lives in `src/worca/orchestrator/error_classifier.py:182-239` (`get_circuit_breaker_state`, `should_halt`, `get_retry_delay`); the `CircuitBreakerError` exception is in `src/worca/orchestrator/batch.py:16` (note: W-048 deletes `batch.py` and may move this exception into `error_classifier.py`); `runner.py` raises its own `CircuitBreakerTripped` (`runner.py:101`) for in-pipeline halt. All of these are per-pipeline only — there is no fleet-level circuit breaker.
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

### 13. UI Surface

W-040 introduces three first-class UX surfaces: a **fleet-aware dashboard** that groups runs by `fleet_id`, a **fleet detail view** that surfaces manifest + guide + token estimate + circuit-breaker state, and a **fleet launcher** that gates expensive launches behind a confirmation. Each is grounded in existing UI patterns (Shoelace components, the project's badge color language, and the `worca-ui/app/views/` view convention).

#### 13.1 Sidebar Navigation

- **New top-level entry:** "Fleet Runs" in `worca-ui/app/views/sidebar.js`, between "Runs" and "Settings". Hidden when no fleets exist (`GET /api/fleet-runs` returns `[]`); revealed automatically when the first fleet is created. Avoids navigation clutter for users who never use fleets.
- **Active-state styling** matches existing sidebar entries (Shoelace's selected variant + accent border).
- **No "Workspaces" entry yet** — that ships in W-047.

#### 13.2 Dashboard Fleet Grouping

- **File:** `worca-ui/app/views/dashboard.js` (extended) and `multi-dashboard.js` (extended for global view).
- **Rendering rule:** When iterating `runs-list`, group entries by `fleet_id` (presence is the trigger). Standalone runs (`fleet_id == null`) render as today.
- **Fleet group element structure:**
  ```html
  <div class="fleet-group" data-fleet-id="...">
    <div class="fleet-header">
      <sl-icon-button name="chevron-down" class="fleet-toggle"></sl-icon-button>
      <strong class="fleet-title">{work_request.title}</strong>
      <sl-badge variant="..." pill>{fleet_status}</sl-badge>
      <span class="fleet-progress">3/5 completed · 1 failed</span>
      <sl-progress-bar value="60" class="fleet-progress-bar"></sl-progress-bar>
      <sl-button size="small" class="fleet-detail-btn">Details</sl-button>
    </div>
    <div class="fleet-children">{child run cards rendered here}</div>
  </div>
  ```
- **Expand/collapse state** persists per-fleet in `localStorage` keyed by `fleet_id`. Default: expanded for `running`/`halted` fleets, collapsed for `completed`/`failed`.
- **Aggregate progress** = `completed_children / total_children` from the fleet manifest.
- **Status badge** on the fleet header maps the fleet's `status` field (see 13.7 for color mapping).
- **No clicks bubble** — clicking inside the fleet header only toggles or routes to detail view; clicking a child run card opens the standard run detail.

#### 13.3 Fleet Detail View

- **New file:** `worca-ui/app/views/fleet-detail.js`. Routed via `#/fleet-runs/:fleet_id`.
- **Layout (top-down):**
  1. **Header strip** — fleet title + status badge + breadcrumb back to dashboard.
  2. **Manifest panel** (`<sl-card>`) — readonly summary: branch template, plan mode, max parallel, circuit-breaker threshold, created-at timestamp.
  3. **Work request panel** — title + description (collapsible if long).
  4. **Guide panel** — shows `hasGuide`, `guideBytes`, `guideFilenames` from the runs-list payload (the sanitized fleet header data from §9). A "View guide content" button calls `GET /api/fleet-runs/:id/guide` and opens the content in a `<sl-dialog>` with markdown rendering. The fetch is opt-in to avoid pushing potentially-large guide content to every dashboard render.
  5. **Children grid** — one row per child: project name, status badge, branch, run-detail link, PR link (when present).
  6. **Circuit breaker strip** (visible only when fleet status is `halted`) — `<sl-alert variant="warning">` with the trip reason and a count of halted-but-unstarted children.
  7. **Actions** — depending on fleet status:
     - `running`: "Halt fleet" button → `DELETE /api/fleet-runs/:id` with a `<sl-dialog>` confirmation that explains in-flight children won't be killed.
     - `halted` / `failed`: "Resume fleet" button → posts to `POST /api/fleet-runs/:id/resume`, which calls `run_fleet.py --resume <fleet_id>`.
     - `completed`: "Open umbrella issue" link (if any), "Cleanup fleet" button → calls `worca cleanup --fleet-id <id>` via the cleanup endpoint added by W-048's pluggable cleanup-source design.
- **PR aggregation:** When all children have published PRs, the children grid surfaces them as `<sl-tag>` chips in a "PRs" column. A "Copy all PR URLs" button copies them as a markdown list to clipboard (handy for posting to chat).

#### 13.4 Fleet Launcher View

- **New file:** `worca-ui/app/views/fleet-launcher.js`. Routed via `#/fleet-runs/new`.
- **Form structure (top-down):**

  1. **Project multi-select.** A `<sl-select multiple clearable>` populated from `GET /api/projects` (registered projects in `~/.worca/projects.d/` from W-032). Each option shows project name + path. Above the select, a "Select all registered projects" button (toggles all) and a search/filter input that narrows options client-side.

  2. **Work request input.** Tab strip with two tabs: "Prompt" (a `<sl-textarea rows=6>`) and "Source" (an input for `gh:issue:N` etc.). Mirrors the existing single-run dialog's UX.

  3. **Guide upload.** A drop zone (`<div>` with drag-drop event handlers) and a "Browse" `<sl-button>`. Multiple files allowed. Each uploaded file shows as an `<sl-tag removable>` with filename + size. A live "Total guide size: 12.4 KB / 64 KB" readout sits below; turns warning-orange when within 80% of the cap, and danger-red + disables submit when over the cap.

  4. **Branch template input.** `<sl-input>` with placeholder `migration/v2/{project}` and helper text listing supported placeholders: `{project}`, `{fleet_id}`, `{slug}`, `{yyyymmdd}`, `{yyyymmddhhmm}`. Below the input, a **live preview panel** showing the resolved branch names for each currently-selected project. Updates as the user types. If two projects resolve to the same name, the colliding pair is highlighted in red and the submit button is disabled.

  5. **Plan mode toggle.** A `<sl-radio-group>` with three options:
     - **Use existing plan** (default off) → reveals a file path input. Maps to `--plan <path>`.
     - **Plan-first reference project** → reveals a `<sl-select>` choosing one of the selected projects as the reference. Maps to `--plan-first <project-name>`.
     - **Independent plans** → no input. Triggers a `<sl-alert variant="warning">` warning that each child runs its own Planner and the strategy may diverge.

  6. **Advanced options** (`<sl-details>` collapsed by default) — max parallel (`<sl-input type="number" value=5>`), circuit-breaker threshold (`<sl-range min="0" max="1" step="0.05" value="0.30">`).

  7. **Token-overhead gate.** Below the form, a **mandatory pre-launch panel** showing the estimated input-token overhead computed as `guide_tokens × prompt_stages × fleet_size` (matching the CLI estimate from §9). The launch button is labeled "Estimate cost" until the user clicks it. After clicking, the estimate appears and the button changes to "Launch fleet". When the estimate exceeds a configurable threshold (default 1M tokens of input overhead), a `<sl-checkbox>` "I understand the cost" must be checked before the button enables. Mirrors the CLI's `--yes` short-circuit semantics — provides a uniform gate across CLI and UI.

  8. **Submit** → `POST /api/fleet-runs` with the full payload. On success, navigate to `#/fleet-runs/:fleet_id` (the detail view).

#### 13.5 WebSocket Events

- **New event type:** `fleet-update` — emitted by the server when `~/.worca/fleet-runs/<fleet_id>.json` changes (server adds a watcher in Phase 4). Payload: `{ fleet_id, status, completed_children, failed_children, children: [{run_id, project_path, status}] }`. The dashboard fleet header subscribes to this event and updates aggregate progress + status badge in place — without requiring a `runs-list` round-trip.
- **`runs-list` event remains unchanged** — it carries `fleet_id` per run for grouping, but child status updates ride on `runs-list` as today. `fleet-update` only carries fleet-level state.
- **Protocol allowlist:** Add `'fleet-update'` to `worca-ui/app/protocol.js` allowlist.

#### 13.6 REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/fleet-runs` | Launch a new fleet. Body: `{ projects, prompt|source, guide_files, branch_template, plan_mode, max_parallel, fleet_failure_threshold }`. Multipart for guide upload. Returns `{ fleet_id, manifest_path }`. |
| `GET` | `/api/fleet-runs` | List all fleet manifests. Returns `[{ fleet_id, work_request, status, children_count, ... }]`. |
| `GET` | `/api/fleet-runs/:id` | Full manifest + enriched per-child status (joined from `pipelines.d/`). |
| `DELETE` | `/api/fleet-runs/:id` | Halt unstarted children. In-flight children continue. Returns `{ halted_count }`. |
| `POST` | `/api/fleet-runs/:id/resume` | Re-launch failed/pending children. Wraps `run_fleet.py --resume`. |
| `GET` | `/api/fleet-runs/:id/guide` | Returns concatenated guide content (opt-in, not in default payload). Content-Type: text/markdown. |
| `POST` | `/api/fleet-runs/estimate` | Pre-launch token estimate without launching. Body: subset of POST `/api/fleet-runs`. Returns `{ guide_bytes, guide_tokens_est, total_overhead_est }`. |

#### 13.7 Status Badge Color Mapping

Aligns new fleet states to the existing badge color language (`worca-ui/docs/badge-color-language.md`).

| Fleet status | Variant | Rationale |
|--------------|---------|-----------|
| `running` | `primary` (blue) | Active |
| `completed` | `success` (green) | All children succeeded |
| `failed` | `danger` (red) | All children failed or unrecoverable |
| `halted` | `warning` (orange) | Circuit breaker tripped — partial success, in-flight children may still be running. Caution, not failure. |

Per-child status (in fleet detail view's children grid) uses the existing pipeline-status mapping. New child-level state added by W-040:

| Child status | Variant | Rationale |
|--------------|---------|-----------|
| `setup_failed` | `danger` (red) | `worca init --upgrade` failed for this target — pipeline never started. |
| `pending` | `neutral` (grey) | Queued but not yet launched (e.g., gated behind circuit breaker). |

Update `worca-ui/app/styles.css` if any new CSS variables are needed; otherwise the variants above already map to existing colors.

#### 13.8 UI Test Coverage

| File | Coverage |
|------|----------|
| `worca-ui/app/views/dashboard-fleet.test.js` (new) | Fleet group renders header + aggregate progress + expand/collapse; localStorage persistence of expand state; status badge color mapping. |
| `worca-ui/app/views/fleet-detail.test.js` (new) | Renders manifest panel, guide opt-in fetch, children grid; halt button shows confirmation; resume button visible only on halted/failed; cleanup button visible only on completed. |
| `worca-ui/app/views/fleet-launcher.test.js` (new) | Project multi-select; tab switching prompt/source; guide upload tags + size readout; branch-template live preview; collision detection disables submit; plan-mode radio reveals correct sub-inputs; token-overhead gate requires "I understand" check above threshold. |
| `worca-ui/server/fleet-routes.test.js` (new) | All endpoints listed in 13.6 — contract + error paths (404, 409 on resume of running fleet, 400 on guide cap exceeded). |
| `worca-ui/app/views/sidebar.test.js` (extend) | "Fleet Runs" entry hidden when zero fleets, visible when fleets exist; auto-reveals on first fleet creation via `runs-list` mutation. |
| `worca-ui/app/views/sidebar-status-badges.test.js` (extend) | New `halted` and `setup_failed` badge color cases. |
| `worca-ui/test/ws-integration.test.js` (extend) | `fleet-update` event subscription and dashboard re-render. |
| `worca-ui/e2e/fleet-runs.spec.js` (new, Playwright `--workers=1`) | End-to-end: launch fleet, observe halted state, resume from UI, see PR aggregation. |

#### 13.9 Files Added/Touched for §13

| File | Change |
|------|--------|
| `worca-ui/app/views/sidebar.js` | "Fleet Runs" nav entry (conditional visibility) |
| `worca-ui/app/views/dashboard.js` | Fleet grouping renderer with expand/collapse |
| `worca-ui/app/views/multi-dashboard.js` | Fleet grouping for global multi-project view |
| `worca-ui/app/views/fleet-detail.js` | **New** — manifest, guide, children, actions |
| `worca-ui/app/views/fleet-launcher.js` | **New** — guided launch form with token gate |
| `worca-ui/app/protocol.js` | Add `'fleet-update'` to allowlist |
| `worca-ui/server/fleet-routes.js` | **New** — REST endpoints from 13.6 |
| `worca-ui/server/ws-modular.js` | Fleet manifest watcher; emits `fleet-update` |
| `worca-ui/app/styles.css` | Fleet group + launcher styles; halted/setup_failed CSS vars if needed |
| Tests above | **New / extended** |

## Implementation Plan

### Phase 1: Shared guide injection (foundation)

**Files:** `src/worca/orchestrator/work_request.py`, `src/worca/scripts/run_pipeline.py`, `src/worca/scripts/run_parallel.py`, `src/worca/scripts/run_worktree.py`, `src/worca/agents/core/planner.md`, `src/worca/agents/core/reviewer.md`, `src/worca/agents/core/tester.md`, `.claude/worca/settings.json`, `CLAUDE.md`

**Tasks:**
1. Add `attach_guide(wr, guide_paths)` in `work_request.py` with the normative header.
2. Add `worca.guide.max_bytes` default (64KB) to `settings.json`.
3. Wire `--guide PATH` (repeatable) into `run_pipeline.py`, `run_parallel.py`, `run_worktree.py`; call after `normalize(...)`.
4. Document precedence **guide > plan > description** in `CLAUDE.md`. The guide is the highest-authority normative material (matching the "treat any conflict between the guide and the task description as a bug" wording in the normative header). The plan is derived from the guide and the description; if the plan diverges from the guide, the guide wins. The description is task scope, expanded by both. When all three are present, agents must surface plan-vs-guide conflicts rather than silently resolving them.
5. Reinforce the precedence in the agent templates: add a "Guide precedence" instruction block to `planner.md`, `reviewer.md`, and `tester.md` that tells the agent (a) to conform to the guide, (b) to surface plan-vs-guide divergence rather than silently resolving it, (c) to treat description requests that conflict with the guide as bugs to flag.

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

### Phase 4: UI integration (see §13 for full surface)

**Files:** `worca-ui/server/fleet-routes.js` (new), `worca-ui/server/ws-modular.js`, `worca-ui/app/views/dashboard.js`, `worca-ui/app/views/multi-dashboard.js`, `worca-ui/app/views/sidebar.js`, `worca-ui/app/views/fleet-launcher.js` (new), `worca-ui/app/views/fleet-detail.js` (new), `worca-ui/app/protocol.js`, `worca-ui/app/styles.css`

**Tasks:**
1. Add fleet manifest file watcher to `ws-modular.js`; emit `fleet-update` events on manifest changes; add `'fleet-update'` to `app/protocol.js` allowlist.
2. Implement REST endpoints from §13.6: `POST/GET/DELETE /api/fleet-runs`, `GET /api/fleet-runs/:id`, `POST /api/fleet-runs/:id/resume`, `GET /api/fleet-runs/:id/guide`, `POST /api/fleet-runs/estimate`.
3. Fleet-grouping renderer in `dashboard.js` and `multi-dashboard.js` — group `runs-list` entries by `fleet_id`, render collapsible header with aggregate progress, persist expand state in localStorage.
4. Build `fleet-launcher.js` per §13.4 — project multi-select, guide upload, branch-template live preview, plan-mode toggle, token-overhead gate.
5. Build `fleet-detail.js` per §13.3 — manifest panel, guide opt-in viewer, children grid with PR aggregation, halt/resume/cleanup actions.
6. Add conditional "Fleet Runs" entry in `sidebar.js` (visible when fleets exist).
7. Wire badge color mapping for `halted`, `setup_failed`, `pending` (§13.7).

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
| `src/worca/agents/core/planner.md` | Add "Guide precedence" instruction (guide > plan > description) |
| `src/worca/agents/core/reviewer.md` | Add "Guide precedence" instruction; flag plan-vs-guide divergence |
| `src/worca/agents/core/tester.md` | Add "Guide precedence" instruction; treat guide-conflicting description as a bug |
| `.claude/worca/settings.json` | Add `worca.guide.max_bytes`, `worca.fleet.*` defaults |
| `worca-ui/server/fleet-routes.js` | **New** — fleet REST endpoints (§13.6) |
| `worca-ui/server/ws-modular.js` | Fleet manifest file watcher + `fleet-update` event |
| `worca-ui/app/views/dashboard.js` | Fleet grouping renderer (collapsible header, aggregate progress) |
| `worca-ui/app/views/multi-dashboard.js` | Fleet grouping in global multi-project view |
| `worca-ui/app/views/sidebar.js` | Conditional "Fleet Runs" nav entry |
| `worca-ui/app/views/fleet-launcher.js` | **New** — guided launch form with token gate (§13.4) |
| `worca-ui/app/views/fleet-detail.js` | **New** — manifest, guide, children grid, actions (§13.3) |
| `worca-ui/app/protocol.js` | Add `'fleet-update'` to event allowlist |
| `worca-ui/app/styles.css` | Fleet group + launcher styles; status color additions if needed |
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
