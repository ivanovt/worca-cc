# W-056: Wire up workspace planning strategy options

**Status:** Draft
**Priority:** P2
**Area:** cc, ui
**Date:** 2026-05-17
**Depends on:** W-047 (multi-repo coordinated pipelines)

## Problem

The workspace launcher exposes four `Workspace planning strategy` options — `Master planner`, `Use existing workspace plan`, `Skip planning, use per-repo plans`, `Independent plans` (`worca-ui/app/views/fleet-launcher.js:825-829`) — but only the first one is wired end-to-end. The server collapses every choice to a single boolean:

```js
// worca-ui/server/workspace-routes.js:1060
skip_planning: plan_mode === 'skip',
```

None of the four UI values is the string `'skip'`, so:

- `existing` silently runs the master planner and drops the `workspace_plan` path the user provided.
- `per-repo` silently runs the master planner — the label "Skip planning" is a lie.
- `independent` silently runs the master planner instead of letting every child run its own Planner.

The dispatcher (`worca-ui/server/app.js:694`) only knows `--skip-integration` and `--skip-planning`. `run_workspace.py` has no flag to accept a pre-prepared `workspace-plan.json` or per-project plan files (`src/worca/scripts/run_workspace.py:744-749` — `--skip-planning`'s help text says "use `--plan` per-project instead", but no such flag exists). Users selecting any of the three non-default options get behavior that contradicts the label without any warning or error.

## Proposal

Make the three dead UI options behave as labeled by extending `run_workspace.py` with two new flags and adding a server-side translation layer:

1. **`independent`** → server sends `--skip-planning`; each child runs its own Planner (one-line server fix).
2. **`existing`** → new `--workspace-plan PATH` flag that loads + validates a user-supplied `workspace-plan.json` and reuses the existing `write_workspace_plan_files()` machinery to materialize per-project sub-plans.
3. **`per-repo`** → new `--project-plan NAME=PATH` (repeatable) flag that seeds `manifest["plan"]["project_plans"]` directly from user-supplied per-project markdown plans, bypassing both the master planner and the JSON intermediate. UI gains a per-project file-upload widget.

The DagExecutor already forwards `--plan <path>` to each child when `manifest["plan"]["project_plans"][project]` is set (`src/worca/workspace/dag_executor.py:268, 604-609`), so no executor changes are needed — the work is at the manifest-seeding layer.

## Design

### 1. CLI: new `run_workspace.py` flags

**Current state:** `src/worca/scripts/run_workspace.py:704-788` (`create_parser`) exposes `--prompt`, `--source`, `--guide`, `--branch`, `--skip-integration`, `--skip-planning`, `--resume`, `--workspace-id`, `--max-parallel`, `--dry-run`, `--settings`. There is no way to feed in a pre-prepared plan.

**Resolution:** Add two mutually-exclusive flags to a new argparse group, both incompatible with `--skip-planning`:

```python
plan_source = parser.add_mutually_exclusive_group()
plan_source.add_argument(
    "--workspace-plan",
    metavar="PATH",
    help=(
        "Path to a pre-prepared workspace-plan.json. Skips the master "
        "workspace_planner and materializes per-project sub-plans from "
        "the supplied file. Validated against schemas/workspace_plan.json."
    ),
)
plan_source.add_argument(
    "--project-plan",
    action="append",
    metavar="NAME=PATH",
    default=[],
    help=(
        "Pre-prepared plan for a single project (repeatable). "
        "NAME must match a project in workspace.json; PATH points to "
        "a markdown plan file. Bypasses the master planner; projects "
        "without a --project-plan entry fall back to running their own "
        "child Planner (with a warning)."
    ),
)
```

Update the help text on `--skip-planning` from `"use --plan per-project instead"` to `"every child runs its own Planner"` so the docstring matches reality.

Validation rules enforced in `main()`:
- `--workspace-plan` is mutually exclusive with `--project-plan` AND `--skip-planning`. argparse covers the first; an explicit check covers the second.
- `--workspace-plan PATH` must exist, be readable JSON, and validate against the `workspace_plan.json` schema via the existing `validate_workspace_plan()` helper (`src/worca/scripts/run_workspace.py:388`).
- `--project-plan NAME=PATH` entries: NAME must appear in `ws.projects`; PATH must exist and be readable; duplicate NAMEs are an error. Projects not covered by any `--project-plan` are recorded for fallback (per-child Planner).

### 2. CLI: plan-loading branches in `main()`

**Current state:** `src/worca/scripts/run_workspace.py:1168-1273` has a single `if not args.skip_planning:` branch that calls `run_workspace_planner()` → `validate_workspace_plan()` → `write_workspace_plan_files()` → seeds `manifest["plan"]`.

**Resolution:** Refactor the planning section into a small dispatcher with four sub-paths:

```python
def _materialize_plan(args, ws, run_dir, manifest):
    """Populate manifest['plan']; return ('master'|'existing'|'per-repo'|'independent')."""
    if args.skip_planning:
        return "independent"

    if args.workspace_plan:
        plan = _load_workspace_plan_from_file(args.workspace_plan)
        errors = validate_workspace_plan(plan, ws)
        if errors:
            raise WorkspacePlanError("; ".join(errors))
        project_plan_paths = write_workspace_plan_files(plan, run_dir)
        manifest["plan"] = {
            "workspace_plan_path": _copy_into_run_dir(args.workspace_plan, run_dir),
            "project_plans": project_plan_paths,
            "source": "existing",
        }
        return "existing"

    if args.project_plan:
        project_plan_paths = _materialize_per_project_plans(
            args.project_plan, ws, run_dir,
        )
        manifest["plan"] = {
            "workspace_plan_path": None,
            "project_plans": project_plan_paths,
            "source": "per-repo",
        }
        return "per-repo"

    # default: run the master planner (existing behavior)
    plan = run_workspace_planner(...)
    ...
    return "master"
```

`_materialize_per_project_plans()` parses `NAME=PATH` entries, copies each file into the run dir as `{name}-plan.md` (so the dispatched children get a stable absolute path that survives `worca cleanup --workspace-id`), and returns the `{name: abs_path}` map. Projects missing from the map are not added — the DagExecutor's existing `.get(project)` lookup already returns `None` for those, which means the child runs without `--plan` (its own Planner runs). Emit a `workspace.plan.partial` event listing the uncovered projects.

`_load_workspace_plan_from_file()` reads the JSON and raises `WorkspacePlanError` on parse failure with a useful error message.

Emit new events to match new modes:
- `workspace.plan.loaded` — when `existing` or `per-repo` mode skips the master planner (payload: `mode`, `project_count`, `covered_projects`, `uncovered_projects`).
- Existing `workspace.plan.started` / `workspace.plan.completed` / `workspace.plan.failed` continue to fire only for `master` mode.

### 3. Server route: translate `plan_mode` to CLI flags

**Current state:** `worca-ui/server/workspace-routes.js:952-1070` reads `plan_mode` from the form, sets `manifest.skip_planning = plan_mode === 'skip'`, drops `workspace_plan`. The dispatcher (`worca-ui/server/app.js:678-707`) reads from the manifest, not from the route, and only forwards `--skip-integration` and `--skip-planning`.

**Resolution:** Two changes.

**Route (`workspace-routes.js`):** Replace the one-liner with a small mapping function and persist its outputs on the manifest:

```js
function _resolvePlanStrategy(plan_mode, workspace_plan_path, project_plans, ws) {
  if (plan_mode === 'independent') {
    return { skip_planning: true };
  }
  if (plan_mode === 'existing') {
    if (!workspace_plan_path) {
      throw new BadRequest('plan_mode=existing requires workspace_plan');
    }
    return { workspace_plan_path };
  }
  if (plan_mode === 'per-repo') {
    if (!project_plans || Object.keys(project_plans).length === 0) {
      throw new BadRequest('plan_mode=per-repo requires at least one project plan');
    }
    _validateProjectNames(project_plans, ws);  // throws on unknown name
    return { project_plans };
  }
  // 'master' or unknown → default
  return {};
}
```

Persist the resolved fields on the manifest:

```js
const planResolution = _resolvePlanStrategy(plan_mode, ..., ws);
const manifest = {
  ...,
  plan_mode,                                  // record what UI asked for
  skip_planning: planResolution.skip_planning ?? false,
  workspace_plan_path: planResolution.workspace_plan_path ?? null,
  project_plans: planResolution.project_plans ?? null,
};
```

**Per-project plan upload handling:** the `per-repo` mode arrives as multipart form fields named `project_plan_<name>` (one file per project). The route writes each into `wsRunDir/plans/{name}.md` and builds the `project_plans` map of absolute paths before manifest write. Cap each plan at 256 KB and reject the request if exceeded — same shape as the existing `guide_files` cap (`guideCapBytes`).

**Existing workspace plan upload handling:** when `plan_mode === 'existing'`, accept a `workspace_plan_file` multipart field (file) OR a `workspace_plan` field (server-side path string, for power users / tests). Write the file to `wsRunDir/workspace-plan.json` and pass its absolute path.

**Dispatcher (`app.js`):** Forward the new manifest fields:

```js
if (manifest.skip_planning) args.push('--skip-planning');
if (manifest.workspace_plan_path) {
  args.push('--workspace-plan', manifest.workspace_plan_path);
}
for (const [name, path] of Object.entries(manifest.project_plans || {})) {
  args.push('--project-plan', `${name}=${path}`);
}
```

### 4. UI: per-project plan upload widget

**Current state:** `worca-ui/app/views/fleet-launcher.js:820-890` (`_workspacePlanSection`). When `existing` is selected, a single `sl-input` for `workspacePlanPath` appears. When `per-repo` or `independent` is selected, only a hint/alert appears. The form never actually uploads anything for these modes.

**Resolution:**

For `existing`, replace the text input with a file picker that uploads the JSON:

```js
${workspacePlanMode === 'existing' ? html`
  <sl-input
    class="input-workspace-plan-file"
    type="file"
    accept="application/json,.json"
    @sl-change=${onWorkspacePlanFileSelected}
  ></sl-input>
` : nothing}
```

For `per-repo`, render one file picker per project (after a workspace is selected so `workspaceData.projects` is populated):

```js
${workspacePlanMode === 'per-repo' && workspaceData ? html`
  <div class="per-project-plans">
    ${workspaceData.projects.map(p => html`
      <div class="per-project-plan-row">
        <span class="per-project-plan-name">${p.name}</span>
        <sl-input
          type="file"
          accept=".md,.markdown,text/markdown"
          data-project=${p.name}
          @sl-change=${onProjectPlanSelected}
        ></sl-input>
        ${perRepoPlans[p.name] ? html`<sl-icon name="check"></sl-icon>` : nothing}
      </div>
    `)}
    <sl-alert variant="primary" open>
      Projects without a plan will run their own Planner.
    </sl-alert>
  </div>
` : nothing}
```

Submit payload (`_submitWorkspaceLauncher`):

```js
formData.append('plan_mode', workspacePlanMode);
if (workspacePlanMode === 'existing' && workspacePlanFile) {
  formData.append('workspace_plan_file', workspacePlanFile, workspacePlanFile.name);
}
if (workspacePlanMode === 'per-repo') {
  for (const [name, file] of Object.entries(perRepoPlans)) {
    formData.append(`project_plan_${name}`, file, file.name);
  }
}
```

State additions to `fleet-launcher.js`:

```js
let workspacePlanFile = null;             // File for 'existing'
let perRepoPlans = {};                    // {projectName: File} for 'per-repo'
```

`resetLauncherState()` clears both.

### 5. Manifest schema additions

| Field | Type | When set |
|-------|------|----------|
| `plan_mode` | `'master' \| 'existing' \| 'per-repo' \| 'independent'` | Always (from UI; CLI infers from flags) |
| `workspace_plan_path` | `string \| null` | `existing` mode only — absolute path inside run dir |
| `project_plans` | `{[name: string]: string} \| null` | `per-repo` mode only — abs paths inside run dir |

These are stored alongside the existing `skip_planning` flag. The `plan.source` field inside `manifest["plan"]` (set by `_materialize_plan`) records which path populated `project_plans` for downstream tooling (UI badge on the run header, debugging).

UI run-detail can read `manifest.plan_mode` to show a "Planning: existing plan" badge instead of the default "Master planner" label.

## Implementation Plan

### Phase 1: CLI flags + tests (Python)

**Files:** `src/worca/scripts/run_workspace.py`, `tests/test_run_workspace.py`

1. Add `--workspace-plan` and `--project-plan` flags in `create_parser()`.
2. Implement `_load_workspace_plan_from_file()`, `_materialize_per_project_plans()`, `_materialize_plan()`.
3. Refactor `main()`'s planning section to call `_materialize_plan()`.
4. Update `--skip-planning` help text.
5. Add `workspace.plan.loaded` event type in `src/worca/events/event_types.py`.
6. Tests:
   - Each flag parses correctly; mutual exclusion enforced.
   - `--workspace-plan` happy path seeds manifest correctly.
   - `--workspace-plan` with invalid JSON / schema-failing JSON fails cleanly.
   - `--project-plan` with unknown project name fails cleanly.
   - `--project-plan` partial coverage leaves uncovered projects to per-child Planner.
   - `--workspace-plan` + `--skip-planning` rejected.

### Phase 2: Server route + dispatcher (JS)

**Files:** `worca-ui/server/workspace-routes.js`, `worca-ui/server/app.js`, `worca-ui/server/workspace-routes.test.js`

1. Add `_resolvePlanStrategy()` helper in `workspace-routes.js`.
2. Handle multipart fields `workspace_plan_file` and `project_plan_<name>` in the POST handler; write to `wsRunDir/workspace-plan.json` and `wsRunDir/plans/{name}.md`.
3. Persist `plan_mode`, `workspace_plan_path`, `project_plans` on the manifest.
4. Update dispatcher in `app.js` to forward `--workspace-plan` and `--project-plan` flags.
5. Tests:
   - Each `plan_mode` value produces the expected manifest fields.
   - `existing` without `workspace_plan_file` → 400.
   - `per-repo` with no project plans → 400.
   - `per-repo` with unknown project name → 422.
   - Uploaded files land in the expected paths.
   - Dispatcher snapshot includes the new flags.

### Phase 3: UI launcher (JS)

**Files:** `worca-ui/app/views/fleet-launcher.js`, `worca-ui/app/views/fleet-launcher.test.js`, `worca-ui/app/styles.css`

1. Add `workspacePlanFile` and `perRepoPlans` state.
2. Replace the `existing` text input with a file picker.
3. Add per-project file pickers for `per-repo` mode.
4. Wire `_submitWorkspaceLauncher()` to append the new multipart fields.
5. Update `resetLauncherState()` and `getFleetLauncherSubmitState()` (if it surfaces plan state).
6. Add minimal CSS for the per-project-plans grid.
7. Tests (vitest):
   - `existing` mode renders file picker, not text input.
   - `per-repo` mode renders one row per project from `workspaceData.projects`.
   - Submit FormData contains expected fields for each mode.
   - `independent` mode submits `plan_mode=independent` with no plan files.

### Phase 4: Integration + Playwright

**Files:** `tests/integration/test_workspace_planning_modes.py`, `worca-ui/e2e/workspace-launcher.spec.js`

1. Python integration: launch `run_workspace.py` four times (one per mode), assert each child dispatch reflects the chosen mode (master writes plan files, existing reuses supplied JSON, per-repo seeds direct paths, independent passes `--skip-planning`).
2. Playwright: cover the UI happy path for each mode end-to-end against a mock backend that captures the FormData.

### Phase 5: Docs + run-detail badge

**Files:** `docs/workspace-runs.md`, `worca-ui/app/views/run-detail.js`, `CLAUDE.md` (workspace section)

1. Document the four modes in `docs/workspace-runs.md`: when to use each, what files to supply, validation rules.
2. Run-detail view shows a `Planning: <mode>` badge near the workspace header so it's obvious which mode produced the plan after the fact.
3. Brief mention in `CLAUDE.md` workspace section: "see W-056 for planning strategy options".

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/scripts/run_workspace.py` | New `--workspace-plan`, `--project-plan` flags; `_materialize_plan()` dispatcher; updated `--skip-planning` help text |
| `src/worca/events/event_types.py` | Add `WORKSPACE_PLAN_LOADED` event + payload helper |
| `tests/test_run_workspace.py` | Add coverage for the two new flags and the dispatcher branches |
| `tests/integration/test_workspace_planning_modes.py` | NEW — end-to-end Python integration for all four modes |
| `worca-ui/server/workspace-routes.js` | `_resolvePlanStrategy()`; multipart upload handling for plans; manifest fields |
| `worca-ui/server/app.js` | Forward `--workspace-plan` and `--project-plan` in dispatcher |
| `worca-ui/server/workspace-routes.test.js` | Coverage for each `plan_mode` → manifest mapping; validation errors |
| `worca-ui/app/views/fleet-launcher.js` | File pickers for `existing` and `per-repo`; new state; submit changes |
| `worca-ui/app/views/fleet-launcher.test.js` | Coverage for new UI states + FormData shapes |
| `worca-ui/app/views/run-detail.js` | Show `Planning: <mode>` badge from `manifest.plan_mode` |
| `worca-ui/app/styles.css` | `.per-project-plans` grid styles |
| `worca-ui/e2e/workspace-launcher.spec.js` | NEW — Playwright happy path per mode |
| `docs/workspace-runs.md` | Planning strategy section with mode comparison table |
| `CLAUDE.md` | Cross-reference W-056 in the workspace section |

## Considerations

- **Backward compatibility:** existing manifests have no `plan_mode` field. The run-detail badge code must default to `'master'` when the field is absent. The dispatcher already does the right thing for old manifests (no new flags forwarded if the fields aren't set).
- **Partial coverage policy (`per-repo`):** uncovered projects fall back to per-child Planner with a warning, rather than failing the run. This matches the "make the labels honest" goal without forcing users to draft a plan for every project up front. The warning fires both as a stderr line and a `workspace.plan.partial` event.
- **Schema validation for `existing` mode:** reuses the existing `workspace_plan.json` schema and `validate_workspace_plan()`. Errors are surfaced as `workspace.plan.failed` events with `error_type=ValidationError`, matching the master-planner failure path.
- **Upload size caps:** per-project plans capped at 256 KB each, workspace plan capped at the existing `guideCapBytes` total (default 1 MB). Both raise 400 with a clear message.
- **Multipart field naming:** `project_plan_<name>` lets the server reconstruct the project mapping without a separate `projects=[]` field. Names are sanitized via the existing `sanitizeFilename()` helper before being used as on-disk filenames; the original project name (unsanitized) is the map key.
- **Governance:** no hook changes needed. Pre-prepared plans still flow through `--plan` to children, which already triggers the governance plan_check hook satisfaction in the child pipeline.
- **Breaking changes:** none. The default `master` mode is unchanged. The three previously-broken modes now do what their labels say; users who somehow depended on the broken behavior will see the new (correct) behavior, but there is no plausible workflow that depends on the old silent fall-through.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_workspace_plan_flag_parses` | argparse accepts `--workspace-plan path` |
| Python | `test_project_plan_flag_repeatable` | `--project-plan a=/x.md --project-plan b=/y.md` collects both |
| Python | `test_workspace_plan_and_project_plan_mutex` | Combining the two raises argparse error |
| Python | `test_workspace_plan_and_skip_planning_mutex` | Explicit check raises before dispatch |
| Python | `test_materialize_plan_existing_happy_path` | `_materialize_plan()` seeds manifest from valid JSON |
| Python | `test_materialize_plan_existing_invalid_schema` | Raises `WorkspacePlanError` with schema messages |
| Python | `test_materialize_plan_per_repo_partial_coverage` | Uncovered projects omitted from `project_plans`; warning emitted |
| Python | `test_materialize_plan_per_repo_unknown_project` | Raises with clear message |
| Python | `test_materialize_plan_independent_sets_no_plan` | Manifest has no `plan` key; `skip_planning=true` |
| JS | `resolvePlanStrategy maps each mode` | Server-side helper for all four values |
| JS | `route rejects existing without file` | 400 with clear error |
| JS | `route rejects per-repo with no plans` | 400 with clear error |
| JS | `route rejects per-repo with unknown project` | 422 with clear error |
| JS | `dispatcher forwards new flags` | Snapshot of spawn args per manifest shape |
| JS | `launcher renders file picker for existing` | DOM contains `.input-workspace-plan-file` |
| JS | `launcher renders one row per project for per-repo` | DOM contains N `.per-project-plan-row` elements |
| JS | `launcher submit FormData per mode` | Each mode produces the expected multipart fields |

### Integration / E2E Tests

- `tests/integration/test_workspace_planning_modes.py` — boots `run_workspace.py` against a 3-project temp workspace, asserts each mode dispatches child `run_worktree.py` commands with the right `--plan` arguments (or absence).
- `worca-ui/e2e/workspace-launcher.spec.js` — drives the launcher UI through each mode and captures the multipart payload via a request interceptor.

### Existing Tests to Update

- `worca-ui/app/views/fleet-launcher.test.js` — existing `'shows Master planner as the default option'` test continues to pass; additional tests are additive.
- `worca-ui/server/workspace-routes.test.js` — current tests assume `plan_mode` mostly maps to `skip_planning`; they need to be split into per-mode cases.

## Files to Create/Modify

See **Files Changed Summary** table above.

## Out of Scope

- **`--plan` on `run_fleet.py`:** fleet already accepts a single shared plan via `--plan`. This plan does not touch fleet behavior.
- **Editing the workspace plan in-UI:** users supply a pre-prepared file; an in-UI plan editor is a separate future feature.
- **Workspace-plan-as-issue-link:** auto-fetching a plan from a GitHub issue body (parallel to the per-issue `## Plan` link convention for project pipelines) is not part of this plan. Could be a follow-up.
- **Plan re-use across resume:** when a workspace run is resumed, the existing manifest's plan paths are already loaded by `_resume_workspace()`. No new resume-time logic is needed for the new modes — the plan files live in the run dir and survive the resume.
- **Removing the dead options as an alternative:** explicitly chosen against. Each of the three modes corresponds to a real user workflow; making them work is a smaller change overall than reasoning about which UX cuts are safe.
