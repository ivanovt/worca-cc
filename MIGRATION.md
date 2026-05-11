# Migrating worca-cc

## TL;DR

| Step | Command | Notes |
|------|---------|-------|
| 1. Upgrade package | `pip install --upgrade worca-cc==X.Y.Z` | Updates the Python package |
| 2. Refresh runtime | `cd <project> && worca init --upgrade` | Migrates settings, copies new runtime |
| 3. Manual cleanup | See [What you must delete manually](#what-you-must-delete-manually) | Only needed for projects that pre-date v0.6.0 packaging |

## How upgrades work

1. **`pip install --upgrade worca-cc==X.Y.Z`** updates the Python package globally (or in your venv). This does not touch any project files.

2. **`worca init --upgrade`** (run inside each project) refreshes the `.claude/worca/` runtime copy and migrates settings. Run this in every project that uses worca.

3. **Manual cleanup** may be required for projects that were initially set up before the v0.6.0 packaging migration (i.e., when worca files lived directly in `.claude/hooks/`, `.claude/scripts/`, etc.).

### Why manual cleanup is sometimes needed

`worca init --upgrade` includes a one-shot legacy cleanup function (`_cleanup_legacy_files` in `src/worca/cli/init.py`). However, this cleanup **only runs when `.claude/worca/__init__.py` has no `__version__` string** — meaning the project was set up via the old copy-paste method, not from a pip package.

Once a project has been upgraded to a versioned (packaged) install, the version check gate (`read_version(worca_dir) is not None`) causes the cleanup to be skipped on all subsequent upgrades. Legacy directories left behind by a previous pre-packaging install will persist silently.

## What `worca init --upgrade` handles automatically

### Settings path migrations

These old paths in `settings.json` are rewritten to their new locations:

| Old path | New path |
|----------|----------|
| `.claude/hooks/pre_tool_use.py` | `.claude/worca/claude_hooks/pre_tool_use.py` |
| `.claude/hooks/post_tool_use.py` | `.claude/worca/claude_hooks/post_tool_use.py` |
| `.claude/hooks/user_prompt_submit.py` | `.claude/worca/claude_hooks/user_prompt_submit.py` |
| `.claude/scripts/preflight_checks.py` | `.claude/worca/scripts/preflight_checks.py` |

Source: `_PATH_MIGRATIONS` in `src/worca/cli/init.py:108-118`.

### Settings key migrations

| Setting | Old value | New value | Context |
|---------|-----------|-----------|---------|
| `worca.stages.review.agent` | `guardian` | `reviewer` | W-037 agent rename |
| `worca.agent_overrides_dir` | `.claude/agents/overrides` | `.claude/agents` | Override dir flattening |

### Agent override directory migration

Override files are moved from `.claude/agents/overrides/*.md` to `.claude/agents/*.md` (flat). The empty `overrides/` directory is removed if no user files remain.

### Runtime copy

The entire `.claude/worca/` directory is replaced with a fresh copy from the installed package (excluding `cli/` and `__pycache__/`).

### Settings deep-merge

New default keys from the package's `src/worca/settings.json` are merged into the project's `.claude/settings.json` **non-destructively**: missing keys are added, but existing user values are preserved. This means user-chosen agent models (`worca.agents.<name>.model`), custom `permissions.allow` entries, webhooks, loop counts, and other tuned values survive `--upgrade`.

Forward-incompatible renames (e.g. `stages.review.agent: guardian -> reviewer` in W-037) are applied explicitly via `_migrate_settings_paths` *before* the merge, so they land deterministically and show up under `worca init --check`.

If you want to hard-reset your settings to the current template, use `worca init --force` (destructive). Project-specific overrides that should never be touched by any upgrade still belong in `.claude/settings.local.json`.

### Global key extraction (W-049)

Four settings keys that are naturally global (apply across all projects) are extracted from `.claude/settings.json` into `~/.worca/settings.json`:

| Key (under `worca.`) | Default | Scope after migration |
|---|---|---|
| `parallel.cleanup_policy` | `never` | Global (`~/.worca/settings.json`) |
| `parallel.max_concurrent_pipelines` | `10` | Global |
| `ui.worktree_disk_warning_bytes` | `2000000000` | Global |
| `circuit_breaker.classifier_model` | `haiku` | Global |

If `~/.worca/settings.json` does not exist, it is created. Existing values in the global file are preserved (project values merge in). After extraction, the keys are removed from the project file.

Idempotent: runs silently on second invocation.

Source: `_migrate_global_keys_to_preferences` in `src/worca/cli/init.py`.

### Inert milestone key stripping (W-049)

`pr_approval` and `deploy_approval` under `worca.milestones` are removed from `.claude/settings.json` **if and only if** their value is exactly `true` (the old template default). Any other value (`false`, a string, etc.) is left alone as an intentional user override.

Why: these keys were inert before W-049 — the runner ignored them. After W-049, the runner gates on `pr_approval is True`, so leaving the template default in place would activate the PR-creation approval gate on every upgraded project, hanging autonomous flows.

Stripping the default lets the runner's missing-key behavior (`false`) take effect, keeping the gate opt-in.

If both keys are removed and `worca.milestones` becomes empty, the empty object is cleaned up.

Idempotent: runs silently on second invocation.

Source: `_strip_inert_milestone_keys` in `src/worca/cli/init.py`.

### .gitignore entries

These entries are added if missing: `.worca/`, `logs/`, `.claude/settings.local.json`.

### Beads

- `.beads/` is initialized if it doesn't exist.
- The beads repo fingerprint is updated on upgrade (`bd migrate --update-repo-id`).

### One-shot legacy cleanup (pre-packaging installs only)

On the **first** upgrade from a pre-packaging install (no version in `.claude/worca/__init__.py`), these are automatically removed:

- `.claude/hooks/` — files: `__init__.py`, `post_tool_use.py`, `pre_compact.py`, `pre_tool_use.py`, `session_end.py`, `session_start.py`, `stop.py`, `subagent_start.py`, `subagent_stop.py`, `user_prompt_submit.py`
- `.claude/scripts/` — files: `__init__.py`, `preflight_checks.py`, `run_batch.py`, `run_learn.py`, `run_multi.py`, `run_parallel.py`, `run_pipeline.py`, `worca.py`
- `.claude/agents/core/` — files: `coordinator.md`, `guardian.md`, `implementer.md`, `learner.md`, `plan_reviewer.md`, `planner.md`, `tester.md`
- `.claude/agents/domain/` — removed if it only contains `.gitkeep` and/or `.DS_Store`
- `.claude/worca-ui/` — entire directory

## What you must delete manually

If your project was set up before v0.6.0 and has since been upgraded past the version gate, the following directories and files may still exist. **None of them are read by any current code path** — they are safe to delete.

Run `worca init --check` first as a dry-run to see what the upgrade tool would do, then use the table below to identify leftover files.

### Obsolete files inventory

| Path | Replaced by | Still read by any code? | Safe to delete |
|------|-------------|------------------------|----------------|
| `.claude/hooks/` | `.claude/worca/claude_hooks/` | No — `settings.json` points to `.claude/worca/claude_hooks/` | Yes |
| `.claude/scripts/` | `.claude/worca/scripts/` | No — `settings.json` and CLI entry points use the packaged paths | Yes |
| `.claude/worca-ui/` | `@worca/ui` npm package (install globally) or the `worca-ui/` directory in the source repo | No — the embedded UI was fully removed | Yes |
| `.claude/agents/core/*.md` | `.claude/worca/agents/core/` (runtime copy from package) | No — see explanation below | Yes |
| `.claude/agents/domain/` | Nothing (empty scaffolding leftover) | No | Yes |
| `.claude/agents/overrides/` | `.claude/agents/` (flat, no subdirectory) | No — `agent_overrides_dir` defaults to `.claude/agents` | Yes |
| `__pycache__/` dirs inside any of the above | N/A | No | Yes |

### Why `.claude/agents/core/*.md` files are dead

This is the most confusing leftover. Three different `agents/core/` paths exist:

1. **`src/worca/agents/core/`** — the canonical templates in the pip package source tree.
2. **`.claude/worca/agents/core/`** — the runtime copy created by `worca init`. This is what the pipeline reads at runtime (`runner.py:257`).
3. **`.claude/agents/core/`** — the **old** pre-packaging location. **Nothing reads from here.**

The runtime (`runner.py`) resolves agent templates from `.claude/worca/agents/core/` only. Agent overrides live flat in `.claude/agents/<agent>.md` (no `core/` subdirectory). Claude Code's subagent discovery scans `.claude/agents/` flat — it does not recurse into `core/`.

Files in `.claude/agents/core/` are neither templates nor overrides. They are inert.

### Consolidated cleanup command

After verifying with `worca init --check`, run this from your project root:

```bash
cd .claude
rm -rf hooks/ scripts/ worca-ui/ agents/domain/ agents/overrides/
rm -f agents/core/coordinator.md agents/core/guardian.md agents/core/implementer.md \
     agents/core/learner.md agents/core/plan_reviewer.md agents/core/planner.md \
     agents/core/tester.md agents/core/reviewer.md
rmdir agents/core 2>/dev/null || true
find . -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
```

If `.claude/agents/core/` contains files you do not recognize (not in the list above), investigate before deleting — they may be custom files you created.

## Where overrides go now

| Type | Location | Example |
|------|----------|---------|
| Per-project agent override | `.claude/agents/<agent>.md` | `.claude/agents/implementer.md` |
| Per-project block override | `.claude/agents/<block>.block.md` | `.claude/agents/implement.block.md` |

Override modes:

- **Replace** (default): the override file replaces the base prompt entirely. No tag needed, or use `<!-- replace -->` explicitly.
- **Append** (`<!-- append -->`): sections are merged into the base using section-level merge. Use `## Override: <Section Name>` headings to target specific sections.
- **Governance protection**: sections marked `<!-- governance -->` in the base cannot be replaced by overrides (demoted to append with a warning).

For details, see the `/worca-agent-override` skill or `src/worca/orchestrator/overlay.py`.

## Verifying the upgrade

After upgrading and cleaning up, run these checks:

```bash
# 1. Dry-run check for drift
worca init --check

# 2. Verify .claude/ directory structure
ls .claude/
# Expected: agents/  settings.json  skills/  templates/  worca/
# Optional: settings.local.json  worktrees/

# 3. Confirm runtime version matches installed package
grep __version__ .claude/worca/__init__.py
python -c "import worca; print(worca.__version__)"
# Both should print the same version

# 4. Check settings.json has no stale paths
grep -c '.claude/hooks/' .claude/settings.json    # should be 0
grep -c '.claude/scripts/' .claude/settings.json  # should be 0 (except .claude/worca/scripts/ which is correct)
```

## Version-specific notes

### 0.5.0 → 0.6.0

The packaging migration. This is the release that moved pipeline code from `.claude/` into the `src/worca/` pip package.

- Agent templates moved from `.claude/agents/core/` to `src/worca/agents/core/` (runtime copy at `.claude/worca/agents/core/`)
- Hook scripts moved from `.claude/hooks/` to `src/worca/claude_hooks/`
- Agent overrides directory simplified from `.claude/agents/overrides/` to `.claude/agents/` (flat)
- `release.yml` merged into `release-pypi.yml`
- **Manual cleanup required** for projects that pre-date this release — see [What you must delete manually](#what-you-must-delete-manually)

### 0.6.x → 0.7.0

- Usage object logging added with model-specific pricing
- `DEFAULT_PRICING` removed from UI; pricing now sourced from `settings.json`
- Beads fingerprint upgrade added to `worca init`

### 0.7.0 → 0.8.0

- Pipeline templates system added (W-016)
- No path or settings migrations required

### 0.8.0 → 0.9.0

- Template agent prompt overrides wired through overlay resolver
- `milestones.plan_approval=false` now correctly auto-approves plans
- `pipeline.pid` moved to per-run directories for concurrent pipeline support

### 0.9.0 → 0.10.0+

- W-037: Agent prompts extracted into composable block files
- `stages.review.agent` renamed from `guardian` to `reviewer` (auto-migrated by `worca init --upgrade`)

### 0.15.x → 0.16.0

W-043: Unified pipeline state model and universal event dispatch.

**Breaking changes:**

1. **Terminal state for user-stop unified to `interrupted`** — Previously, stopping a running pipeline via the UI wrote `pipeline_status: "failed"`. Now all stop paths (control-file, webhook, signal) produce `"interrupted"` with a discriminating `stop_reason` (`control_file`, `control_webhook`, `signal`, `force_cancelled`). Code that checks for `"failed"` to detect user-initiated stops must now check for `"interrupted"` instead.

2. **`POST /runs/:id/stop` rejects dead-PID with 409** — If the pipeline process is no longer alive but `pipeline_status` is still `running` or `paused`, the stop endpoint now returns `409 { code: "no_running_process", suggested_action: "cancel" }` instead of silently rewriting the status. Use the cancel endpoint to clean up dead runs.

3. **`DELETE /runs/:id` removed** — The old DELETE alias for stopping a pipeline has been removed. Use `POST /runs/:id/stop` to stop a running pipeline. A new `POST /runs/:id/delete` endpoint permanently removes a run directory (refuses if the pipeline is still running).

4. **New `pipeline.run.cancelled` event type** — Cancelling a run via `POST /runs/:id/cancel` now emits a `pipeline.run.cancelled` event through the universal dispatch pipeline (webhooks, integrations). Previously, cancel was a silent status rewrite.

5. **`resuming` pipeline status removed** — The `resuming` status is no longer emitted by any code path. Pipelines go directly from `paused` to `running` on resume. UI components no longer render a `resuming` badge. The legacy `interrupted → paused` status mapping has also been removed — `interrupted` is now a canonical terminal state.

6. **Windows stop semantics** — On Windows, `SIGTERM` does not propagate to child processes. The stop flow now kills the agent subprocess directly via `agent.pid` when `process.platform === 'win32'`.

**No automatic migrations required** — these are runtime behavior changes. Update any external integrations or scripts that depend on the old behavior.

### 0.17.x → 0.18.0

W-048: Worktree-based pipeline isolation and unified run aggregation.

**Breaking changes:**

1. **`active_run` pointer file removed** — `.worca/active_run` is no longer written by any code path. External tools or scripts that read this file will get no data. Replace with scanning `.worca/runs/*/status.json` for non-terminal runs (`pipeline_status` not in `completed`, `failed`, `interrupted`). The stale file is deleted on the next `worca init --upgrade`.

2. **`run_multi.py` and `run_batch.py` removed** — Both batch entry points are gone. Use `run_worktree.py` (one call per pipeline) or a shell loop as a replacement:
   ```bash
   # Old (run_multi.py accepted --requests)
   python .claude/worca/scripts/run_multi.py --requests req1.json req2.json
   # New
   for req in req1.json req2.json; do
     python .claude/worca/scripts/run_worktree.py --source "$req" &
   done
   ```

3. **WebSocket protocol: 5 pipeline-* message types removed** — The `MultiWatcher`-based pipeline subscription protocol has been retired. The following message types are no longer emitted or accepted by the server:
   - `list-pipelines`
   - `subscribe-pipeline`
   - `unsubscribe-pipeline`
   - `pipeline-status-changed`
   - `pipelines-list`

   **Third-party WebSocket subscribers using any of these types will break.** Migrate to the unified run subscription protocol: subscribe via `subscribe-run` (or receive `runs-list` broadcasts) which now includes worktree runs alongside root runs. The `state.pipelines` client-side map is derived from `state.runs` — no separate pipeline subscription needed.

4. **`MultiWatcher` server module removed** — `worca-ui/server/multi-watcher.js` is deleted. If any custom server code references `MultiWatcher`, `WatcherSet#getMultiWatcher`, or `WatcherSet#_createMultiWatcher`, remove those references.

5. **'Pipeline already running' block removed from new-run UI** — Starting a new run no longer fails when a pipeline is already running. Each run spawns in its own isolated git worktree, so multiple concurrent pipelines are supported. External integrations that relied on the `422 Pipeline already running` error from `POST /runs` (or the equivalent WS rejection) must remove that error-handling branch.

**New features / commands:**

- **`run_worktree.py`** — single-pipeline worktree launcher. Creates a git worktree, registers in `pipelines.d/`, and spawns `run_pipeline.py` inside the worktree. Accepts `--prompt`, `--source`, `--plan`, `--branch`, `--guide`, `--fleet-id`.
- **`--guide` flag on `run_pipeline.py`** — Pass a reference guide (repeatable) into the pipeline. Requires W-040 (`attach_guide()`) to be installed; emits a fatal error otherwise rather than silently dropping the content.
- **`worca cleanup`** — Remove completed/failed pipeline worktrees from disk and from the `pipelines.d/` registry. Running worktrees are never eligible. Options: `--all`, `--run-id`, `--dry-run`, `--older-than`.
- **`pipelines.d/` fan-out in `discoverRuns`** — Worktree runs are now visible in the unified runs list alongside root project runs. No UI changes required.

**No automatic migrations required** — these are runtime behavior and protocol changes. Run `worca init --upgrade` once to remove the stale `active_run` file from `.worca/`. Update any external integrations or scripts that depend on the removed batch scripts, WebSocket protocol types, or `active_run` file.

### 0.18.x → 0.19.0

W-049: Settings UI for execution, approval gates, circuit breaker, and worktree disk threshold.

**Default changes:**

| Setting | Old default | New default | Rationale |
|---|---|---|---|
| `cleanup_policy` | `on-success` | `never` | Auto-deletion would silently break worktree inspection workflows |
| `max_concurrent_pipelines` | `3` | `10` | A cap of 3 immediately blocks users with 4+ projects |
| `pr_approval` | `true` (inert) | `false` (active) | Default-true would hang every autonomous run at the PR-creation gate |

**Project/global settings split:**

Four keys move from project-scoped (`.claude/settings.json`) to global-scoped (`~/.worca/settings.json`): `cleanup_policy`, `max_concurrent_pipelines`, `worktree_disk_warning_bytes`, `classifier_model`. The canonical list and defaults live in `src/worca/schemas/keys.json`.

**Automatic migration via `worca init --upgrade`:**

1. Global keys are extracted from the project file into `~/.worca/settings.json` (created if absent).
2. Template-default `pr_approval: true` and `deploy_approval: true` are stripped from the project file to prevent the new PR-approval gate from activating unexpectedly.

Both steps are idempotent. Run output:

```
Migrated 4 key(s) to ~/.worca/settings.json
Reset 2 template-default milestone key(s) (pr_approval, deploy_approval) — gate now opt-in via Pipeline tab
```

**If you skip `worca init --upgrade`:**

The UI's settings editor handles migration automatically. When you open project settings, a banner appears if misplaced global keys or inert milestone defaults are detected. Clicking "Migrate now" (or simply saving settings) triggers the same extraction — the server's save handler auto-migrates on every save. No data is lost; no separate endpoint or manual JSON editing is required.

**New features:**

- Settings UI panels for Execution & Parallelism, Approval Gates, and Circuit Breaker configuration.
- Global Preferences tab (`~/.worca/settings.json`) for cross-project settings (worktree cleanup, concurrency cap, disk threshold, classifier model).
- PR-approval gate: when `worca.milestones.pr_approval` is `true`, the pipeline pauses before PR creation and waits for user approval via the run-detail UI.
- Server-enforced `max_concurrent_pipelines` cap with launch mutex (returns 409 when at capacity).

### 0.19.0 → 0.24.0

Additive features only — no breaking changes. The one required user action is the Python floor bump.

**Required action:**

- **Python 3.10+** — the package floor was raised from 3.8 to 3.10. Ensure your environment matches before upgrading; the package will refuse to install on older interpreters.

**New features:**

- **`/worca-analyze` skill** — end-to-end issue triage (analysis → decisions → issue update → template recommendation → optional worktree launch). Auto-installed into `.claude/skills/worca-analyze/` by `worca init --upgrade`. See the [Issue Triage section in CONTRIBUTING.md](./CONTRIBUTING.md#issue-triage).
- **`worca run --worktree`** — first-class CLI flag to launch a pipeline into an isolated git worktree (parallel-safe). Mirrors the UI's "New Pipeline" path; falls back to in-place if `run_worktree.py` is missing in the project runtime. New companion flags: `--branch` (worktree base branch) and `--guide` (reference guides for the planner, repeatable, requires W-040).
- **`worca templates list --json`** — machine-readable enumeration of all resolvable templates (id, name, description, tier, tags, builtin, created_at) with user > project > built-in tier resolution applied. Used by `/worca-analyze` and external tooling.
- **Multi-host PR metadata (W-051)** — the `pr.json` schema gained `commit_sha`, `source_branch`, `target_branch`, `provider`, and `is_draft` fields. The `pr_url.py` parser detects GitHub, GitLab, Bitbucket, Azure DevOps, and Gitea URL patterns. UI surfaces a collapsible "PR details" subsection on the PR stage card. Webhook subscribers receive the richer `GIT_PR_CREATED` payload automatically — no breaking change to event names.
- **`investigate` template now publishes its plan as a PR (W-046)** — the PR stage is enabled in this template so investigation outputs land as reviewable PRs instead of staying local-only.
- **Coverage runner: `--include-unit-tests`** — opt-in flag on `scripts/coverage.py ci` that wraps the pytest invocation itself with `coverage run --parallel-mode` so unit-test in-process calls are measured alongside integration subprocess fragments. Default off (doubles wall time but produces accurate per-module numbers when needed).

**No automatic migration steps required** — `worca init --upgrade` handles the new skill placement and continues to be idempotent. All settings.json changes are additive.

### 0.24.x → 0.25.0

W-051: Configurable model profiles with per-model environment variables.

- **`worca.models` entries now accept an object form** `{ "id": "model-id", "env": { "KEY": "value" } }` in addition to the existing plain string. Env vars are injected into the subprocess environment when the corresponding agent stage runs. Secrets belong in `settings.local.json` (gitignored). No migration required — purely additive; existing string-form configs continue to work unchanged.

## Getting help

- Issues: https://github.com/SinishaDjukic/worca-cc/issues
- The `/worca-install` and `/worca-sync` skills handle most install/upgrade flows

---

*Follow-up: add a pointer to this file from the project README: `> **Upgrading?** See [MIGRATION.md](./MIGRATION.md).`*
