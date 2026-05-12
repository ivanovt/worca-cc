# W-040: Fleet Runs — Cross-Repository Fan-Out of a Single Work-Request

**Status:** Ready (plumbing partially landed; fleet runner unimplemented)
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-04-14 (revised 2026-04-25, refreshed 2026-05-11)
**Depends on:** W-032 (global multi-project worca-ui — `~/.worca/projects.d/` semantics, **shipped**), W-039 (workspace batch add projects — **soft dependency**, see note below), W-048 / #82 (worktree-based pipeline isolation — `pipelines.d/` registry, unified `discoverRuns`, `active_run` removal, **shipped 2026-04 — see commit cd0edc0**)

> **W-039 soft dependency.** The fleet launcher's project multi-select (§13.4) is populated from `GET /api/projects` (registered projects in `~/.worca/projects.d/`), which is a W-032 feature (**shipped**). W-039 adds *batch* project registration (scan a parent folder, register N subfolders at once) — a UX convenience that makes fleet launches more practical for users with many repos, but not a functional prerequisite. The fleet launcher works with whatever projects are already registered via the existing single-project "Add Project" flow. If W-039 has shipped by Phase 4, the launcher benefits automatically; if not, no code changes are blocked.

## Current Implementation Snapshot (2026-05-11)

Anchor every section's "Current state" claim against this snapshot — earlier drafts were written before W-048 landed, so several claims that say "W-048 introduces …" should now read "W-048 provides …" and a few "add this field" tasks are already done. The remaining work is the fleet runner itself (`run_fleet.py`), the `attach_guide()` function body, and the fleet-specific UI surface.

**Shipped (in tree today, no work needed):**
- `src/worca/orchestrator/registry.py::register_pipeline()` already accepts `fleet_id`, `workspace_id`, `group_type`, and `target_branch` (keyword-only) and enforces `fleet_id`/`workspace_id` mutual exclusion. `pipelines.d/` lives at `.worca/multi/pipelines.d/<run_id>.json`.
- `src/worca/scripts/run_worktree.py` accepts `--fleet-id` and `--guide` (forwarded to `run_pipeline.py` as absolute paths).
- `src/worca/scripts/run_pipeline.py` accepts `--guide` and imports `attach_guide` lazily, raising an `argparse.ArgumentError` referencing W-040 / #101 when the symbol is absent. The current-tree symbol is absent — the gate fires every time `--guide` is used.
- `src/worca/orchestrator/registry.py::reconcile_orphan_groups()` is a stub returning `[]`; W-040 must wire the manifest-existence check.
- `src/worca/cli/cleanup.py` has commented-out `FleetSource` / `WorkspaceSource` stubs (lines 196–207); uncomment + implement in this plan.
- `worca-ui/server/watcher.js` and `worca-ui/server/worktrees-routes.js` propagate `fleet_id` / `workspace_id` / `group_type` from registry entries into the `runs-list` payload.
- `worca-ui/app/views/worktrees.js` already implements the canonical fleet-grouping pattern (group by `group_type === "fleet"` + `fleet_id`, then render a header per group). **Dashboard §13.2 must reuse this pattern — extract shared helpers (`groupByFleet`, `fleetHeaderView`) into `worca-ui/app/views/group-rendering.js` rather than reimplementing.** `multi-dashboard.js` was removed during W-048 — every reference below to `multi-dashboard.js` now applies to `dashboard.js`.
- `src/worca/orchestrator/batch.py` was deleted; `CircuitBreakerTripped` lives in `runner.py:104`.

**Missing (the actual W-040 deliverable):**
- `src/worca/orchestrator/work_request.py::attach_guide()` — declared in tests and imported in `run_pipeline.py:220` but **not defined**; the ImportError gate fires today. Tests at `tests/test_run_pipeline.py:744-762` pin the current behavior and must be flipped (the gate test deleted, parser tests retained) when the function lands.
- `src/worca/scripts/run_parallel.py` does not have `--guide`; Phase 1 must wire it (and import the slugifier from `utils/branch_naming.py` once that module exists).
- `src/worca/utils/branch_naming.py` — does not exist; `_slugify` is duplicated in `run_parallel.py:35` and `run_worktree.py:76`.
- `src/worca/scripts/run_fleet.py` — does not exist; the core fleet runner is unimplemented.
- `src/worca/agents/core/{planner,reviewer,tester,guardian}.md` — no guide-precedence or fleet-PR instructions yet.
- `.claude/worca/settings.json` (and the bundled template) — no `worca.guide.max_bytes` or `worca.fleet.*` keys yet.
- UI: `fleet-routes.js`, `fleet-launcher.js`, `fleet-detail.js`, `launcher-shared.js` — none exist; `dashboard.js` has no fleet-grouping branch; `protocol.js` allowlist does not include `fleet-update`. `sidebar.js:177-185` renders the "New Pipeline" CTA as a plain `<button>` — not a dropdown; Phase 4 must convert it to `sl-dropdown` + `sl-menu` before adding the "New Fleet" option (§13.1).

This snapshot is normative for the rest of the document — when a §N "Current state" paragraph conflicts with it, this snapshot wins.

## Problem

There is no first-class way to apply a single work-request to many independent project repositories in parallel. Existing parallel runners are intra-repo only: `src/worca/scripts/run_parallel.py` and `src/worca/utils/git.py:create_pipeline_worktree` are built on `git worktree add`, which cannot span distinct `.git/` directories. W-048's `run_worktree.py` (replacing `run_multi.py`) launches isolated pipelines within a single repo via git worktrees — it cannot target a different repo. Users who want to roll a migration, compliance change, or repo-hygiene task across 5–20 registered projects must launch pipelines N times by hand, with no shared guide, no branch-template, no grouped observability in the dashboard, and no aggregate circuit breaker. Shared normative context (a migration guide, RFC, or spec) also has no pinning mechanism today: `src/worca/orchestrator/work_request.py` only carries a single `description`, and `CLAUDE.md` is the wrong lifecycle for per-run authoritative material.

## Proposal

Add a `run_fleet.py` entry point that accepts N target project paths, one prompt (or `--source`), an optional repeatable `--guide`, an optional `--plan`, and a `--branch <template>`, then launches N isolated pipelines — one per target repo — under a shared `fleet_id`. Each fleet child is dispatched via W-048's `run_worktree.py`, giving it worktree isolation within its target repo (the user's working tree is not dirtied). Per-project pipelines stay independent (own `.claude/worca/`, own branch, own PR) but register under the common `fleet_id` in W-048's `pipelines.d/` registry so the UI, CLI, and cleanup scripts treat the fleet as a single unit. A new `attach_guide()` helper in `work_request.py` prepends guide content to `description` under a normative header and is wired into every entry script (not fleet-only). A lightweight fleet manifest at `~/.worca/fleet-runs/<fleet_id>.json` tracks fleet-level state (status, circuit breaker, plan mode) while per-child pipeline state is tracked by `pipelines.d/` and `discoverRuns` — no parallel tracking system.

## Design

### 1. Cross-Repository Runner

- **Current state:** W-048 has shipped (commit `cd0edc0`). `src/worca/scripts/run_worktree.py` is the default single-pipeline launcher; it creates a git worktree within the current repo, copies `.claude/worca/` into it, registers in `.worca/multi/pipelines.d/<run_id>.json` via `register_pipeline()`, and spawns `run_pipeline.py --worktree` inside the worktree. The flags relevant to fleet dispatch (`--prompt`, `--source`, `--plan`, `--branch`, `--fleet-id`, `--guide`) are already wired and forwarded as absolute paths. `src/worca/scripts/run_parallel.py` handles intra-repo parallelism (and still owns its own `_slugify`). No entry point accepts N absolute project paths targeting distinct git repos.
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

**Confirmed `run_worktree.py` interface (as shipped in W-048 / #82):** `run_worktree.py` accepts `--prompt`/`--source`, `--plan <path>`, `--branch <name>` (= `target_branch` = base branch the worktree forks from and PR targets), `--fleet-id <id>`, `--guide <path>` (repeatable), `--msize`, `--mloops`, `--template`, `--param`, `--skip-preflight`. It registers in `pipelines.d/` via `register_pipeline(..., fleet_id=<id>, ...)` and spawns `run_pipeline.py --worktree` detached. `--fleet-id` and `--guide` already round-trip through to the child pipeline — `run_fleet.py` only needs to pass them through. `register_pipeline()` accepts `group_type` as a keyword arg today but `run_worktree.py` does not yet pass `group_type="fleet"`; W-040 must add that pass-through to satisfy §5's authoritative grouping contract.

**Authoritative grouping fields (binding contract from W-048 §5):** Fleet children are registered with `fleet_id=<id>` and `group_type="fleet"` ONLY. Never set `workspace_id` on a fleet child. UI code that filters fleet membership uses `fleet_id`; UI code that branches on rendering style uses `group_type`. **Never derive type from `fleet_id != null`** — see W-048 §5 for the full rule. This plan binds W-040 to that contract.

### 2. Target-Repo Runtime Provisioning

- **Current state:** `src/worca/cli/init.py` creates `.claude/worca/` on demand; target repos in a fleet may never have had `worca init` run.
- **Obstacle:** Without `.claude/worca/`, hooks, agent templates, and settings are missing and the pipeline cannot start. Manually running `worca init` N times is error-prone.
- **Resolution:** `run_fleet.py` calls `worca init <project_dir> --upgrade` for every target before launching. The `--upgrade` path is already non-destructive (preserves user `settings.json`, updates only worca-owned files under `.claude/worca/`, idempotent). Failures are marked `setup_failed` in the manifest; the fleet continues with the rest.

  **Per-target init timeout (default 60s):** A hung target (network slow, prompt waiting on user input that never comes, filesystem stuck) would block the entire fleet launch. Each `worca init --upgrade` invocation runs as a `subprocess` with `timeout=worca.fleet.init_timeout_seconds` (default 60). On timeout the child is marked `setup_failed` with a clear message ("init exceeded 60s — target may be unreachable") and the fleet continues with the rest. The timeout is configurable per fleet via `--init-timeout` and per-installation via `worca.fleet.init_timeout_seconds`.

  **UI Cancel during init phase:** The launcher (§13.4) disables the "Launch fleet" button immediately on submit and displays a per-target progress strip (`<sl-progress-bar>` row per target with status text — "queued" / "initializing" / "ready" / "setup_failed: <reason>"). A **"Cancel launch"** button below the strip aborts the in-flight init phase by killing all outstanding `worca init` subprocesses; targets already past init proceed (their child pipelines are already detached). The cancel signal is sent via `DELETE /api/fleet-runs/:id?stage=initializing` which the server resolves to "kill init subprocesses but leave dispatched children alone" — same shape as the post-launch halt, different effect.

  **Version compatibility:** `worca init --upgrade` overwrites hooks and agent templates but preserves `settings.json`. If the target repo used an older worca version with a different settings schema, the new hooks may expect keys that don't exist. To mitigate: add a `schema_version` field to `.claude/worca/settings.json`; `init --upgrade` performs schema migration (adds missing keys with defaults, warns about removed keys). The fleet manifest records the worca version used for provisioning.

### 3. Shared Reference-Context Mechanism

- **Current state:** `src/worca/orchestrator/work_request.py` carries a single `description`; `src/worca/orchestrator/prompt_builder.py` routes it into every stage's user-channel. There is no pinning mechanism for per-run normative context. The `--guide` flag has already been wired through `run_worktree.py` and `run_pipeline.py` as plumbing — `run_pipeline.py:218-229` accepts the flag, imports `attach_guide` lazily, and raises `argparse.ArgumentError` with a W-040 / #101 reference when the symbol is absent (which it is). `run_parallel.py` has no `--guide` plumbing yet.
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

Because `prompt_builder.py` already routes `wr.description` into every stage, no stage-level change is needed. The helper itself is the missing piece — once `attach_guide()` lands in `work_request.py`, the existing `--guide` plumbing in `run_pipeline.py` (line 220) starts working without further wiring; `run_parallel.py` still needs the flag added; `run_fleet.py` will be born with it. Once the function ships, delete the `argparse.ArgumentError` gate at `run_pipeline.py:218-229` and the corresponding `tests/test_run_pipeline.py::test_guide_flag_errors_without_attach_guide` test — both become unreachable.

**Path resolution:** `run_fleet.py` resolves all `--guide` paths to absolute paths before dispatching children. Guide paths are relative to the fleet launcher's CWD, not the child's. This is critical because children run with `cwd=project_dir` — a relative path like `./migration-spec.md` would fail to resolve in the child's context.

**Authority precedence — guide > plan > description.** When all three sources of intent are present, agents must treat the guide as authoritative, the plan as derived, and the description as task scope. The normative header in `attach_guide()` already encodes this for the guide-vs-description conflict ("treat any conflict between the guide and the task description as a bug in the task description"). Extend the same rule to plan-vs-guide: if a per-repo plan (from `--plan` or `--plan-first`) diverges from the guide on any normative point, the guide wins and the agent must surface the divergence rather than silently resolving it. Concretely:
- Planner stage: when both `--guide` and the task description are present, the Planner produces a plan that conforms to the guide. If the description requests something the guide forbids, the Planner reports the conflict.
- Implementer / Reviewer / Tester stages: if the plan tells them to do something the guide forbids, they must flag it via the standard review/tester channels rather than executing the plan.
- This precedence is documented in `CLAUDE.md` (Phase 1 task 4) and reinforced in `agents/core/planner.md`, `agents/core/reviewer.md`, and `agents/core/tester.md` instruction sections — wire those updates as part of Phase 1 alongside `attach_guide()`.

### 3.5. Guide Upload — Server-Side Storage Path

- **Current state:** §3's `attach_guide()` reads guide files from absolute paths supplied via CLI `--guide`. UI launcher (§13.4) uploads files via multipart. There is no defined server-side storage path, so the manifest's `guide.paths` field (§10) cannot reference UI uploads.
- **Obstacle:** Without a defined location, three failure modes exist:
  1. UI uploads land in OS temp and are GC'd before children read them → child dispatch fails.
  2. UI uploads land in `cwd` of the server process → may be a target repo, dirties working tree.
  3. CLI fleets and UI fleets store guides differently → the `guide.paths` field has incompatible semantics by source.
- **Resolution:** All UI-uploaded guides land in `~/.worca/fleet-runs/<fleet_id>/guides/<original-filename>` (sibling to the manifest at `~/.worca/fleet-runs/<fleet_id>.json` — see §10). The `POST /api/fleet-runs` endpoint (§13.6) handler:

  1. Generates `fleet_id` first.
  2. Creates `~/.worca/fleet-runs/<fleet_id>/guides/`.
  3. Streams each multipart file part into that directory, sanitizing filenames (strip path separators, allow only `[A-Za-z0-9._-]`, deduplicate by appending `-1`, `-2` on collision).
  4. Resolves each saved path to absolute (matching CLI `--guide` semantics).
  5. Calls `attach_guide()` size-cap validation **before** dispatching children.
  6. Writes the absolute paths into the manifest's `guide.paths` field.

  **CLI fleets unchanged:** When `run_fleet.py --guide /home/me/spec.md` is called from CLI, the absolute path goes straight into the manifest. The path may not be readable by the UI server later — see §13.3 for the "guide content not retrievable" UI fallback.

  **Cleanup:** The `~/.worca/fleet-runs/<fleet_id>/` directory (manifest + guides/) is removed by `worca cleanup --fleet-id <id>` via `FleetSource` (W-048 §12 pluggable cleanup). UI-uploaded guides do not leak.

  **Symmetry with W-047:** Workspace runs use `{workspace_root}/.worca/workspace-runs/<run_id>/guides/` (W-047 §7) — same convention, different root. UI's workspace launcher (W-047 §10.3) uses the same multipart pattern.

  **Disk quota:** Aggregate `~/.worca/fleet-runs/*/guides/` size is reported in the same UI surface as worktree disk (W-048 §13.3 disk strip — extend with a "Fleet/workspace artifacts: X MB" sub-line).

### 4. Branch-Name Templating and PR Base Branch

- **Current state:** `src/worca/scripts/run_parallel.py._slugify` derives branch names from the work-request title. A fleet shares one work-request, so all children would slug to the same branch. W-048 §10 introduces `target_branch` as the **PR base branch** (the branch the worktree forks from and `gh pr create --base` targets). `run_worktree.py` accepts `--branch <name>` for this. There is no fleet-level mechanism to set the base branch.
- **Obstacle:** Two distinct concepts share the word "branch":
  1. **Head branch** (per-child, the branch the agent commits to and pushes) — needs templating across the fleet to avoid PR collisions.
  2. **Base branch** (typically shared across the fleet, the target of every fleet PR) — needs to be settable so a fleet that lands on `dev` doesn't accidentally PR to `main`.

  W-040's original design only addressed (1) and silently defaulted (2) to each repo's default branch. That's correct for most fleets but invisible to users — and impossible to override.
- **Resolution:** Two separate flags on `run_fleet.py` with non-overlapping semantics:

  | Flag | Concept | Maps to | Default |
  |------|---------|---------|---------|
  | `--head-template <template>` | Per-child head branch name | `run_worktree.py` derived branch name (head) | `migration/{slug}/{project}` |
  | `--base <name>` | PR base branch (shared across fleet) | `run_worktree.py --branch <name>` (= W-048 `target_branch`) | Each repo's default branch (resolved per-child via `git symbolic-ref refs/remotes/origin/HEAD`) |

  **No `--branch` alias.** The flag string `--branch` is reserved by `run_worktree.py` (W-048 §10) where it means **base branch** — the same string used for `run_fleet.py` would have to mean **head template**. Carrying a deprecated alias for `--head-template` would create a flag-string collision that fails silently when scripts are copy-pasted between worktree and fleet contexts (a user typing `run_fleet.py --branch dev` thinking it sets the base would actually set the head template). Since W-040 is a new entry point with no existing users, the alias has no real backwards-compat benefit. `run_fleet.py` rejects `--branch` at argparse time with the message:

  ```
  --branch is not a valid flag for run_fleet.py. You probably want one of:
    --base <name>             PR base branch (= run_worktree.py --branch)
    --head-template <tmpl>    Per-child head branch name template
  See W-040 §4 for the distinction.
  ```

  This forces every fleet invocation to be explicit and eliminates the cross-script flag-meaning collision flagged in the plan-set review.

  **Head-template placeholders** (unchanged from prior design): `{project}` (slugified basename), `{fleet_id}`, `{slug}`, `{yyyymmdd}`, `{yyyymmddhhmm}`. If no placeholder is present, `/{project}` is appended automatically. Slugification reuses `_slugify`, extracted into `src/worca/utils/branch_naming.py` for sharing. Post-substitution the full head-branch set is checked for uniqueness before any child launches; conflicts fail fast with the colliding pair reported.

  **Base branch resolution:** When `--base` is set, every child's `run_worktree.py --branch <base>` receives the same value, and the fleet's pre-flight verifies the base branch exists in **every** target repo (`git -C <target> branch --list <base>`). Missing-in-some-repos fails fast with the list of repos lacking the branch. When `--base` is omitted, each child resolves its own default branch independently — a heterogeneous fleet (some repos default to `main`, some to `master`) "just works" without per-repo configuration.

  **Manifest schema** adds `base_branch: string | null` (§10) and renames `branch_template` → `head_template` (with backward-compatible read). UI launcher (§13.4) collects both as separate inputs.

### 5. Environment Isolation for Fleet Children

- **Current state:** Stage execution in `src/worca/orchestrator/runner.py` and the agent templates in `src/worca/agents/core/*.md` (planner.md, coordinator.md, implementer.md, tester.md, reviewer.md, guardian.md, learner.md, plan_reviewer.md) depend on `WORCA_AGENT` / `WORCA_RUN_ID` being set per-stage. The hook side enforces this in `src/worca/claude_hooks/pre_tool_use.py:65`. Children spawn as `subprocess.Popen`.
- **Obstacle:** Stale env vars from the parent (e.g., `WORCA_AGENT` from a launcher, or `CLAUDECODE=1` when launched from inside Claude Code) leak in and cause hooks to misclassify the child.
- **Resolution:** `run_fleet.py` uses the authoritative `RESERVED_ENV_KEYS` frozenset and `RESERVED_PREFIXES` tuple from `src/worca/utils/env.py` to scrub per-child environments — **not a hand-maintained parallel list**. Concretely: `run_fleet.py` imports `RESERVED_ENV_KEYS` and `RESERVED_PREFIXES` from `worca.utils.env`, builds a per-child env from `os.environ.copy()`, then strips any key that is in `RESERVED_ENV_KEYS` or matches any `RESERVED_PREFIXES` entry (currently `WORCA_*`). This covers all pipeline-internal keys: `WORCA_AGENT`, `WORCA_RUN_ID`, `WORCA_PROJECT_ROOT`, `WORCA_RUN_DIR`, `WORCA_PLAN_FILE`, `WORCA_EVENTS_PATH`, `WORCA_TARGET_BRANCH`, `WORCA_COVERAGE`, `WORCA_SKIP_BEADS`, `WORCA_CLAUDE_BIN`, `CLAUDECODE`, and `PATH` (which `get_env()` rebuilds per-child anyway). Children set these vars themselves as stages fire via `get_env()`.

  **Why a single source of truth matters:** `env.py` already maintains `RESERVED_ENV_KEYS` for `filter_model_env()` (used to sanitize per-model env overrides from `settings.json`). Maintaining a parallel scrub list in `run_fleet.py` would invite drift — the plan's original list of 5 keys was already missing 7 keys that `env.py` covers (e.g., `WORCA_RUN_DIR`, `WORCA_PLAN_FILE`, `WORCA_EVENTS_PATH`). By importing from `env.py`, any future key additions automatically apply to fleet child scrubbing.

  **`WORCA_PROJECT_ROOT` specifically** must be scrubbed because the CWD-lock hook in `pre_tool_use.py:35` reads it to prefix all Bash commands with `cd $root &&` — if it inherits the fleet launcher's directory instead of the child's worktree path, every hook invocation in every child will misfire.

### 6. Plan Stage Modes

- **Current state:** The Planner stage is dispatched by `src/worca/orchestrator/runner.py` using the prompt template at `src/worca/agents/core/planner.md`. The stage list itself lives in `src/worca/orchestrator/stages.py` (the `Stage` enum and `can_transition` helpers — there is no `stages/` package, just a single file). In a fleet without explicit plan handling, every child runs its own Planner.
- **Obstacle:** N projects produce N different strategies (defeating the point of a fleet) and burn N× Planner tokens.
- **Resolution:** Two flags:
  - `--plan <path>` (explicit): every child receives the same plan; Planner is skipped in every child. **Recommended for fleet work.**
  - `--plan-first [project-name]` (derived): a designated reference project runs Planner first; once its plan is written, the plan file is copied to a fleet-scoped temp directory (`~/.worca/fleet-runs/<fleet_id>/shared-plan.md`) and the remaining N−1 children launch with that plan attached via `--plan`. If no project name is given, the first in the `--projects` list is used. If the reference Planner fails, the fleet halts before fan-out.
  - Neither flag: warn and proceed with independent Planners.

### 7. Fleet-Level Circuit Breaker

- **Current state:** Per-pipeline circuit breaker logic lives in `src/worca/orchestrator/error_classifier.py:182-239` (`get_circuit_breaker_state`, `should_halt`, `get_retry_delay`); `batch.py` has been deleted by W-048 and the `CircuitBreakerTripped` exception now lives in `runner.py:104`. All of these are per-pipeline only — there is no fleet-level circuit breaker.
- **Obstacle:** A systematic issue (bad guide, bad plan, missing tool) that fails the first 5 children will still burn through the remaining 15.
- **Resolution:** Add `fleet_failure_threshold` (default 30%) to fleet config. The `run_fleet.py` main loop tracks completed children; when `failed / completed >= threshold` and `completed >= min(3, total)`, unstarted children are cancelled and the fleet manifest is marked `halted` with `halt_reason = "circuit_breaker"`. In-flight children finish naturally — fleet-halt does not kill running subprocesses, avoiding half-written repo states.

  **Dispatch strategy:** Do not submit all children to `ThreadPoolExecutor` at once — eagerly queued futures cannot be reliably cancelled. Instead, use a manual dispatch loop: maintain a set of in-flight futures (up to `--max-parallel`), check the circuit breaker before submitting each new child, and skip remaining children if the threshold is reached. This ensures the breaker can actually prevent unstarted children from launching.

  **`halt_reason` discrimination — user halt vs circuit-breaker halt.** A `halted` fleet has two distinct origins that the UI must distinguish:

  | `halt_reason` | Set when | Manifest origin | UI signal |
  |---------------|----------|-----------------|-----------|
  | `"user"` | Operator clicks "Halt fleet" in UI or runs `DELETE /api/fleet-runs/:id` from CLI | `DELETE` handler writes it | Header badge: `neutral` variant ("Halted by you") — no orange "needs attention" |
  | `"circuit_breaker"` | Auto-triggered by failure threshold | `run_fleet.py` writes it on threshold trip | Header badge: `warning` variant ("Halted by circuit breaker — N failures across M children") — orange |
  | `null` (legacy) | Pre-W-040 manifest or unknown origin | n/a | Defaults to `warning` for safety |

  Both states use `status: "halted"` in the manifest — `halt_reason` is a sibling field that does not change lifecycle semantics (resume / cleanup behave identically). Only the UI render differs. The badge color differentiation is documented in §13.7 below.

### 8. Registry Integration via `pipelines.d/`

- **Current state:** W-048 shipped `.worca/multi/pipelines.d/*.json` as the per-pipeline registry. Each entry tracks `run_id`, `worktree_path`, and status. `discoverRuns` in `worca-ui/server/watcher.js` fans out across these entries to discover all concurrent runs and already passes `fleet_id` / `workspace_id` / `group_type` through to `runs-list` (see `watcher.js:160` and `worktrees-routes.js:331+`). The UI's `WatcherSet` watches `pipelines.d/` for changes and broadcasts run updates automatically. `register_pipeline()` already accepts `fleet_id`, `workspace_id`, `group_type`, and `target_branch` as keyword-only arguments and enforces `fleet_id`/`workspace_id` mutual exclusion (registry.py:48-98). `run_worktree.py` already accepts `--fleet-id` and passes it through.
- **Obstacle:** The registry has the grouping fields but no fleet manifest exists to back them — children registered with a `fleet_id` today would be orphans (`reconcile_orphan_groups()` would strip them once it learns to look for manifests). `run_worktree.py` does not yet pass `group_type="fleet"` even when `--fleet-id` is set.
- **Resolution:** No registry signature changes needed — only a small `run_worktree.py` patch that passes `group_type="fleet"` to `register_pipeline()` when `--fleet-id` is set. The bulk of this section is now about **wiring the existing grouping fields into the dashboard UI** (the worktrees view already does this — see §13.2). The UI groups runs by `fleet_id` AND `group_type === "fleet"` (per W-048 §5 — never derive type from `fleet_id != null`):
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
  "fleet_id_short": "<rand>",
  "created_at": "<iso8601>",
  "work_request": { "title": "...", "description": "...", "source": "..." },
  "guide": { "paths": ["..."], "bytes": 12345, "filenames": ["..."], "uploaded": true },
  "plan": { "mode": "explicit|plan-first|none", "path": "..." },
  "head_template": "migration/v2/{project}",
  "base_branch": "main",
  "max_parallel": 5,
  "fleet_failure_threshold": 0.30,
  "status": "running|halted|completed|failed",
  "halt_reason": "user|circuit_breaker|null",
  "children": [
    {
      "project_path": "/abs/path",
      "project_slug": "proj",
      "head_branch": "migration/v2/proj",
      "base_branch": "main",
      "run_id": "r_..."
    }
  ]
}
```

Field notes:
- `head_template` / `head_branch` replace the prior `branch_template` / `branch` — clarifies these are head-branch concepts (per §4). Old field names are preserved on read for one minor release for backward compat.
- `base_branch` (top-level) is the fleet-wide PR base. `null` means "each child resolves its own default branch" (§4 default).
- `children[].base_branch` is the resolved per-child base (may differ from top-level when top-level is null and per-child defaults differ).
- `guide.uploaded: true` indicates the guide files live under `~/.worca/fleet-runs/<fleet_id>/guides/` (§3.5); `false` means CLI-supplied absolute paths (which may not be readable by the UI server — see §13.3 fallback).
- `halt_reason` is set when `status` transitions to `halted`. Values: `"user"` (operator-initiated halt), `"circuit_breaker"` (failure threshold trip per §7), or `null` (status is not `halted`, or legacy pre-W-040 manifest). The UI uses this to pick the badge variant (§13.7) — `circuit_breaker` is orange/warning, `user` is grey/neutral.
- Per-child `status`, `started_at`, `completed_at`, and `returncode` are NOT in the manifest — they are read from `pipelines.d/` entries and `status.json` at query time. The `children` array is a lightweight index mapping `run_id` to `project_path` for fleet-scoped queries.

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

- **Layout follows W-048 §13.7** (binding contract): flat siblings under the existing "Pipeline" section. W-040 adds a "Fleets" entry between `Worktrees` (added by W-048) and the future `Workspaces` slot (added by W-047).
- **Conditional visibility:** Hidden when `GET /api/fleet-runs` returns `[]`; revealed automatically when the first fleet is created. Same pattern as W-048's "Worktrees" entry.
- **Count badge:** `<sl-badge variant="primary" pill>` showing active fleet count (status `running`); flips to `warning` variant when at least one fleet is `halted`. Matches existing convention for Pipeline > Running.
- **"+ New Pipeline" CTA → dropdown conversion.** The current sidebar (`sidebar.js:177-185`) renders a plain `<button class="sidebar-new-run-btn">` with a single `@click` handler — there is no dropdown, no `sl-menu`, and no option-insertion point. W-048 §13.7 planned but did not ship a dropdown. **Phase 4 must first convert this button into an `<sl-dropdown>` + `<sl-menu>` with "New Pipeline" (existing behavior) and "New Fleet" (routes to `#/fleet-runs/new`) as menu items** before the fleet option can be added. The dropdown trigger retains the existing `.sidebar-new-run-btn` class and `Plus` icon for visual continuity; the menu appears on click. W-047 later adds "New Workspace" as a third item — the dropdown structure accommodates this without further refactoring.
- **No nesting** — flat siblings only. The earlier W-047 "Multi-Repo > Workspaces" nesting proposal is superseded by W-048 §13.7.
- **Active-state styling** matches existing sidebar entries (Shoelace's selected variant + accent border).

#### 13.2 Dashboard Fleet Grouping

- **File:** `worca-ui/app/views/dashboard.js` (extended — `multi-dashboard.js` was rolled into `dashboard.js` during W-048; cross-project rendering lives in `dashboard.js` today, exercised by `dashboard-multiproject.test.js`).
- **Reuse:** `worca-ui/app/views/worktrees.js` already implements fleet grouping (see `worktrees.js:21,284-286` for `group_type === "fleet"` + `fleet_id` bucketing). Phase 4 extracts the shared helpers (`groupByFleet`, `fleetHeaderView`, status-badge color resolver) into `worca-ui/app/views/group-rendering.js` and consumes them from both `dashboard.js` and `worktrees.js`. Do not reimplement.
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
     - **Fallback for unreachable CLI guides:** When the fleet was launched from CLI with `--guide /path/from/dev/machine.md` (`guide.uploaded === false` in manifest, see §3.5), the server may not have read access to the path (different user, different machine via shared FS, file moved). On `ENOENT` or `EACCES`, return `404` with body `{ ok: false, error: "guide_not_retrievable", hint: "Guide was supplied via CLI from a path the UI server cannot read. View the original file on the launching machine." }`. UI surfaces this hint inline in the dialog instead of a generic error toast.
  5. **Children grid** — one row per child: project name, status badge, **base branch**, **head branch**, run-detail link, PR link (when present), per-child cost (computed from child's `status.json` cost rollup).
  6. **Aggregate cost panel** — `<sl-card>` showing fleet-total input/output token spend and dollar cost, summed from each child's `status.json` cost data (same shape `dashboard.js:14-24` already computes per project). **Refreshes** on `runs-list` update. Closes the visibility gap a 20-repo fleet would otherwise leave.
  7. **Circuit breaker strip** (visible only when fleet status is `halted`) — `<sl-alert variant="warning">` with the trip reason and a count of halted-but-unstarted children.
  8. **Actions** — depending on fleet status (verbs aligned with W-048 §13.3 / W-047 §10.5 — single "Cleanup" verb across all artifact-removal surfaces):
     - `running`: **"Halt fleet"** button → `DELETE /api/fleet-runs/:id` with a `<sl-dialog>` confirmation that explains in-flight children won't be killed. Tooltip: "Cancels unstarted children. In-flight children finish."
     - `halted` / `failed`: **"Resume fleet"** button → posts to `POST /api/fleet-runs/:id/resume`, which calls `run_fleet.py --resume <fleet_id>`.
     - `completed` / `halted` / `failed`: **"Cleanup fleet"** button → calls `DELETE /api/fleet-runs/:id?cleanup=1` which invokes `worca cleanup --fleet-id <id>` (W-048's pluggable cleanup via `FleetSource`). Confirmation lists per-child worktree disk to free + the manifest dir + `~/.worca/fleet-runs/<id>/guides/` size. **For `halted`/`failed` fleets**, the confirmation includes "Cleanup will block any future `--resume` attempt for this fleet — child worktrees and the shared plan are removed." with explicit `<sl-checkbox>` "I understand resume will be unavailable" requirement (mirrors W-048 §13.3 resume-aware deletion).
     - `completed` with umbrella issue: **"Open umbrella issue"** link.
     - **"Re-run fleet"** button (always visible when status is terminal) → opens `fleet-launcher.js` pre-filled from this manifest (projects, prompt, guide, base, head_template). Lets users reapply the same fleet definition to a new run without re-typing.
- **PR aggregation:** When all children have published PRs, the children grid surfaces them as `<sl-tag>` chips in a "PRs" column. A "Copy all PR URLs" button copies them as a markdown list to clipboard (handy for posting to chat).

#### 13.4 Fleet Launcher View

- **New file:** `worca-ui/app/views/fleet-launcher.js`. Routed via `#/fleet-runs/new`.
- **Shared subcomponent extraction (binding architectural decision).** The launcher's reusable subcomponents — multipart guide upload widget, head-template input with collision preview, plan-mode radio shell, token-overhead gate — are extracted into `worca-ui/app/views/launcher-shared.js` **as part of this plan, not deferred to W-047**. Even though `fleet-launcher.js` is the only consumer at W-040 ship time, the shared module establishes the API W-047's workspace-launcher mode (W-047 §10.3) extends. Doing the extraction here avoids a refactor of just-shipped W-040 code when W-047 lands. The exports:

  ```javascript
  // worca-ui/app/views/launcher-shared.js
  export function guideUploadWidget(state, { onChange, maxBytes }) { ... }
  export function headTemplateInput(state, { selectedProjects, onChange }) { ... }
  export function planModeRadio(state, { options, onChange }) { ... }
  export function tokenOverheadGate(state, { estimateFn, threshold }) { ... }
  ```

  `fleet-launcher.js` composes these. W-047 §10.3 reuses the same exports plus adds workspace-only widgets (DAG preview, master-planner option) on top.

- **Form structure (top-down):**

  1. **Project multi-select.** A `<sl-select multiple clearable>` populated from `GET /api/projects` (registered projects in `~/.worca/projects.d/` from W-032). Each option shows project name + path. Above the select, a "Select all registered projects" button (toggles all) and a search/filter input that narrows options client-side.

  2. **Work request input.** Tab strip with two tabs: "Prompt" (a `<sl-textarea rows=6>`) and "Source" (an input for `gh:issue:N` etc.). Mirrors the existing single-run dialog's UX.

  3. **Guide upload.** A drop zone (`<div>` with drag-drop event handlers) and a "Browse" `<sl-button>`. Multiple files allowed. Each uploaded file shows as an `<sl-tag removable>` with filename + size. A live "Total guide size: 12.4 KB / 64 KB" readout sits below; turns warning-orange when within 80% of the cap, and danger-red + disables submit when over the cap.

  4. **Branch inputs (two fields side-by-side, see §4 for semantics):**
     - **Head branch template.** `<sl-input>` with placeholder `migration/v2/{project}` and helper text listing supported placeholders: `{project}`, `{fleet_id}`, `{slug}`, `{yyyymmdd}`, `{yyyymmddhhmm}`. Submits as `head_template`. Below the input, a **live preview panel** showing the resolved branch names for each currently-selected project. Updates as the user types. If two projects resolve to the same name, the colliding pair is highlighted in red and the submit button is disabled.
     - **PR base branch.** `<sl-input>` with placeholder `main` and helper text "Branch the worktrees fork from and PRs target. Leave blank to use each repo's default branch." Submits as `base_branch` (null when blank). When set, a server pre-flight call (`POST /api/fleet-runs/validate-base`) confirms the branch exists in **every** selected project; missing-in-some-repos shows the list and disables submit. **This input mirrors W-048 §13.2's per-run dialog** so the UX is consistent across single-run and fleet-run launchers.

  5. **Plan mode toggle.** A `<sl-radio-group>` with three options:
     - **Use existing plan** (default off) → reveals a file path input. Maps to `--plan <path>`.
     - **Plan-first reference project** → reveals a `<sl-select>` choosing one of the selected projects as the reference. Maps to `--plan-first <project-name>`.
     - **Independent plans** → no input. Triggers a `<sl-alert variant="warning">` warning that each child runs its own Planner and the strategy may diverge.

  6. **Advanced options** (`<sl-details>` collapsed by default) — max parallel (`<sl-input type="number" value=5>`), circuit-breaker threshold (`<sl-range min="0" max="1" step="0.05" value="0.30">`).

  7. **Token-overhead gate.** Below the form, a **mandatory pre-launch panel** showing the estimated input-token overhead computed as `guide_tokens × prompt_stages × fleet_size` (matching the CLI estimate from §9). The launch button is labeled "Estimate cost" until the user clicks it. After clicking, the estimate appears and the button changes to "Launch fleet". When the estimate exceeds a configurable threshold (default 1M tokens of input overhead), a `<sl-checkbox>` "I understand the cost" must be checked before the button enables. Mirrors the CLI's `--yes` short-circuit semantics — provides a uniform gate across CLI and UI.

  8. **Submit** → `POST /api/fleet-runs` with the full payload. On success, navigate to `#/fleet-runs/:fleet_id` (the detail view).

#### 13.5 WebSocket Events

- **New event type:** `fleet-update` — emitted by the server when `~/.worca/fleet-runs/<fleet_id>.json` changes (server adds a watcher in Phase 4). Payload: `{ fleet_id, status, completed_children, failed_children, children: [{run_id, project_path, status}] }`. The dashboard fleet header subscribes to this event and updates aggregate progress + status badge in place — without requiring a `runs-list` round-trip.
- **Workspace events stay separate.** W-047 introduces `workspace-update` (its own event type) for `~/.worca/workspace-runs/<id>.json` manifest changes. **`fleet-update` carries fleet-manifest payloads only.** This rule replaces an earlier proposal in W-047 §10.9 to multiplex both manifest types over `fleet-update` distinguished by a `workspace_id` field — that approach was rejected here because it forced every consumer to inspect a sibling field. Categorical event types match the protocol's existing pattern (one event type = one server-side source).
- **`runs-list` event remains unchanged** — it carries `fleet_id` per run for grouping, but child status updates ride on `runs-list` as today. `fleet-update` only carries fleet-level state.
- **Protocol allowlist:** Add `'fleet-update'` to `worca-ui/app/protocol.js` allowlist. (W-047 adds `'workspace-update'` separately.)

#### 13.6 REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/fleet-runs` | Launch a new fleet. Body (multipart): `{ projects, prompt|source, guide_files (parts), head_template, base_branch, plan_mode, max_parallel, fleet_failure_threshold }`. Server side: generates `fleet_id`, saves uploaded guides under `~/.worca/fleet-runs/<fleet_id>/guides/` (§3.5), validates size cap, dispatches. Returns `{ fleet_id, manifest_path }`. |
| `POST` | `/api/fleet-runs/validate-base` | Pre-flight check that a `base_branch` value exists in every selected project. Body: `{ projects, base_branch }`. Returns `{ ok, missing_in: [project_path...] }`. Used by the launcher to gate submit (§13.4). |
| `GET` | `/api/fleet-runs` | List all fleet manifests. Returns `[{ fleet_id, work_request, status, children_count, base_branch, total_cost_usd, ... }]`. |
| `GET` | `/api/fleet-runs/:id` | Full manifest + enriched per-child status (joined from `pipelines.d/`) + aggregate cost rollup. |
| `DELETE` | `/api/fleet-runs/:id` | Halt unstarted children. In-flight children continue. Returns `{ halted_count }`. With `?cleanup=1` query param (§13.3 Cleanup fleet button), additionally invokes `worca cleanup --fleet-id <id>` after halt completes; returns `{ halted_count, cleaned_worktrees, freed_bytes }`. Returns 412 (Precondition Failed) without `?force=1` if the fleet is in `halted`/`failed` state — UI sets `force=1` after the user confirms the resume-loss warning. |
| `POST` | `/api/fleet-runs/:id/resume` | Re-launch failed/pending children. Wraps `run_fleet.py --resume`. Returns 410 (Gone) if any child's worktree was previously cleaned (resume impossible). |
| `POST` | `/api/fleet-runs/:id/relaunch` | "Re-run fleet" action (§13.3). Body: optional overrides for `prompt`, `head_template`, `base_branch`. Returns `{ new_fleet_id }`. Implementation: read this manifest, apply overrides, POST to `/api/fleet-runs` internally. |
| `GET` | `/api/fleet-runs/:id/guide` | Returns concatenated guide content (opt-in, not in default payload). Content-Type: text/markdown. **404 with `error: "guide_not_retrievable"`** when CLI-supplied paths are unreadable (see §13.3 fallback). |
| `POST` | `/api/fleet-runs/estimate` | Pre-launch token estimate without launching. Body: subset of POST `/api/fleet-runs`. Returns `{ guide_bytes, guide_tokens_est, total_overhead_est }`. |

#### 13.7 Status Badge Color Mapping

Aligns new fleet states to the existing badge color language (`worca-ui/docs/badge-color-language.md`).

| Fleet status | `halt_reason` | Variant | Rationale |
|--------------|---------------|---------|-----------|
| `running` | n/a | `primary` (blue) | Active |
| `completed` | n/a | `success` (green) | All children succeeded |
| `failed` | n/a | `danger` (red) | All children failed or unrecoverable |
| `halted` | `circuit_breaker` | `warning` (orange) | Circuit breaker tripped — partial success, system needs attention. |
| `halted` | `user` | `neutral` (grey) | Operator halted intentionally — informational, no action needed. |
| `halted` | `null` (legacy) | `warning` (orange) | Pre-W-040 manifest or unknown reason — default to caution. |

The badge label also changes by reason: `Halted` (user) vs `Halted (circuit breaker)` (auto). Tooltip on the header badge expands to "Halted by you on `<timestamp>`" or "Halted automatically: `<N>` of `<M>` children failed".

Per-child status (in fleet detail view's children grid) uses the existing pipeline-status mapping. New child-level states added by W-040:

| Child status | Variant | Rationale |
|--------------|---------|-----------|
| `setup_failed` | `danger` (red) | `worca init --upgrade` failed for this target — pipeline never started. |
| `pending` | `neutral` (grey) | Queued but not yet launched (e.g., gated behind circuit breaker). |

**Required call-site extensions per W-048 §13.4 binding contract.** Each new status value (`halted`, `setup_failed`, `pending`) must be added to all three render call sites:

1. `worca-ui/app/utils/state-actions.js` — extend `STATES` and `ACTION_MATRIX`:
   - `halted`: allows `resume`, `cancel`, `archive`, `delete`, `learn`. Disallows `pause`, `stop` (already halted), `unarchive`.
   - `setup_failed`: allows `cancel`, `archive`, `delete`. Disallows resume — `worca init` failed before the pipeline started, so there's nothing to resume; user must re-launch the fleet.
   - `pending`: allows `cancel`, `delete`. Disallows everything else (no PID exists yet).
2. `worca-ui/app/utils/status-badge.js` — extend `CLASS_MAP` and `ICON_DATA` with the new statuses. `CLASS_MAP` maps status strings to CSS class names using the existing `status-*` convention:
   - `halted: 'status-halted'`
   - `setup_failed: 'status-setup-failed'`
   - `unrecoverable: 'status-unrecoverable'`
   (`pending` is already present in `CLASS_MAP`.)
   `ICON_DATA` gets matching icon entries (e.g., `halted` → `CircleSlash`, `setup_failed` → `CircleAlert`, `unrecoverable` → `CircleAlert`).
3. `worca-ui/app/styles.css` — add entries following the existing `status-*` convention (both badge colors and run-card border styling):
   - `.status-halted { color: var(--status-paused); }` + `.run-card.status-halted { border-left: 3px solid var(--status-paused); }`
   - `.status-setup-failed { color: var(--status-failed); }` + `.run-card.status-setup-failed { border-left: 3px solid var(--status-failed); }`
   - `.status-unrecoverable { color: var(--status-failed); }` + `.run-card.status-unrecoverable { border-left: 3px solid var(--status-failed); }`
   **No new CSS variables** — reuse existing color variables to match the badge variants above. The `status-*` prefix is the codebase's established convention (see `CLASS_MAP` in `status-badge.js` and the existing `.status-running`, `.status-failed`, etc. rules in `styles.css`). Do **not** introduce a parallel `pipeline-*` naming system.

The same triple is enforced in W-047 §10.7 for workspace-specific statuses.

#### 13.8 UI Test Coverage

| File | Coverage |
|------|----------|
| `worca-ui/app/views/dashboard-fleet.test.js` (new) | Fleet group renders header + aggregate progress + expand/collapse; localStorage persistence of expand state; status badge color mapping. |
| `worca-ui/app/views/fleet-detail.test.js` (new) | Renders manifest panel, guide opt-in fetch, children grid; halt button shows confirmation; resume button visible only on halted/failed; **Cleanup fleet** button visible on completed/halted/failed; resume-loss warning + checkbox required for halted/failed cleanup; aggregate cost panel renders sum of child costs; "Re-run fleet" pre-fills launcher with manifest values; guide-not-retrievable fallback message. |
| `worca-ui/app/views/fleet-launcher.test.js` (new) | Project multi-select; tab switching prompt/source; guide upload tags + size readout; **head template AND base branch are separate inputs** (§4); head-template live preview + collision detection disables submit; **base branch pre-flight (`POST /api/fleet-runs/validate-base`) gating submit when missing in some repos**; plan-mode radio reveals correct sub-inputs; token-overhead gate requires "I understand" check above threshold. |
| `worca-ui/server/fleet-routes.test.js` (new) | All endpoints listed in 13.6 — contract + error paths (404, 409 on resume of running fleet, 400 on guide cap exceeded, 412 on cleanup of resumable fleet without `?force=1`, 410 on resume after worktree cleanup, `validate-base` returns missing-in list). |
| `worca-ui/server/fleet-routes-guide-upload.test.js` (new) | Multipart upload lands files under `~/.worca/fleet-runs/<id>/guides/` per §3.5; filename sanitization (path separators stripped); collision dedup (`-1`, `-2`); size cap enforced before dispatch; manifest `guide.uploaded === true` for UI uploads, `false` for CLI paths. |
| `worca-ui/app/views/sidebar.test.js` (extend) | "Fleets" entry hidden when zero fleets, visible when fleets exist (per W-048 §13.7 layout); count badge shows active count; badge variant flips to warning when any fleet halted; "New Pipeline" button converted to `sl-dropdown` + `sl-menu`; "+ New Fleet" menu item present and routes to `#/fleet-runs/new`; existing "New Pipeline" item retains original behavior. |
| `worca-ui/app/views/sidebar-status-badges.test.js` (extend) | New `halted` and `setup_failed` badge color cases; `halted` + `halt_reason: "user"` renders neutral, `halted` + `halt_reason: "circuit_breaker"` renders warning. |
| `worca-ui/app/utils/state-actions.test.js` (extend, new if absent) | `actionAllowed('resume', 'halted') === true`; `actionAllowed('pause', 'halted') === false`; `setup_failed` only allows `cancel`/`archive`/`delete`; `pending` only allows `cancel`/`delete`. Enforces W-048 §13.4 binding contract. |
| `worca-ui/app/utils/status-badge.test.js` (extend, new if absent) | `statusClass('halted')` returns `status-halted`; `statusClass('setup_failed')` returns `status-setup-failed`; `statusClass('unrecoverable')` returns `status-unrecoverable`; new statuses no longer fall through to `status-unknown`. |
| `worca-ui/app/views/launcher-shared.test.js` (new) | Each extracted subcomponent (guide upload, head-template input, plan-mode radio shell, token-overhead gate) in isolation; verified the API surface W-047 will compose against. |
| `worca-ui/test/ws-integration.test.js` (extend) | `fleet-update` event subscription and dashboard re-render; **`workspace-update` is a separate event type and never carries fleet payloads** (negative test ensuring multiplexing isn't reintroduced). |
| `worca-ui/e2e/fleet-runs.spec.js` (new, Playwright `--workers=1`) | End-to-end: launch fleet (via UI multipart upload), observe halted state, resume from UI, see PR aggregation, see aggregate cost panel, "Re-run fleet" creates a new fleet with same definition. |

#### 13.9 Files Added/Touched for §13

| File | Change |
|------|--------|
| `worca-ui/app/views/sidebar.js` | Convert "New Pipeline" button → `sl-dropdown` + `sl-menu`; "Fleet Runs" nav entry (conditional visibility) |
| `worca-ui/app/views/dashboard.js` | Fleet grouping renderer with expand/collapse |
| `worca-ui/app/views/fleet-detail.js` | **New** — manifest, guide, children, actions |
| `worca-ui/app/views/fleet-launcher.js` | **New** — guided launch form with token gate |
| `worca-ui/app/protocol.js` | Add `'fleet-update'` to allowlist |
| `worca-ui/server/fleet-routes.js` | **New** — REST endpoints from 13.6 |
| `worca-ui/server/ws-modular.js` | Fleet manifest watcher; emits `fleet-update` |
| `worca-ui/app/utils/state-actions.js` | Extend `STATES` + `ACTION_MATRIX` with `halted`, `setup_failed`, `unrecoverable` (§13.7 triple-update) |
| `worca-ui/app/utils/status-badge.js` | Extend `CLASS_MAP` + `ICON_DATA` with new status values (§13.7 triple-update) |
| `worca-ui/app/styles.css` | Fleet group + launcher styles; `.status-halted`, `.status-setup-failed`, `.status-unrecoverable` rules (§13.7 triple-update) |
| Tests above | **New / extended** |

## Implementation Plan

### Phase 1: Shared guide injection (foundation)

**Files:** `src/worca/orchestrator/work_request.py`, `src/worca/scripts/run_pipeline.py`, `src/worca/scripts/run_parallel.py`, `src/worca/scripts/run_worktree.py`, `src/worca/agents/core/planner.md`, `src/worca/agents/core/reviewer.md`, `src/worca/agents/core/tester.md`, `.claude/worca/settings.json`, `CLAUDE.md`

**Tasks:**
1. Add `attach_guide(wr, guide_paths)` in `work_request.py` with the normative header (returns a new `WorkRequest` with the prepended block). This is the load-bearing missing piece — `run_pipeline.py:220` already tries to import it.
2. Add `worca.guide.max_bytes` default (64KB) to the bundled `.claude/worca/settings.json` template **and** `src/worca/templates/` so `worca init`/`worca init --upgrade` propagate the key.
3. Add `--guide PATH` (repeatable) to `run_parallel.py` (`run_pipeline.py:51-52` and `run_worktree.py:154-158` already declare it). Call `attach_guide()` after `normalize(...)` once the function exists.
4. **Remove the ImportError gate at `run_pipeline.py:218-229` and the `tests/test_run_pipeline.py::test_guide_flag_errors_without_attach_guide` test** — once `attach_guide` is defined, both become unreachable / wrong. Retain the parser-level tests (`test_guide_arg_parsed`, `test_guide_repeatable`, `test_guide_absent_by_default`) — they cover the flag declaration and are still correct.
5. Document precedence **guide > plan > description** in `CLAUDE.md`. The guide is the highest-authority normative material (matching the "treat any conflict between the guide and the task description as a bug" wording in the normative header). The plan is derived from the guide and the description; if the plan diverges from the guide, the guide wins. The description is task scope, expanded by both. When all three are present, agents must surface plan-vs-guide conflicts rather than silently resolving them.
6. Reinforce the precedence in the agent templates: add a "Guide precedence" instruction block to `planner.md`, `reviewer.md`, and `tester.md` that tells the agent (a) to conform to the guide, (b) to surface plan-vs-guide divergence rather than silently resolving it, (c) to treat description requests that conflict with the guide as bugs to flag.

### Phase 2a: Fleet runner skeleton (plumbing)

**Files:** `src/worca/scripts/run_fleet.py` (new), `src/worca/utils/branch_naming.py` (new), `src/worca/scripts/run_worktree.py`, `src/worca/scripts/run_parallel.py`

This phase delivers the runner's argument parser, branch naming utilities, init provisioning, and the `group_type` wiring — all unit-testable in isolation without the dispatch loop or manifest storage.

**Tasks:**
1. Add `src/worca/scripts/run_fleet.py` with arg parsing for `--projects` / `--projects-file`, `--head-template` (canonical), `--base` (PR base branch — see §4), `--guide`, `--plan`, `--plan-first`, `--max-parallel`, `--fleet-failure-threshold`, `--resume`. **`--branch` is explicitly rejected** with the §4 error message — no deprecation alias exists. The dispatch loop and manifest logic are stubs at this point — Phase 2b fills them in.
2. Extract `_slugify` + `_resolve_branch_template` into `src/worca/utils/branch_naming.py`; update `run_parallel.py:35` AND `run_worktree.py:76` to import from there (both files currently duplicate the helper).
3. Add collision detection on post-substitution **head** branch names. **Base branch pre-flight:** when `--base` is set, verify it exists in every selected project via `git -C <target> branch --list <base>`; abort with the missing-in list if any are absent.
4. Invoke `worca init --upgrade` per target; capture failures as `setup_failed` (per-target subprocess timeout from §2).
5. Patch `run_worktree.py` to pass `group_type="fleet"` to `register_pipeline()` when `--fleet-id` is set. **The `--fleet-id` flag itself, `register_pipeline()`'s `fleet_id`/`workspace_id`/`group_type`/`target_branch` keyword args, and the mutual-exclusion check are already shipped** — no signature changes needed; just the one missing `group_type="fleet"` pass-through call at `run_worktree.py:253`.

### Phase 2b: Fleet runner orchestration (stateful)

**Files:** `src/worca/scripts/run_fleet.py`, `src/worca/orchestrator/registry.py`, `src/worca/cli/cleanup.py`

This phase builds the manifest, dispatch loop, circuit breaker, orphan reconciliation, and cleanup source on top of Phase 2a's skeleton.

**Tasks:**
1. Write fleet manifest to `~/.worca/fleet-runs/<fleet_id>.json` (manifest schema §10 includes `head_template`, `base_branch`, `fleet_id_short`, `guide.uploaded`); update fleet-level status on child transitions (polled from `pipelines.d/`).
2. Manual dispatch loop with `--max-parallel` (default 5) — **not `ThreadPoolExecutor.map`** (see §7 dispatch-strategy note: eagerly queued futures can't be reliably cancelled). Each child calls `run_worktree.py` with `cwd=project_dir`, `--fleet-id`, and `--branch <base>` (W-048 §10 = base branch). Environment scrubbing uses `RESERVED_ENV_KEYS` and `RESERVED_PREFIXES` imported from `worca.utils.env` (§5) — no hand-maintained scrub list.
3. Fleet-level circuit breaker (`fleet_failure_threshold`, default 30%).
4. Extend `reconcile_orphan_groups()` (registry.py:215 — currently a no-op stub returning `[]`) to read `~/.worca/fleet-runs/<id>.json` existence and strip dead `fleet_id` / `group_type` from registry entries whose manifest no longer exists. The skeleton is in place; this task adds the manifest-lookup body.
5. Replace the commented-out `FleetSource` stub in `src/worca/cli/cleanup.py:196-202` with a real implementation: `list_eligible(filters)` enumerates `~/.worca/fleet-runs/*.json`; `remove(entry)` removes child worktrees (via the existing `WorktreeSource` path), deregisters their `pipelines.d/` entries, and removes the `~/.worca/fleet-runs/<fleet_id>/` directory (manifest + `guides/`). Wire it into `_build_sources()` (line 213).

### Phase 3: Plan modes

**Files:** `src/worca/scripts/run_fleet.py`

**Tasks:**
1. `--plan <path>` propagation to every child via `run_worktree.py --plan`.
2. `--plan-first`: sequential Planner on reference project, then fan out.

### Phase 4: UI integration (see §13 for full surface)

**Files:** `worca-ui/server/fleet-routes.js` (new), `worca-ui/server/ws-modular.js`, `worca-ui/app/views/dashboard.js` (handles both single-project and cross-project rendering post-W-048; `multi-dashboard.js` no longer exists), `worca-ui/app/views/sidebar.js`, `worca-ui/app/views/fleet-launcher.js` (new), `worca-ui/app/views/fleet-detail.js` (new), `worca-ui/app/views/group-rendering.js` (new — shared with `worktrees.js`), `worca-ui/app/protocol.js`, `worca-ui/app/styles.css`

**Tasks:**
1. Add fleet manifest file watcher to `ws-modular.js`; emit `fleet-update` events on manifest changes (workspace events use a separate `workspace-update` type per §13.5); add `'fleet-update'` to `app/protocol.js` allowlist.
2. Implement REST endpoints from §13.6: `POST/GET/DELETE /api/fleet-runs` (with multipart guide upload landing in `~/.worca/fleet-runs/<fleet_id>/guides/` per §3.5), `POST /api/fleet-runs/validate-base`, `GET /api/fleet-runs/:id`, `POST /api/fleet-runs/:id/resume`, `POST /api/fleet-runs/:id/relaunch`, `GET /api/fleet-runs/:id/guide` (with not-retrievable fallback), `POST /api/fleet-runs/estimate`. Cleanup variant of `DELETE` invokes `worca cleanup --fleet-id <id>` with resume-loss gate (412 without `?force=1`).
3. Fleet-grouping renderer in `dashboard.js` (cross-project rendering already lives here post-W-048) — group `runs-list` entries by `fleet_id` AND `group_type === "fleet"` (W-048 §5 rule — never derive from `fleet_id` presence alone), render collapsible header with aggregate progress + aggregate cost, persist expand state in localStorage. Reuse helpers from the new `group-rendering.js` module (shared with `worktrees.js`).
4. Build `fleet-launcher.js` per §13.4 — project multi-select, multipart guide upload, **separate head-template + base-branch inputs** with collision/missing-base validation, plan-mode toggle, token-overhead gate.
5. Build `fleet-detail.js` per §13.3 — manifest panel, guide opt-in viewer (with not-retrievable fallback), children grid with PR aggregation, **aggregate cost panel**, halt/resume/cleanup/re-run actions with resume-loss confirmation.
6. **Sidebar: convert "New Pipeline" button to dropdown + add "Fleets" nav entry.** The current `sidebar.js:177-185` is a plain `<button>` — convert it to `<sl-dropdown>` + `<sl-menu>` with "New Pipeline" and "New Fleet" items (see §13.1). Add conditional "Fleets" entry per W-048 §13.7 layout (flat sibling under Pipeline section).
7. **Status system triple-update (§13.7 binding contract).** Add `halted`, `setup_failed`, and `unrecoverable` to all three render call sites in lockstep — this is a single atomic task, not three independent changes:
   - `state-actions.js`: extend `STATES` array with `halted`, `setup_failed`, `unrecoverable`; extend `ACTION_MATRIX` with the allowed actions per §13.7 (e.g., `halted` allows `resume`/`cancel`/`archive`/`delete`/`learn`; `setup_failed` allows `cancel`/`archive`/`delete`; `pending` already exists in `STATES`).
   - `status-badge.js`: extend `CLASS_MAP` with `halted: 'status-halted'`, `setup_failed: 'status-setup-failed'`, `unrecoverable: 'status-unrecoverable'`; extend `ICON_DATA` with matching icons.
   - `styles.css`: add `.status-halted`, `.status-setup-failed`, `.status-unrecoverable` rules (both badge colors and run-card border styling) using existing `--status-*` CSS variables per §13.7.
8. Wire fleet-specific badge color mapping: `halted` + `halt_reason` variant resolution (§13.7 fleet status table), fleet header badge label/tooltip by `halt_reason`.

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
| `src/worca/scripts/run_fleet.py` | **New** — fleet entry point with `--head-template` (canonical), `--base` (PR base branch), `--guide`, `--plan`, `--plan-first`, `--projects`, `--max-parallel`, `--fleet-failure-threshold`. `--branch` is explicitly rejected at argparse time per §4 to avoid flag-string collision with `run_worktree.py --branch` |
| `src/worca/utils/branch_naming.py` | **New** — extracted `_slugify` + template resolver |
| `src/worca/agents/core/guardian.md` | Fleet-aware PR title + footer |
| `src/worca/agents/core/planner.md` | Add "Guide precedence" instruction (guide > plan > description) |
| `src/worca/agents/core/reviewer.md` | Add "Guide precedence" instruction; flag plan-vs-guide divergence |
| `src/worca/agents/core/tester.md` | Add "Guide precedence" instruction; treat guide-conflicting description as a bug |
| `.claude/worca/settings.json` | Add `worca.guide.max_bytes`, `worca.fleet.*` defaults |
| `worca-ui/server/fleet-routes.js` | **New** — fleet REST endpoints (§13.6) including multipart guide upload (§3.5), `validate-base` pre-flight, `relaunch`, cleanup with resume-loss gate |
| `worca-ui/server/ws-modular.js` | Fleet manifest file watcher + `fleet-update` event (workspace events stay separate per §13.5) |
| `worca-ui/app/views/dashboard.js` | Fleet grouping renderer (collapsible header, aggregate progress, aggregate cost). Cross-project rendering lives here post-W-048 — `multi-dashboard.js` no longer exists. Groups by `fleet_id` when `group_type === "fleet"`. |
| `worca-ui/app/views/group-rendering.js` | **New** — extracted shared helpers (`groupByFleet`, `fleetHeaderView`) consumed by both `dashboard.js` and `worktrees.js` (which already implements the pattern; refactor to import from the new module). |
| `worca-ui/app/views/sidebar.js` | Convert "New Pipeline" button to `sl-dropdown` + `sl-menu` (prerequisite — §13.1); add "New Fleet" menu item; add conditional "Fleets" nav entry per W-048 §13.7 layout (flat sibling under Pipeline section) |
| `worca-ui/app/views/launcher-shared.js` | **New** — extracted subcomponents (guide upload, head-template input, plan-mode radio shell, token-overhead gate). Established here, **not in W-047**, to avoid refactoring just-shipped W-040 code when W-047 lands (§13.4 binding architectural decision) |
| `worca-ui/app/views/fleet-launcher.js` | **New** — guided launch form composing `launcher-shared.js`; token gate, separate head-template + base-branch inputs, multipart guide upload, per-target init progress strip + Cancel button (§13.4) |
| `worca-ui/app/views/fleet-detail.js` | **New** — manifest, guide (with not-retrievable fallback), children grid, aggregate cost panel, actions (§13.3) |
| `worca-ui/app/utils/state-actions.js` | Extend `STATES` + `ACTION_MATRIX` with `halted`, `setup_failed`, `unrecoverable` (§13.7 triple-update) |
| `worca-ui/app/utils/status-badge.js` | Extend `CLASS_MAP` + `ICON_DATA` with new status values (§13.7 triple-update) |
| `worca-ui/app/protocol.js` | Add `'fleet-update'` to event allowlist |
| `worca-ui/app/styles.css` | Fleet group + launcher styles; `.status-halted`, `.status-setup-failed`, `.status-unrecoverable` rules (§13.7 triple-update) |
| `CLAUDE.md` | Fleet Runs section + guide precedence note |
| `MIGRATION.md` | Release note |
| `docs/fleet-runs.md` | **New** — user-facing walkthrough |

## Considerations

- **Per-project independence preserved.** No cross-project dependency resolution, no shared-branch/mono-PR strategy. If projects need different prompts, callers use `run_parallel.py` or launch multiple fleets.
- **Grouping field discipline (binding W-048 §5 contract).** Fleet children set `fleet_id` + `group_type="fleet"` — never `workspace_id`. UI consumers branch on `group_type` for rendering style and use the explicit ID field for membership. The earlier proposal (rejected) overloaded `fleet_id` to also represent workspace IDs distinguished by a sibling `group_type` field; that pattern is forbidden across all three plans (W-048, W-040, W-047).
- **Cleanup verb consistency.** All artifact-removal surfaces (W-048 worktree view, this plan's fleet detail, W-047 workspace detail) use the verb **"Cleanup"** — not "Remove", "Delete", or "Discard". Single verb across plans reduces cognitive load.
- **Event channel discipline.** `fleet-update` carries fleet-manifest payloads only. `workspace-update` (W-047) is a separate event type. Multiplexing manifest types over one event was rejected (see §13.5).
- **PR base branch — explicit and pre-flighted.** `--base` is a top-level fleet flag (§4) with launch-time validation (§13.4 / §13.6 `validate-base`). Default behavior (per-child default-branch resolution) is preserved when `--base` is omitted, so heterogeneous fleets need no per-repo configuration.
- **Guide upload storage path is canonical.** UI uploads land at `~/.worca/fleet-runs/<fleet_id>/guides/` (§3.5). CLI `--guide` paths can be anywhere. The manifest's `guide.uploaded` flag distinguishes; the UI's guide viewer falls back gracefully when a CLI path is unreachable (§13.3).
- **Worktree isolation for fleet children.** By dispatching via `run_worktree.py`, each fleet child gets a git worktree within its target repo. The user's working tree is not dirtied — important when fleet-targeting repos where the user may have uncommitted work.
- **In-flight children finish on fleet halt.** The fleet-level circuit breaker only cancels unstarted children — killing mid-flight subprocesses risks half-written repos.
- **Single source of truth for per-child state.** Per-child pipeline status lives in `pipelines.d/` entries and `status.json`, not duplicated in the fleet manifest. The manifest only stores fleet-level concerns. This avoids state drift between two tracking systems.
- **Env scrubbing uses a single source of truth.** `run_fleet.py` imports `RESERVED_ENV_KEYS` and `RESERVED_PREFIXES` from `src/worca/utils/env.py` rather than maintaining its own scrub list. If future stages add new `WORCA_*` env vars, adding them to `env.py` automatically covers fleet child scrubbing. No regression test for list drift is needed — there is only one list.
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
| Python | `tests/test_fleet_env_isolation.py::test_scrub_uses_env_py` | Child subprocess env has none of the keys in `RESERVED_ENV_KEYS` from `worca.utils.env` (including `WORCA_AGENT`, `WORCA_RUN_ID`, `WORCA_PROJECT_ROOT`, `CLAUDECODE`, etc.); verifies `run_fleet.py` imports from `env.py` rather than maintaining a parallel list |
| Python | `tests/test_attach_guide.py::test_path_resolution` | Relative `--guide` paths resolved to absolute before child dispatch |
| Python | `tests/test_fleet_plan_modes.py::test_plan_explicit` | `--plan <path>` attaches same plan to every child; Planner skipped |
| Python | `tests/test_fleet_plan_modes.py::test_plan_first` | Reference child's Planner output is reused by N−1 others; failure halts fan-out |
| Python | `tests/test_fleet_circuit_breaker.py::test_halt_threshold` | ≥30% failures with ≥3 completed → unstarted children cancelled, in-flight survive |
| Python | `tests/test_fleet_circuit_breaker.py::test_halt_reason_circuit_breaker` | Auto-halt writes `halt_reason: "circuit_breaker"` in manifest |
| Python | `tests/test_fleet_circuit_breaker.py::test_halt_reason_user` | `DELETE /api/fleet-runs/:id` (or CLI equivalent) writes `halt_reason: "user"` in manifest |
| Python | `tests/test_fleet_init_timeout.py::test_per_target_timeout` | One target hangs >timeout → marked `setup_failed`, others dispatched normally |
| Python | `tests/test_fleet_init_timeout.py::test_cancel_during_init` | `?stage=initializing` cancellation kills outstanding `worca init` subprocesses; dispatched children continue |
| Python | `tests/test_fleet_resume.py::test_resume_skips_cleaned_children` | Worktree removed pre-resume → child marked `unrecoverable`, resume continues with the rest |
| Python | `tests/test_registry.py::test_reconcile_orphan_groups_strips_dead_fleet` | W-040-extended `reconcile_orphan_groups` strips `fleet_id`/`group_type` when manifest missing (extends W-048 §11.5 skeleton) |
| Python | `tests/test_fleet_resume.py::test_resume_selects_failed` | `--resume` re-launches only `pending`/`failed`/`setup_failed` children |
| Python | `tests/test_fleet_resume.py::test_resume_reads_pipelines_d` | `--resume` resolves child status from `pipelines.d/` entries, not manifest |
| Python | `tests/test_fleet_branch.py::test_base_branch_propagation` | `--base dev` is propagated to every child's `run_worktree.py --branch dev`; manifest `base_branch == "dev"`; child entries `base_branch == "dev"` |
| Python | `tests/test_fleet_branch.py::test_base_branch_pre_flight` | `--base nonexistent` aborts with the list of repos lacking the branch; no children dispatched |
| Python | `tests/test_fleet_branch.py::test_base_branch_default_resolution` | `--base` omitted → each child resolves its own default branch via `git symbolic-ref refs/remotes/origin/HEAD`; heterogeneous (main/master) handled |
| Python | `tests/test_fleet_branch.py::test_branch_flag_rejected` | `run_fleet.py --branch foo` raises `ArgumentError` with the §4 message pointing the user at `--base` and `--head-template`; no children dispatched |
| Python | `tests/test_attach_guide.py::test_uploaded_path_resolution` | `attach_guide` reads files from `~/.worca/fleet-runs/<id>/guides/`; manifest `guide.uploaded === true` |
| Python | `tests/test_registry_grouping.py::test_fleet_id_only_for_fleet` | A fleet child registry entry has `fleet_id` set, `workspace_id` is `None`, `group_type == "fleet"`. Inverse for workspace child (covered in W-047 tests). Enforces W-048 §5 authoritative rule. |
| UI (vitest) | `worca-ui/server/fleet-routes.test.js` | `POST/GET/DELETE /api/fleet-runs` + guide endpoint contract + validate-base + relaunch + 412/410 paths |
| UI (vitest) | `worca-ui/app/views/dashboard-fleet.test.js` | Fleet grouping renders header + aggregate progress + expand/collapse |

### Integration / E2E Tests

- **Synthetic 3-repo fleet (pytest fixture).** Scratch repos generated by the harness; fleet applies a trivial guide (`add HEALTH.md`); asserts 3 worktrees created (one per repo), 3 `pipelines.d/` entries with matching `fleet_id`, 3 branches, 3 PRs (mocked `gh`), fleet manifest status `completed`.
- **Full-stack W-048 + W-040 integration (pytest fixture, no W-047).** This is the W-040-only end-to-end check, mirroring W-047's full-stack test but stopping one layer down — closes the gap where a W-040 regression would otherwise wait for W-047 dogfooding to surface.
  1. Launch via `python .claude/worca/scripts/run_fleet.py --projects /tmp/repo-a /tmp/repo-b /tmp/repo-c --prompt "..." --base main --head-template fleet/{slug}/{project}` against three scratch repos.
  2. Assert `run_fleet.py` calls `run_worktree.py` per repo with `--fleet-id <id>` and `--branch main` (W-048 §10 = base branch).
  3. Assert each child writes a `pipelines.d/` entry with `fleet_id == <id>`, `workspace_id IS NULL`, `group_type == "fleet"`, `target_branch == "main"`, `worktree_path` populated.
  4. Assert `discoverRuns` (W-048's `watcher.js` step 5) in **global mode** (cross-project fan-out per W-048 §5) returns all 3 children in one `runs-list` payload, each enriched with `fleet_id` / `group_type`.
  5. Assert no `pipeline-status-changed` events fire (MultiWatcher is gone — W-048 §6.5 contract).
  6. Assert the UI dashboard groups all 3 runs under one fleet header (rendered by `dashboard.js` fleet-grouping per §13.2) with aggregate progress matching `completed_children / total_children`.
  7. Halt mid-flight via `DELETE /api/fleet-runs/:id`. Assert: in-flight children continue, unstarted children are cancelled, fleet manifest `status: "halted"`, `halt_reason: "user"`, header badge variant flips to `neutral` (per §13.7).
  8. Trigger circuit-breaker halt in a separate run by mocking child failures past threshold. Assert `halt_reason: "circuit_breaker"`, header badge variant `warning`.
  9. Cleanup via `worca cleanup --fleet-id <id>`. Assert: worktrees removed, `~/.worca/fleet-runs/<id>/` removed (manifest + guides/ subdir), `pipelines.d/` entries deregistered. Run `reconcile_orphan_groups()` (W-048 §11.5) → returns empty list (no orphan IDs left).
- **Playwright (`--workers=1`).** Launch a fleet via the UI, observe grouped progress on the dashboard, stop the fleet, verify `DELETE /api/fleet-runs/:id` halts unstarted children. Also exercise: per-target init progress strip during the launch phase, "Cancel launch" button kills outstanding `worca init` subprocesses (§2 init-timeout / cancel surface).
- **`--plan-first` happy path + failure path.** Reference Planner succeeds → fan-out; reference Planner fails → fleet halted before fan-out, manifest status `failed`.
- **Resume after partial failure.** Fleet of 3; mock one child to fail. `--resume` re-launches only the failed child; completed children untouched; `pipelines.d/` entries verified.
- **Resume skips cleaned children (regression).** Fleet of 3 with one child's worktree manually `rm -rf`'d post-failure. `--resume` logs "skipping run X — worktree gone (cleaned up)", continues with remaining failed children. Manifest reflects the cleaned child as `unrecoverable`.
- **Init-timeout regression.** Mock one of three target repos to hang `worca init --upgrade` indefinitely. `run_fleet.py --init-timeout 5` aborts that target after 5s, marks `setup_failed`, dispatches the other two normally. Total launch time < 10s.
- **`reconcile_orphan_groups` end-to-end.** Register a child with `fleet_id="ghost_xyz"`, then assert no manifest exists at `~/.worca/fleet-runs/ghost_xyz.json`. Run `reconcile_orphan_groups()` → strips the dead `fleet_id` and `group_type` from the entry; child is now standalone. Verify `discoverRuns` returns it without group fields.

### Existing Tests to Update

- `tests/test_run_parallel.py` — import of `_slugify` moves from `run_parallel` to `utils.branch_naming`.
- W-048's `run_worktree.py` tests — add coverage for the new `--fleet-id` flag being written to `pipelines.d/` entries; verify `workspace_id` stays `None` for fleet children (W-048 §5 mutual-exclusion rule).
- `worca-ui/app/views/dashboard.test.js` and `dashboard-multiproject.test.js` (the post-W-048 dashboard test suites) — extend with a fleet grouping scenario: 3 worktree runs, 2 with same `fleet_id` + `group_type === "fleet"`, render fleet header wrapping the two and a standalone card for the third.

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
