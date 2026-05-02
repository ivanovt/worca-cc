# W-049: Settings UI + Runtime Consumers for Execution, Approval Gates, Circuit Breaker, and Worktree Disk Threshold

**Status:** Draft (revised — scope expanded to include consumer implementation; project/global split committed to option B)
**Priority:** P2
**Area:** ui + cc
**Date:** 2026-05-02
**Depends on:** W-048 (worktree-isolation-unified-runs — already merged)

## Problem

Several `settings.json` keys under the `worca` namespace ship today with no UI editor. A consumer audit reveals that 5 of the 11 keys in scope are also **inert at runtime** — the runner / UI code never reads them, so they are documentation-only stubs. Exposing inert keys in the UI would let users change values that nothing observes.

Verified consumer status (audit grepped both Python and JS sources):

| Key | Default | Consumer status |
|---|---|---|
| `worca.parallel.worktree_base_dir` | `.worktrees` | **CONSUMED** — `src/worca/scripts/run_worktree.py:222-228` |
| `worca.parallel.default_base_branch` | `main` | **INERT** — no consumer |
| `worca.parallel.max_concurrent_pipelines` | `3` | **INERT** — no consumer |
| `worca.parallel.cleanup_policy` | `on-success` | **INERT** — no consumer |
| `worca.ui.worktree_disk_warning_bytes` | `2_000_000_000` | **HALF-CONSUMED** — sidebar reads wrong shape (Bug A); worktrees view hardcodes 2 GB (Bug B); `state.settings` never reaches the views (Bug C) |
| `worca.milestones.plan_approval` | `true` | **CONSUMED** — `src/worca/orchestrator/runner.py:2089-2118` |
| `worca.milestones.pr_approval` | `true` | **INERT** — no consumer (no PR-stage gate exists) |
| `worca.milestones.deploy_approval` | `true` | **INERT** — no `Stage.DEPLOY` exists |
| `worca.circuit_breaker.enabled` | `true` | **CONSUMED** — `src/worca/orchestrator/runner.py:1877` |
| `worca.circuit_breaker.max_consecutive_failures` | `3` | **CONSUMED** — `src/worca/orchestrator/error_classifier.py:227`, `worca-ui/app/views/run-detail.js:264` |
| `worca.circuit_breaker.classifier_model` | `haiku` | **CONSUMED** — `src/worca/orchestrator/error_classifier.py:102` |

(Excluded from scope: `cb.transient_retry_count` is redundant with `len(transient_retry_backoff_seconds)`; `cb.transient_retry_backoff_seconds` is consumed but is an internal mechanic per Considerations.)

User-facing impact: power features are invisible; the W-048 worktree mechanics in particular are invisible **and** half-broken (the configured disk threshold has no effect even when set).

### Three plumbing bugs blocking the disk-threshold feature today

1. **Bug A — wrong key shape.** `worca-ui/app/views/sidebar.js:105` reads `settings['worca.ui.worktree_disk_warning_bytes']` (flat-dot key) but the server response from `worca-ui/server/project-routes.js:363` returns nested via `readMergedSettings`.
2. **Bug B — hardcoded threshold.** `worca-ui/app/views/worktrees.js:56` literal `over2gb = total > 2_000_000_000`; never reads the setting.
3. **Bug C — no data flow to the views.** `worca-ui/app/main.js:805` assigns `projSettings` to a module-local variable. It is **never** pushed into the store via `store.setState`. `sidebarView` destructures `settings = {}` from `state` (`sidebar.js:81`) — so the lookup always falls back to 2 GB regardless of what the JSON contains. `worktreesView(state.worktrees || [], { ... })` (`main.js:2149`) doesn't receive settings at all.

Bug C is the headline: even after Bug A's fix, the sidebar would see an empty object and the threshold would still be inert. All three must be fixed in the same wave that ships the editor, or the editor saves a value nothing reads.

## Proposal

Five phased waves. Each lands as its own PR. The first ships the global preferences endpoint plus editors for the 6 already-consumed keys — bigger than originally drafted (Wave 1 ~300 LOC) because committing to the project/global split up front avoids a later migration. Waves 2–5 implement runtime consumers for the inert keys, then expose them via editors that go straight into the correct tab.

| Wave | Scope | Risk | Approx LOC |
|------|-------|------|---|
| 1 | Global preferences endpoint + threshold plumbing fix (Bugs A/B/C) + editors for the 6 already-consumed keys (4 project, 2 global) | medium | ~300 + tests |
| 2 | Implement `default_base_branch` consumer + project editor + New Pipeline form placeholder | low | ~50 + tests |
| 3 | Implement `cleanup_policy` consumer (post-completion hook in process-manager, reading from global) + global editor | medium | ~100 + tests |
| 4 | Implement `max_concurrent_pipelines` server enforcement (cross-project cap) + UI gating + global editor | medium | ~120 + tests |
| 5 | Implement `pr_approval` consumer (mirror `plan_approval` state-machine pattern) + UI approve/reject affordance + project editor | medium-high | ~200 + tests |

**Architectural decisions (committed):**
- **Global preferences endpoint** (`GET`/`PUT /api/preferences` reading/writing `~/.worca/settings.json`) ships in Wave 1. Hosts all four naturally-global keys from day one — no later migration.
- **Disk-threshold data flow:** explicit prop threading through `main.js → sidebarView` and `main.js → worktreesView`, sourced from a `state.worktreeDiskWarningBytes` scalar. The scalar is populated from the global preferences fetch on bootstrap, not from per-project settings.
- **Project / global split** (final, no later migration):

| Tab | Keys | Justification |
|---|---|---|
| **Project Pipeline** (`.claude/settings.json`) | `worktree_base_dir`, `default_base_branch`, `plan_approval`, `pr_approval`, `cb.enabled`, `cb.max_consecutive_failures` | Varies per repo / pipeline shape |
| **Global Preferences** (`~/.worca/settings.json`) | `cleanup_policy`, `worktree_disk_warning_bytes`, `cb.classifier_model`, `max_concurrent_pipelines` | Per-user / per-machine concern (habit, disk, wallet, host capacity) |

Both blobs deep-merge client-side, project taking precedence — same pattern as `worca.models`. (Today no overlap exists in practice; the merge is forward-compatible.)

### Out of scope

- **`worca.milestones.deploy_approval`** — no `Stage.DEPLOY` exists; gating something that doesn't run is meaningless. Defer to whenever a deploy stage ships (file as a follow-up, do not expose an editor here).
- **`worca.circuit_breaker.transient_retry_count`** — redundant with `len(transient_retry_backoff_seconds)`. Document as deprecated in `settings.json` comments; do not expose.
- **`worca.circuit_breaker.transient_retry_backoff_seconds`** — consumed but internal-mechanic; tweaking it without context produces surprising retry storms.
- `worca.models.*` — set-once-per-codebase; the Agents tab already lets users pick between aliases.
- `worca.events.*` — already exposed in Notifications/Webhooks tab.
- Per-run worktree on/off toggle (decided during W-048).
- `.claude/` skip-patterns key (not shipped in `settings.json` yet).

## Design

### 1. Tab section ordering

#### Project Pipeline tab

`worca-ui/app/views/settings.js:514-643` renders the project-scoped `pipelineTab(worca, rerender)`. Today's order:

```
Preflight
Stage Configuration
Loop Limits
Plan Path Template
Run Defaults
[Save / Reset]
```

Target ordering after all waves (new sections marked `*`, with the wave that adds each):

```
Preflight
Stage Configuration
Loop Limits
Plan Path Template
Run Defaults
Approval Gates*           (Wave 1 plan_approval, Wave 5 pr_approval)
Circuit Breaker*          (Wave 1 — enabled + max_consecutive_failures only; classifier_model goes global)
Execution & Parallelism*  (Wave 1 worktree_base_dir; Wave 2 default_base_branch)
[Save / Reset]
```

#### Global Preferences tab

`worca-ui/app/views/settings.js:1077-1115` renders the global `preferencesTab(preferences, { onThemeToggle, onSaveSourceRepo, rerender })`. Today's content is theme + source repo. Target ordering after all waves:

```
Theme                                (existing)
Development (source repo)            (existing)
Worktrees*                           (Wave 1 — disk threshold; Wave 3 — cleanup_policy)
Pipeline Execution*                  (Wave 1 — cb.classifier_model; Wave 4 — max_concurrent_pipelines)
Version block                        (existing)
```

### 2. Wave 1 — Global preferences endpoint + plumbing fix + already-consumed editors

#### 2a. Global preferences endpoint (new infrastructure)

`worca-ui/server/preferences-routes.js` (new file):

```js
// GET /api/preferences — returns the merged ~/.worca/settings.json with defaults applied
router.get('/', (req, res) => {
  const prefs = readGlobalSettings();
  res.json({ ok: true, preferences: prefs });
});

// PUT /api/preferences — partial deep-merge update of ~/.worca/settings.json
router.put('/', (req, res) => {
  const validation = validateGlobalSettings(req.body);
  if (!validation.ok) return res.status(400).json(validation);
  writeGlobalSettings(req.body);
  res.json({ ok: true });
});
```

`readGlobalSettings` / `writeGlobalSettings` mirror the existing `readMergedSettings` / `writeProjectSettings` helpers in `worca-ui/server/settings-reader.js` but target `~/.worca/settings.json`. Add to the same file:

```js
const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.worca', 'settings.json');

function readGlobalSettings() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  raw.worca ??= {};
  raw.worca.parallel ??= {};
  raw.worca.parallel.cleanup_policy ??= 'on-success';
  raw.worca.parallel.max_concurrent_pipelines ??= 3;
  raw.worca.ui ??= {};
  raw.worca.ui.worktree_disk_warning_bytes ??= 2_000_000_000;
  raw.worca.circuit_breaker ??= {};
  raw.worca.circuit_breaker.classifier_model ??= 'haiku';
  return raw;
}

function writeGlobalSettings(partial) {
  // Deep-merge partial into existing global blob, then atomic write
  const existing = readGlobalSettings();
  const merged = deepMerge(existing, partial);
  ensureDirSync(path.dirname(GLOBAL_SETTINGS_PATH));
  writeFileSyncAtomic(GLOBAL_SETTINGS_PATH, JSON.stringify(merged, null, 2));
}
```

`validateGlobalSettings` is a focused validator covering only the four global keys (Section 8).

Mount the router in `worca-ui/server/app.js` alongside the existing project routes.

**Consumer-side change:** the runner / Python side reads project `settings.json` today via `worca.utils.settings.load_settings`. After Wave 1, `cleanup_policy` and `max_concurrent_pipelines` are not consumed by Python (the consumers are added in Waves 3 / 4 and live in the UI server, which reads `~/.worca/settings.json` directly). `cb.classifier_model` IS consumed by Python (`error_classifier.py:102`); it must continue to read from per-project settings, but with a global fallback. Add a small helper `worca.utils.settings.load_settings_with_global_fallback(project_path)` that deep-merges `~/.worca/settings.json` under the project blob (project wins). Update `error_classifier.py:102` to use it.

That's the only Python-side change in Wave 1 — three lines plus a helper.

#### 2b. Disk-threshold plumbing fix (Bugs A/B/C)

The threshold now sources from global preferences. `bootstrap()` in `main.js` fetches `/api/preferences` once at startup; the `worktreeDiskWarningBytes` scalar lives in store state.

```js
// main.js — in bootstrap, after initial project list fetch
const prefsRes = await fetch('/api/preferences');
const { preferences } = await prefsRes.json();
const bytes = preferences?.worca?.ui?.worktree_disk_warning_bytes ?? 2_000_000_000;
store.setState({
  worktreeDiskWarningBytes: bytes,
  classifierModel: preferences?.worca?.circuit_breaker?.classifier_model ?? 'haiku',
  cleanupPolicy: preferences?.worca?.parallel?.cleanup_policy ?? 'on-success',
  maxConcurrentPipelines: preferences?.worca?.parallel?.max_consecutive_pipelines ?? 3,
});
```

(Last three populated together so later waves don't need to re-touch this block.)

Then in `sidebarView`:

```js
// sidebar.js — replace lines 104-105
const diskWarningThreshold =
  state.worktreeDiskWarningBytes ?? 2_000_000_000;
```

And in `worktreesView`:

```js
// worktrees.js — replace line 56
const overThreshold = total > (options.diskWarningBytes ?? 2_000_000_000);
```

`main.js:2149` call site:

```js
return worktreesView(state.worktrees || [], {
  ...existingOptions,
  diskWarningBytes: state.worktreeDiskWarningBytes ?? 2_000_000_000,
});
```

`store.js` initial state adds `worktreeDiskWarningBytes: 2_000_000_000` (and the three other globals so first render before bootstrap doesn't NPE).

**Why prop threading vs `state.settings`:** the views never destructure a `settings` blob; they consume single scalars from state. Sidebar reads from state directly because it already destructures from state for everything else; worktrees view takes a prop because it already takes a fat options bag. Pattern stays consistent with each view's existing shape.

#### 2c. Project Pipeline tab editors (Wave 1 subset)

All in project-scoped `.claude/settings.json` via the existing `POST /api/projects/:id/settings`. Render shape mirrors existing `settings-grid` / `settings-field` rows.

**Approval Gates section** (Wave 1 ships only `plan_approval`; Wave 5 adds `pr_approval`):

| Field | Key | Default | Control |
|---|---|---|---|
| Plan approval required | `worca.milestones.plan_approval` | `true` | `<sl-switch id="milestone-plan-approval">`. Hint: "Pipeline pauses after Plan stage; pause-control event lets you approve or reject before Coordinate." |

**Circuit Breaker section** (Wave 1 — `classifier_model` ships in the Global tab, Section 2d):

| Field | Key | Default | Control |
|---|---|---|---|
| Enabled | `worca.circuit_breaker.enabled` | `true` | `<sl-switch id="cb-enabled">` |
| Max consecutive failures | `worca.circuit_breaker.max_consecutive_failures` | `3` | `<sl-input type="number" min="1" max="10" id="cb-max-failures">`. Hint: "Stop after N consecutive errors of the same kind." |

**Execution & Parallelism section** (Wave 1 subset):

| Field | Key | Default | Control |
|---|---|---|---|
| Worktree base directory | `worca.parallel.worktree_base_dir` | `.worktrees` | `<sl-input id="parallel-worktree-base-dir">`. Hint: "Relative paths resolve from project root. Absolute and `~/`-prefixed paths supported." |

#### 2d. Global Preferences tab editors (Wave 1 subset)

All in `~/.worca/settings.json` via `PUT /api/preferences`. New `preferencesTab` Save handler PUTs the partial blob.

**Worktrees group:**

| Field | Key | Default | Control |
|---|---|---|---|
| Disk warning threshold | `worca.ui.worktree_disk_warning_bytes` | `2_000_000_000` (2 GB) | Number input + unit `<sl-select>` (MB/GB), range 0.5–50 GB; persists raw bytes. |

Two-control layout:

```js
function formatDiskThreshold(bytes) {
  if (bytes >= 1_000_000_000) return { value: bytes / 1_000_000_000, unit: 'GB' };
  return { value: bytes / 1_000_000, unit: 'MB' };
}

function readDiskThresholdFromDom() {
  const v = parseFloat(document.getElementById('pref-disk-warning-value')?.value);
  const unit = document.getElementById('pref-disk-warning-unit')?.value || 'GB';
  if (!Number.isFinite(v) || v <= 0) return 2_000_000_000;
  const factor = unit === 'MB' ? 1_000_000 : 1_000_000_000;
  return Math.min(50_000_000_000, Math.max(500_000_000, Math.round(v * factor)));
}
```

**Pipeline Execution group:**

| Field | Key | Default | Control |
|---|---|---|---|
| Error classifier model | `worca.circuit_breaker.classifier_model` | `haiku` | `<sl-select id="pref-classifier-model">` populated from `Object.keys(worca.models)`. Hint: "Model used to classify pipeline errors. Cost is billed to your API key." |

The classifier-model `<sl-select>` reads from `worca.models` aliases on the client (so it tracks future alias additions). The validator (`VALID_MODELS` at `worca-ui/server/settings-validator.js:15`, currently `['opus', 'sonnet', 'haiku']`) must be updated in lockstep when new aliases are added — call this out as a known coupling in code comments at both sites.

**Save handler in `preferencesTab`:**

```js
async function savePreferences() {
  const partial = {
    worca: {
      ui: { worktree_disk_warning_bytes: readDiskThresholdFromDom() },
      circuit_breaker: { classifier_model: document.getElementById('pref-classifier-model')?.value || 'haiku' },
      // cleanup_policy added in Wave 3, max_concurrent_pipelines added in Wave 4
    },
  };
  const res = await fetch('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  // ... handle 400 validation errors, refresh state ...
}
```

### 3. Wave 2 — `default_base_branch` (project consumer + project editor)

**Backend consumer:** `src/worca/scripts/run_worktree.py:217` currently does `base_branch = args.branch or "HEAD"`. Replace with:

```python
_settings = load_settings(args.settings)
_parallel = _settings.get("worca", {}).get("parallel", {})
_default_branch = _parallel.get("default_base_branch", "main")
base_branch = args.branch or _default_branch
```

(Move the `load_settings` call above its current spot at line 222 since it's now needed for both `worktree_base_dir` and `default_base_branch`. Single read, both reads off the same dict.)

**UI consumer:** New Pipeline form (find via `grep -n "branch" worca-ui/app/views/new-pipeline.js` — verify path during implementation) uses the configured value as placeholder for the base-branch text input. If the form already takes a `defaultBranch` prop, pass `state.projectSettings?.worca?.parallel?.default_base_branch ?? 'main'` from `main.js`. If not, add the prop.

**Project Pipeline tab editor (Execution & Parallelism section):**

| Field | Key | Default | Control |
|---|---|---|---|
| Default PR base branch | `worca.parallel.default_base_branch` | `main` | `<sl-input id="parallel-default-base-branch">`. Hint: "Used as the default when launching a new worktree-based run if `--branch` is not specified." |

**Tests:**
- `tests/test_run_worktree.py` — `--branch` omitted + `default_base_branch` set → `create_pipeline_worktree` called with that branch.
- `tests/test_run_worktree.py` — `--branch` provided → `default_base_branch` ignored.
- Render test for the editor in Pipeline tab.

### 4. Wave 3 — `cleanup_policy` (consumer + global editor)

**Where the consumer lives:** `run_worktree.py` uses fire-and-forget `subprocess.Popen` (line 264-272) to spawn the pipeline. Cleanup must happen *after* the subprocess exits and from a process *outside* the worktree (you cannot `git worktree remove` from inside it). The cleanest place is the UI server's process-manager, which already tracks running PIDs and polls for status — and which already has `readGlobalSettings()` available from Wave 1.

**Backend:**

`worca-ui/server/process-manager.js` — add a completion-watcher behavior. When `getRunningPid()` transitions from a valid PID to `null` (process exit detected on the next status poll), read the cleanup policy from **global preferences** and the run's exit status:

```js
// After process exit detected:
const globalPrefs = readGlobalSettings();
const policy = globalPrefs?.worca?.parallel?.cleanup_policy ?? 'on-success';
const status = readRunStatus(runId); // status.json
const exitOk = status?.outcome === 'completed' || status?.exit_code === 0;
const worktreePath = status?.worktree_path;

if (worktreePath && policy === 'on-success' && exitOk) {
  await removeWorktree(worktreePath); // wraps `git worktree remove --force`
  emitEvent('worktree.auto_cleanup', { runId, path: worktreePath, reason: 'on-success' });
}
// 'never' and 'manual-only' both no-op — semantic difference is documentation only
```

`removeWorktree` mirrors `_cleanup_worktree` at `src/worca/scripts/run_parallel.py:117-122` (one-line `git worktree remove` shell-out).

**Pre-conditions to verify during implementation:**
- That `status.json` contains `worktree_path` after W-048. If not, plumb it through `register_pipeline()`.
- That process-manager has a hook for "process exit detected" — there is already polling for `getRunningPid()`; this just adds a state-transition handler. ~30 LOC.

**Global Preferences tab editor (Worktrees group):**

| Field | Key | Default | Control |
|---|---|---|---|
| Auto-cleanup policy | `worca.parallel.cleanup_policy` | `on-success` | `<sl-select id="pref-cleanup-policy">` with options `never`, `on-success`, `manual-only`. Hint: "Auto-removes the worktree after pipeline completion. `on-success` only removes on clean exit; `manual-only` and `never` both leave the worktree in place — use `manual-only` to signal intent for the Worktrees view to surface a cleanup hint." |

Extend `preferencesTab` Save handler to include `cleanup_policy` in the PUT payload.

**Tests:**
- `worca-ui/server/process-manager.test.js` — three cases: `on-success` + clean exit → cleanup called; `on-success` + failed exit → no cleanup; `never` → no cleanup.
- Integration test in `tests/integration/` — full pipeline with `cleanup_policy=on-success` leaves no worktree behind.
- Render test for the global editor.

### 5. Wave 4 — `max_concurrent_pipelines` enforcement + UI gating + global editor

The global preferences endpoint already exists from Wave 1. This wave only adds the enforcement, UI gating, and editor.

#### 5a. Server enforcement on POST /runs

`worca-ui/server/project-routes.js:617-627` already 409s on per-project parallelism. Add a sibling check for the global cap **before** the per-project check, since it's strictly broader:

```js
router.post('/runs', requireWorcaDir, async (req, res) => {
  const globalPrefs = readGlobalSettings();
  const cap = globalPrefs?.worca?.parallel?.max_concurrent_pipelines ?? 3;
  const totalRunning = countRunningPipelinesAcrossProjects();
  if (totalRunning >= cap) {
    return res.status(409).json({
      ok: false,
      error: `At max concurrent pipelines (${cap}). Stop a running pipeline or raise the cap in global Preferences.`,
      code: 'max_concurrent_exceeded',
      cap,
      running: totalRunning,
    });
  }

  // ... existing per-project check ...
});
```

`countRunningPipelinesAcrossProjects` is a new helper in `worca-ui/server/process-registry.js` that walks `~/.worca/projects.d/`, calls `pm.getRunningPid()` per project, returns the count.

#### 5b. UI gating + feedback

- New Pipeline launch button: when `state.totalRunning >= state.maxConcurrentPipelines`, disable + tooltip "At max concurrent (N). Stop a running pipeline first."
- On launch attempt that returns 409 with `code: 'max_concurrent_exceeded'`, show a banner with the response message.
- Sidebar / Dashboard: when at cap, surface a small badge "N/N pipelines" (orange) so the cap is visible.

`state.totalRunning` derives from `Object.values(state.runs).filter(r => r.pipeline_status === 'running').length` — already in state.
`state.maxConcurrentPipelines` is already populated by the Wave 1 bootstrap fetch (Section 2b).

#### 5c. Global Preferences tab editor (Pipeline Execution group)

| Field | Key | Default | Control |
|---|---|---|---|
| Max concurrent pipelines | `worca.parallel.max_concurrent_pipelines` | `3` | `<sl-input type="number" min="1" max="20" id="pref-max-concurrent">`. Hint: "Hard cap across all projects. Server returns 409 when exceeded." |

Extend `preferencesTab` Save handler to include `max_concurrent_pipelines` in the PUT payload.

**Tests:**
- Server: 409 when `totalRunning >= cap`; 200 when below cap.
- Server: validator rejects `< 1` and `> 20`.
- UI: launch button disabled when at cap; 409 banner shown on launch failure.
- E2E: launch N runs across two projects, attempt N+1, expect 409 + UI banner.

### 6. Wave 5 — `pr_approval` (state-machine consumer + UI approve/reject + project editor)

#### 6a. Backend — mirror `plan_approval` pattern

The existing `plan_approval` gate (`runner.py:2089-2118`) runs after PLAN completes:

```python
elif current_stage == Stage.PLAN:
    _ms_cfg = load_settings(settings_path).get("worca", {}).get("milestones", {})
    if _ms_cfg.get("plan_approval") is False:
        approved = True
    else:
        approved = result.get("approved", True)
    # ... emit MILESTONE_SET, await control webhook for approve/reject/pause/abort ...
```

Add an analogous gate **at the start of PR-stage handling, before guardian creates the PR**:

```python
elif current_stage == Stage.PR:
    _ms_cfg = load_settings(settings_path).get("worca", {}).get("milestones", {})
    if _ms_cfg.get("pr_approval") is False:
        pr_approved = True
    else:
        set_milestone(status, "pr_approved", False)
        pr_approved = False
        if ctx:
            _ms_event = emit_event(ctx, MILESTONE_SET, milestone_set_payload(
                milestone="pr_approved", value=False, stage=Stage.PR.value,
            ))
            if _ms_event:
                _action = _check_control_response(ctx, _ms_event)
                if _action == "approve":
                    pr_approved = True
                    set_milestone(status, "pr_approved", True)
                elif _action == "reject":
                    raise PipelineInterrupted(
                        "PR creation rejected by user",
                        stop_reason="pr_rejected",
                    )
                elif _action == "pause":
                    _handle_pause(ctx, "pr_approved milestone")
                elif _action == "abort":
                    raise PipelineInterrupted(
                        "Aborted via control webhook",
                        stop_reason="control_webhook",
                    )
        else:
            # No webhook context — default to approve to preserve existing behavior
            pr_approved = True
            set_milestone(status, "pr_approved", True)

    if not pr_approved:
        # No approval received and no rejection — defer; pipeline pauses
        save_status(status, actual_status_path)
        return
```

**Schema additions:**
- `set_milestone(status, "pr_approved", ...)` — add `pr_approved` to the milestone keys recognized by `src/worca/state/status.py` (or wherever milestones are typed).
- `stop_reason="pr_rejected"` — add to the `STOP_REASONS` enum if one exists; otherwise document inline.

#### 6b. UI — approve/reject affordance

`run-detail.js` already has a pause/resume control panel. Add a parallel "approval pending" affordance that appears when `run.milestones?.pr_approved === false` and the run is paused at the PR gate.

```js
// run-detail.js — new approval panel rendered above the pause/resume controls
${
  run.milestones?.pr_approved === false && run.pipeline_status === 'paused'
    ? approvalPanelView({
        title: 'PR creation requires approval',
        onApprove: () => sendControl(run.id, { milestone: 'pr_approved', action: 'approve' }),
        onReject: () => sendControl(run.id, { milestone: 'pr_approved', action: 'reject' }),
      })
    : nothing
}
```

`sendControl` posts to `POST /api/projects/:projectId/runs/:id/control` (confirm endpoint exists; if not, the pause/resume buttons already do something analogous — reuse).

#### 6c. Editor

Add `pr_approval` to the existing Project Pipeline > Approval Gates section (created in Wave 1):

| Field | Key | Default | Control |
|---|---|---|---|
| PR approval required | `worca.milestones.pr_approval` | `true` | `<sl-switch id="milestone-pr-approval">`. Hint: "Pipeline pauses before guardian creates the PR. Approve/reject from the run detail view." |

**Tests:**
- `tests/test_runner_pr_approval.py` — `pr_approval=true` + control approve → PR runs; `pr_approval=true` + control reject → `PipelineInterrupted("pr_rejected")`; `pr_approval=false` → PR runs without gate.
- `tests/integration/test_pr_approval_flow.py` — full pipeline with the gate, mock-controlled approve.
- UI render test for the approval panel; UI test for the editor.

### 7. Read / save plumbing (cumulative across waves)

#### 7a. Project tab — `readPipelineFromDom`

`worca-ui/app/views/settings.js:365-379`. Cumulative shape after all waves:

```js
function readPipelineFromDom() {
  // ...existing loops/plan_path_template/defaults reads...

  // Wave 1
  const milestones = {
    plan_approval: document.getElementById('milestone-plan-approval')?.checked ?? true,
    // pr_approval added in Wave 5 below
  };
  const circuit_breaker = {
    enabled: document.getElementById('cb-enabled')?.checked ?? true,
    max_consecutive_failures: parseInt(document.getElementById('cb-max-failures')?.value, 10) || 3,
    // classifier_model lives in global preferences (Wave 1) — not here
  };
  const parallel = {
    worktree_base_dir: document.getElementById('parallel-worktree-base-dir')?.value?.trim() || '.worktrees',
    // default_base_branch added in Wave 2 below
    // cleanup_policy + max_concurrent_pipelines live in global preferences — not here
  };

  // Wave 2
  parallel.default_base_branch = document.getElementById('parallel-default-base-branch')?.value?.trim() || 'main';
  // Wave 5
  milestones.pr_approval = document.getElementById('milestone-pr-approval')?.checked ?? true;

  return { loops, plan_path_template, defaults, parallel, milestones, circuit_breaker };
}
```

Save handler payload (`settings.js:625-636`):

```js
saveSettings({
  worca: { loops, stages, plan_path_template, defaults, parallel, milestones, circuit_breaker }
}, rerender);
```

#### 7b. Global tab — `readPreferencesFromDom` + `savePreferences`

New helper in `preferencesTab`:

```js
function readGlobalsFromDom() {
  return {
    worca: {
      // Wave 1
      ui: { worktree_disk_warning_bytes: readDiskThresholdFromDom() },
      circuit_breaker: { classifier_model: document.getElementById('pref-classifier-model')?.value || 'haiku' },
      parallel: {
        // Wave 3
        cleanup_policy: document.getElementById('pref-cleanup-policy')?.value || 'on-success',
        // Wave 4
        max_concurrent_pipelines: parseInt(document.getElementById('pref-max-concurrent')?.value, 10) || 3,
      },
    },
  };
}

async function savePreferences() {
  const res = await fetch('/api/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readGlobalsFromDom()),
  });
  if (!res.ok) {
    const body = await res.json();
    notify('error', body.error || 'Save failed', body.details);
    return;
  }
  // refresh in-memory state from server
  const fresh = await (await fetch('/api/preferences')).json();
  store.setState({
    worktreeDiskWarningBytes: fresh.preferences?.worca?.ui?.worktree_disk_warning_bytes ?? 2_000_000_000,
    classifierModel: fresh.preferences?.worca?.circuit_breaker?.classifier_model ?? 'haiku',
    cleanupPolicy: fresh.preferences?.worca?.parallel?.cleanup_policy ?? 'on-success',
    maxConcurrentPipelines: fresh.preferences?.worca?.parallel?.max_concurrent_pipelines ?? 3,
  });
  rerender();
}
```

The existing `pref-source-repo` save handler stays untouched; both share the `preferencesTab` Save button or have separate buttons per group — decide during implementation. Recommend a single Save button driving both, to match the project tab's pattern.

### 8. Validator additions (`worca-ui/server/settings-validator.js`)

#### 8a. Project validator — extends Wave 1

**`worca.parallel`** (Wave 1; extended in Wave 2):

```js
if (w.parallel !== undefined) {
  if (typeof w.parallel !== 'object' || w.parallel === null || Array.isArray(w.parallel)) {
    details.push('worca.parallel must be an object');
  } else {
    const p = w.parallel;
    if (p.worktree_base_dir !== undefined &&
        (typeof p.worktree_base_dir !== 'string' || p.worktree_base_dir.length === 0)) {
      details.push('parallel.worktree_base_dir must be a non-empty string');
    }
    if (p.default_base_branch !== undefined &&
        (typeof p.default_base_branch !== 'string' || p.default_base_branch.length === 0)) {
      details.push('parallel.default_base_branch must be a non-empty string');
    }
    // cleanup_policy + max_concurrent_pipelines live in global validator (8b)
  }
}
```

**`worca.circuit_breaker`** (Wave 1):

```js
if (w.circuit_breaker !== undefined) {
  if (typeof w.circuit_breaker !== 'object' || w.circuit_breaker === null || Array.isArray(w.circuit_breaker)) {
    details.push('worca.circuit_breaker must be an object');
  } else {
    const cb = w.circuit_breaker;
    if (cb.enabled !== undefined && typeof cb.enabled !== 'boolean') {
      details.push('circuit_breaker.enabled must be a boolean');
    }
    if (cb.max_consecutive_failures !== undefined &&
        (!Number.isInteger(cb.max_consecutive_failures) ||
         cb.max_consecutive_failures < 1 || cb.max_consecutive_failures > 10)) {
      details.push('circuit_breaker.max_consecutive_failures must be an integer between 1 and 10');
    }
    // classifier_model lives in global validator (8b)
  }
}
```

`worca.milestones` already validated (`settings-validator.js:248-265`); no change for Wave 1 / Wave 5.

The project validator must also reject keys that belong in global preferences (`cleanup_policy`, `max_concurrent_pipelines`, `ui.worktree_disk_warning_bytes`, `circuit_breaker.classifier_model`) with a helpful message: "this setting is configured in global Preferences (~/.worca/settings.json), not project settings". Prevents users from hand-editing the wrong file and silently having no effect.

#### 8b. Global validator — Wave 1

A new `validateGlobalSettings(prefs)` function — focused on the four global keys only:

```js
const VALID_CLEANUP_POLICIES = ['never', 'on-success', 'manual-only'];

function validateGlobalSettings(prefs) {
  const details = [];
  const w = prefs?.worca;
  if (!w) return { ok: true };

  // Wave 1 — disk threshold
  if (w.ui?.worktree_disk_warning_bytes !== undefined) {
    const v = w.ui.worktree_disk_warning_bytes;
    if (!Number.isInteger(v) || v < 500_000_000 || v > 50_000_000_000) {
      details.push('ui.worktree_disk_warning_bytes must be an integer between 500_000_000 (500 MB) and 50_000_000_000 (50 GB)');
    }
  }

  // Wave 1 — classifier model
  if (w.circuit_breaker?.classifier_model !== undefined &&
      !VALID_MODELS.includes(w.circuit_breaker.classifier_model)) {
    details.push(`circuit_breaker.classifier_model must be one of: ${VALID_MODELS.join(', ')}`);
  }

  // Wave 3 — cleanup policy
  if (w.parallel?.cleanup_policy !== undefined &&
      !VALID_CLEANUP_POLICIES.includes(w.parallel.cleanup_policy)) {
    details.push(`parallel.cleanup_policy must be one of: ${VALID_CLEANUP_POLICIES.join(', ')}`);
  }

  // Wave 4 — max concurrent
  if (w.parallel?.max_concurrent_pipelines !== undefined) {
    const n = w.parallel.max_concurrent_pipelines;
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      details.push('parallel.max_concurrent_pipelines must be an integer between 1 and 20');
    }
  }

  return details.length === 0 ? { ok: true } : { ok: false, details };
}
```

Note: `worca.ui` already holds `worca.ui.stages` (consumed by `worca-ui/server/settings-reader.js:11`) **in project settings**. The global blob does not currently have a `ui.stages` consumer; the global validator narrows only `worktree_disk_warning_bytes` and ignores other `ui.*` keys (forward-compatible).

### 9. Default normalization

#### 9a. Project — `loadSettings()` at `worca-ui/app/views/settings.js:160`

```js
// Wave 1
if (!settingsData.worca.parallel) settingsData.worca.parallel = {};
if (settingsData.worca.parallel.worktree_base_dir === undefined) {
  settingsData.worca.parallel.worktree_base_dir = '.worktrees';
}
if (!settingsData.worca.circuit_breaker) {
  settingsData.worca.circuit_breaker = { enabled: true, max_consecutive_failures: 3 };
}
if (!settingsData.worca.milestones) {
  settingsData.worca.milestones = { plan_approval: true };
}

// Wave 2
if (settingsData.worca.parallel.default_base_branch === undefined) {
  settingsData.worca.parallel.default_base_branch = 'main';
}

// Wave 5
if (settingsData.worca.milestones.pr_approval === undefined) {
  settingsData.worca.milestones.pr_approval = true;
}
```

#### 9b. Global — `readGlobalSettings()` (server, `worca-ui/server/settings-reader.js`)

Already shown in Section 2a — applies all four defaults at read time.

### 10. Tab-scope decisions (final, no later migration)

| Key | Wave | Tab | Persistence |
|---|---|---|---|
| `parallel.worktree_base_dir` | 1 | Project Pipeline | `.claude/settings.json` |
| `parallel.default_base_branch` | 2 | Project Pipeline | `.claude/settings.json` |
| `parallel.cleanup_policy` | 3 | **Global Preferences** | `~/.worca/settings.json` |
| `parallel.max_concurrent_pipelines` | 4 | **Global Preferences** | `~/.worca/settings.json` |
| `ui.worktree_disk_warning_bytes` | 1 | **Global Preferences** | `~/.worca/settings.json` |
| `milestones.plan_approval` | 1 | Project Pipeline | `.claude/settings.json` |
| `milestones.pr_approval` | 5 | Project Pipeline | `.claude/settings.json` |
| `circuit_breaker.enabled` | 1 | Project Pipeline | `.claude/settings.json` |
| `circuit_breaker.max_consecutive_failures` | 1 | Project Pipeline | `.claude/settings.json` |
| `circuit_breaker.classifier_model` | 1 | **Global Preferences** | `~/.worca/settings.json` |

## Implementation Plan

### Wave 1 — Global preferences endpoint + plumbing fix + already-consumed editors

**Files:**
- `worca-ui/server/preferences-routes.js` (new)
- `worca-ui/server/preferences-routes.test.js` (new)
- `worca-ui/server/settings-reader.js` (add `readGlobalSettings` / `writeGlobalSettings`)
- `worca-ui/server/settings-validator.js` (new `validateGlobalSettings`; project blocks for `worca.parallel`, `worca.circuit_breaker`; reject-misplaced-keys helper)
- `worca-ui/server/settings-validator.test.js` (extend)
- `worca-ui/server/app.js` (mount preferences router)
- `src/worca/utils/settings.py` (add `load_settings_with_global_fallback`)
- `src/worca/orchestrator/error_classifier.py` (use the new helper at line 102)
- `tests/test_settings_global_fallback.py` (new)
- `worca-ui/app/main.js` (bootstrap fetches `/api/preferences`; populates four state scalars; passes threshold into `worktreesView`)
- `worca-ui/app/store.js` (add four global-derived scalars to initial state)
- `worca-ui/app/views/sidebar.js` (Bug A + Bug C — read `state.worktreeDiskWarningBytes`)
- `worca-ui/app/views/sidebar.test.js` (update fixtures: state-level scalar)
- `worca-ui/app/views/worktrees.js` (Bug B — accept `options.diskWarningBytes`)
- `worca-ui/app/views/settings.js`:
  - Project Pipeline tab: Approval Gates (`plan_approval`), Circuit Breaker (`enabled`, `max_consecutive_failures`), Execution & Parallelism (`worktree_base_dir`); extend `readPipelineFromDom`, `loadSettings` defaults, save handler
  - Global Preferences tab: Worktrees group (disk threshold), Pipeline Execution group (`classifier_model`); add `readGlobalsFromDom` and `savePreferences`
- `worca-ui/app/views/settings-approval-gates.test.js` (new)
- `worca-ui/app/views/settings-circuit-breaker.test.js` (new)
- `worca-ui/app/views/settings-execution-parallelism.test.js` (new)
- `worca-ui/app/views/settings-preferences-worktrees.test.js` (new)
- `worca-ui/app/views/settings-preferences-pipeline.test.js` (new)

**Steps:**
1. Build `readGlobalSettings` / `writeGlobalSettings` + `validateGlobalSettings`; mount router; smoke-test GET/PUT.
2. Add `load_settings_with_global_fallback` Python helper; wire into `error_classifier.py:102`.
3. Add four global-derived scalars to store initial state.
4. In `bootstrap()`, fetch `/api/preferences`; populate state scalars.
5. Update `sidebar.js:104-105` to read `state.worktreeDiskWarningBytes`.
6. Update `worktrees.js:56` to read `options.diskWarningBytes`; update `main.js:2149` call site.
7. Update `sidebar.test.js` fixtures.
8. Add Project Pipeline tab editors (Approval Gates, Circuit Breaker, Execution & Parallelism rows for already-consumed keys); extend `readPipelineFromDom`, `loadSettings` defaults, save handler.
9. Add Global Preferences tab editors (Worktrees + Pipeline Execution groups); add `readGlobalsFromDom`, `savePreferences`.
10. Add reject-misplaced-keys helper in project validator (rejects `cleanup_policy`, `max_concurrent_pipelines`, `ui.worktree_disk_warning_bytes`, `circuit_breaker.classifier_model` from project blob).
11. Render tests + validator tests + plumbing test (set scalar, assert sidebar badge variant + worktrees banner).
12. `cd worca-ui && npm run lint:fix && npx vitest run && npm run build`; `pytest tests/`.

### Wave 2 — `default_base_branch` (project consumer + project editor)

**Files:**
- `src/worca/scripts/run_worktree.py`
- `worca-ui/app/views/new-pipeline.js` (placeholder — verify path)
- `worca-ui/app/views/settings.js` (extend Execution & Parallelism)
- `tests/test_run_worktree.py`
- `worca-ui/app/views/settings-execution-parallelism.test.js`

**Steps:**
1. Move/refactor settings load in `run_worktree.py` to a single read; derive both `worktree_base_dir` and `default_base_branch`.
2. Replace `base_branch = args.branch or "HEAD"` with `args.branch or _default_branch`.
3. Thread `default_base_branch` into the New Pipeline form's base-branch placeholder.
4. Add the `default_base_branch` row + read/save plumbing.
5. Tests + lint + build.

### Wave 3 — `cleanup_policy` (consumer + global editor)

**Files:**
- `worca-ui/server/process-manager.js`
- `worca-ui/server/process-manager.test.js`
- `src/worca/state/status.py` (verify `worktree_path` in status.json; plumb if missing)
- `src/worca/scripts/run_worktree.py` (write `worktree_path` to status.json — confirm; W-048 may already do this)
- `worca-ui/app/views/settings.js` (extend Global Preferences > Worktrees group; extend `readGlobalsFromDom`)
- `tests/integration/test_cleanup_policy.py` (new)
- `worca-ui/app/views/settings-preferences-worktrees.test.js`

**Steps:**
1. Verify `worktree_path` is in status.json; add if missing.
2. Add post-exit handler in process-manager that reads `cleanup_policy` from global prefs and conditionally calls `removeWorktree`.
3. Add `cleanup_policy` row to Global > Worktrees group + extend `readGlobalsFromDom`.
4. Server tests + integration test + lint + build.

### Wave 4 — `max_concurrent_pipelines` enforcement + UI gating + global editor

**Files:**
- `worca-ui/server/process-registry.js` (add `countRunningPipelinesAcrossProjects`)
- `worca-ui/server/project-routes.js` (add 409 cap check at `:617`)
- `worca-ui/server/project-routes.test.js`
- `worca-ui/app/views/new-pipeline.js` (disable launch button when at cap; 409 banner)
- `worca-ui/app/views/settings.js` (extend Global > Pipeline Execution group; extend `readGlobalsFromDom`)
- `worca-ui/app/views/settings-preferences-pipeline.test.js`

**Steps:**
1. Implement cross-project count helper.
2. Add 409 cap check before per-project check in `POST /runs`.
3. Add launch-button gating + 409 banner.
4. Add `max_concurrent_pipelines` row to Global > Pipeline Execution + extend `readGlobalsFromDom`.
5. Tests (unit + e2e: launch N, attempt N+1, expect 409) + lint + build.

### Wave 5 — `pr_approval` (consumer + UI affordance + project editor)

**Files:**
- `src/worca/orchestrator/runner.py` (add PR-stage milestone gate mirroring `plan_approval`)
- `src/worca/state/status.py` (add `pr_approved` to recognized milestones)
- `src/worca/orchestrator/events.py` (verify `MILESTONE_SET` payload supports `pr_approved`)
- `worca-ui/app/views/run-detail.js` (approval panel for `pr_approved === false`)
- `worca-ui/app/views/run-detail.test.js`
- `worca-ui/app/views/settings.js` (add `pr_approval` to existing Approval Gates section; extend `readPipelineFromDom`)
- `tests/test_runner_pr_approval.py` (new)
- `tests/integration/test_pr_approval_flow.py` (new)
- `worca-ui/app/views/settings-approval-gates.test.js` (extend)

**Steps:**
1. Add `pr_approved` milestone schema.
2. Add PR-stage gate in `runner.py` (find PR-stage dispatch block; wrap with milestone gate).
3. Add UI approval panel + control wiring.
4. Add `pr_approval` row to Approval Gates section.
5. Unit + integration + UI tests + lint + build.

## Test Plan

### Wave 1

**Server tests:**
- `preferences-routes.test.js`: GET returns merged blob with defaults; PUT validates; PUT rejects out-of-range disk threshold / unknown classifier model.
- `settings-validator.test.js`: project validator rejects misplaced global keys with helpful message.
- `tests/test_settings_global_fallback.py`: project + global merge, project wins on overlap.

**Render tests:**
- `settings-approval-gates.test.js` — `plan_approval` switch renders + reads default
- `settings-circuit-breaker.test.js` — `enabled` + `max_consecutive_failures` controls render
- `settings-execution-parallelism.test.js` — `worktree_base_dir` input renders
- `settings-preferences-worktrees.test.js` — disk-threshold MB/GB pair + formatter / reader unit tests
- `settings-preferences-pipeline.test.js` — classifier-model select reads from `worca.models`

**Plumbing test (Bugs A/B/C):**
- Set `state.worktreeDiskWarningBytes = 400_000_000`; assert sidebar badge variant flips at threshold; assert worktrees view renders banner.

### Wave 2
- `tests/test_run_worktree.py`: `--branch` omitted → uses `default_base_branch`; `--branch` provided → ignores config.
- Render: `default_base_branch` input renders with current value.

### Wave 3
- `process-manager.test.js`: `on-success` + clean exit → `removeWorktree` called; `on-success` + failed exit → not called; `never` → not called.
- Integration: full pipeline with `cleanup_policy=on-success` leaves no worktree.
- Render: `cleanup_policy` select renders three options.

### Wave 4
- `project-routes.test.js`: 409 with `code: 'max_concurrent_exceeded'` when over cap; 200 when under.
- E2E: launch N runs across two projects, attempt N+1, observe 409 + UI banner.
- Render: `max_concurrent_pipelines` input renders.

### Wave 5
- `tests/test_runner_pr_approval.py`: gate skipped when `pr_approval=false`; webhook approve → PR runs; webhook reject → `PipelineInterrupted("pr_rejected")`.
- Integration: full pipeline pauses at PR gate; mock-control approves; PR succeeds.
- UI: approval panel renders when `run.milestones.pr_approved === false && pipeline_status === 'paused'`.

### Done criteria (per wave)
- All new vitest / pytest tests pass.
- `cd worca-ui && npm run lint:fix && npx vitest run` clean.
- `cd worca-ui && npm run build` produces updated bundle.
- Manual round-trip per wave (e.g., Wave 1: change disk threshold in global Preferences, save, exceed it, observe sidebar badge flip + worktrees banner appear).

## Considerations

- **Wave 1 is now ~300 LOC** (was ~200 LOC) because the global preferences endpoint ships up front. Trade-off accepted to avoid a future migration of three keys from project to global, which would surprise any user who configured them per-project in the meantime.
- **Five waves is heavy.** Worth it because each wave is independently shippable and rolls back cleanly. Bundling waves 1–2 or 4–5 is possible but each PR would exceed ~400 LOC and review quality drops.
- **`pr_approval` (Wave 5) is the largest consumer addition.** It introduces a new pipeline state and a new UI affordance. If priority drops, this wave can be deferred indefinitely without blocking the rest.
- **`deploy_approval` is honestly out of scope.** No `Stage.DEPLOY` exists. Saving the value to disk is fine (W-048 already accepts it) but we don't ship an editor that gates a non-existent stage.
- **`cb.transient_retry_count` is redundant with `len(transient_retry_backoff_seconds)`.** Document as deprecated in `settings.json`; do not expose. If anyone tunes it, the runner ignores them — the fix is to delete the key from defaults in a future cleanup.
- **Hard caps documented as hard.** Wave 4 hint for `max_concurrent_pipelines` says "Hard cap; server returns 409". Don't reuse "soft cap" language anywhere — the consumer audit shows nothing implements a soft cap today.
- **Validator / classifier-model coupling.** `VALID_MODELS` in the validator is hardcoded; the UI select is dynamic. Adding a new alias requires updating both. Add a code comment in `worca-ui/server/settings-validator.js:15` noting this.
- **Project / global merge precedence.** Project settings win over global on overlap. Today there is no overlap in practice — each key lives in exactly one tab. The merge is forward-compatible: if a future feature needs a per-project override of a global key, the merge already does the right thing.
- **Reject misplaced keys.** The project validator rejects `cleanup_policy`, `max_concurrent_pipelines`, `ui.worktree_disk_warning_bytes`, `circuit_breaker.classifier_model` with a message pointing users to the global Preferences tab. Prevents silent no-ops from hand-edits to `.claude/settings.json`.
- **Migration:** none. Default normalization in `loadSettings` and `readGlobalSettings` handles upgrades transparently. Existing users with no relevant blocks see hardcoded defaults that match current runner behavior.
- **Governance impact:** none. No hook scripts read these keys; the new `pr_approval` gate uses the existing webhook control mechanism.

## Files to Create/Modify

| Path | Wave | Status |
|------|------|--------|
| `worca-ui/server/preferences-routes.js` | 1 | create |
| `worca-ui/server/preferences-routes.test.js` | 1 | create |
| `worca-ui/server/settings-reader.js` | 1 | modify (global helpers) |
| `worca-ui/server/settings-validator.js` | 1 | modify (global validator + project blocks + reject-misplaced) |
| `worca-ui/server/settings-validator.test.js` | 1 | extend |
| `worca-ui/server/app.js` | 1 | modify (mount router) |
| `src/worca/utils/settings.py` | 1 | modify (`load_settings_with_global_fallback`) |
| `src/worca/orchestrator/error_classifier.py` | 1 | modify (use fallback helper) |
| `tests/test_settings_global_fallback.py` | 1 | create |
| `worca-ui/app/main.js` | 1 | modify (bootstrap fetch + threading) |
| `worca-ui/app/store.js` | 1 | modify (four global-derived scalars) |
| `worca-ui/app/views/sidebar.js` | 1 | modify (Bug A + Bug C consume) |
| `worca-ui/app/views/sidebar.test.js` | 1 | modify (state shape) |
| `worca-ui/app/views/worktrees.js` | 1 | modify (Bug B + accept threshold) |
| `worca-ui/app/views/settings.js` | 1, 2, 3, 4, 5 | modify (project + global tabs grow per wave) |
| `worca-ui/app/views/settings-approval-gates.test.js` | 1, 5 | create / extend |
| `worca-ui/app/views/settings-circuit-breaker.test.js` | 1 | create |
| `worca-ui/app/views/settings-execution-parallelism.test.js` | 1, 2 | create / extend |
| `worca-ui/app/views/settings-preferences-worktrees.test.js` | 1, 3 | create / extend |
| `worca-ui/app/views/settings-preferences-pipeline.test.js` | 1, 4 | create / extend |
| `src/worca/scripts/run_worktree.py` | 2, 3 | modify |
| `worca-ui/app/views/new-pipeline.js` | 2, 4 | modify (placeholder + cap gating) |
| `tests/test_run_worktree.py` | 2 | extend |
| `worca-ui/server/process-manager.js` | 3 | modify (post-exit hook) |
| `worca-ui/server/process-manager.test.js` | 3 | extend |
| `src/worca/state/status.py` | 3, 5 | modify (worktree_path; pr_approved milestone) |
| `tests/integration/test_cleanup_policy.py` | 3 | create |
| `worca-ui/server/process-registry.js` | 4 | modify (cross-project count) |
| `worca-ui/server/project-routes.js` | 4 | modify (409 cap check) |
| `worca-ui/server/project-routes.test.js` | 4 | extend |
| `src/worca/orchestrator/runner.py` | 5 | modify (PR-stage gate) |
| `worca-ui/app/views/run-detail.js` | 5 | modify (approval panel) |
| `worca-ui/app/views/run-detail.test.js` | 5 | extend |
| `tests/test_runner_pr_approval.py` | 5 | create |
| `tests/integration/test_pr_approval_flow.py` | 5 | create |
