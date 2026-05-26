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
- `--workspace-plan` is mutually exclusive with `--project-plan`. argparse enforces this via the `plan_source` group.
- `--skip-planning` is NOT added to the argparse mutual-exclusion group (it is an existing standalone `store_true` flag and moving it would be a disruptive refactor). Instead, `_materialize_plan()` performs an explicit conflict check at the top: if `args.skip_planning` is set alongside `args.workspace_plan` or `args.project_plan`, it calls `parser.error(...)` before any branch executes (see Design §2).
- `--workspace-plan PATH` must exist, be readable JSON, and validate against the `workspace_plan.json` schema via the existing `validate_workspace_plan()` helper (`src/worca/scripts/run_workspace.py:388`).
- `--project-plan NAME=PATH` entries: NAME must appear in `ws.projects`; PATH must exist, be readable, and be non-empty (size > 0 after stripping whitespace); duplicate NAMEs are an error. Projects not covered by any `--project-plan` are recorded for fallback (per-child Planner).

### 2. CLI: plan-loading branches in `main()`

**Current state:** `src/worca/scripts/run_workspace.py:1168-1273` has a single `if not args.skip_planning:` branch that calls `run_workspace_planner()` → `validate_workspace_plan()` → `write_workspace_plan_files()` → seeds `manifest["plan"]`.

**Resolution:** Refactor the planning section into a small dispatcher with four sub-paths:

```python
def _materialize_plan(args, ws, run_dir, manifest, parser):
    """Populate manifest['plan']; return ('master'|'existing'|'per-repo'|'independent')."""
    # Explicit conflict check: --skip-planning is not in the argparse
    # mutual-exclusion group (it's a standalone store_true flag), so we
    # guard here before any branch can silently win.
    if args.skip_planning and (args.workspace_plan or args.project_plan):
        parser.error(
            "--skip-planning cannot be combined with "
            "--workspace-plan or --project-plan"
        )

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

`_materialize_per_project_plans()` parses `NAME=PATH` entries, validates each file exists and is non-empty (size > 0 / non-whitespace content — empty plan files fail fast at launch rather than silently confusing the child Planner), copies each file into the run dir as `{name}-plan.md` (so the dispatched children get a stable absolute path that survives `worca cleanup --workspace-id`), and returns the `{name: abs_path}` map. Projects missing from the map are not added — the DagExecutor's existing `.get(project)` lookup already returns `None` for those, which means the child runs without `--plan` (its own Planner runs). Emit a `workspace.plan.partial` event listing the uncovered projects.

`_load_workspace_plan_from_file()` reads the JSON and raises `WorkspacePlanError` on parse failure with a useful error message.

Emit new events to match new modes:
- `workspace.plan.loaded` — when `existing` or fully-covered `per-repo` mode skips the master planner (payload: `mode`, `project_count`, `covered_projects`).
- `workspace.plan.partial` — when `per-repo` mode has uncovered projects falling back to per-child Planner (payload: `mode`, `project_count`, `covered_projects`, `uncovered_projects`). This is a distinct, actionable condition: partial coverage means some children will plan independently, which a chat subscriber or webhook consumer may want to know about. Severity: warning.
- Existing `workspace.plan.started` / `workspace.plan.completed` / `workspace.plan.failed` continue to fire only for `master` mode.

### 3. Server route: translate `plan_mode` to CLI flags

**Current state:** `worca-ui/server/workspace-routes.js:952-1070` reads `plan_mode` from the form, sets `manifest.skip_planning = plan_mode === 'skip'`, drops `workspace_plan`. The dispatcher (`worca-ui/server/app.js:678-707`) reads from the manifest, not from the route, and only forwards `--skip-integration` and `--skip-planning`.

**Resolution:** Three changes: multipart parser dispatch, plan-strategy resolver, and CLI dispatcher.

**Multipart parser dispatch (`workspace-routes.js`):** The existing multipart parsing loop (lines 941-946) routes ALL filename-bearing parts to `guideFiles` via a blanket `if (part.filename != null)` check. Plan-related file uploads (`workspace_plan_file`, `project_plan_<name>`) would be misclassified as guide files. Update the loop to route parts by `part.name` before falling through to the `guideFiles` catch-all:

```js
let workspacePlanFileData = null;
const projectPlanFiles = {};

for (const part of parts) {
  if (part.name === 'workspace_plan_file' && part.filename != null) {
    workspacePlanFileData = { filename: part.filename, content: part.content };
  } else if (part.name?.startsWith('project_plan_') && part.filename != null) {
    const projectName = part.name.slice('project_plan_'.length);
    projectPlanFiles[projectName] = { filename: part.filename, content: part.content };
  } else if (part.filename != null) {
    guideFiles.push({ filename: part.filename, content: part.content });
  } else if (part.name) {
    fields[part.name] = part.content.toString('utf8');
  }
}
```

The name-based checks (`workspace_plan_file`, `project_plan_*`) are tested before the generic `part.filename` catch-all, so guide files continue to work unchanged. `workspacePlanFileData` and `projectPlanFiles` are consumed below by `_resolvePlanStrategy()`.

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

**Per-project plan upload handling:** The `projectPlanFiles` map (populated by the multipart dispatch above) contains one `{filename, content}` entry per project. Before calling `_resolvePlanStrategy()`, write each to `wsRunDir/plans/{sanitizedName}.md`, cap each at 256 KB (reject with 400 if exceeded — same shape as the existing `guide_files` cap), and build the `project_plans` path map:

```js
const projectPlans = {};
for (const [name, file] of Object.entries(projectPlanFiles)) {
  if (file.content.length > 256 * 1024) {
    return res.status(400).json({
      ok: false,
      error: `Project plan for "${name}" exceeds 256 KB limit`,
    });
  }
  const safeName = sanitizeFilename(name);
  const planPath = join(wsRunDir, 'plans', `${safeName}.md`);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, file.content);
  projectPlans[name] = planPath;  // original name as key, safe path as value
}
```

**Existing workspace plan upload handling:** When `plan_mode === 'existing'`, the upload comes via the `workspacePlanFileData` variable (from the multipart dispatch above) OR as a `workspace_plan` string field (server-side path, for power users / tests). File upload takes precedence. Write the uploaded file to `wsRunDir/workspace-plan.json` and pass its absolute path:

```js
let workspacePlanPath = null;
if (workspacePlanFileData) {
  workspacePlanPath = join(wsRunDir, 'workspace-plan.json');
  writeFileSync(workspacePlanPath, workspacePlanFileData.content);
} else if (fields.workspace_plan) {
  // Server-side path: validate existence before passing through
  if (!existsSync(fields.workspace_plan)) {
    return res.status(400).json({
      ok: false,
      error: `workspace_plan path not found: ${fields.workspace_plan}`,
    });
  }
  workspacePlanPath = fields.workspace_plan;
}
```

Persist the resolved fields on the manifest:

```js
const planResolution = _resolvePlanStrategy(
  plan_mode, workspacePlanPath, projectPlans, ws,
);
const manifest = {
  ...,
  plan_mode,                                  // record what UI asked for
  skip_planning: planResolution.skip_planning ?? false,
  workspace_plan_path: planResolution.workspace_plan_path ?? null,
  project_plans: planResolution.project_plans ?? null,
};
```

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

### 4. UI: file upload widgets and plan mode controls

**Current state:** `worca-ui/app/views/fleet-launcher.js:820-890` (`_workspacePlanSection`). When `existing` is selected, a single `sl-input` for `workspacePlanPath` appears. When `per-repo` or `independent` is selected, only a hint/alert appears. The form never actually uploads anything for these modes.

**Important: Shoelace does not support `sl-input type="file"`.** Shoelace's `sl-input` only accepts text/number/search/etc. — `type="file"` silently falls back to a plain text input. All file pickers in this plan use the proven pattern from `launcher-shared.js:80-93`: an `sl-button` that programmatically creates a native `<input type="file">` via `document.createElement('input')`, clicks it, and reads the result in `onchange`. This pattern is already used by `guideUploadWidget()` for guide file uploads.

**Resolution:**

**Shared helper:** Extract a reusable `filePickerButton()` from the `guideUploadWidget()` pattern in `launcher-shared.js`. This keeps the file-picker logic DRY across the guide upload, workspace plan upload, and per-project plan upload widgets:

```js
export function filePickerButton({ label, accept, multiple, onFiles, className }) {
  return html`
    <sl-button
      size="small"
      variant="default"
      class=${className || 'btn-file-browse'}
      @click=${() => {
        const inp = document.createElement('input');
        inp.type = 'file';
        if (accept) inp.accept = accept;
        if (multiple) inp.multiple = true;
        inp.onchange = () => {
          const files = [...(inp.files || [])];
          if (files.length) onFiles(files);
        };
        inp.click();
      }}
    >${label || 'Browse files'}</sl-button>
  `;
}
```

Refactor `guideUploadWidget()` to call `filePickerButton()` internally (no behavior change, just dedup).

**For `existing` mode — file picker + advanced server-side path toggle:**

The primary input is a file upload button. Below it, an `sl-details` toggle reveals a text input for a server-side path — this is the "advanced" affordance for power users running the UI server on the same host as the workspace files (per the Decisions section). Only one is used: if a file is uploaded, it takes precedence over the path string; the path string is submitted only when no file is selected.

```js
${workspacePlanMode === 'existing' ? html`
  <div class="workspace-plan-upload">
    ${filePickerButton({
      label: 'Choose workspace plan…',
      accept: 'application/json,.json',
      className: 'btn-workspace-plan-browse',
      onFiles: ([file]) => {
        workspacePlanFile = file;
        workspacePlanPath = null;  // file takes precedence
        rerender();
      },
    })}
    ${workspacePlanFile ? html`
      <sl-tag
        removable
        class="workspace-plan-tag"
        @sl-remove=${() => { workspacePlanFile = null; rerender(); }}
      >${workspacePlanFile.name} (${_formatBytes(workspacePlanFile.size)})</sl-tag>
    ` : nothing}
    <sl-details summary="Advanced: server-side path" class="workspace-plan-advanced">
      <sl-input
        class="input-workspace-plan-path"
        placeholder="/path/to/workspace-plan.json"
        value=${workspacePlanPath || ''}
        @sl-input=${(e) => { workspacePlanPath = e.target.value; }}
      ></sl-input>
      <small>Use when the plan file is already on the server host. Ignored if a file is uploaded above.</small>
    </sl-details>
  </div>
` : nothing}
```

**For `per-repo` mode — per-project file pickers:**

Render one file-picker row per project (after a workspace is selected so `workspaceData.projects` is populated):

```js
${workspacePlanMode === 'per-repo' && workspaceData ? html`
  <div class="per-project-plans">
    ${workspaceData.projects.map(p => html`
      <div class="per-project-plan-row">
        <span class="per-project-plan-name">${p.name}</span>
        ${filePickerButton({
          label: 'Choose plan…',
          accept: '.md,.markdown,text/markdown',
          className: 'btn-project-plan-browse',
          onFiles: ([file]) => {
            perRepoPlans = { ...perRepoPlans, [p.name]: file };
            rerender();
          },
        })}
        ${perRepoPlans[p.name] ? html`
          <sl-tag
            removable
            class="project-plan-tag"
            @sl-remove=${() => {
              const { [p.name]: _, ...rest } = perRepoPlans;
              perRepoPlans = rest;
              rerender();
            }}
          >${perRepoPlans[p.name].name}</sl-tag>
        ` : nothing}
      </div>
    `)}
    <sl-alert variant="primary" open>
      Projects without a plan will run their own Planner.
    </sl-alert>
  </div>
` : nothing}
```

**Submit payload (`_submitWorkspaceLauncher`):**

```js
formData.append('plan_mode', workspacePlanMode);
if (workspacePlanMode === 'existing') {
  if (workspacePlanFile) {
    formData.append('workspace_plan_file', workspacePlanFile, workspacePlanFile.name);
  } else if (workspacePlanPath) {
    formData.append('workspace_plan', workspacePlanPath);
  }
}
if (workspacePlanMode === 'per-repo') {
  for (const [name, file] of Object.entries(perRepoPlans)) {
    formData.append(`project_plan_${name}`, file, file.name);
  }
}
```

**State additions to `fleet-launcher.js`:**

```js
let workspacePlanFile = null;             // File for 'existing' (upload)
let workspacePlanPath = null;             // string for 'existing' (server-side path)
let perRepoPlans = {};                    // {projectName: File} for 'per-repo'
```

`resetLauncherState()` clears all three.

### 5. Chat renderers for new events

**Current state:** `worca-ui/server/integrations/renderers.js:566-577` registers opt-in renderers for `workspace.plan.started`, `.completed`, and `.failed`. New event types need renderer entries to be visible to chat/webhook subscribers.

**Resolution:** Add two new opt-in renderers matching the existing pattern:

```js
function renderWorkspacePlanLoaded(envelope) {
  const p = envelope.payload ?? {};
  const mode = p.mode === 'per-repo' ? 'per-repo plans' : 'existing workspace plan';
  const parts = [`📋 **Workspace plan loaded:** ${workspaceTitle(envelope)}`];
  parts.push(`   **Mode:** ${mode} (${p.project_count} project${p.project_count === 1 ? '' : 's'})`);
  return mdMsg(parts.join('\n'), 'info');
}

function renderWorkspacePlanPartial(envelope) {
  const p = envelope.payload ?? {};
  const uncovered = (p.uncovered_projects || []).join(', ');
  const parts = [`⚠️ **Partial plan coverage:** ${workspaceTitle(envelope)}`];
  parts.push(`   **Covered:** ${(p.covered_projects || []).length} / ${p.project_count}`);
  parts.push(`   **Falling back to per-child Planner:** ${uncovered}`);
  return mdMsg(parts.join('\n'), 'warning');
}
```

Register both in `OPT_IN_RENDERERS`:

```js
export const OPT_IN_RENDERERS = {
  ...
  'workspace.plan.loaded': renderWorkspacePlanLoaded,
  'workspace.plan.partial': renderWorkspacePlanPartial,
  ...
};
```

### 6. Manifest schema additions

| Field | Type | When set |
|-------|------|----------|
| `plan_mode` | `'master' \| 'existing' \| 'per-repo' \| 'independent'` | Always (from UI; CLI infers from flags) |
| `workspace_plan_path` | `string \| null` | `existing` mode only — absolute path inside run dir |
| `project_plans` | `{[name: string]: string} \| null` | `per-repo` mode only — abs paths inside run dir |

These are stored alongside the existing `skip_planning` flag. The `plan.source` field inside `manifest["plan"]` (set by `_materialize_plan`) records which path populated `project_plans` for downstream tooling (UI badge on the run header, debugging).

UI run-detail can read `manifest.plan_mode` to show a "Planning: existing plan" badge instead of the default "Master planner" label.

## Implementation Plan

### Phase 1: CLI flags + events + tests (Python)

**Files:** `src/worca/scripts/run_workspace.py`, `src/worca/events/types.py`, `tests/test_run_workspace.py`

1. Add `--workspace-plan` and `--project-plan` flags in `create_parser()`.
2. Implement `_load_workspace_plan_from_file()`, `_materialize_per_project_plans()`, `_materialize_plan()`.
3. Refactor `main()`'s planning section to call `_materialize_plan()`.
4. Update `--skip-planning` help text.
5. Add `WORKSPACE_PLAN_LOADED` and `WORKSPACE_PLAN_PARTIAL` event constants in `src/worca/events/types.py`, with `workspace_plan_loaded_payload()` and `workspace_plan_partial_payload()` builder functions.
6. Tests:
   - Each flag parses correctly; mutual exclusion enforced.
   - `--workspace-plan` happy path seeds manifest correctly.
   - `--workspace-plan` with invalid JSON / schema-failing JSON fails cleanly.
   - `--project-plan` with unknown project name fails cleanly.
   - `--project-plan` with empty / whitespace-only plan file fails cleanly.
   - `--project-plan` partial coverage leaves uncovered projects to per-child Planner.
   - `--project-plan` partial coverage emits `workspace.plan.partial` event with correct `covered_projects` / `uncovered_projects` lists.
   - `--workspace-plan` + `--skip-planning` rejected.

### Phase 2: Server route + dispatcher + renderers (JS)

**Files:** `worca-ui/server/workspace-routes.js`, `worca-ui/server/app.js`, `worca-ui/server/integrations/renderers.js`, `worca-ui/server/workspace-routes.test.js`, `worca-ui/server/integrations/renderers.test.js`

1. Update the multipart parsing loop in `workspace-routes.js` to route `workspace_plan_file` and `project_plan_<name>` parts to dedicated variables before the `guideFiles` catch-all (see Design §3 multipart dispatch).
2. Add `_resolvePlanStrategy()` helper in `workspace-routes.js`.
3. Write uploaded plan files to `wsRunDir/` paths and build the `workspacePlanPath` / `projectPlans` maps before calling `_resolvePlanStrategy()`.
4. Accept `workspace_plan` string field (server-side path) as fallback when no file is uploaded for `existing` mode.
5. Persist `plan_mode`, `workspace_plan_path`, `project_plans` on the manifest.
6. Update dispatcher in `app.js` to forward `--workspace-plan` and `--project-plan` flags.
7. Add `renderWorkspacePlanLoaded` and `renderWorkspacePlanPartial` to `renderers.js`, registered in `OPT_IN_RENDERERS`.
8. Tests:
   - Each `plan_mode` value produces the expected manifest fields.
   - `existing` without `workspace_plan_file` or `workspace_plan` string → 400.
   - `existing` with file upload writes to expected path; `workspace_plan` string also accepted.
   - `per-repo` with no project plans → 400.
   - `per-repo` with unknown project name → 422.
   - Uploaded plan files land in plan-specific paths, NOT in `guideFiles`.
   - Guide file uploads still route to `guideFiles` when plan files are also present.
   - Per-project plan file exceeding 256 KB → 400.
   - Dispatcher snapshot includes the new flags.
   - `renderWorkspacePlanLoaded` produces info-severity message with mode and project count.
   - `renderWorkspacePlanPartial` produces warning-severity message listing uncovered projects.

### Phase 3: UI launcher (JS)

**Files:** `worca-ui/app/views/launcher-shared.js`, `worca-ui/app/views/fleet-launcher.js`, `worca-ui/app/views/fleet-launcher.test.js`, `worca-ui/app/styles.css`

1. Extract `filePickerButton()` helper in `launcher-shared.js` from the existing `guideUploadWidget()` pattern; refactor `guideUploadWidget()` to use it.
2. Add `workspacePlanFile`, `workspacePlanPath`, and `perRepoPlans` state to `fleet-launcher.js`.
3. Replace the `existing` text input with a file-picker button (via `filePickerButton()`) plus an `sl-details` "Advanced: server-side path" toggle that reveals the existing text input.
4. Add per-project file-picker rows for `per-repo` mode (one `filePickerButton()` per project).
5. Wire `_submitWorkspaceLauncher()` to append the new multipart fields (file upload takes precedence over path string for `existing`).
6. Update `resetLauncherState()` and `getFleetLauncherSubmitState()` (if it surfaces plan state).
7. Add CSS for `.workspace-plan-upload`, `.workspace-plan-advanced`, `.per-project-plans`, `.per-project-plan-row`.
8. Tests (vitest):
   - `filePickerButton()` renders an `sl-button` with the given label and class.
   - `existing` mode renders `.btn-workspace-plan-browse` button, not a file-type input.
   - `existing` mode renders `sl-details` with "Advanced: server-side path" summary.
   - `per-repo` mode renders one `.per-project-plan-row` per project from `workspaceData.projects`.
   - Submit FormData contains expected fields for each mode.
   - `existing` submit prefers file over path string when both are set.
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
| `src/worca/events/types.py` | Add `WORKSPACE_PLAN_LOADED` + `workspace_plan_loaded_payload()` and `WORKSPACE_PLAN_PARTIAL` + `workspace_plan_partial_payload()` |
| `tests/test_run_workspace.py` | Add coverage for the two new flags, the dispatcher branches, and `workspace.plan.partial` event emission |
| `tests/integration/test_workspace_planning_modes.py` | NEW — end-to-end Python integration for all four modes |
| `worca-ui/server/workspace-routes.js` | `_resolvePlanStrategy()`; multipart upload handling for plans; `workspace_plan` string field for server-side path; manifest fields |
| `worca-ui/server/app.js` | Forward `--workspace-plan` and `--project-plan` in dispatcher |
| `worca-ui/server/integrations/renderers.js` | Add `renderWorkspacePlanLoaded` (info) and `renderWorkspacePlanPartial` (warning) to `OPT_IN_RENDERERS` |
| `worca-ui/server/workspace-routes.test.js` | Coverage for each `plan_mode` → manifest mapping; validation errors; file vs path-string acceptance |
| `worca-ui/server/integrations/renderers.test.js` | Coverage for new renderer output and severity |
| `worca-ui/app/views/launcher-shared.js` | Extract `filePickerButton()` helper; refactor `guideUploadWidget()` to use it |
| `worca-ui/app/views/fleet-launcher.js` | File-picker buttons for `existing` and `per-repo`; `sl-details` path toggle for `existing`; new state; submit changes |
| `worca-ui/app/views/fleet-launcher.test.js` | Coverage for new UI states, file-picker rendering, path toggle, FormData shapes |
| `worca-ui/app/views/run-detail.js` | Show `Planning: <mode>` badge from `manifest.plan_mode` |
| `worca-ui/app/styles.css` | `.workspace-plan-upload`, `.workspace-plan-advanced`, `.per-project-plans` grid styles |
| `worca-ui/e2e/workspace-launcher.spec.js` | NEW — Playwright happy path per mode |
| `docs/workspace-runs.md` | Planning strategy section with mode comparison table |
| `CLAUDE.md` | Cross-reference W-056 in the workspace section |

## Considerations

- **Backward compatibility:** existing manifests have no `plan_mode` field. The run-detail badge code must default to `'master'` when the field is absent. The dispatcher already does the right thing for old manifests (no new flags forwarded if the fields aren't set).
- **Partial coverage policy (`per-repo`):** uncovered projects fall back to per-child Planner with a warning, rather than failing the run. This matches the "make the labels honest" goal without forcing users to draft a plan for every project up front. The warning fires both as a stderr line and a `workspace.plan.partial` event (with a chat renderer at warning severity).
- **Schema validation for `existing` mode:** reuses the existing `workspace_plan.json` schema and `validate_workspace_plan()`. Errors are surfaced as `workspace.plan.failed` events with `error_type=ValidationError`, matching the master-planner failure path.
- **Markdown plan validation (`per-repo`):** existence + readability + non-empty (size > 0 / non-whitespace) sanity check before dispatch. Empty plan files fail fast at launch rather than silently confusing the child Planner. No schema — markdown plans stay free-form.
- **Upload size caps:** per-project plans capped at 256 KB each, workspace plan capped at the existing `guideCapBytes` total (default 1 MB). Both raise 400 with a clear message.
- **Multipart field naming:** `project_plan_<name>` lets the server reconstruct the project mapping without a separate `projects=[]` field. Names are sanitized via the existing `sanitizeFilename()` helper before being used as on-disk filenames; the original project name (unsanitized) is the map key.
- **Multipart parser dispatch order:** The existing multipart loop routes all filename-bearing parts to `guideFiles`. The updated loop checks `part.name` for `workspace_plan_file` and `project_plan_*` prefixes before the `guideFiles` catch-all, so plan uploads are routed to dedicated variables and guide uploads continue to work unchanged.
- **`--skip-planning` conflict guard:** `--skip-planning` remains a standalone `store_true` flag (not added to the argparse mutual-exclusion group — moving it would be a disruptive refactor of the existing CLI). Instead, `_materialize_plan()` performs an explicit `parser.error(...)` check at the top before any branch executes. This prevents `--skip-planning --workspace-plan foo.json` from silently taking the skip path and dropping the plan.
- **Shoelace file picker pattern:** Shoelace's `sl-input` does not support `type="file"`. All file pickers use the proven `sl-button` + native `document.createElement('input')` pattern from `launcher-shared.js:80-93` (`guideUploadWidget()`), extracted into a shared `filePickerButton()` helper.
- **Server-side path toggle (`existing` mode):** an `sl-details` "Advanced: server-side path" toggle exposes a text input for users running the server on the same host as the workspace files. File upload takes precedence; the path string is only submitted when no file is selected. This keeps the primary UX simple (file picker) while providing a real UI affordance for the path-string route — not just API/test-only.
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
| Python | `test_materialize_plan_per_repo_emits_partial_event` | `workspace.plan.partial` fires with correct `covered_projects` / `uncovered_projects` lists |
| Python | `test_materialize_plan_per_repo_full_coverage_emits_loaded` | `workspace.plan.loaded` fires (not `.partial`) when all projects are covered |
| Python | `test_materialize_plan_per_repo_unknown_project` | Raises with clear message |
| Python | `test_materialize_plan_per_repo_empty_plan_file` | Raises with clear message for empty / whitespace-only plan file |
| Python | `test_materialize_plan_independent_sets_no_plan` | Manifest has no `plan` key; `skip_planning=true` |
| JS | `multipart routes plan files to dedicated vars` | `workspace_plan_file` and `project_plan_*` parts are NOT in `guideFiles` |
| JS | `multipart routes guide files alongside plan files` | Guide file uploads still land in `guideFiles` when plan parts are also present |
| JS | `per-project plan over 256KB rejected` | 400 with size-limit error message |
| JS | `resolvePlanStrategy maps each mode` | Server-side helper for all four values |
| JS | `route rejects existing without file` | 400 with clear error |
| JS | `route accepts existing with server-side path string` | Path-string field accepted when no file uploaded |
| JS | `route rejects per-repo with no plans` | 400 with clear error |
| JS | `route rejects per-repo with unknown project` | 422 with clear error |
| JS | `dispatcher forwards new flags` | Snapshot of spawn args per manifest shape |
| JS | `renderWorkspacePlanLoaded produces info message` | Renderer output contains mode and project count at info severity |
| JS | `renderWorkspacePlanPartial produces warning message` | Renderer lists uncovered projects at warning severity |
| JS | `filePickerButton renders sl-button` | Helper produces `sl-button` with expected label and class |
| JS | `launcher renders file picker for existing` | DOM contains `.btn-workspace-plan-browse` button |
| JS | `launcher renders path toggle for existing` | DOM contains `sl-details` with "Advanced: server-side path" summary |
| JS | `launcher renders one row per project for per-repo` | DOM contains N `.per-project-plan-row` elements |
| JS | `launcher submit FormData per mode` | Each mode produces the expected multipart fields |
| JS | `launcher submit existing prefers file over path` | File upload present → path string omitted from FormData |

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
