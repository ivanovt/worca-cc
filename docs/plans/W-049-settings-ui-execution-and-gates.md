# W-049: Settings UI + Runtime Consumers for Execution, Approval Gates, Circuit Breaker, and Worktree Disk Threshold

**Status:** Draft (revised — single-delivery; project/global split committed; risk mitigations folded in)
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

Bug C is the headline: even after Bug A's fix, the sidebar would see an empty object and the threshold would still be inert. All three must be fixed in the same PR that ships the editor, or the editor saves a value nothing reads.

## Proposal

**Single delivery — one PR, one release** for both `worca-cc` and `@worca/ui` (coordinated tag push). Approximate size: ~870 LOC implementation + ~1000 LOC tests. Five logical work-streams (project tab editors, global tab editors + endpoint, runtime consumers, server enforcement, plumbing fixes + template migration), all merging together to eliminate the package-version-skew risk that a phased rollout would create.

### Architectural decisions (committed, no later migration)

- **Global preferences endpoint** (`GET`/`PUT /api/preferences` reading/writing `~/.worca/settings.json`) hosts all naturally-global keys from day one.
- **Disk-threshold data flow:** explicit prop threading through `main.js → sidebarView` and `main.js → worktreesView`, sourced from a `state.worktreeDiskWarningBytes` scalar. The scalar is populated from the global preferences fetch on bootstrap, not from per-project settings.
- **Project / global split:**

| Tab | Keys | Justification |
|---|---|---|
| **Project Pipeline** (`.claude/settings.json`) | `worktree_base_dir`, `default_base_branch`, `plan_approval`, `pr_approval`, `cb.enabled`, `cb.max_consecutive_failures` | Varies per repo / pipeline shape |
| **Global Preferences** (`~/.worca/settings.json`) | `cleanup_policy`, `worktree_disk_warning_bytes`, `cb.classifier_model`, `max_concurrent_pipelines` | Per-user / per-machine concern (habit, disk, wallet, host capacity) |

Both blobs deep-merge client-side, project taking precedence on overlap.

### Defaults (revised from earlier drafts to mitigate identified risks)

| Key | Earlier draft | Final | Reason for change |
|---|---|---|---|
| `parallel.cleanup_policy` | `on-success` | **`never`** | Auto-deletion of worktrees on success would silently break workflows that depend on post-run worktree inspection. Make `on-success` an explicit opt-in. |
| `milestones.pr_approval` | `true` | **`false`** | Default-true would hang every autonomous flow at the PR gate waiting for an approval event no one sends. Ship the gate infrastructure but keep the gate off by default. |
| `parallel.max_concurrent_pipelines` | `3` | **`10`** | Cap of 3 immediately bites users with 4+ projects on day-one upgrade. 10 is permissive enough that real workflows aren't blocked but still enforces a global ceiling. |
| `milestones.plan_approval` | `true` | `true` (unchanged) | Already in production today with this default; matches existing behavior. |
| `cb.enabled` | `true` | `true` (unchanged) | Matches current `settings.json` template default. |

### Out of scope

- **`worca.milestones.deploy_approval`** — no `Stage.DEPLOY` exists; gating something that doesn't run is meaningless. Defer to whenever a deploy stage ships.
- **`worca.circuit_breaker.transient_retry_count`** — redundant with `len(transient_retry_backoff_seconds)`. Document as deprecated; do not expose.
- **`worca.circuit_breaker.transient_retry_backoff_seconds`** — consumed but internal-mechanic.
- `worca.models.*`, `worca.events.*`, per-run worktree on/off toggle, `.claude/` skip patterns — see prior plan revisions for rationale.

### Risk profile after bundling + mitigations

| Prior risk | Status |
|---|---|
| Package release skew (UI saves global, old runtime reads project) | **Eliminated** by single-delivery |
| Template ships to-be-global keys at project scope → validation failures on upgrade | **Mitigated** by §11 (template strip + `worca init --upgrade` migration) |
| Auto-cleanup default deletes worktrees on success | **Mitigated** by default flip to `never` |
| `pr_approval` default-true hangs autonomous flows | **Mitigated** by default flip to `false` + design-time timeout backstop |
| Global cap of 3 immediately blocks multi-project users | **Mitigated** by default raise to `10` |
| Malformed `~/.worca/settings.json` crashes endpoint | **Mitigated** by try/catch in `readGlobalSettings` (§4) |
| `VALID_MODELS` validator/UI select drift | **Mitigated** by superset assertion test (§9) |
| Existing test fixtures fail new project validator | **Mitigated** in same PR (test fixtures updated alongside code) |

## Design

### 1. Tab section ordering

#### Project Pipeline tab (`worca-ui/app/views/settings.js:514-643`)

```
Preflight
Stage Configuration
Loop Limits
Plan Path Template
Run Defaults
Approval Gates*           (plan_approval + pr_approval)
Circuit Breaker*          (enabled + max_consecutive_failures only)
Execution & Parallelism*  (worktree_base_dir + default_base_branch)
[Save / Reset]
```

#### Global Preferences tab (`worca-ui/app/views/settings.js:1077-1115`)

```
Theme                                (existing)
Development (source repo)            (existing)
Worktrees*                           (disk threshold + cleanup_policy)
Pipeline Execution*                  (cb.classifier_model + max_concurrent_pipelines)
Version block                        (existing)
```

### 2. Project Pipeline tab editors

All in `.claude/settings.json` via the existing `POST /api/projects/:id/settings`. Render shape mirrors existing `settings-grid` / `settings-field` rows.

**Approval Gates section:**

| Field | Key | Default | Control |
|---|---|---|---|
| Plan approval required | `worca.milestones.plan_approval` | `true` | `<sl-switch id="milestone-plan-approval">`. Hint: "Pipeline pauses after Plan stage; pause-control event lets you approve or reject before Coordinate." |
| PR approval required | `worca.milestones.pr_approval` | `false` | `<sl-switch id="milestone-pr-approval">`. Hint: "When enabled, pipeline pauses before guardian creates the PR; approve/reject from the run detail view. Off by default to avoid hanging unattended runs — see global Preferences for default approval timeout." |

**Circuit Breaker section** (`classifier_model` lives in Global tab):

| Field | Key | Default | Control |
|---|---|---|---|
| Enabled | `worca.circuit_breaker.enabled` | `true` | `<sl-switch id="cb-enabled">` |
| Max consecutive failures | `worca.circuit_breaker.max_consecutive_failures` | `3` | `<sl-input type="number" min="1" max="10" id="cb-max-failures">`. Hint: "Stop after N consecutive errors of the same kind." |

**Execution & Parallelism section:**

| Field | Key | Default | Control |
|---|---|---|---|
| Worktree base directory | `worca.parallel.worktree_base_dir` | `.worktrees` | `<sl-input id="parallel-worktree-base-dir">`. Hint: "Relative paths resolve from project root. Absolute and `~/`-prefixed paths supported." |
| Default PR base branch | `worca.parallel.default_base_branch` | `main` | `<sl-input id="parallel-default-base-branch">`. Hint: "Used as the default when launching a new worktree-based run if `--branch` is not specified." |

### 3. Global Preferences tab editors

All in `~/.worca/settings.json` via `PUT /api/preferences`.

**Worktrees group:**

| Field | Key | Default | Control |
|---|---|---|---|
| Disk warning threshold | `worca.ui.worktree_disk_warning_bytes` | `2_000_000_000` (2 GB) | Number input + unit `<sl-select>` (MB/GB), range 0.5–50 GB; persists raw bytes. |
| Auto-cleanup policy | `worca.parallel.cleanup_policy` | `never` | `<sl-select id="pref-cleanup-policy">` with options `never`, `on-success`, `manual-only`. Hint: "When `on-success`, the worktree is auto-removed after a clean pipeline exit. `never` (default) and `manual-only` both leave it in place — use `manual-only` to flag it for the Worktrees view's cleanup hint." |

Two-control layout for the threshold (formatter / reader):

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
| Max concurrent pipelines | `worca.parallel.max_concurrent_pipelines` | `10` | `<sl-input type="number" min="1" max="20" id="pref-max-concurrent">`. Hint: "Hard cap across all projects. Server returns 409 when exceeded." |

The classifier-model `<sl-select>` reads from `worca.models` aliases on the client (so it tracks future alias additions). The validator (`VALID_MODELS` at `worca-ui/server/settings-validator.js:15`) is hardcoded — see §9 for the superset assertion test that prevents drift.

### 4. Server: global preferences endpoint

`worca-ui/server/preferences-routes.js` (new file):

```js
router.get('/', (req, res) => {
  try {
    const prefs = readGlobalSettings();
    res.json({ ok: true, preferences: prefs });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: 'Failed to read global preferences',
      detail: err.message,
    });
  }
});

router.put('/', (req, res) => {
  const validation = validateGlobalSettings(req.body);
  if (!validation.ok) return res.status(400).json(validation);
  writeGlobalSettings(req.body);
  res.json({ ok: true });
});
```

`worca-ui/server/settings-reader.js` additions (with try/catch for malformed JSON — risk #7 mitigation):

```js
const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.worca', 'settings.json');

function readGlobalSettings() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // First-run: file doesn't exist yet — return defaults
    } else if (err instanceof SyntaxError) {
      console.error(`Invalid JSON in ${GLOBAL_SETTINGS_PATH}: ${err.message}; falling back to defaults`);
    } else {
      throw err;
    }
  }
  raw.worca ??= {};
  raw.worca.parallel ??= {};
  raw.worca.parallel.cleanup_policy ??= 'never';
  raw.worca.parallel.max_concurrent_pipelines ??= 10;
  raw.worca.ui ??= {};
  raw.worca.ui.worktree_disk_warning_bytes ??= 2_000_000_000;
  raw.worca.circuit_breaker ??= {};
  raw.worca.circuit_breaker.classifier_model ??= 'haiku';
  return raw;
}

function writeGlobalSettings(partial) {
  const existing = readGlobalSettings();
  const merged = deepMerge(existing, partial);
  ensureDirSync(path.dirname(GLOBAL_SETTINGS_PATH));
  writeFileSyncAtomic(GLOBAL_SETTINGS_PATH, JSON.stringify(merged, null, 2));
}
```

Mount the router in `worca-ui/server/app.js`.

### 5. Server: enforcement

#### 5a. `max_concurrent_pipelines` cap on `POST /runs`

`worca-ui/server/project-routes.js:617-627` already 409s on per-project parallelism. Add a sibling check for the global cap **before** the per-project check:

```js
router.post('/runs', requireWorcaDir, async (req, res) => {
  const globalPrefs = readGlobalSettings();
  const cap = globalPrefs?.worca?.parallel?.max_concurrent_pipelines ?? 10;
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

#### 5b. `cleanup_policy` post-completion hook

`worca-ui/server/process-manager.js` — when `getRunningPid()` transitions from a valid PID to `null` (process exit detected on the next status poll), read the cleanup policy from global preferences:

```js
const globalPrefs = readGlobalSettings();
const policy = globalPrefs?.worca?.parallel?.cleanup_policy ?? 'never';
const status = readRunStatus(runId);
const exitOk = status?.outcome === 'completed' || status?.exit_code === 0;
const worktreePath = status?.worktree_path;

if (worktreePath && policy === 'on-success' && exitOk) {
  await removeWorktree(worktreePath);
  emitEvent('worktree.auto_cleanup', { runId, path: worktreePath, reason: 'on-success' });
}
// 'never' (default) and 'manual-only' both no-op
```

`removeWorktree` mirrors `_cleanup_worktree` at `src/worca/scripts/run_parallel.py:117-122`. Pre-condition: `worktree_path` must be present in `status.json` — verify during implementation; W-048 may already write it via `register_pipeline()`.

### 6. Runtime (Python) consumer changes

#### 6a. `cb.classifier_model` — global fallback

`src/worca/utils/settings.py` adds:

```python
def load_settings_with_global_fallback(project_path: str) -> dict:
    """Deep-merge ~/.worca/settings.json under the project blob; project wins on overlap."""
    project = load_settings(project_path)
    global_path = os.path.expanduser("~/.worca/settings.json")
    try:
        with open(global_path, "r", encoding="utf-8") as f:
            global_blob = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return project
    return deep_merge(global_blob, project)  # project overrides global
```

`src/worca/orchestrator/error_classifier.py:102` switches from `load_settings` to the new helper. No other Python consumers change for the global keys (cleanup_policy and max_concurrent are server-side; disk threshold is UI-side).

#### 6b. `default_base_branch` consumer

`src/worca/scripts/run_worktree.py:217` becomes:

```python
_settings = load_settings(args.settings)
_parallel = _settings.get("worca", {}).get("parallel", {})
_default_branch = _parallel.get("default_base_branch", "main")
base_branch = args.branch or _default_branch
_wt_base = _parallel.get("worktree_base_dir", ".worktrees")
worktree_path = create_pipeline_worktree(run_id, slug, base_branch, _wt_base)
```

(Single `load_settings` call covers both keys; lines 222-228 collapse into the block above.)

#### 6c. `pr_approval` gate

Mirror the existing `plan_approval` pattern (`runner.py:2089-2118`). Insert at the start of PR-stage handling:

```python
elif current_stage == Stage.PR:
    _ms_cfg = load_settings(settings_path).get("worca", {}).get("milestones", {})
    if _ms_cfg.get("pr_approval") is not True:  # default-false: only gate when explicitly enabled
        pr_approved = True
    else:
        set_milestone(status, "pr_approved", False)
        pr_approved = False
        if ctx:
            _ms_event = emit_event(ctx, MILESTONE_SET, milestone_set_payload(
                milestone="pr_approved", value=False, stage=Stage.PR.value,
            ))
            if _ms_event:
                _action = _check_control_response(
                    ctx, _ms_event,
                    timeout_seconds=_ms_cfg.get("pr_approval_timeout_seconds", 3600),
                    timeout_default="approve",
                )
                if _action == "approve":
                    pr_approved = True
                    set_milestone(status, "pr_approved", True)
                elif _action == "reject":
                    raise PipelineInterrupted("PR creation rejected by user", stop_reason="pr_rejected")
                elif _action == "pause":
                    _handle_pause(ctx, "pr_approved milestone")
                elif _action == "abort":
                    raise PipelineInterrupted("Aborted via control webhook", stop_reason="control_webhook")
        else:
            pr_approved = True  # No webhook context — preserve unattended-run behavior
            set_milestone(status, "pr_approved", True)

    if not pr_approved:
        save_status(status, actual_status_path)
        return
```

**Two design choices baked into this block, each mitigating risk #4:**
- **Default `false`:** the gate fires only when explicitly enabled (`is not True` rather than `is not False`). Preserves existing autonomous-run behavior.
- **Timeout backstop:** `_check_control_response` accepts an optional `timeout_seconds` (default 3600 = 1 hour) and `timeout_default="approve"`. If no approval arrives within the window, the gate auto-approves and emits a log line. Verify during implementation that `_check_control_response` supports timeouts; if not, extend it (small change). The `pr_approval_timeout_seconds` setting is internal — not editable from UI in this PR; configurable by hand-edit only.

**Schema additions:**
- `set_milestone(status, "pr_approved", ...)` — extend recognized milestones in `src/worca/state/status.py`.
- `stop_reason="pr_rejected"` — add to `STOP_REASONS` if enumerated.

### 7. Plumbing: disk-threshold data flow + Bug A/B/C fixes

Threshold sources from global preferences, threaded as a single state scalar:

```js
// main.js bootstrap
const prefsRes = await fetch('/api/preferences');
const { preferences } = await prefsRes.json();
store.setState({
  worktreeDiskWarningBytes: preferences?.worca?.ui?.worktree_disk_warning_bytes ?? 2_000_000_000,
  classifierModel: preferences?.worca?.circuit_breaker?.classifier_model ?? 'haiku',
  cleanupPolicy: preferences?.worca?.parallel?.cleanup_policy ?? 'never',
  maxConcurrentPipelines: preferences?.worca?.parallel?.max_concurrent_pipelines ?? 10,
});
```

```js
// sidebar.js — replace lines 104-105 (Bug A + Bug C)
const diskWarningThreshold = state.worktreeDiskWarningBytes ?? 2_000_000_000;
```

```js
// worktrees.js — replace line 56 (Bug B)
const overThreshold = total > (options.diskWarningBytes ?? 2_000_000_000);
```

```js
// main.js:2149 call site
return worktreesView(state.worktrees || [], {
  ...existingOptions,
  diskWarningBytes: state.worktreeDiskWarningBytes ?? 2_000_000_000,
});
```

`store.js` initial state adds the four global-derived scalars so first render before bootstrap doesn't NPE.

### 8. Read / save plumbing

#### 8a. Project tab — `readPipelineFromDom` (`settings.js:365-379`)

```js
function readPipelineFromDom() {
  // ...existing loops/plan_path_template/defaults reads...
  const milestones = {
    plan_approval: document.getElementById('milestone-plan-approval')?.checked ?? true,
    pr_approval: document.getElementById('milestone-pr-approval')?.checked ?? false,
  };
  const circuit_breaker = {
    enabled: document.getElementById('cb-enabled')?.checked ?? true,
    max_consecutive_failures: parseInt(document.getElementById('cb-max-failures')?.value, 10) || 3,
  };
  const parallel = {
    worktree_base_dir: document.getElementById('parallel-worktree-base-dir')?.value?.trim() || '.worktrees',
    default_base_branch: document.getElementById('parallel-default-base-branch')?.value?.trim() || 'main',
  };
  return { loops, plan_path_template, defaults, parallel, milestones, circuit_breaker };
}
```

Save handler (`settings.js:625-636`) shape unchanged.

#### 8b. Global tab — `readGlobalsFromDom` + `savePreferences`

```js
function readGlobalsFromDom() {
  return {
    worca: {
      ui: { worktree_disk_warning_bytes: readDiskThresholdFromDom() },
      circuit_breaker: { classifier_model: document.getElementById('pref-classifier-model')?.value || 'haiku' },
      parallel: {
        cleanup_policy: document.getElementById('pref-cleanup-policy')?.value || 'never',
        max_concurrent_pipelines: parseInt(document.getElementById('pref-max-concurrent')?.value, 10) || 10,
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
  const fresh = await (await fetch('/api/preferences')).json();
  store.setState({
    worktreeDiskWarningBytes: fresh.preferences?.worca?.ui?.worktree_disk_warning_bytes ?? 2_000_000_000,
    classifierModel: fresh.preferences?.worca?.circuit_breaker?.classifier_model ?? 'haiku',
    cleanupPolicy: fresh.preferences?.worca?.parallel?.cleanup_policy ?? 'never',
    maxConcurrentPipelines: fresh.preferences?.worca?.parallel?.max_concurrent_pipelines ?? 10,
  });
  rerender();
}
```

Single Save button in `preferencesTab` drives both the existing source-repo handler and `savePreferences` (parallel calls).

### 9. Validator additions (`worca-ui/server/settings-validator.js`)

#### 9a. Project validator — extended

**`worca.parallel`:**

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
    // cleanup_policy + max_concurrent_pipelines rejected by misplaced-keys helper below
  }
}
```

**`worca.circuit_breaker`:**

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
    // classifier_model rejected by misplaced-keys helper below
  }
}
```

**Reject misplaced keys (project blob):**

```js
const GLOBAL_ONLY_KEYS = [
  ['parallel', 'cleanup_policy'],
  ['parallel', 'max_concurrent_pipelines'],
  ['ui', 'worktree_disk_warning_bytes'],
  ['circuit_breaker', 'classifier_model'],
];

for (const [section, key] of GLOBAL_ONLY_KEYS) {
  if (w?.[section]?.[key] !== undefined) {
    details.push(`worca.${section}.${key} is a global preference (~/.worca/settings.json), not a project setting. Configure it in the global Preferences tab.`);
  }
}
```

#### 9b. Global validator (`validateGlobalSettings`)

```js
const VALID_CLEANUP_POLICIES = ['never', 'on-success', 'manual-only'];

function validateGlobalSettings(prefs) {
  const details = [];
  const w = prefs?.worca;
  if (!w) return { ok: true };

  if (w.ui?.worktree_disk_warning_bytes !== undefined) {
    const v = w.ui.worktree_disk_warning_bytes;
    if (!Number.isInteger(v) || v < 500_000_000 || v > 50_000_000_000) {
      details.push('ui.worktree_disk_warning_bytes must be an integer between 500_000_000 (500 MB) and 50_000_000_000 (50 GB)');
    }
  }

  if (w.circuit_breaker?.classifier_model !== undefined &&
      !VALID_MODELS.includes(w.circuit_breaker.classifier_model)) {
    details.push(`circuit_breaker.classifier_model must be one of: ${VALID_MODELS.join(', ')}`);
  }

  if (w.parallel?.cleanup_policy !== undefined &&
      !VALID_CLEANUP_POLICIES.includes(w.parallel.cleanup_policy)) {
    details.push(`parallel.cleanup_policy must be one of: ${VALID_CLEANUP_POLICIES.join(', ')}`);
  }

  if (w.parallel?.max_concurrent_pipelines !== undefined) {
    const n = w.parallel.max_concurrent_pipelines;
    if (!Number.isInteger(n) || n < 1 || n > 20) {
      details.push('parallel.max_concurrent_pipelines must be an integer between 1 and 20');
    }
  }

  return details.length === 0 ? { ok: true } : { ok: false, details };
}
```

#### 9c. `VALID_MODELS` superset assertion (risk #9 mitigation)

`worca-ui/server/settings-validator.test.js`:

```js
test('VALID_MODELS includes every alias from the shipped settings.json template', () => {
  const template = JSON.parse(readFileSync('../../src/worca/settings.json', 'utf-8'));
  const aliases = Object.keys(template.worca.models);
  for (const alias of aliases) {
    expect(VALID_MODELS).toContain(alias);
  }
});
```

Catches drift the moment a new alias is added to the template without updating the validator.

### 10. Default normalization

#### 10a. Project — `loadSettings()` (`settings.js:160`)

```js
if (!settingsData.worca.parallel) settingsData.worca.parallel = {};
if (settingsData.worca.parallel.worktree_base_dir === undefined) {
  settingsData.worca.parallel.worktree_base_dir = '.worktrees';
}
if (settingsData.worca.parallel.default_base_branch === undefined) {
  settingsData.worca.parallel.default_base_branch = 'main';
}
if (!settingsData.worca.circuit_breaker) {
  settingsData.worca.circuit_breaker = { enabled: true, max_consecutive_failures: 3 };
}
if (!settingsData.worca.milestones) {
  settingsData.worca.milestones = { plan_approval: true, pr_approval: false };
}
if (settingsData.worca.milestones.pr_approval === undefined) {
  settingsData.worca.milestones.pr_approval = false;
}
```

#### 10b. Global — `readGlobalSettings()` (server)

Already shown in §4 — all four defaults applied at read time.

### 11. Template + migration (risk #1 mitigation)

This is the only block that must ship before users hit the new validator on next save. Two pieces:

#### 11a. Strip global keys from `src/worca/settings.json`

The template currently ships at `src/worca/settings.json:285-290`:

```json
"parallel": {
  "worktree_base_dir": ".worktrees",
  "default_base_branch": "main",
  "max_concurrent_pipelines": 3,
  "cleanup_policy": "on-success"
},
```

After this PR:

```json
"parallel": {
  "worktree_base_dir": ".worktrees",
  "default_base_branch": "main"
},
```

Same surgery applied to `worca.circuit_breaker` (remove `classifier_model`) and `worca.ui` (remove `worktree_disk_warning_bytes` if present). The default values now live exclusively in `readGlobalSettings()`.

#### 11b. `worca init --upgrade` migration

`src/worca/cli/init.py` (or wherever `--upgrade` lives) gains a one-shot migration step that runs once per project:

```python
def _migrate_global_keys_to_preferences(project_settings_path: str) -> dict:
    """One-shot: extract any to-be-global keys from .claude/settings.json,
    write them into ~/.worca/settings.json, then strip from the project file.
    Idempotent: returns {} on second run."""
    if not os.path.exists(project_settings_path):
        return {}
    with open(project_settings_path) as f:
        project = json.load(f)

    GLOBAL_KEYS = [
        ("parallel", "cleanup_policy"),
        ("parallel", "max_concurrent_pipelines"),
        ("ui", "worktree_disk_warning_bytes"),
        ("circuit_breaker", "classifier_model"),
    ]
    extracted = {}
    worca = project.get("worca", {})
    for section, key in GLOBAL_KEYS:
        val = worca.get(section, {}).get(key)
        if val is not None:
            extracted.setdefault(section, {})[key] = val
            del worca[section][key]
            if not worca[section]:
                del worca[section]

    if not extracted:
        return {}

    # Merge into ~/.worca/settings.json
    global_path = os.path.expanduser("~/.worca/settings.json")
    os.makedirs(os.path.dirname(global_path), exist_ok=True)
    try:
        with open(global_path) as f:
            global_blob = json.load(f)
    except FileNotFoundError:
        global_blob = {}
    global_blob.setdefault("worca", {})
    for section, kvs in extracted.items():
        global_blob["worca"].setdefault(section, {}).update(kvs)
    with open(global_path, "w") as f:
        json.dump(global_blob, f, indent=2)

    # Re-write the project file without the migrated keys
    with open(project_settings_path, "w") as f:
        json.dump(project, f, indent=2)

    return extracted
```

Returns the migrated dict so the calling CLI command can print a one-liner: `Migrated 3 keys from .claude/settings.json to ~/.worca/settings.json`.

#### 11c. UI banner on detection (defense-in-depth)

When the UI loads a project's settings and the response contains any of the four global-only keys (because the user is on an un-migrated project), show a one-time banner: "This project's settings contain keys that have moved to global Preferences. Click here to migrate." Button calls a new endpoint `POST /api/projects/:id/migrate-global-keys` which runs the same logic as the CLI helper.

This catches users who upgrade `@worca/ui` but never run `worca init --upgrade`.

## Implementation Plan

Single PR. Recommended ordering — ship migration & template strip *first* in the diff so reviewers see the breaking change is contained, then build outward:

1. **Template + migration** (§11). Strip global keys from `src/worca/settings.json`. Add `_migrate_global_keys_to_preferences` helper + wire into `worca init --upgrade`. Add migration banner endpoint stub.
2. **Server: global preferences endpoint** (§4). New `preferences-routes.js`, `readGlobalSettings`/`writeGlobalSettings`, `validateGlobalSettings`. Mount router.
3. **Server: validator additions** (§9). Project validator extensions + reject-misplaced-keys helper + `VALID_MODELS` superset test.
4. **Server: enforcement** (§5). `max_concurrent_pipelines` 409 cap + `cleanup_policy` post-completion hook.
5. **Python runtime** (§6). `load_settings_with_global_fallback` helper. Update `error_classifier.py:102`. Update `run_worktree.py:217`. Add `pr_approval` gate in `runner.py` (with timeout backstop). Extend `status.py` for `pr_approved` milestone.
6. **UI plumbing** (§7). Add four global-derived scalars to `store.js`. Bootstrap fetch in `main.js`. Fix Bug A/B/C in `sidebar.js`/`worktrees.js`/`main.js:2149`.
7. **UI: project tab editors** (§2 + §8a). Approval Gates, Circuit Breaker, Execution & Parallelism sections. Extend `readPipelineFromDom` + `loadSettings` defaults + Save handler.
8. **UI: global tab editors** (§3 + §8b). Worktrees + Pipeline Execution groups. Add `readGlobalsFromDom` + `savePreferences`.
9. **UI: PR-approval affordance** (§6c UI side). New approval panel in `run-detail.js`. Wire to `/api/projects/:projectId/runs/:id/control`.
10. **UI: max-concurrent gating + banner** (§5a UI side). Disable launch button when at cap; 409 banner; sidebar "N/cap" badge.
11. **Tests** (§Test Plan). Run `cd worca-ui && npm run lint:fix && npx vitest run && npm run build`; `pytest tests/`.
12. **MIGRATION.md** updated with the §11 user-facing migration story.

## Test Plan

### Server (vitest)

- `preferences-routes.test.js`:
  - `GET` returns merged blob with defaults applied (incl. revised defaults).
  - `GET` returns defaults when file is missing (ENOENT).
  - `GET` returns defaults + warning when file has malformed JSON (risk #7).
  - `PUT` validates; rejects out-of-range disk threshold / unknown classifier model / out-of-range max_concurrent / unknown cleanup_policy.
  - `PUT` deep-merges (existing keys preserved).
- `settings-validator.test.js`:
  - Project validator rejects misplaced global keys with helpful message.
  - `VALID_MODELS` superset assertion against shipped `settings.json` template (risk #9).
- `process-manager.test.js`:
  - `cleanup_policy='on-success'` + clean exit → `removeWorktree` called.
  - `cleanup_policy='on-success'` + failed exit → no cleanup.
  - `cleanup_policy='never'` → no cleanup.
  - `cleanup_policy='manual-only'` → no cleanup.
- `project-routes.test.js`:
  - 409 with `code: 'max_concurrent_exceeded'` when over global cap.
  - 200 when under cap.
  - Per-project 409 still fires under global cap.

### Python (pytest)

- `tests/test_settings_global_fallback.py`:
  - Project + global merge, project wins on overlap.
  - Returns project unchanged when global is missing or malformed.
- `tests/test_run_worktree.py`:
  - `--branch` omitted → uses `default_base_branch`.
  - `--branch` provided → ignores config.
- `tests/test_runner_pr_approval.py`:
  - `pr_approval=false` (default) → PR runs without gate.
  - `pr_approval=true` + control approve → PR runs.
  - `pr_approval=true` + control reject → `PipelineInterrupted("pr_rejected")`.
  - `pr_approval=true` + no `ctx` → auto-approve.
  - `pr_approval=true` + `ctx` but no listener → timeout fires after 1h → auto-approve (mock the timer).
- `tests/test_init_migration.py`:
  - `_migrate_global_keys_to_preferences` extracts the four keys, writes to global, removes from project.
  - Idempotent on second run (returns `{}`).
  - Handles missing global file (creates it).
  - Handles missing project file (no-op).
- `tests/integration/test_cleanup_policy.py`:
  - Full pipeline with `cleanup_policy='on-success'` leaves no worktree.
  - Full pipeline with `cleanup_policy='never'` leaves the worktree intact.
- `tests/integration/test_pr_approval_flow.py`:
  - Pipeline pauses at PR gate; mock-control approves; PR succeeds.

### UI render (vitest)

- `settings-approval-gates.test.js` — both switches (`plan_approval` checked default-true; `pr_approval` checked default-false); hint copy present.
- `settings-circuit-breaker.test.js` — `enabled` + `max_consecutive_failures` controls render.
- `settings-execution-parallelism.test.js` — `worktree_base_dir` + `default_base_branch` inputs render.
- `settings-preferences-worktrees.test.js` — disk-threshold MB/GB pair + cleanup_policy select with three options.
- `settings-preferences-pipeline.test.js` — classifier-model select reads from `worca.models`; max-concurrent input renders.
- Plumbing test (Bugs A/B/C): set `state.worktreeDiskWarningBytes = 400_000_000`; assert sidebar badge variant flips at threshold; assert worktrees view renders banner.
- `run-detail.test.js` — approval panel renders when `run.milestones.pr_approved === false && pipeline_status === 'paused'`; not rendered otherwise.
- `new-pipeline.test.js` — launch button disabled when `state.totalRunning >= state.maxConcurrentPipelines`; 409 banner shown on launch failure.

### E2E (playwright, `--workers=1`)

- Launch N runs across two projects, attempt N+1, observe 409 + UI banner.
- Round-trip: change disk threshold in global Preferences, save, exceed it, observe sidebar badge flip + worktrees banner.
- Round-trip: enable `pr_approval`, launch a run, pipeline pauses at PR gate, click Approve, PR completes.

### Done criteria

- All vitest / pytest tests green.
- `cd worca-ui && npm run lint:fix && npx vitest run` clean.
- `cd worca-ui && npm run build` produces updated bundle.
- `pytest tests/` green.
- `worca init --upgrade` on a project containing pre-W-049 settings emits a one-line migration summary; subsequent runs say nothing.
- MIGRATION.md updated.

## Considerations

- **Single-delivery PR is large.** Estimated ~870 LOC implementation + ~1000 LOC tests. Reviewable but requires explicit ordering (template/migration first, then endpoint, then consumers) so the diff reads in dependency order. CODEOWNERS may want a UI-side and Python-side reviewer in parallel.
- **All four reviewed risk mitigations are folded in.** See "Risk profile after bundling + mitigations" table in Proposal.
- **Defaults flipped from earlier draft.** `cleanup_policy` is `never`, `pr_approval` is `false`, `max_concurrent_pipelines` is `10`. Each is justified in the table; flip back if the product preference is to gate / auto-cleanup by default.
- **`pr_approval` timeout is hand-edit only.** Exposing a UI for it adds another control to a tab that's already crowded; users who flip `pr_approval` on are advanced enough to read MIGRATION.md for the timeout knob. Reassess if support questions arise.
- **`deploy_approval` and `transient_retry_count` stay out.** No consumers; would ship UI for non-existent behavior.
- **Hint copy guidance:** "Hard cap; server returns 409" for max_concurrent. "Auto-removes the worktree after a clean pipeline exit" for cleanup_policy. Don't reuse "soft cap" phrasing anywhere — nothing implements soft caps.
- **Validator / classifier-model coupling.** The new `VALID_MODELS` superset test (§9c) catches drift; add a code comment at `settings-validator.js:15` pointing at the test.
- **Project-over-global merge precedence.** Project wins on overlap. Today there is no overlap in practice (each key lives in exactly one tab and the project validator rejects the global keys). Forward-compatible: if a future feature needs a per-project override of a global key, the merge already does the right thing.
- **Reject misplaced keys produces a clear error.** The error message points users at the global tab, eliminating the "I set it but nothing happened" confusion.
- **Migration:** active. §11 strips template, runs one-shot extraction in `worca init --upgrade`, and surfaces a UI banner for users who skip the CLI step.
- **Governance impact:** none. No hook scripts read these keys; the new `pr_approval` gate uses the existing webhook control mechanism; `removeWorktree` is a `git worktree remove` shell-out (already permitted).

## Files to Create/Modify

| Path | Status | Notes |
|------|--------|---|
| `src/worca/settings.json` | modify | Strip 4 global keys from template (§11a) |
| `src/worca/cli/init.py` | modify | Add `_migrate_global_keys_to_preferences` + wire into `--upgrade` (§11b) |
| `tests/test_init_migration.py` | create | Migration helper tests |
| `worca-ui/server/preferences-routes.js` | create | GET/PUT /api/preferences (§4) |
| `worca-ui/server/preferences-routes.test.js` | create | Endpoint tests |
| `worca-ui/server/settings-reader.js` | modify | `readGlobalSettings` / `writeGlobalSettings` with try/catch (§4) |
| `worca-ui/server/settings-validator.js` | modify | `validateGlobalSettings` + project blocks + reject-misplaced-keys helper (§9) |
| `worca-ui/server/settings-validator.test.js` | extend | New blocks + `VALID_MODELS` superset test (§9c) |
| `worca-ui/server/app.js` | modify | Mount preferences router |
| `worca-ui/server/process-manager.js` | modify | Post-exit cleanup hook reading global prefs (§5b) |
| `worca-ui/server/process-manager.test.js` | extend | Cleanup policy branches |
| `worca-ui/server/process-registry.js` | modify | `countRunningPipelinesAcrossProjects` (§5a) |
| `worca-ui/server/project-routes.js` | modify | 409 cap check (§5a) + banner-migration endpoint (§11c) |
| `worca-ui/server/project-routes.test.js` | extend | Cap enforcement |
| `src/worca/utils/settings.py` | modify | `load_settings_with_global_fallback` (§6a) |
| `src/worca/orchestrator/error_classifier.py` | modify | Use fallback helper (§6a) |
| `src/worca/scripts/run_worktree.py` | modify | Read `default_base_branch` + write `worktree_path` to status.json (§6b) |
| `src/worca/state/status.py` | modify | `worktree_path` field; `pr_approved` milestone (§6c) |
| `src/worca/orchestrator/runner.py` | modify | PR-stage gate with timeout backstop (§6c) |
| `src/worca/orchestrator/control.py` (or wherever `_check_control_response` lives) | modify | Add `timeout_seconds` / `timeout_default` params if absent |
| `tests/test_settings_global_fallback.py` | create | Helper merge tests |
| `tests/test_run_worktree.py` | extend | `default_base_branch` cases |
| `tests/test_runner_pr_approval.py` | create | Gate behavior + timeout |
| `tests/integration/test_cleanup_policy.py` | create | End-to-end policy branches |
| `tests/integration/test_pr_approval_flow.py` | create | Mock-controlled approve flow |
| `worca-ui/app/main.js` | modify | Bootstrap fetch + threading (§7) |
| `worca-ui/app/store.js` | modify | Four global-derived scalars (§7) |
| `worca-ui/app/views/sidebar.js` | modify | Bug A + Bug C |
| `worca-ui/app/views/sidebar.test.js` | modify | State shape |
| `worca-ui/app/views/worktrees.js` | modify | Bug B + accept threshold |
| `worca-ui/app/views/settings.js` | modify | Project + global tab editors (§§2-3, 8) |
| `worca-ui/app/views/settings-approval-gates.test.js` | create | `plan_approval` + `pr_approval` switches |
| `worca-ui/app/views/settings-circuit-breaker.test.js` | create | Enabled + max-failures |
| `worca-ui/app/views/settings-execution-parallelism.test.js` | create | base-dir + default-branch |
| `worca-ui/app/views/settings-preferences-worktrees.test.js` | create | Disk threshold + cleanup_policy |
| `worca-ui/app/views/settings-preferences-pipeline.test.js` | create | Classifier model + max-concurrent |
| `worca-ui/app/views/run-detail.js` | modify | Approval panel (§6c UI) |
| `worca-ui/app/views/run-detail.test.js` | extend | Approval panel render conditions |
| `worca-ui/app/views/new-pipeline.js` | modify | Disable button at cap + 409 banner + base-branch placeholder |
| `worca-ui/app/views/new-pipeline.test.js` | extend | Cap-disabled state |
| `MIGRATION.md` | modify | Document `worca init --upgrade` migration |
