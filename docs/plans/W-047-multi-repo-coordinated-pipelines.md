# W-047: Multi-Repo Coordinated Pipelines

**Status:** Draft
**Priority:** P3
**Area:** cc + ui
**Date:** 2026-04-26
**Depends on:** W-048 / #82 (worktree-based pipeline isolation — `pipelines.d/` registry, unified `discoverRuns`, `active_run` removal), W-040 / #101 (fleet runs — cross-repository fan-out, `fleet_id` grouping, manifest, circuit breaker, `--resume`, guide injection)

## Problem

Fleet runs (W-040) fan out a single work-request to N independent repos — every child gets the same prompt and runs in isolation. This solves migrations and compliance sweeps but cannot handle the common case where a **single feature requires coordinated changes across interdependent repos**: a backend adds an API endpoint, a shared-lib adds a type, and a frontend consumes both. Today there is no mechanism to:

1. **Decompose** one prompt into repo-specific sub-prompts. Fleet sends the same prompt everywhere (`src/worca/scripts/run_fleet.py` — from W-040 design §1); a multi-repo feature needs different work in each repo.
2. **Order** child pipelines by dependency. Fleet uses `ThreadPoolExecutor` for all-at-once parallel dispatch (`run_fleet.py` — W-040 design §1); cross-repo features need `shared-lib` to finish before `backend`, and `backend` before `frontend`.
3. **Test across repo boundaries.** Each child's tester stage — dispatched by `src/worca/orchestrator/runner.py` using the prompt template at `src/worca/agents/core/tester.md` (there is no `stages/test.py`; stage execution lives in `runner.py` and the stage list is in `src/worca/orchestrator/stages.py`) — runs tests within one repo. There is no post-completion phase that validates the combined changes work together.
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
  },
  "umbrella_repo": "org/platform-meta"
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
  2. Reads `CLAUDE.md` from each repo for project-specific context. Each `CLAUDE.md` is truncated to 4KB (extracting the top-level sections: Quick Start, Architecture, Testing, Development Approach) to bound total context size. For a 5-repo workspace this caps repo context at ~20KB. A warning is emitted if any `CLAUDE.md` exceeds the cap.
  3. Receives the user's prompt.
  4. Produces a **workspace plan** — a structured output containing:
     - A high-level summary of the cross-repo change.
     - Per-repo sub-plans: each is a self-contained work description that a standard worca pipeline can execute independently.
     - Dependency annotations: which repo's changes are prerequisites for which (confirming or refining the static `depends_on` in `workspace.json`).
     - Integration test expectations: what the cross-repo test should validate.

  The master planner produces structured JSON output (validated against `workspace_plan.json` schema). The orchestrator (`run_workspace.py`) parses this output and writes the plan files to `{workspace_root}/.worca/workspace-runs/{run_id}/` — `workspace-plan.md` (human-readable, rendered from the JSON) and individual `{repo}-plan.md` files. The planner agent itself does not write files; the orchestrator does. This avoids needing to modify the guard hook's role-based file-write restrictions. Each child pipeline receives its repo-specific plan via `--plan`.

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

  1. After `shared-lib` completes, extract from the worktree: `git diff main..HEAD --stat` (always included, ~200 bytes) + targeted file-level diffs prioritizing public API surfaces (exported types, route definitions, schema files) over internal implementation.
  2. Assemble into a context block capped at 8KB per dependency edge. The prioritization strategy: (a) include `--stat` summary always, (b) include diffs for files matching `**/types/**`, `**/api/**`, `**/schemas/**`, `**/index.*` first, (c) fill remaining budget with other files in diff order. If the budget is exhausted mid-file, include the file header and a `[truncated — N lines remaining]` marker rather than cutting mid-hunk.
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
  2. **Set up the integration environment.** For each child repo, create a temporary git worktree at `{workspace_root}/.worca/integration-env/{repo_name}/` checked out to the child's branch. This gives the integration test a directory tree where every repo has its changes applied, without modifying any repo's main working tree. The environment variables `WORCA_INTEGRATION_ENV=1` and `WORCA_WORKSPACE_ROOT={workspace_root}` are set so the test command can locate repos.
  3. Execute the command with `cwd = {workspace_root}/.worca/integration-env / working_dir`.
  4. Capture stdout/stderr into `{workspace_run_dir}/integration-test.log`.
  5. Clean up the integration environment worktrees after the test (pass or fail).
  6. If the test fails, mark the workspace run as `integration_failed`. The user can inspect logs and `--resume` to re-run.
  7. If no `integration_test` is configured, skip this phase with a warning.

  The integration test command is user-defined and opaque to worca — it could be `docker-compose up && pytest tests/integration/`, a Makefile target, or a script. Worca only runs it and checks the exit code.

  **PR push timing.** Child guardians commit and push to their worktree branches as part of normal operation (required for inter-tier `git fetch`). However, PR *creation* (`gh pr create`) is deferred until after integration tests pass. To achieve this, workspace children run with `WORCA_DEFER_PR=1` in their environment. The guardian stage, when this var is set, commits and pushes the branch but skips `gh pr create`. After integration tests pass, `run_workspace.py` creates all PRs centrally via `gh pr create --repo <owner/repo> --head <branch>` for each child. On `integration_failed`, branches exist on remotes but no PRs are created — the user can inspect and clean up.

### 6. Linked PR Creation

- **Current state:** Fleet's guardian prepends `[fleet:<id>]` to PR titles (W-040 design §11). No cross-references between PRs.
- **Obstacle:** A reviewer looking at `backend#42` has no way to know that `shared-lib#15` must merge first, or that `frontend#43` depends on this PR.
- **Resolution:** Extend the guardian stage with workspace-aware PR creation:

  1. After integration tests pass (or are skipped), `run_workspace.py` creates PRs for each child repo via `gh pr create --repo <owner/repo> --head <branch> --base <target>`. The `--repo` flag is required because `run_workspace.py`'s CWD is the workspace root (not inside any git repo). The repo owner/name is resolved from each child repo's `git remote get-url origin`.
  2. After all PRs are created, `run_workspace.py` post-processes them:
     - For each PR, add a comment via `gh pr comment <number> --repo <owner/repo>` listing its dependencies and dependents:
       ```
       ## Workspace: my-platform
       **Depends on:** org/shared-lib#15 (must merge first)
       **Blocks:** org/frontend#43
       **Workspace run:** `ws_20260426_abc123`
       ```
     - Optionally create an **umbrella issue** on the repo specified in `workspace.json` `umbrella_repo` field (e.g., `"umbrella_repo": "org/platform-meta"`). If `umbrella_repo` is not set, the umbrella issue is created on the first repo in the dependency chain (tier 0). The issue links all PRs:
       ```
       ## Workspace PR Set: Add user profiles
       - [ ] org/shared-lib#15 — Add UserProfile type
       - [ ] org/backend#42 — Add /api/profile endpoint
       - [ ] org/frontend#43 — Add profile page
       ```
  3. PR URLs are stored in the workspace manifest.

  **Cross-org workspaces:** If repos span multiple GitHub orgs, `gh` must be authenticated for each org. `run_workspace.py` validates `gh auth status` per unique org before dispatch and fails fast with an actionable error if authentication is missing.

  Merge order is documented but **not enforced** — worca does not auto-merge. The checklist in the umbrella issue serves as a manual coordination tool.

### 7. Workspace State & Manifest

- **Current state:** Fleet manifest at `~/.worca/fleet-runs/<fleet_id>.json` tracks fleet-level state. Per-child state in `pipelines.d/`.
- **Obstacle:** Workspace runs need additional state: the workspace plan, DAG structure, tier execution progress, integration test results, and PR cross-references. These artifacts are workspace-specific and should live near the workspace, not in the global `~/.worca/` directory.
- **Resolution:** Workspace runs use `{workspace_root}/.worca/workspace-runs/{run_id}/` as the run directory. A lightweight pointer file at `~/.worca/workspace-runs/{run_id}.json` stores only `{ "workspace_root": "/abs/path", "workspace_id": "ws_..." }` so the UI can discover workspace runs globally and follow the pointer to the full manifest.

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

`run_workspace.py` internally reuses fleet primitives: `worca init --upgrade` per repo, `run_worktree.py` dispatch, `pipelines.d/` registration, W-040's circuit breaker logic. **Workspace children are registered with `workspace_id` and `group_type: "workspace"`** — `fleet_id` is NEVER set on a workspace child. This binds W-047 to **W-048 §5's authoritative grouping-field rule** (the earlier proposal in this plan to overload `fleet_id` with the workspace ID is rejected; that pattern would force every consumer to inspect a sibling field to disambiguate). Fleet children set `fleet_id` + `group_type: "fleet"` and never `workspace_id`. UI code that filters workspace membership uses `workspace_id`; UI code that branches on rendering style uses `group_type`. **Never derive type from `fleet_id != null` or `workspace_id != null`** — see W-048 §5 for the full rule.

`run_worktree.py` accepts `--workspace-id <id>` (added by this plan, mirroring W-040's `--fleet-id`); both flags are passed through to `register_pipeline()`. Mutual exclusion is enforced at `register_pipeline` (raises if both are set).

### 9. `worca workspace init`

- **Current state:** `worca init` operates on a single git repo.
- **Resolution:** Add `worca workspace init /path/to/parent`:

  1. Scan child directories for `.git/`.
  2. Read each repo's `CLAUDE.md` (if present) for role hints.
  3. Generate `workspace.json` with all discovered repos, `depends_on: []`, and no integration test.
  4. Create `{workspace_root}/.worca/` directory.
  5. Run `worca init --upgrade` in each child repo.
  6. Print the workspace definition and prompt the user to edit `depends_on` relationships and add an integration test command.

### 10. UI Surface

W-047 introduces five UX surfaces that build on W-040's fleet UI: a **workspace creation flow** (parent-dir picker + DAG editor), a **workspace launcher** (extension of fleet launcher), a **dashboard tier rendering** that augments fleet grouping, a **workspace detail view** (DAG visualization + plan editor + integration log + PR table), and **conflict surfacing** in run cards. Each is grounded in W-040's existing fleet UI patterns and the project's badge color language.

#### 10.1 Sidebar Navigation

- **Layout follows W-048 §13.7** (binding contract): flat siblings under the existing "Pipeline" section. W-047 adds a "Workspaces" entry between W-040's "Fleets" entry and any future entries.
- **No nesting** — the earlier proposal to introduce a "Multi-Repo" parent group with "Fleets" and "Workspaces" children is **superseded** by W-048 §13.7's flat-siblings convention. Nesting was rejected because it would be the first nested nav entry in the entire app for only two siblings; flat siblings preserve the existing visual rhythm with no readability loss.
- **Conditional visibility:** Hidden when `GET /api/workspace-runs` returns `[]` (no workspace runs ever launched); auto-revealed on first launch. Same pattern as W-048 "Worktrees" and W-040 "Fleets".
- **Count badge:** `<sl-badge variant="primary" pill>` showing active workspace count (status `running`/`planning`/`integration_testing`); flips to `warning` when at least one workspace is `halted`/`integration_failed`. Same convention as W-040 "Fleets".
- **"+ New Pipeline" CTA evolution:** W-048 §13.7 scaffolds the dropdown; W-040 adds "+ New Fleet"; W-047 adds the **"+ New Workspace"** option, routing to `#/workspaces/new` (creation flow) when no workspaces exist, or to `#/workspace-runs/new` (launcher) when at least one workspace.json is registered.
- **Active-state styling** matches existing patterns.

#### 10.2 Workspace Creation Flow

- **New file:** `worca-ui/app/views/workspace-create.js`. Routed via `#/workspaces/new`.
- **Why a UI flow:** The CLI `worca workspace init <path>` works for power users, but defining a DAG in JSON by hand is friction. The UI provides discoverability for the workspace concept itself.
- **Step 1 — Parent directory picker.**
  - **Auto-detect path** (default when at least one project is registered in `~/.worca/projects.d/`): the input is pre-filled with the longest common parent of registered project paths. A helper line shows "Auto-detected from N registered projects" with a "Clear" link to reset.
  - **Empty-state fallback** (when zero projects are registered): the auto-detect helper is replaced with an `<sl-alert variant="primary">` "No registered projects to auto-detect from. Type or paste a parent directory path to scan." This avoids a dead-end where the auto-detect feature is suggested but produces nothing.
  - **Free-form input always available:** the user can type/paste any absolute path regardless of whether auto-detect succeeded.
  - **Scan button:** Below the input, a `<sl-button>` "Scan" triggers `POST /api/workspaces/scan` which runs the equivalent of `find <path> -maxdepth 2 -name .git` and returns discovered repos. **Reuses W-039's `/api/scan-directory` infrastructure** (already proven for the add-project flow); workspace scan adds `.git/` filtering on top.
  - **Browse fallback** (optional polish, ship if time permits): a "Browse..." button that opens a native directory picker via `<input type="file" webkitdirectory>` and extracts the parent path. Useful for users who don't know the absolute path of their workspace parent.
- **Step 2 — Repo selection.** Discovered repos render as a checklist (`<sl-checkbox>` per repo). Each row shows repo name, path, and detected role hint (parsed from the repo's `CLAUDE.md` if present, e.g., "Architecture: backend service" → role suggestion `service`). User toggles which repos belong to the workspace.
- **Step 3 — Dependency editor.** A simple two-column visual:
  - **Left column:** list of selected repos.
  - **Right column for each repo:** a `<sl-select multiple>` where the user picks which other repos this one depends on. Selecting `frontend → depends_on: [backend]` is one click.
  - Below the visual, a **live DAG preview** (rendered with the same component as the detail view's DAG, see §10.5) updates as the user edits dependencies. Cycles are detected client-side (Tarjan's SCC) and shown as a red banner with the cycle path; submit is disabled until resolved.
- **Step 4 — Integration test.** Optional `<sl-input>` for the test command and `<sl-input>` for the working directory (defaults to `.`). A `<sl-checkbox>` "Skip integration test" disables both.
- **Step 5 — Umbrella repo (optional).** `<sl-input>` for `org/repo-name` for the umbrella issue.
- **Submit** → `POST /api/workspaces` writes `workspace.json` to the parent dir + creates `{workspace_root}/.worca/`. Then offers a "Run worca init in each repo" action that invokes the per-repo `worca init --upgrade` (mirroring `run_workspace.py`'s setup phase).
- **Workspace registration:** A pointer file at `~/.worca/workspaces.d/<workspace_name>.json` (mirroring `projects.d/`) so the UI can list workspaces in the sidebar without scanning the disk.

#### 10.2.5 Workspace Definition Edit Flow

- **Why:** §10.2 has a creation wizard. Once `workspace.json` is written, the only edit path is hand-editing the file. Adding a repo, changing `depends_on`, or updating the integration test command requires re-running the wizard or shelling in. Closes the lifecycle gap.
- **New file:** `worca-ui/app/views/workspace-edit.js`. Routed via `#/workspaces/:name/edit`.
- **Form (re-uses §10.2 components):**
  1. **Repo list** — same checklist component as §10.2 step 2, pre-checked from current `workspace.json`. User can add (re-scan from parent dir) or remove repos.
  2. **Dependency editor** — same component as §10.2 step 3 with the live DAG preview + cycle detection.
  3. **Integration test fields** — same as §10.2 step 4.
  4. **Umbrella repo** — same as §10.2 step 5.
- **Submit** → `PUT /api/workspaces/:name` overwrites `workspace.json`. Server validates against `workspace.json` schema, runs cycle detection server-side.
- **Snapshot semantics:** The header banner clarifies "Changes apply to future workspace runs. Active runs (N) use the snapshot from their launch time and are unaffected." The launcher (§10.3) reads the current `workspace.json` at submit time.
- **Worka-init re-trigger** — a "Run worca init in newly-added repos" action (visible only when the diff added repos) invokes the same per-repo `worca init --upgrade` from §10.2 submit.

#### 10.3 Workspace Launcher (Extension of Fleet Launcher)

- **Reuses:** `worca-ui/app/views/fleet-launcher.js` from W-040 with a top-level mode toggle: "Fleet (same prompt to N repos)" vs "Workspace (one feature, coordinated across repos)". Shared subcomponents (guide upload widget, head-template input, plan-mode radio shell, token-overhead gate) are extracted into `worca-ui/app/views/launcher-shared.js` so both modes consume the same building blocks — avoids drift.
- **Workspace mode changes:**
  - **Project multi-select** is replaced with a workspace `<sl-select>` populated from `GET /api/workspaces`. Selecting a workspace pins the project list to that workspace's repos (read-only).
  - **Branch input semantics** match W-040 §4 (separate head-template and PR base branch fields) but with workspace-appropriate defaults:
    - **Head template default:** `workspace/{slug}/{repo}` (instead of fleet's `migration/{slug}/{project}`). The `{repo}` placeholder is the W-047 equivalent of W-040's `{project}` — it resolves to the repo name from `workspace.json`.
    - **Base branch:** Same `<sl-input>` as fleet mode; same `validate-base` pre-flight against every workspace repo.
  - **Plan mode toggle — explicit 4-option radio (vs W-040's 3 options).** Both modes share the radio-group component but populate different option lists. Mapping table makes the contrast clear:

    | # | Workspace mode option | Maps to flag | Fleet mode equivalent |
    |---|----------------------|--------------|------------------------|
    | 1 | **Master planner (default)** — Opus decomposes the prompt into per-repo sub-plans | (no flag, default) | n/a — workspace-only |
    | 2 | **Use existing workspace plan** — file picker for a previously-generated `workspace-plan.json` | `--workspace-plan <path>` | n/a — workspace-only |
    | 3 | **Skip planning, use per-repo plans** — file picker per repo (advanced) | `--skip-planning` + per-repo `--plan` | Maps to fleet's "Use existing plan" (option 1) |
    | 4 | **Independent plans** — each child repo runs its own Planner | `--skip-planning` (no per-repo plan) | Maps to fleet's "Independent plans" (option 3) |

    Fleet mode's "Plan-first reference project" (W-040 §13.4 option 2) has no workspace analog — workspaces always have a master planner that sees all repos, so a per-child Planner-first dispatch doesn't fit. Workspace mode's "Master planner" is the analogous default and supersedes the concept.
  - **New section — Pre-launch DAG preview.** Shows the workspace's tier structure with repo names and dependency arrows. User confirms tier layout before launch.
  - **Pre-launch `gh auth status` check (cross-org workspaces).** When the workspace's repos span multiple GitHub orgs (resolved from each repo's `git remote get-url origin`), the launcher calls `POST /api/workspace-runs/validate-gh-auth` which runs `gh auth status` for each unique org. Missing-auth orgs are listed inline as `<sl-alert variant="danger">` with the exact `gh auth login --hostname github.com --scopes repo` command for each. **Submit is disabled** until all orgs are authenticated (or the user explicitly checks "Skip auth check (PRs may fail)" — escape hatch for offline / dry-run scenarios). This pre-empts §6's "fail-fast at run time" — without this gate, dispatched children burn worktree disk + planner tokens before failing at PR creation.
  - **Token-overhead gate** also surfaces master planner cost (one Opus call) plus context-injection budget per dependency edge (capped at 8KB × edge count) in addition to the guide overhead.
- **Submit** → `POST /api/workspace-runs` returns `{ workspace_id }`, navigate to detail view.

#### 10.4 Dashboard Tier Rendering

- **Extends:** W-040's fleet group renderer in `dashboard.js` and `multi-dashboard.js`.
- **Trigger:** When a run has `group_type === "workspace"` (read from `runs-list` payload, populated by W-048 from the `pipelines.d/` entry), render with workspace tier sub-grouping. **Use `group_type` exclusively** — never derive workspace-vs-fleet from `workspace_id != null` (W-048 §5 binding rule). Children are grouped by `workspace_id` for membership (matching W-040's `fleet_id` membership pattern), with `group_type === "workspace"` selecting the tier-renderer; `group_type === "fleet"` selects the flat fleet renderer.
- **Layout:** The fleet header row is unchanged. Below it, children are grouped by `tier` field from the workspace manifest:
  ```
  [Workspace header — running · tier 2 of 3 · 4/5 children completed]
    Tier 0
      [shared-lib]  ✓ completed
    Tier 1
      [backend]     ✓ completed
    Tier 2
      [frontend]    ▶ running
      [admin-app]   ⏸ blocked (depends on backend, which failed)
    Integration test  ⏸ pending
  ```
- **Tier label** styled via a small `<span class="tier-label">` with subtle background. Tier number derived from manifest.
- **Integration test row** appears as a final pseudo-tier when `integration_test` is configured. Shows status badge (`pending`/`passed`/`failed`/`skipped`).
- **Blocked children** show a tooltip explaining which dependency failure blocked them (from the manifest's `dag.tiers[].repos` cross-reference).

#### 10.5 Workspace Detail View

- **New file:** `worca-ui/app/views/workspace-detail.js`. Routed via `#/workspaces/runs/:workspace_id`.
- **Layout (top-down):**
  1. **Header strip** — workspace name + status badge + tier progress + breadcrumb back to dashboard.
  2. **DAG visualization panel** (see §10.6 below).
  3. **Workspace plan panel** (`<sl-card>`) — markdown-rendered `workspace-plan.md`. Has an **"Edit plan"** `<sl-button>` (visible only when status is `halted` / `failed` / `integration_failed`). Clicking opens a `<sl-dialog>` with a plain `<sl-textarea rows="40">` (with a `code` style class for monospace + syntax highlighting via CSS — **not Monaco or any other editor library**, which would add ~2 MB to the bundle and conflicts with the project's lean-deps stance, see §10.6). The textarea content is the raw `workspace-plan.json`. On save, the UI calls `PUT /api/workspace-runs/:id/plan` (returns 409 if status is not in editable set) and offers a "Resume with edited plan" action that calls `POST /api/workspace-runs/:id/resume`. Server-side validates the JSON against `workspace_plan.json` schema before persisting.
  4. **Per-repo context artifacts panel** (`<sl-tab-group>`) — one tab per dependency edge, rendering the markdown-formatted diff summary that was injected into the next tier. Helps the user understand what the master planner thought was important to surface across tiers.
  5. **Aggregate cost panel** — `<sl-card>` showing workspace-total input/output token spend and dollar cost (sum across all child runs + master-planner call). Mirrors W-040 §13.3 fleet aggregate cost. Refreshes on `runs-list` update.
  6. **Integration test panel** (only when configured) — log viewer (reuses `live-output.js` component) + status badge + "Re-run integration test" button (visible when status is `integration_failed` or `completed`). Calls `POST /api/workspace-runs/:id/re-run-integration`.
  7. **PR table** — one row per repo: PR number, PR URL, status (open/merged), dependency annotations from W-047 §6 (shown as `<sl-tag>` chips: "Depends on org/lib#15", "Blocks org/frontend#43"). Includes a "View umbrella issue" link when present. **"Copy all PR URLs"** button (mirrors W-040 §13.3) copies as a markdown checklist to clipboard.
  8. **Actions row** — verbs aligned with W-048 §13.3 / W-040 §13.3 (single "Cleanup" verb across plans):
     - **"Halt workspace"** (visible when status is `running`/`planning`/`integration_testing`) → `DELETE /api/workspace-runs/:id` with `<sl-dialog>` confirmation. In-flight tier children finish.
     - **"Resume workspace"** (visible when status is `halted`/`failed`/`integration_failed`) → `POST /api/workspace-runs/:id/resume`. Returns 410 if any child's worktree was previously cleaned (resume impossible — see §6 worktree retention policy).
     - **"Cleanup workspace"** (visible when status is terminal — `completed`/`failed`/`integration_failed`/`halted`) → `DELETE /api/workspace-runs/:id?cleanup=1` invoking `worca cleanup --workspace-id <id>` (W-048 §12 pluggable cleanup via `WorkspaceSource`). Confirmation lists per-child worktree disk to free + the workspace run directory + integration-env worktrees + `~/.worca/workspace-runs/<id>/guides/` size. **For non-completed states**, includes the resume-loss warning + explicit `<sl-checkbox>` requirement (mirrors W-048 §13.3 / W-040 §13.3 pattern).
     - **"Re-run workspace"** (always visible when status is terminal) → opens `workspace-launcher.js` pre-filled from this run's parameters.
- **Workspace definition edit (separate from plan edit):** A small "Edit workspace.json" link in the header strip (visible to all users) routes to `#/workspaces/:name/edit` — see §10.2.5 for the full edit flow. Editing `workspace.json` does NOT affect in-progress runs (which use the snapshot at launch time); changes apply to subsequent launches only.

#### 10.6 DAG Visualization

- **Library choice:** Hand-rolled SVG using a tier-column layout. **No external graph library** — d3/cytoscape add ~100KB+ to the bundle and the worca DAG is small (typically 2-5 tiers, 3-15 repos). A bespoke SVG renderer is ~150 lines and matches the project's lean dependency posture (the same reasoning rules out Monaco for the plan editor in §10.5).
- **Layout algorithm:**
  - Columns = tiers (computed from `dag.tiers` in the workspace manifest).
  - Rows within a column = repos in that tier (vertical-center aligned).
  - Edges = `depends_on` relationships, drawn as Bezier curves from the right edge of the source node to the left edge of the destination node.
- **Node styling:** A `<rect>` with rounded corners, fill color = status mapping (see §10.7), stroke = darker variant. Repo name centered.
- **Mode-aware interactivity (`mode` prop):** The same renderer is used in three contexts (workspace-detail navigation, workspace-create dependency editing, workspace-edit dependency editing). Click semantics differ by context. Pass `mode` via prop:

  | `mode` | Used by | Node click | Edge click | Hover |
  |--------|---------|------------|------------|-------|
  | `"navigate"` | `workspace-detail.js` (§10.5) | Routes to the child's run-detail view | Opens the context artifact for that dependency | Highlights incoming/outgoing edges |
  | `"edit"` | `workspace-create.js` (§10.2 step 3) and `workspace-edit.js` (§10.2.5) | Opens the per-repo dependency multi-select inline | (no-op) | Highlights incoming/outgoing edges |
  | `"preview"` | Launcher pre-launch DAG preview (§10.3) | (no-op) | (no-op) | Highlights only |

  Each mode emits the appropriate event (`node-navigate`, `node-edit`, etc.); host views handle accordingly. This avoids two separate renderers.
- **Edge styling:** Stroke color = status of the source node (green if completed, blue if running, etc.) — visually shows where work is propagating in `"navigate"` mode. In `"edit"`/`"preview"` mode, all edges are neutral grey (no run state to reflect).
- **File:** `worca-ui/app/views/dag-graph.js` (new shared component).

#### 10.7 Status Badge Color Mapping

Extends W-040's badge mapping for workspace-specific states. All map to existing variants — no new CSS variables needed.

| Workspace status | Variant | Rationale |
|------------------|---------|-----------|
| `planning` | `primary` (blue) | Master planner active — equivalent to "running" semantically |
| `running` | `primary` (blue) | Tier execution active |
| `integration_testing` | `primary` (blue) | All children done, integration phase running |
| `completed` | `success` (green) | All children + integration passed; PRs created |
| `failed` | `danger` (red) | Tier failure unrecoverable |
| `integration_failed` | `danger` (red) | Children done but integration test failed → no PRs |

Per-tier status (in dashboard tier rendering and DAG nodes):

| Tier status | Variant | Rationale |
|-------------|---------|-----------|
| `completed` | `success` | All repos in tier succeeded |
| `running` | `primary` | One or more repos active |
| `blocked` | `warning` | All repos blocked on a previous tier failure |
| `failed` | `danger` | Tier had a fatal failure |
| `pending` | `neutral` | Not yet reached |

Per-child status adds one new value beyond W-040:

| Child status | Variant | Rationale |
|--------------|---------|-----------|
| `blocked` | `warning` (orange) | Waiting on a failed dependency in an earlier tier — caution, may be skipped or resumed. |

#### 10.8 Conflict Surfacing (Plan-vs-Guide Divergence)

- **Why:** W-040 §3's authority precedence (guide > plan > description) tells agents to surface plan-vs-guide conflicts. Without UI surfacing, users won't see them.
- **Where the conflict signal lives:** Agents emit a structured event when they flag a conflict (existing dispatch event mechanism in `events/types.py`). W-047 adds `events.GUIDE_CONFLICT` event type with payload `{ run_id, stage, message, source: "plan|description" }`.
- **Run card surfacing:** In `worca-ui/app/views/run-card.js`, when a run has any `GUIDE_CONFLICT` events, show a `<sl-icon name="exclamation-triangle" style="color: var(--status-paused);">` next to the run title. Tooltip: "Guide conflicts flagged ({count}). View details."
- **Run detail surfacing:** In `worca-ui/app/views/run-detail.js`, add a "Guide Conflicts" panel (collapsible, default-open when conflicts exist) listing each event with stage + message + source. Each row has a "View source" button that scrolls to the relevant stage tab.
- **Workspace detail surfacing:** Aggregated count in the workspace detail view header — "3 guide conflicts across children". Click expands a list grouped by repo.

#### 10.9 WebSocket Events

- **New event type: `workspace-update`** — emitted by the server when `~/.worca/workspace-runs/<id>.json` (pointer file) or `{workspace_root}/.worca/workspace-runs/<run_id>/workspace-manifest.json` changes. Payload: `{ workspace_id, status, completed_children, failed_children, dag: { tiers: [...] }, integration_test: {...}, children: [{run_id, project_path, status, tier}] }`. **This is a dedicated event type — separate from W-040's `fleet-update`.** The earlier proposal in this plan to reuse `fleet-update` for both manifest types (distinguished by a `workspace_id` field presence) is **rejected** in favor of W-040 §13.5's binding contract: one event type per server-side source. Multiplexing was rejected because it forced every consumer to inspect a sibling field; categorical events match the protocol's existing pattern.
- **New event type:** `workspace-tier-update` — emitted when tier status changes (e.g., tier 0 → completed). Payload: `{ workspace_id, tier, status, repos: [...] }`. Used by the dashboard tier renderer to update without a full re-fetch. (Sub-type of workspace state — kept separate from `workspace-update` because dashboard tier rendering needs higher-frequency updates than full-manifest reloads warrant.)
- **New event type:** `guide-conflict` — emitted when an agent flags a divergence. Payload: `{ run_id, workspace_id, fleet_id, stage, message }`. Drives the run-card warning icon in §10.8. The payload's `workspace_id` and `fleet_id` are nullable; **at most one is set** (W-048 §5 mutual-exclusion rule). The `run_id` is always set.
- **Protocol allowlist:** Add `'workspace-update'`, `'workspace-tier-update'`, and `'guide-conflict'` to `worca-ui/app/protocol.js`.

#### 10.10 REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/workspaces/scan` | Body: `{ parent_path }`. Returns discovered repos with role hints. Reuses W-039 `/api/scan-directory` infrastructure with `.git/` filtering. |
| `POST` | `/api/workspaces` | Create workspace.json. Body: full workspace definition. Validates against `workspace.json` schema and runs cycle detection server-side. |
| `GET` | `/api/workspaces` | List workspaces from `~/.worca/workspaces.d/`. |
| `GET` | `/api/workspaces/:name` | Workspace.json + per-repo metadata. |
| `PUT` | `/api/workspaces/:name` | **Edit workspace.json** (§10.2.5). Validates schema + cycles. 422 on cycle/missing-dep; 409 if any active workspace run targets this workspace (warning, not block — caller can include `?force=1` after confirming snapshot semantics). |
| `POST` | `/api/workspace-runs` | Launch. Body (multipart): `{ workspace_name, prompt|source, guide_files (parts), plan_mode, ... }`. Saves uploaded guides under `{workspace_root}/.worca/workspace-runs/<run_id>/guides/` (matching W-040 §3.5 pattern, scoped to workspace root). Returns `{ workspace_id }`. |
| `POST` | `/api/workspace-runs/validate-gh-auth` | **Pre-flight gh auth check (§10.3).** Body: `{ workspace_name }`. Server resolves each repo's GitHub org via `git remote get-url origin`, runs `gh auth status` per unique org, returns `{ ok, missing_orgs: [{ host, org, login_command }] }`. Used by launcher to gate submit. |
| `POST` | `/api/workspace-runs/validate-base` | Pre-flight that `base_branch` exists in every workspace repo. Body: `{ workspace_name, base_branch }`. Same shape as W-040 `/api/fleet-runs/validate-base`. |
| `GET` | `/api/workspace-runs` | List workspace runs from `~/.worca/workspace-runs/*.json` pointer files. **Follows pointers across projects** so workspaces are discoverable from the global multi-project UI. |
| `GET` | `/api/workspace-runs/:id` | Full manifest + enriched child status + DAG state + aggregate cost rollup. |
| `DELETE` | `/api/workspace-runs/:id` | Halt unstarted children. With `?cleanup=1` (§10.5 Cleanup workspace button), additionally invokes `worca cleanup --workspace-id <id>` after halt. With `?force=1`, bypasses the resume-loss precondition. Returns 412 (Precondition Failed) on cleanup of `halted`/`failed`/`integration_failed` workspaces without `?force=1`. |
| `POST` | `/api/workspace-runs/:id/resume` | Resume failed/blocked children. Reuses cached plan. Returns 410 (Gone) if any child's worktree was previously cleaned (resume impossible — see §6 retention policy). |
| `POST` | `/api/workspace-runs/:id/relaunch` | "Re-run workspace" action (§10.5). Body: optional overrides. Returns `{ new_workspace_id }`. |
| `POST` | `/api/workspace-runs/:id/re-run-integration` | Re-run integration test only. |
| `GET` | `/api/workspace-runs/:id/plan` | Workspace plan markdown + JSON. |
| `PUT` | `/api/workspace-runs/:id/plan` | Save edited workspace-plan.json (only when status is halted/failed/integration_failed; 409 otherwise). |
| `GET` | `/api/workspace-runs/:id/guide` | Concatenated guide content (opt-in, not in default payload). 404 with `error: "guide_not_retrievable"` for CLI-supplied paths the server can't read (matches W-040 §13.6 fallback). |
| `GET` | `/api/workspace-runs/:id/integration-log` | Integration test output (text/plain). |
| `GET` | `/api/workspace-runs/:id/context/:repo` | Context artifact for a dependency edge (markdown). |

#### 10.11 UI Test Coverage

| File | Coverage |
|------|----------|
| `worca-ui/app/views/workspace-create.test.js` (new) | Scan returns repos; checklist toggles; dependency editor (dag-graph mode=`"edit"`) updates DAG preview; cycle detection disables submit; **empty-state fallback**: zero registered projects shows the alert and free-form input still works; **Browse fallback** (if shipped) extracts parent path via webkitdirectory; integration test fields; submit POSTs correct payload. |
| `worca-ui/app/views/workspace-edit.test.js` (new, §10.2.5) | Pre-fills from current workspace.json; remove + re-scan adds repos; PUT `/api/workspaces/:name` payload correct; snapshot banner visible when active runs exist; "Run worca init in newly-added repos" action visible only on additive diff. |
| `worca-ui/app/views/workspace-detail.test.js` (new) | Renders DAG (mode=`"navigate"`), plan panel, context artifacts, **aggregate cost panel**, integration log, PR table with "Copy all PR URLs"; edit-plan dialog uses `<sl-textarea>` (NOT Monaco) and is visible only when halted/failed/integration_failed; re-run integration button visible when integration_failed; **Cleanup workspace** button shows resume-loss warning + checkbox for non-completed states; "Re-run workspace" pre-fills launcher; "Edit workspace.json" link routes to workspace-edit. |
| `worca-ui/app/views/dag-graph.test.js` (new) | Layout: 3-tier linear chain renders correctly; diamond renders correctly; cycles render with red highlight; **mode prop discrimination**: `"navigate"` emits `node-navigate`, `"edit"` emits `node-edit`, `"preview"` is non-interactive; edge stroke is status-derived in `"navigate"` and neutral in `"edit"`/`"preview"`. |
| `worca-ui/app/views/dashboard.test.js` (extend) | Workspace tier sub-grouping renders for `group_type === "workspace"` runs (W-048 §5 rule — never derived from workspace_id presence alone); tier labels and integration test row present. |
| `worca-ui/app/views/fleet-launcher.test.js` (extend) | Workspace mode toggle reveals workspace select + DAG preview (mode=`"preview"`) + 4-option plan toggle whose options match the §10.3 enumeration table; workspace-mode head-template default is `workspace/{slug}/{repo}`; **gh auth pre-flight check disables submit when `validate-gh-auth` returns missing orgs**; missing-org rows include the exact `gh auth login` command; "Skip auth check" escape hatch re-enables submit. |
| `worca-ui/app/views/run-card.test.js` (extend) | Guide-conflict warning icon renders when `GUIDE_CONFLICT` events present; hidden otherwise. |
| `worca-ui/app/views/run-detail.test.js` (extend) | Guide Conflicts panel renders with grouped events; "View source" scrolls to stage tab. |
| `worca-ui/server/workspace-routes.test.js` (new) | All endpoints from §10.10 — contract + error paths (404; 409 on edit-plan when running; 422 on cycle in submitted DAG; 412 on cleanup of halted/failed/integration_failed without `?force=1`; 410 on resume after worktree cleanup; `validate-gh-auth` returns missing-orgs list with login commands; `validate-base` returns missing-in list; PUT `/api/workspaces/:name` 409 with `?force=1` override). |
| `worca-ui/server/workspace-routes-guide-upload.test.js` (new) | Multipart upload lands files under `{workspace_root}/.worca/workspace-runs/<run_id>/guides/` per W-040 §3.5 pattern; manifest `guide.uploaded === true` for UI uploads. |
| `worca-ui/app/views/sidebar.test.js` (extend) | "Workspaces" entry hidden when zero workspaces, visible when workspaces exist (per W-048 §13.7 flat layout — NOT nested under a "Multi-Repo" group); count badge shows active workspace count; badge variant flips to warning when any workspace halted; "+ New Workspace" option appears in the New Pipeline dropdown and routes correctly based on whether workspace.json exists. |
| `worca-ui/app/views/sidebar-status-badges.test.js` (extend) | New `planning`, `integration_testing`, `integration_failed`, `blocked` badge cases. |
| `worca-ui/test/ws-integration.test.js` (extend) | `workspace-update`, `workspace-tier-update`, `guide-conflict` event subscription and rendering; **`workspace-update` is a separate event type from `fleet-update`** (negative test: a `fleet-update` payload never carries workspace data and vice versa); `guide-conflict` payload has at most one of `fleet_id`/`workspace_id` set (W-048 §5 enforcement). |
| `worca-ui/e2e/workspaces.spec.js` (new, Playwright `--workers=1`) | End-to-end: create workspace from UI (verifying empty-state fallback when no projects registered), launch run with multipart guide upload, observe tier progression, halt mid-tier, edit plan with `<sl-textarea>`, resume, see PR table; also exercise edit-workspace.json flow (add repo, save, verify next launch picks up change). |

#### 10.12 Files Added/Touched for §10

| File | Change |
|------|--------|
| `worca-ui/app/views/sidebar.js` | "Multi-Repo > Workspaces" nav entry (extends W-040's nav) |
| `worca-ui/app/views/dashboard.js` | Workspace tier sub-grouping inside fleet groups |
| `worca-ui/app/views/multi-dashboard.js` | Workspace tier sub-grouping for global view |
| `worca-ui/app/views/workspace-create.js` | **New** — workspace creation flow (§10.2) |
| `worca-ui/app/views/workspace-detail.js` | **New** — DAG, plan, integration log, PR table (§10.5) |
| `worca-ui/app/views/dag-graph.js` | **New** — shared SVG DAG renderer (§10.6) |
| `worca-ui/app/views/fleet-launcher.js` | Extend with workspace mode toggle (§10.3) |
| `worca-ui/app/views/run-card.js` | Guide-conflict warning icon (§10.8) |
| `worca-ui/app/views/run-detail.js` | Guide Conflicts panel (§10.8) |
| `worca-ui/app/protocol.js` | Add `'workspace-tier-update'`, `'guide-conflict'` to allowlist |
| `worca-ui/server/workspace-routes.js` | **New** — REST endpoints from §10.10 |
| `worca-ui/server/ws-modular.js` | Workspace manifest watcher; `workspace-tier-update` and `guide-conflict` emitters |
| `worca-ui/app/styles.css` | Tier styling, DAG styling, conflict-icon color |
| `src/worca/events/types.py` | Add `GUIDE_CONFLICT` event type |
| Tests above | **New / extended** |

## Implementation Plan

### Phase 1: Workspace definition & CLI scaffold

**Files:** `src/worca/workspace/manifest.py` (new), `src/worca/cli/workspace.py` (new), `src/worca/scripts/run_workspace.py` (new), `src/worca/scripts/run_worktree.py` (extend)

**Tasks:**
1. Define `workspace.json` schema in `src/worca/schemas/workspace.json`.
2. Add `Workspace` dataclass in `src/worca/workspace/manifest.py` — load, validate, cycle-detect in dependency graph, compute tiers.
3. Add `worca workspace init /path` command in `src/worca/cli/workspace.py` — scan for `.git/` children, generate `workspace.json`, create `.worca/`.
4. Scaffold `run_workspace.py` with arg parsing, workspace loading, and `--dry-run` (prints DAG, no dispatch).
5. Add `--workspace-id <id>` flag to `run_worktree.py`; pass through to `register_pipeline(workspace_id=..., group_type="workspace")`. **Enforce W-048 §5 mutual exclusion:** `register_pipeline` raises if both `fleet_id` and `workspace_id` are passed (already added in W-040 Phase 2 task 5; verify here).

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
1. Implement `DagExecutor` class — accepts tiers from phase 1, dispatches each tier via `ThreadPoolExecutor` calling `run_worktree.py` with `cwd=repo_dir`, **`--workspace-id workspace_id`** (NOT `--fleet-id`; binding W-048 §5 rule from §8), and per-child env vars `WORCA_WORKSPACE_ID`, `WORCA_WORKSPACE_NAME`, `WORCA_DEFER_PR=1`. These env vars are set explicitly per-child (not inherited from the parent process) so they survive W-040's env scrub list.
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
4. Re-generate context artifacts from already-completed children before resuming. This requires completed children's worktrees to still exist. **Worktree retention policy:** worktrees are NOT cleaned up until the entire workspace run reaches terminal status (`completed` or manually cancelled). This is critical for resume — a cleaned-up worktree means context artifacts and branch state are lost. Disk usage scales with `N repos x worktree size` for the full workspace run duration; the pre-flight check (see Considerations) warns about this.
5. If integration test failed: `--resume` re-runs only the integration test (children are already complete).
6. `worca cleanup --workspace-id <workspace_id>` (extends W-048's pluggable cleanup-source model — see W-048 §12) removes all child worktrees, the workspace run directory under `{workspace_root}/.worca/workspace-runs/{run_id}/`, the integration-env worktrees under `{workspace_root}/.worca/integration-env/`, and the `pipelines.d/` entries for the workspace's children. Add `WorkspaceSource` to `CLEANUP_SOURCES` in `src/worca/cli/cleanup.py` rather than introducing a separate `worca workspace cleanup` subcommand — keeps a single user entry point for all cleanup.

### Phase 7: UI integration (see §10 for full surface)

**Files:** `worca-ui/server/workspace-routes.js` (new), `worca-ui/app/views/workspace-create.js` (new), `worca-ui/app/views/workspace-edit.js` (new), `worca-ui/app/views/workspace-detail.js` (new), `worca-ui/app/views/dag-graph.js` (new), `worca-ui/app/views/launcher-shared.js` (new), `worca-ui/app/views/dashboard.js`, `worca-ui/app/views/multi-dashboard.js`, `worca-ui/app/views/sidebar.js`, `worca-ui/app/views/fleet-launcher.js`, `worca-ui/app/views/run-card.js`, `worca-ui/app/views/run-detail.js`, `worca-ui/app/protocol.js`, `worca-ui/server/ws-modular.js`, `worca-ui/app/styles.css`, `src/worca/events/types.py`

**Sequencing constraint:** This phase must NOT start until W-040's UI Phase 4 is shipped — both share `fleet-launcher.js` and would conflict. After W-040 Phase 4 ships, this phase can begin.

**Tasks:**
1. Implement REST endpoints from §10.10 in `workspace-routes.js` — scan, CRUD, run lifecycle (with cleanup resume-loss gate), plan edit, integration re-run, context artifact fetch, **`validate-gh-auth` and `validate-base` pre-flight endpoints**, multipart guide upload landing in `{workspace_root}/.worca/workspace-runs/<run_id>/guides/`, **`PUT /api/workspaces/:name` for workspace.json edits**.
2. Build the shared `dag-graph.js` SVG renderer per §10.6 (reused by `workspace-create.js`, `workspace-edit.js`, `workspace-detail.js`, and launcher preview — `mode` prop discriminates).
3. Build `workspace-create.js` per §10.2 — parent picker with **empty-state fallback for zero registered projects**, repo checklist, dependency editor with live DAG preview (mode=`"edit"`) + cycle detection.
4. Build `workspace-edit.js` per §10.2.5 — pre-fills from current workspace.json, snapshot-semantics banner, optional re-trigger of per-repo `worca init --upgrade` for newly-added repos.
5. Build `workspace-detail.js` per §10.5 — DAG (mode=`"navigate"`), **plain `<sl-textarea>` plan editor (NOT Monaco)**, context artifacts tabs, **aggregate cost panel**, integration log, PR table with "Copy all PR URLs", halt/resume/cleanup/re-run actions with resume-loss confirmation.
6. **Extract shared launcher subcomponents into `launcher-shared.js`** (guide upload, head-template input, plan-mode radio shell, token-overhead gate) so fleet-mode and workspace-mode of `fleet-launcher.js` consume the same building blocks.
7. Extend `fleet-launcher.js` per §10.3 — workspace mode toggle, workspace select, **explicit 4-option plan radio per §10.3 enumeration table** (mapped against W-040's 3 fleet options), **pre-launch DAG preview (mode=`"preview"`)**, **gh auth pre-flight (`validate-gh-auth`) gating submit with per-org login commands**.
8. Extend `dashboard.js` and `multi-dashboard.js` per §10.4 — tier sub-grouping when `group_type === "workspace"` (membership via `workspace_id`, never inferred from `workspace_id != null`), tier labels, integration test pseudo-tier row, blocked-child tooltips.
9. Extend `sidebar.js` per §10.1 — "Workspaces" flat-sibling nav entry under Pipeline (NOT nested under "Multi-Repo"), count badge, "+ New Workspace" option in the New Pipeline dropdown.
10. Add guide-conflict surfacing per §10.8 — `GUIDE_CONFLICT` event type in `events/types.py` (with W-048 §5 mutual-exclusion enforcement on payload `fleet_id`/`workspace_id`), agent emission instructions in `planner.md`/`reviewer.md`/`tester.md` (already covered in W-040 Phase 1 — verify wired); warning icon in `run-card.js`, Guide Conflicts panel in `run-detail.js`.
11. Add `'workspace-update'`, `'workspace-tier-update'`, `'guide-conflict'` to `protocol.js` allowlist (each is a separate event type; never multiplexed with `fleet-update`); emit from `ws-modular.js` workspace manifest watcher.
12. Wire badge color mappings for `planning`, `integration_testing`, `integration_failed`, `blocked` per §10.7.

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
| `src/worca/agents/core/guardian.md` | Workspace-aware PR description when `WORCA_WORKSPACE_ID` set; defer PR creation when `WORCA_DEFER_PR=1` |
| `src/worca/state/status.py` | Extend with canonical `PipelineStatus`, `FleetStatus`, `WorkspaceStatus` enums and helpers (extends the existing module, no new file) |
| `.claude/worca/settings.json` | Add `worca.workspace.*` defaults |
| `worca-ui/server/workspace-routes.js` | **New** — workspace REST endpoints (§10.10) including multipart guide upload, validate-gh-auth, validate-base, edit workspace.json, cleanup with resume gate, relaunch |
| `worca-ui/server/ws-modular.js` | Workspace manifest watcher; emits `workspace-update`, `workspace-tier-update`, `guide-conflict` (separate event types per §10.9 — never multiplexed with W-040's `fleet-update`) |
| `worca-ui/app/views/workspace-create.js` | **New** — workspace creation flow with live DAG (§10.2), empty-state fallback for zero registered projects, optional Browse... button |
| `worca-ui/app/views/workspace-edit.js` | **New** — workspace.json edit flow (§10.2.5) |
| `worca-ui/app/views/workspace-detail.js` | **New** — DAG (mode=`"navigate"`), plan editor (`<sl-textarea>`, NOT Monaco), aggregate cost panel, integration log, PR table with "Copy all PR URLs", halt/resume/cleanup/re-run actions with resume-loss gate (§10.5) |
| `worca-ui/app/views/dag-graph.js` | **New** — shared SVG DAG renderer with `mode` prop (§10.6) — used in workspace-detail (`navigate`), workspace-create (`edit`), workspace-edit (`edit`), launcher preview (`preview`) |
| `worca-ui/app/views/launcher-shared.js` | **New** — extracted subcomponents shared between fleet-launcher and workspace-launcher modes (guide upload, head-template input, plan-mode radio shell, token-overhead gate) per §10.3 — avoids drift between the two launcher modes |
| `worca-ui/app/views/dashboard.js` | Workspace tier sub-grouping inside fleet groups (§10.4) |
| `worca-ui/app/views/multi-dashboard.js` | Workspace tier sub-grouping in compact pipeline-card view (uses `selectParallelPipelines` from W-048 §6.5; groups by `workspace_id` when `group_type === "workspace"`) |
| `worca-ui/app/views/sidebar.js` | "Workspaces" nav entry per W-048 §13.7 layout (flat sibling under Pipeline section, NOT nested under "Multi-Repo"); "+ New Workspace" option in the New Pipeline dropdown |
| `worca-ui/app/views/fleet-launcher.js` | Workspace mode toggle + DAG preview + 4-option plan radio per §10.3 enumeration table; gh auth pre-flight check |
| `worca-ui/app/views/run-card.js` | Guide-conflict warning icon (§10.8) |
| `worca-ui/app/views/run-detail.js` | Guide Conflicts panel (§10.8) |
| `worca-ui/app/protocol.js` | Add `'workspace-update'`, `'workspace-tier-update'`, `'guide-conflict'` to allowlist |
| `src/worca/events/types.py` | Add `GUIDE_CONFLICT` event type |
| `worca-ui/app/styles.css` | Tier styling, DAG styling, conflict-icon color |
| `CLAUDE.md` | Workspace Runs section |
| `MIGRATION.md` | Release note |
| `docs/workspace-runs.md` | **New** — user-facing walkthrough |

## Considerations

- **Fleet reuse, not replacement.** Workspace runs build on fleet infrastructure — `run_worktree.py` dispatch, circuit breaker, `--resume`, guide injection, UI grouping primitives. Fleet continues to serve its purpose (same-prompt fan-out) unchanged.
- **Grouping field discipline (binding W-048 §5 contract).** Workspace children set `workspace_id` + `group_type="workspace"` — NEVER `fleet_id`. Fleet children set `fleet_id` + `group_type="fleet"` — NEVER `workspace_id`. UI consumers branch on `group_type` for rendering style and use the explicit ID field for membership. The earlier proposal in this plan to overload `fleet_id` with the workspace ID is **superseded** by W-048 §5's authoritative rule. The `register_pipeline()` helper enforces mutual exclusion at write time.
- **Cleanup verb consistency (binding contract).** All artifact-removal surfaces (W-048 worktree view, W-040 fleet detail, this plan's workspace detail) use the verb **"Cleanup"** — not "Remove", "Delete", or "Discard". Single verb across plans reduces cognitive load.
- **Event channel discipline (binding W-040 §13.5 contract).** `workspace-update` is a dedicated event type for workspace manifests; `fleet-update` is dedicated to fleet manifests. They are NEVER multiplexed. `workspace-tier-update` and `guide-conflict` are sub-events of workspace state with their own channels.
- **Sidebar layout (binding W-048 §13.7 contract).** Workspaces is a flat sibling under the Pipeline section, NOT nested under a "Multi-Repo" parent. "+ New Workspace" is added to the existing CTA dropdown.
- **Child pipelines are standard.** Each repo's pipeline runs the full stage sequence with all existing governance. No hooks, agents, or stage machinery are modified (except guardian gaining workspace-aware PR descriptions).
- **DAG ordering is tier-based, not fine-grained.** Repos in the same tier run in parallel. This is simpler than a full DAG scheduler and sufficient for typical multi-repo topologies (which are usually shallow: 2–3 tiers).
- **Context injection is one-way.** Tier N's output is injected as read-only context into tier N+1. There is no back-channel — if tier 1 discovers that tier 0's API is wrong, the workspace run must be restarted. This is a deliberate simplification; iterative cross-tier negotiation would require fundamentally different agent architecture.
- **`--resume` reuses the original master plan.** The workspace plan is generated once during the initial `run_workspace.py` invocation and cached at `{workspace_root}/.worca/workspace-runs/{run_id}/workspace-plan.json`. `--resume <workspace_id>` re-uses this cached plan as-is and only re-launches failed/blocked children. If the master planner's original assumptions turn out to be wrong (e.g., it underestimated the dependency between `frontend` and `shared-lib`), `--resume` will keep dispatching against the stale plan. Mitigation paths: (a) restart the workspace run with a new `workspace_id` to force re-planning; (b) edit `workspace-plan.json` by hand before resuming. A `--re-plan` flag that re-invokes the master planner before resume is **out of scope for this plan** but explicitly listed in Future Work.
- **Integration test is opaque.** Worca runs the user's command and checks the exit code. It does not parse test output, identify failing tests, or retry. The user is responsible for providing a working integration test command.
- **PR merge order is advisory, not enforced.** The umbrella issue documents merge order. Worca does not auto-merge or block out-of-order merges. Enforcement would require GitHub branch protection rules or a merge bot, which is out of scope.
- **Workspace root is not a git repo.** The parent directory does not need its own `.git/`. `workspace.json` and `.worca/` live there but are not version-controlled (unless the user chooses to create a meta-repo). This avoids forcing a monorepo structure.
- **Breaking changes:** **None.** Workspace is a new entry point and new agents. Existing fleet and pipeline flows are unchanged. A new `group_type` field is added to `pipelines.d/` entries (optional, defaults to `"fleet"`) to distinguish workspace from fleet runs.
- **Token cost.** The master planner adds one Opus call per workspace run (~20KB input from truncated `CLAUDE.md` files + workspace.json + prompt). Context injection adds guide content proportional to diff size (capped at 8KB per dependency edge, with smart prioritization of public API files). For a 3-repo workspace with 2 tiers, overhead is ~1 planner call + ~16KB of guide content — modest.
- **Governance.** Existing per-repo governance is preserved. The master planner produces structured JSON output; the orchestrator writes plan files (no new file-write permissions needed in the guard hook). The workspace coordinator cannot commit (only the guardian in each child can). `WORCA_DEFER_PR=1` defers PR creation to after integration tests, adding a new governance control (PRs are only created when the full workspace passes). No governance bypass paths are introduced.
- **Disk space.** Worktrees are retained for the entire workspace run (required for resume and context artifact regeneration). For a 5-repo workspace averaging 200MB per repo, this is ~1GB of worktree copies plus another ~1GB during the integration-env phase (a 2× factor — the integration test creates a parallel set of worktrees so total peak usage is ~2GB for the example above). `run_workspace.py` runs a pre-flight disk space estimate that accounts for this 2× peak and warns if available space is insufficient. `worca cleanup --workspace-id <id>` (W-048's pluggable cleanup, extended in this plan) provides manual removal after the run completes.
- **Status vocabulary.** Workspace adds statuses `planning`, `integration_testing`, and `integration_failed` that have no analogs in fleet or pipeline status enums. The UI must handle these as workspace-specific extensions. The existing `src/worca/state/status.py` module is the canonical home for status helpers (`load_status`, `save_status`, `PIPELINE_STAGES`); extend it in this plan with three explicit enum classes — `PipelineStatus`, `FleetStatus`, `WorkspaceStatus` — that share the common terminal vocabulary (`completed`, `failed`, `cancelled`) and add level-specific values (workspace adds `planning`, `integration_testing`, `integration_failed`; fleet adds `halted`). Do not create a separate `status_enum.py` — keeping enums and I/O in the same module avoids the two-file drift seen in earlier worca refactors.

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
| Python | `tests/test_integration_test.py::test_env_setup` | Integration environment worktrees created at `.worca/integration-env/{repo}/` with correct branches |
| Python | `tests/test_integration_test.py::test_env_cleanup` | Integration environment worktrees removed after test (pass or fail) |
| Python | `tests/test_integration_test.py::test_pass` | Exit code 0 → workspace status `completed`, PRs created |
| Python | `tests/test_integration_test.py::test_fail` | Exit code 1 → workspace status `integration_failed`, no PRs created |
| Python | `tests/test_integration_test.py::test_skip` | No `integration_test` in workspace.json → skipped with warning |
| Python | `tests/test_deferred_pr.py::test_defer_pr_env` | `WORCA_DEFER_PR=1` causes guardian to commit+push but skip `gh pr create` |
| Python | `tests/test_deferred_pr.py::test_central_pr_creation` | `run_workspace.py` creates PRs via `gh pr create --repo` after integration pass |
| Python | `tests/test_pr_linker.py::test_dependency_comments` | Each PR gets a comment listing deps and dependents |
| Python | `tests/test_pr_linker.py::test_umbrella_issue` | Umbrella issue created with checklist in merge order |
| Python | `tests/test_workspace_resume.py::test_resume_partial_tier` | Only failed/blocked children in incomplete tier re-launched |
| Python | `tests/test_workspace_resume.py::test_resume_integration_only` | All children complete, integration failed → re-runs only integration test |
| Python | `tests/test_workspace_resume.py::test_tier_failure_and_integration_failure_combo` | Mock both: tier-1 child fails AND integration test would fail. Assert: workspace status `failed` (tier failure dominates over integration); `--resume` re-runs only the failed tier child; integration test runs only after tier passes. Closes the combination-mode gap. |
| Python | `tests/test_guide_conflict_emission.py::test_planner_emits_on_description_conflict` | Mock claude in planner stage emits a conflict; assert `events.GUIDE_CONFLICT` fires with `stage: "planner"`, `source: "description"`, correct `run_id` and `workspace_id`/`fleet_id` per W-048 §5 mutual-exclusion rule. |
| Python | `tests/test_guide_conflict_emission.py::test_reviewer_emits_on_plan_conflict` | Reviewer stage emits conflict when plan diverges from guide; assert `source: "plan"`. |
| Python | `tests/test_guide_conflict_emission.py::test_tester_emits_on_plan_conflict` | Tester stage emits conflict; assert event reaches the WS broadcaster. |
| Python | `tests/test_guide_conflict_emission.py::test_no_emission_when_no_conflict` | Negative test: agents complete normally, no `GUIDE_CONFLICT` event fires. Closes the "UI surface that never lights up" risk. |
| Python | `tests/test_workspace_edit.py::test_put_workspace_persists` | `PUT /api/workspaces/:name` writes new workspace.json; cycle detection rejects invalid DAG. |
| Python | `tests/test_workspace_edit.py::test_active_runs_use_snapshot` | Active workspace run continues using the workspace.json snapshot from launch time even after the file is edited; verifies snapshot semantics. |
| Python | `tests/test_workspace_validate_gh_auth.py::test_returns_missing_orgs` | Mock `gh auth status` failure for one org; assert endpoint returns `{ ok: false, missing_orgs: [...] }` with login command. |
| Python | `tests/test_registry_grouping.py::test_workspace_id_only_for_workspace` | A workspace child registry entry has `workspace_id` set, `fleet_id` is `None`, `group_type == "workspace"`. Inverse for fleet child. Enforces W-048 §5 mutual-exclusion rule end-to-end (mirrors W-040 test). |
| Python | `tests/test_registry_grouping.py::test_register_pipeline_rejects_both_ids` | `register_pipeline(fleet_id="x", workspace_id="y")` raises ValueError. |
| UI (vitest) | `worca-ui/server/workspace-routes.test.js` | REST endpoint contract (covered above in §10.11) |
| UI (vitest) | `worca-ui/app/views/workspace-detail.test.js` | DAG render, tier status, integration badge (covered above in §10.11) |

### Integration / E2E Tests

- **Synthetic 3-repo workspace (pytest fixture).** `shared-lib → backend → frontend` topology. Mock claude produces minimal changes per repo. Asserts: 3 tiers execute in order, context artifacts generated between tiers, integration test runs, 3 PRs created with dependency comments, umbrella issue created.
- **Diamond dependency (pytest fixture).** `lib → [svc-a, svc-b] → gateway`. Asserts: tier 0 = lib, tier 1 = [svc-a, svc-b] (parallel), tier 2 = gateway (after both complete).
- **Failure propagation.** Mock `backend` to fail. Assert: `frontend` marked `blocked`, `shared-lib` completed, workspace status `failed`, `--resume` re-runs only `backend` + `frontend`.
- **Playwright (`--workers=1`).** Launch workspace via UI, observe tier-grouped progress, inspect workspace detail view (DAG, plan, integration log).
- **Full-stack integration (W-048 + W-040 + W-047).** This is the only test that catches inter-plan integration breakage and must live in this plan because it's the top of the dependency stack. Build a synthetic 3-repo workspace fixture and run the entire stack end-to-end with mock `claude`:
  1. Launch via `worca workspace run /path/to/synthetic-parent --prompt "..."`.
  2. Assert `run_workspace.py` calls `run_fleet.py` (W-040), which calls `run_worktree.py` per repo (W-048's launcher).
  3. Assert each child writes a `pipelines.d/` entry with: `fleet_id == workspace_id`, `group_type == "workspace"`, `target_branch` set, `worktree_path` populated.
  4. Assert `discoverRuns` (W-048's `watcher.js` step 5) returns all 3 child runs in a single `runs-list` payload, each enriched with `fleet_id`, `group_type`, and `target_branch`.
  5. Assert no duplicate broadcasts — the deleted `MultiWatcher` (W-048 §6.5) is not firing `pipeline-status-changed`.
  6. Assert the UI dashboard groups runs first by `group_type == "workspace"` (W-047 tier rendering), within that by tier from the workspace manifest.
  7. Assert the cleanup command (`worca cleanup --workspace-id ws_...`) removes worktrees, the workspace run directory, and the `pipelines.d/` entries together — exercising W-048's pluggable cleanup-source design.

### Existing Tests to Update

- W-040's `run_fleet.py` tests — verify that `group_type` field in `pipelines.d/` entries is correctly set to `"workspace"` for workspace children and `"fleet"` (or absent) for fleet children.
- Guardian agent tests — verify that when `WORCA_DEFER_PR=1` is set, the guardian commits and pushes but skips `gh pr create`. Verify workspace-aware PR description is emitted when `WORCA_WORKSPACE_ID` is set and standard description when it is not.

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

- **`--re-plan` flag for `--resume`.** Optional flag that re-invokes the master planner against the current state of all children's worktrees (with their accumulated diffs as context) before re-launching failed/blocked children. Useful when the original plan's dependency assumptions turned out to be wrong. Requires care: a re-plan may invalidate already-completed children, so the implementation must either (a) re-launch all children if the dependency graph changes, or (b) detect which completed children are still consistent with the new plan and leave them alone.
- **Iterative planning.** If a child pipeline's reviewer rejects changes with cross-repo implications, feed the rejection back to the master planner for re-decomposition.
- **Workspace templates.** Pre-defined workspace.json templates for common topologies (microservices, monorepo-split, library + consumers).
- **Cross-repo code navigation.** Inject workspace-level `CLAUDE.md` that maps the full architecture so agents can reason about cross-repo structure even within single-repo pipelines.
- **Merge orchestration.** Integration with GitHub merge queues or a lightweight merge-order enforcer that auto-merges PRs in dependency order once all are approved.
- **Remote workspace execution.** Distribute workspace tiers across multiple machines for large workspaces (10+ repos).
