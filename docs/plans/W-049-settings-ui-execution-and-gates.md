# W-049: Settings UI + Runtime Consumers for Execution, Approval Gates, Circuit Breaker, and Worktree Disk Threshold

**Status:** Draft (revised — single-delivery; project/global split committed; risk mitigations folded in; gaps closed: status.json `worktree_path` source, local timeout fallback, shared key/default constants, launch mutex, milestone semantic asymmetry documented)
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
- **Why disk threshold is global, not per-project:** the threshold guards a *machine* resource (the disk all worktrees share) — the same heavy-monorepo project that produces a 30 GB worktree on a 500 GB laptop produces it on a 4 TB workstation too, but the user wants a different alarm point on each. Per-project would require N separate edits to react to a single new machine; global captures the actual capacity envelope in one place. If a future use case genuinely needs per-project overrides, the project-over-global merge precedence (see below) supports it without a migration.
- **`worktree_path` source for the cleanup hook:** §5b's `cleanup_policy` post-completion hook reads `worktree_path` from `status.json`, not from the registry file (`pipelines.d/{run_id}.json`). Today only the registry carries `worktree_path` (written by `register_pipeline()`); §6b commits to *also* writing it to status.json so the cleanup hook does not take a cross-cut registry dependency. status.json is the existing read surface for `outcome` / `exit_code` already used by the hook, so this keeps the read path single-source.
- **`_removeWorktree` extraction:** the existing implementation is private to `worca-ui/server/worktrees-routes.js`. §5b extracts it to a new shared `worca-ui/server/worktree-ops.js` module (single owner of `git worktree remove` shell-out, importable from both the route handler and the cleanup hook).
- **Single source of truth for keys + defaults:** to avoid drift across the 5 places that need to know defaults (project validator, global validator/reader, UI normalizer, Python `load_settings_with_global_fallback`, Python migration helpers), this PR adds `src/worca/schemas/keys.json` — a static JSON document listing `GLOBAL_ONLY_KEYS`, `PROJECT_KEYS`, and the canonical default for each. Both languages load it at module import time. See §10 for the schema and per-language consumer pattern.
- **Strip-on-save duplication is structural, not editorial:** §9a-bis (JS, runs in the UI server on every save) and §11b (Python, runs offline during `worca init --upgrade`) both implement strip-and-migrate logic. The contexts are mutually exclusive (offline CLI has no UI server; online save has no Python interpreter readily available), so two implementations are unavoidable. The `GLOBAL_ONLY_KEYS` constant is unified via `src/worca/schemas/keys.json`; per-language tests assert each implementation reads from there. The §11c migration banner reuses the §9a-bis strip-on-save endpoint rather than introducing a third path — see §11c for the call shape.
- **Concurrency-safe launch:** §5a wraps the count-and-register sequence in an in-process async mutex (`worca-ui/server/launch-lock.js`) so two simultaneous `POST /runs` calls cannot both pass the cap check and both register. Single-server deploy assumption is explicit; multi-server coordination is out of scope.
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
| Template ships to-be-global keys at project scope → validation failures on upgrade | **Mitigated** by §11 (template strip + `worca init --upgrade` migration) + §9a-bis (server-side strip-on-save self-heals on every save) |
| Auto-cleanup default deletes worktrees on success | **Mitigated** by default flip to `never` |
| `pr_approval` default-true hangs autonomous flows | **Mitigated** by (1) default flip to `false`, (2) template strip of `pr_approval`, (3) `_strip_inert_milestone_keys` migration, (4) timeout backstop in the gate code with explicit fallback design |
| Global cap of 3 immediately blocks multi-project users | **Mitigated** by default raise to `10` |
| Malformed `~/.worca/settings.json` crashes endpoint | **Mitigated** by try/catch in `readGlobalSettings` (§4) |
| `VALID_MODELS` validator/UI select drift | **Mitigated** by superset assertion test (§9) |
| Existing test fixtures fail new project validator | **Mitigated** in same PR (test fixtures updated alongside code) |
| User dismisses migration banner, hits Save → 400 from validator | **Mitigated** by §9a-bis server-side strip-on-save (auto-migrates on every save; validator becomes pure safety net) |
| `countRunningPipelinesAcrossProjects` inflated by stale PIDs from crashed runs | **Mitigated** by §5a `process.kill(pid, 0)` liveness check; stale PIDs pruned on every cap check |
| `_check_control_response` may not support `timeout_seconds` today | **Resolved** — verified the helper signature is `(ctx, event) -> Optional[str]` with no timeout params. §6c commits to the local-fallback path (deadline-aware loop in the gate code); no shared-helper change. Keeps the PR scope contained and avoids touching every other caller. |
| `worktree_path` location ambiguity (registry vs status.json) | **Resolved** — `register_pipeline()` writes `worktree_path` to the registry file (`pipelines.d/{run_id}.json`), not status.json. §6b commits to *also* writing it to status.json so §5b's cleanup hook can read it without taking a registry dependency. |
| `_removeWorktree` is private to `worktrees-routes.js` | **Resolved** — §5b commits to extracting it to a shared `worca-ui/server/worktree-ops.js` module (single owner of `git worktree remove` shell-out). |
| Two simultaneous `POST /runs` calls both pass the cap check (TOCTOU race) | **Mitigated** by §5a in-process async mutex around the count-and-register sequence. Single-server deploy assumption documented; cross-server coordination is out of scope. |
| Defaults duplicated across 5 places (JS validator, JS reader, UI normalizer, Python helpers, Python runner) | **Mitigated** by §10 single-source-of-truth JSON at `src/worca/schemas/keys.json` — both languages read it; per-language constants tests assert no drift. |
| Strip-on-save duplicated in JS (§9a-bis) and Python (§11b) | **Documented** as forced by online (UI server) vs offline (`worca init --upgrade`) contexts — both languages must run the strip standalone. The shared `GLOBAL_ONLY_KEYS` list lives in `src/worca/schemas/keys.json` (single source); the §11c migration banner reuses the existing project-save endpoint rather than carrying a third implementation. |
| Inconsistent milestone-key semantics: `plan_approval` is default-true (opt-out), `pr_approval` is default-false (opt-in) | **Documented** at §6c with an inline comment in `runner.py` explaining the asymmetry — `plan_approval` ships as `true` in production, `pr_approval` is new-and-default-off to avoid hangs on upgrade. |

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

`worca-ui/server/project-routes.js:617-627` already 409s on per-project parallelism. Add a sibling check for the global cap **before** the per-project check, wrapped in a launch mutex so the count-and-register sequence is atomic:

```js
import { withLaunchLock } from './launch-lock.js';

router.post('/runs', requireWorcaDir, async (req, res) => {
  // Mutex serializes the entire cap-check + spawn + register sequence so two
  // simultaneous POSTs can't both observe `running < cap` and both succeed.
  // Single-server deploy assumption — no cross-process coordination.
  const result = await withLaunchLock(async () => {
    const globalPrefs = readGlobalSettings();
    const cap = globalPrefs?.worca?.parallel?.max_concurrent_pipelines ?? 10;
    const totalRunning = countRunningPipelinesAcrossProjects();
    if (totalRunning >= cap) {
      return {
        status: 409,
        body: {
          ok: false,
          error: `At max concurrent pipelines (${cap}). Stop a running pipeline or raise the cap in global Preferences.`,
          code: 'max_concurrent_exceeded',
          cap,
          running: totalRunning,
        },
      };
    }
    // ... existing per-project check, spawn, and registry write happen *inside*
    // the lock so the new PID is visible to the next caller's count ...
    return await spawnAndRegister(req); // returns { status, body }
  });
  return res.status(result.status).json(result.body);
});
```

`worca-ui/server/launch-lock.js` (new file) is a minimal in-process mutex:

```js
let _chain = Promise.resolve();

export function withLaunchLock(fn) {
  const next = _chain.then(fn, fn); // run regardless of prior rejection
  // Swallow rejection on the chain itself so one failure doesn't poison subsequent callers.
  _chain = next.then(() => undefined, () => undefined);
  return next;
}
```

Reasoning: a homegrown promise-chain mutex is sufficient because Node is single-threaded — concurrency only arrives across `await` boundaries, and serializing those is exactly what this does. No `async-lock` dependency added. The lock granularity is the entire request handler's count-and-register sequence; per-project parallelism checks live inside the same lock so the per-project state is also race-free.

`countRunningPipelinesAcrossProjects` is a new helper in `worca-ui/server/process-registry.js` that walks `~/.worca/projects.d/`, calls `pm.getRunningPid()` per project, **liveness-checks each PID with `process.kill(pid, 0)`** (no signal sent — just throws ESRCH if the process is gone), and returns the count of *actually-live* PIDs:

```js
function countRunningPipelinesAcrossProjects() {
  const projects = listRegisteredProjects(); // walk ~/.worca/projects.d/
  let alive = 0;
  for (const proj of projects) {
    const pid = proj.pm?.getRunningPid();
    if (!pid) continue;
    try {
      process.kill(pid, 0); // throws if process doesn't exist
      alive += 1;
    } catch (err) {
      if (err.code === 'ESRCH') {
        // Stale PID — process died without cleaning up its registry entry.
        // Prune it so the cap doesn't get permanently inflated by zombie state.
        proj.pm?.clearStalePid?.(pid);
      } else if (err.code !== 'EPERM') {
        // EPERM means the process exists but we can't signal it — count as alive.
        // Anything else is unexpected; log and conservatively count as alive.
        console.warn(`PID liveness check for ${pid} failed: ${err.message}`);
        alive += 1;
      } else {
        alive += 1;
      }
    }
  }
  return alive;
}
```

Without the liveness check, a crashed run that didn't clean up its PID file would inflate the count and could permanently block new launches under the cap. With it, stale state self-heals on every cap check.

#### 5b. `cleanup_policy` post-completion hook

`worca-ui/server/process-manager.js` — when `getRunningPid()` transitions from a valid PID to `null` (process exit detected on the next status poll), read the cleanup policy from global preferences:

```js
import { removeWorktree } from './worktree-ops.js';

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

**`worktree_path` source — committed to status.json.** Today only the registry file (`pipelines.d/{run_id}.json`) carries `worktree_path` (written by `register_pipeline()`); status.json does not. §6b commits to *also* writing `worktree_path` into status.json from `run_worktree.py` so the cleanup hook reads from the same surface it already uses for `outcome` / `exit_code`. The change is one extra line at status-init time; no migration needed because pre-W-049 runs that lack the field simply skip cleanup (the hook checks `if (worktreePath && ...)`).

**`removeWorktree` — extracted to a shared module.** The existing `_removeWorktree` is private to `worca-ui/server/worktrees-routes.js`. This PR extracts it to `worca-ui/server/worktree-ops.js` (new file), exporting a single `removeWorktree(path)` function that owns the `git worktree remove` shell-out. The route handler in `worktrees-routes.js` becomes a thin wrapper around the shared function. Logic mirrors `_cleanup_worktree` at `src/worca/scripts/run_parallel.py:117-122`.

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

#### 6b. `default_base_branch` consumer + `worktree_path` written to status.json

`src/worca/scripts/run_worktree.py:217` becomes:

```python
_settings = load_settings(args.settings)
_parallel = _settings.get("worca", {}).get("parallel", {})
_default_branch = _parallel.get("default_base_branch", "main")
base_branch = args.branch or _default_branch
_wt_base = _parallel.get("worktree_base_dir", ".worktrees")
worktree_path = create_pipeline_worktree(run_id, slug, base_branch, _wt_base)

# Persist worktree_path to status.json so the UI server's §5b cleanup hook
# can read it without taking a registry dependency. The registry file
# (pipelines.d/{run_id}.json, written by register_pipeline()) keeps its copy
# unchanged for back-compat; this is a *second* writer to a parallel field.
write_status_field(actual_status_path, "worktree_path", worktree_path)
```

(Single `load_settings` call covers both keys; lines 222-228 collapse into the block above. `write_status_field` is the existing helper in `src/worca/state/status.py` — see §6c schema additions.)

**Status.json schema:** add `worktree_path: Optional[str]` to the status shape in `src/worca/state/status.py`. Pre-W-049 runs that never had this field set continue to work — the cleanup hook gates on `if (worktreePath && ...)` and treats absence as "no auto-cleanup" (the same behavior as `cleanup_policy: 'never'`).

#### 6c. `pr_approval` gate

Mirror the existing `plan_approval` pattern (`runner.py:2089-2118`). Insert at the start of PR-stage handling:

```python
elif current_stage == Stage.PR:
    # Milestone semantics intentionally asymmetric across approval gates:
    #   - plan_approval: default-true (opt-out). Already in production at this default;
    #     flipping it would silently disable an existing gate on every upgraded project.
    #   - pr_approval:   default-false (opt-in). New in W-049; default-true would hang
    #     every autonomous run waiting for an approval event nobody sends.
    # The asymmetry is documented at the risk-profile table and tested in
    # tests/test_runner_pr_approval.py.
    _ms_cfg = load_settings(settings_path).get("worca", {}).get("milestones", {})
    if _ms_cfg.get("pr_approval") is not True:  # opt-in: gate fires only when explicitly true
        pr_approved = True
    else:
        set_milestone(status, "pr_approved", False)
        pr_approved = False
        if ctx:
            _ms_event = emit_event(ctx, MILESTONE_SET, milestone_set_payload(
                milestone="pr_approved", value=False, stage=Stage.PR.value,
            ))
            if _ms_event:
                # Local timeout fallback (committed — see decision below).
                # Wraps the existing _check_control_response without changing its signature.
                _action = _check_control_response_with_timeout(
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

**Design choices baked into this block, each mitigating risk #4:**
- **Default `false`:** the gate fires only when explicitly enabled (`is not True` rather than `is not False`). Preserves existing autonomous-run behavior.
- **Timeout backstop via local helper:** wraps `_check_control_response` in a deadline-aware loop without modifying the shared helper's signature. If no approval arrives within the window, the gate auto-approves and emits a log line. The `pr_approval_timeout_seconds` setting is internal — not editable from UI in this PR; configurable by hand-edit only.

**Timeout helper — committed to local fallback (no shared-helper change).** Verification confirmed that `_check_control_response`'s current signature is `(ctx, event) -> Optional[str]`, with no timeout parameters. Two options were considered (see plan revision history); this revision **commits to option 2 — local fallback in the gate code** — for two reasons: (a) extending the shared helper would touch every other caller and expand the PR's review surface unnecessarily, and (b) the timeout semantics ("auto-approve after deadline") are specific to this gate; future gates may want different defaults, so a per-gate wrapper is the right granularity.

The local helper lives next to the gate code in `runner.py` (private module-level function):

```python
def _check_control_response_with_timeout(
    ctx: EventContext,
    event: dict,
    *,
    timeout_seconds: int,
    timeout_default: str,
) -> str:
    """Deadline-aware wrapper around _check_control_response.

    Polls until the helper returns a non-None action OR the deadline elapses,
    in which case returns `timeout_default` and emits a log line. Keeps the
    shared helper's signature unchanged.
    """
    import time
    deadline = time.monotonic() + timeout_seconds
    poll_interval = _check_control_response_poll_interval()  # existing module-level helper
    while time.monotonic() < deadline:
        action = _check_control_response(ctx, event)
        if action is not None:
            return action
        time.sleep(poll_interval)
    log.warning(
        "pr_approval gate auto-approved on %ds timeout (event=%s)",
        timeout_seconds, event.get("id"),
    )
    return timeout_default
```

If `_check_control_response_poll_interval()` does not exist in `control.py`, fall back to a hardcoded 5-second poll inside the helper — single line change, scoped to the helper only. The implementation step (Step 5) carries this verification as a sub-task.

**Schema additions:**
- `set_milestone(status, "pr_approved", ...)` — extend recognized milestones in `src/worca/state/status.py`.
- `stop_reason="pr_rejected"` — add to `STOP_REASONS` if enumerated.
- `worktree_path: Optional[str]` field — see §6b.

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

#### 9a-bis. Server-side strip-on-save (defense in depth)

The validator above is a hard rejection. If a user opens project settings on an un-migrated project, hits Save without modifying anything, the round-trip would fail because the existing misplaced keys are still present in the on-disk file (the validator runs on the merged result of incoming partial + existing file).

To prevent that hard-stop UX, the project save endpoint at `worca-ui/server/project-routes.js` runs a **strip-and-migrate pass** before validation on every save:

```js
router.put('/settings', async (req, res) => {
  const incoming = req.body;
  const existing = readMergedSettings(settingsPath);
  const merged = deepMerge(existing, incoming);

  // Auto-extract any misplaced global keys to ~/.worca/settings.json,
  // then strip them from the project blob. Idempotent: no-op when clean.
  const extracted = extractAndStripGlobalKeys(merged);
  if (Object.keys(extracted).length > 0) {
    mergeIntoGlobalSettings(extracted);
    console.info(`Auto-migrated ${Object.keys(extracted).length} misplaced keys from project to global on save`);
  }

  const validation = validateProjectSettings(merged);
  if (!validation.ok) return res.status(400).json(validation);
  writeProjectSettings(settingsPath, merged);
  res.json({ ok: true, autoMigrated: extracted });
});
```

`extractAndStripGlobalKeys` and the Python `_migrate_global_keys_to_preferences` (§11b) are parallel implementations — one for the online (UI server save handler) context and one for the offline (`worca init --upgrade` CLI) context. **The duplication is structural, not editorial:** the offline CLI runs without a UI server, and the online save runs without a Python interpreter readily callable from Node. Both must be standalone.

To prevent drift, both implementations read `GLOBAL_ONLY_KEYS` from the shared `src/worca/schemas/keys.json` (see §10.0). The actual strip *logic* — walk the key list, splice the value out of the project blob, accumulate it for global-merge — is small enough (~15 lines per language) that a per-language test asserting input/output equivalence is sufficient. A new test fixture, `tests/fixtures/migration_strip_io.json`, lists `(input_blob, expected_extracted, expected_stripped)` triples; both `worca-ui/server/global-keys.test.js` and `tests/test_init_migration.py` iterate the fixture and assert their language's implementation matches.

After this, the validator's "reject misplaced keys" rule becomes a pure safety net: it only fires if `extractAndStripGlobalKeys` somehow missed a key (a bug). The user-facing path always self-heals on save, so a user who never runs `worca init --upgrade` and dismisses the §11c banner still ends up with clean settings the moment they touch the editor.

Response body's `autoMigrated` field lets the UI surface a one-time toast: "N project settings were moved to global Preferences."

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

#### 10.0. Single source of truth — `src/worca/schemas/keys.json`

Five places need to know the canonical default for each key (project validator, global validator/reader, UI normalizer, Python `load_settings_with_global_fallback`, Python migration helpers). To prevent drift, this PR adds a static JSON document loaded at module import time by both languages:

```json
{
  "global_only_keys": [
    ["parallel", "cleanup_policy"],
    ["parallel", "max_concurrent_pipelines"],
    ["ui", "worktree_disk_warning_bytes"],
    ["circuit_breaker", "classifier_model"]
  ],
  "defaults": {
    "global": {
      "parallel": {
        "cleanup_policy": "never",
        "max_concurrent_pipelines": 10
      },
      "ui": {
        "worktree_disk_warning_bytes": 2000000000
      },
      "circuit_breaker": {
        "classifier_model": "haiku"
      }
    },
    "project": {
      "parallel": {
        "worktree_base_dir": ".worktrees",
        "default_base_branch": "main"
      },
      "circuit_breaker": {
        "enabled": true,
        "max_consecutive_failures": 3
      },
      "milestones": {
        "plan_approval": true,
        "pr_approval": false
      }
    }
  }
}
```

**JS consumer pattern** (used by `readGlobalSettings`, `validateGlobalSettings`, `loadSettings` UI normalizer, `extractAndStripGlobalKeys`):

```js
import keysSchema from '../../src/worca/schemas/keys.json' with { type: 'json' };
export const GLOBAL_ONLY_KEYS = keysSchema.global_only_keys;
export const GLOBAL_DEFAULTS = keysSchema.defaults.global;
export const PROJECT_DEFAULTS = keysSchema.defaults.project;
```

**Python consumer pattern** (used by `load_settings_with_global_fallback`, `_migrate_global_keys_to_preferences`, runner):

```python
import json, importlib.resources
_schema = json.loads(importlib.resources.files("worca.schemas").joinpath("keys.json").read_text())
GLOBAL_ONLY_KEYS = [tuple(k) for k in _schema["global_only_keys"]]
GLOBAL_DEFAULTS = _schema["defaults"]["global"]
PROJECT_DEFAULTS = _schema["defaults"]["project"]
```

**Drift tests** (one per language):

- `worca-ui/server/keys-schema.test.js`: assert `GLOBAL_ONLY_KEYS` length matches the §9a hardcoded list and asserts each entry is also rejected by the project validator. This catches a future contributor who forgets to update the JSON when adding a new global key.
- `tests/test_keys_schema.py`: identical assertions on the Python side.

After this section, every other §10 / §4 / §9 block reads its defaults from `GLOBAL_DEFAULTS` / `PROJECT_DEFAULTS` rather than re-stating the literal value. Stale literal defaults in those sections are intentional documentation — they show what the *current* canonical value is for review purposes, but the code path reads from the JSON.

#### 10a. Project — `loadSettings()` (`settings.js:160`)

Reads canonical defaults from §10.0 — no literal defaults in this function:

```js
import { PROJECT_DEFAULTS } from './keys-schema.js';
import { deepMergeWithDefaults } from './utils.js'; // existing helper

settingsData.worca = deepMergeWithDefaults(settingsData.worca ?? {}, PROJECT_DEFAULTS);
```

Equivalent to the previous per-key `?? default` cascade but driven entirely by `keys.json`. If a new project-scoped key is added later, it appears here with no code change — only a JSON edit.

#### 10b. Global — `readGlobalSettings()` (server)

§4's reader is updated to apply defaults from `GLOBAL_DEFAULTS`:

```js
import { GLOBAL_DEFAULTS } from './keys-schema.js';

function readGlobalSettings() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8')); }
  catch (err) { /* same ENOENT / SyntaxError handling as §4 */ }
  raw.worca = deepMergeWithDefaults(raw.worca ?? {}, GLOBAL_DEFAULTS);
  return raw;
}
```

Same self-healing structure as before; the literal value list moves to `keys.json`.

### 11. Template + migration (risk #1 mitigation)

This is the only block that must ship before users hit the new validator on next save. Two pieces:

#### 11a. Strip global + inert keys from `src/worca/settings.json`

Two strip surgeries on the template, both of which must ship in this PR or the runtime defaults won't take effect for upgraded users.

**Strip 1 — global keys.** The template currently ships at `src/worca/settings.json:285-290`:

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

Same surgery on `worca.circuit_breaker` (remove `classifier_model`) and `worca.ui` (remove `worktree_disk_warning_bytes` if present). The default values now live exclusively in `readGlobalSettings()`.

**Strip 2 — inert milestone keys.** The template currently ships at `src/worca/settings.json:201-204`:

```json
"milestones": {
  "plan_approval": true,
  "pr_approval": true,
  "deploy_approval": true
},
```

After this PR:

```json
"milestones": {
  "plan_approval": true
},
```

Rationale: `pr_approval` and `deploy_approval` are inert today. After this PR `pr_approval` becomes consumed by the new gate (§6c) and `deploy_approval` stays inert (no `Stage.DEPLOY` exists). The runner gates only when `pr_approval is True`; missing or `False` skips the gate. Leaving the template's `pr_approval: true` in place would activate the gate on every upgraded project and hang autonomous flows — exactly the regression the default flip is meant to prevent.

`plan_approval` stays in the template at `true` because that key is already consumed (`runner.py:2089-2118`) and `true` is the existing production behavior — no regression to migrate.

#### 11b. `worca init --upgrade` migration

`src/worca/cli/init.py` (or wherever `--upgrade` lives) gains two one-shot migration steps that run once per project. Both are idempotent on second run.

**Step 1 — extract to-be-global keys to `~/.worca/settings.json`:**

```python
def _migrate_global_keys_to_preferences(project_settings_path: str) -> dict:
    """One-shot: extract to-be-global keys from .claude/settings.json,
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

**Step 2 — strip inert milestone keys from the project file:**

```python
def _strip_inert_milestone_keys(project_settings_path: str) -> list:
    """One-shot: remove pr_approval and deploy_approval from .claude/settings.json
    if they were template-default values (true).

    Why: until this PR these keys were inert; the runner ignored them. The
    template has shipped them as `true` since W-048. After this PR, the runner
    gates on `pr_approval is True`, so leaving the template-default value in
    place would activate the gate on every upgraded project — hanging
    autonomous flows that don't have a UI listener attached.

    Stripping the template default lets the runner's missing-key default
    (`false` for pr_approval; ignored for deploy_approval) take effect.

    Skipped if the user has explicitly set the key to `false` (already safe)
    or to anything non-boolean (treated as user intent — leave alone).

    Returns the list of removed keys for the CLI to report.
    Idempotent: returns [] on second run."""
    if not os.path.exists(project_settings_path):
        return []
    with open(project_settings_path) as f:
        project = json.load(f)

    milestones = project.get("worca", {}).get("milestones", {})
    removed = []
    # Only strip when value is exactly the previous template default of `True`.
    # This preserves any explicit user override (`False`, integers, strings...).
    for key in ("pr_approval", "deploy_approval"):
        if milestones.get(key) is True:
            del milestones[key]
            removed.append(key)

    if not removed:
        return []

    # Clean up empty milestones object if it becomes empty
    if "worca" in project and "milestones" in project["worca"] and not project["worca"]["milestones"]:
        del project["worca"]["milestones"]

    with open(project_settings_path, "w") as f:
        json.dump(project, f, indent=2)

    return removed
```

`worca init --upgrade` calls both helpers and prints a one-liner per migration: `Migrated N keys to ~/.worca/settings.json` and `Reset M template-default milestone keys (pr_approval, deploy_approval) — gate now opt-in via Pipeline tab`.

#### 11c. UI banner on detection (defense-in-depth)

When the UI loads a project's settings and detects either condition, show a one-time banner with a "Migrate now" button:

- **Misplaced global keys present** → "This project's settings contain keys that have moved to global Preferences. Click to migrate."
- **`worca.milestones.pr_approval === true` or `deploy_approval === true`** → "This project carries template-default approval gate values that would activate the new PR-creation gate. Click to reset to opt-in."

**Banner reuses existing endpoints — no third migration implementation.** The button does not POST to a new `/migrate-global-keys` route. Instead, it triggers a *no-op save* against the existing `PUT /api/projects/:id/settings` (§9a-bis) — passing back the project's current settings unmodified. The strip-on-save pass auto-extracts misplaced global keys to `~/.worca/settings.json` and returns them in the `autoMigrated` field. For the inert milestone case, the same save handler runs an inline pass equivalent to `_strip_inert_milestone_keys` (Python helper from §11b is *not* called from JS — instead, the same logic is added to §9a-bis's `extractAndStripGlobalKeys` so the JS implementation handles both classes of stale state in one round-trip). The `extractAndStripGlobalKeys` test fixture (§9a-bis) is extended with the milestone-strip cases.

Net effect: one online code path (§9a-bis), one offline code path (§11b), no banner-specific endpoint. The Python helper remains the offline single-shot migration; the JS helper remains the online perpetual self-healer; both are driven by the same `keys.json` and `tests/fixtures/migration_strip_io.json`.

This catches users who upgrade `@worca/ui` but never run `worca init --upgrade`.

## Implementation Plan

Single PR. Recommended ordering — ship the shared schema and migration first so every later step reads from a single source, then build outward:

1. **Shared key schema** (§10.0). Add `src/worca/schemas/keys.json`. Add per-language consumer modules (`worca-ui/server/keys-schema.js` + Python loader in `src/worca/utils/settings.py`). Add drift tests in both languages.
2. **Test-fixture sweep — must run before any default-flip lands.** `grep -r "max_concurrent_pipelines\|cleanup_policy\|worktree_disk_warning_bytes\|classifier_model" tests/ worca-ui/` to find every fixture that hardcodes pre-W-049 defaults (especially `max_concurrent_pipelines: 3` and `cleanup_policy: 'on-success'`). Update each to either (a) use the new defaults from `keys.json`, or (b) explicitly carry the old value plus a comment explaining why. The `keys-schema.test.js` / `test_keys_schema.py` from step 1 will fail until this sweep is complete — that's the gate. List of fixture files known so far: `worca-ui/server/__fixtures__/`, `tests/fixtures/`, plus any inline JSON in the existing `*.test.js` / `test_*.py` files.
3. **Template + migration** (§11). Strip global keys *and* template-default `pr_approval`/`deploy_approval` from `src/worca/settings.json`. Add both migration helpers (`_migrate_global_keys_to_preferences`, `_strip_inert_milestone_keys`), both reading `GLOBAL_ONLY_KEYS` from `keys.json`. Wire into `worca init --upgrade`. Add `tests/fixtures/migration_strip_io.json` shared between Python and JS migration tests.
4. **Server: shared modules** (§5). `worca-ui/server/launch-lock.js` + `worca-ui/server/worktree-ops.js` (extracted from `worktrees-routes.js`). The route handler in `worktrees-routes.js` becomes a thin wrapper.
5. **Server: global preferences endpoint** (§4). New `preferences-routes.js`, `readGlobalSettings`/`writeGlobalSettings` (using `GLOBAL_DEFAULTS`), `validateGlobalSettings`. Mount router.
6. **Server: validator additions** (§9). Project validator extensions + reject-misplaced-keys helper (reads `GLOBAL_ONLY_KEYS` from schema) + `VALID_MODELS` superset test.
7. **Server: strip-on-save** (§9a-bis). `extractAndStripGlobalKeys` in `worca-ui/server/global-keys.js`, including milestone-strip cases per §11c. Wire into `PUT /api/projects/:id/settings`.
8. **Server: enforcement** (§5). `max_concurrent_pipelines` 409 cap *inside the launch-lock* + `cleanup_policy` post-completion hook reading `worktree_path` from `status.json`.
9. **Python runtime** (§6). `load_settings_with_global_fallback` helper. Update `error_classifier.py:102`. Update `run_worktree.py:217` to read `default_base_branch` *and* write `worktree_path` to status.json. Add `pr_approval` gate + `_check_control_response_with_timeout` local helper in `runner.py`. Extend `status.py` for `pr_approved` milestone and `worktree_path` field.
10. **UI plumbing** (§7). Add four global-derived scalars to `store.js`. Bootstrap fetch in `main.js`. Fix Bug A/B/C in `sidebar.js`/`worktrees.js`/`main.js:2149`.
11. **UI: project tab editors** (§2 + §8a). Approval Gates, Circuit Breaker, Execution & Parallelism sections. Extend `readPipelineFromDom` + `loadSettings` defaults (driven by `PROJECT_DEFAULTS`) + Save handler.
12. **UI: global tab editors** (§3 + §8b). Worktrees + Pipeline Execution groups. Add `readGlobalsFromDom` + `savePreferences`.
13. **UI: PR-approval affordance** (§6c UI side). New approval panel in `run-detail.js`. Wire to `/api/projects/:projectId/runs/:id/control`.
14. **UI: max-concurrent gating + banner** (§5a UI side). Disable launch button when at cap; 409 banner; sidebar "N/cap" badge.
15. **UI: migration banner** (§11c). Detection logic + "Migrate now" button that triggers a no-op save (no new endpoint).
16. **Tests** (§Test Plan). Run `cd worca-ui && npm run lint:fix && npx vitest run && npm run build`; `pytest tests/`.
17. **MIGRATION.md** updated with the §11 user-facing migration story.

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
  - PUT /settings auto-extracts misplaced global keys, writes them to global, returns `autoMigrated` field listing what moved.
  - PUT /settings on a clean payload returns `autoMigrated: {}` (no-op).
  - PUT /settings still 400s if validation fails after the strip-and-migrate pass (safety-net path).
- `process-registry.test.js`:
  - `countRunningPipelinesAcrossProjects` skips PIDs that fail `process.kill(pid, 0)` with ESRCH.
  - Counts PIDs that throw EPERM (we can't signal but they exist).
  - Calls `clearStalePid` on each pruned entry.
  - Returns 0 when registry is empty.
- `launch-lock.test.js`:
  - Two `withLaunchLock(fn)` calls run serially even when the inner functions resolve out of order.
  - A rejection in one call does not poison subsequent calls (next call still runs).
  - Concurrent simulated `POST /runs` test: 12 simultaneous launches with cap 10 → exactly 10 succeed (200), 2 get 409. Without the lock, this test goes flaky.
- `keys-schema.test.js`:
  - `GLOBAL_ONLY_KEYS` matches the validator's reject list (drift sentinel — adding a key in JSON without updating the validator should be caught here).
  - `GLOBAL_DEFAULTS` / `PROJECT_DEFAULTS` exhaustively cover the keys named elsewhere in the validator.
- `global-keys.test.js`:
  - Iterates `tests/fixtures/migration_strip_io.json`; for each `(input, expected_extracted, expected_stripped)`, asserts `extractAndStripGlobalKeys(input)` produces matching outputs.
  - Includes inert-milestone-strip cases per §11c.

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
  - `pr_approval=true` + `ctx` but no listener → timeout fires after 1h → auto-approve (mock the timer); log line emitted.
  - Explicit test for `_check_control_response_with_timeout`: deadline-aware loop returns `"approve"` after the deadline; returns the helper's value before the deadline; respects custom `timeout_default`. (No tests against `_check_control_response` itself — its signature is unchanged in this PR.)
- `tests/test_keys_schema.py`:
  - `GLOBAL_ONLY_KEYS` round-trips Python loader → JSON file → JS loader (loaded as data) is identical.
  - All keys named in `GLOBAL_DEFAULTS` / `PROJECT_DEFAULTS` are also handled by `validateGlobalSettings` / project validator — drift sentinel.
- `tests/test_init_migration.py`:
  - `_migrate_global_keys_to_preferences` extracts the four keys, writes to global, removes from project.
  - `_migrate_global_keys_to_preferences` idempotent on second run (returns `{}`).
  - `_migrate_global_keys_to_preferences` handles missing global file (creates it).
  - `_migrate_global_keys_to_preferences` handles missing project file (no-op).
  - **Shared-fixture parity:** iterates `tests/fixtures/migration_strip_io.json`; for each `(input, expected_extracted, expected_stripped)`, asserts the Python helper's outputs match. The same fixture drives `worca-ui/server/global-keys.test.js` — divergence between the two implementations fails one suite or the other.
  - `_strip_inert_milestone_keys` removes `pr_approval: true` and `deploy_approval: true` from a project carrying template defaults.
  - `_strip_inert_milestone_keys` preserves `pr_approval: false` (user already opted out).
  - `_strip_inert_milestone_keys` preserves non-boolean values (treats as user intent).
  - `_strip_inert_milestone_keys` idempotent on second run (returns `[]`).
  - `_strip_inert_milestone_keys` cleans up empty `worca.milestones` object after stripping.
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

- **Single-delivery PR is large.** Estimated ~970 LOC implementation + ~1100 LOC tests after the gap-closure additions (shared schema, launch lock, worktree-ops extraction, fixture sweep). Reviewable but requires explicit ordering (schema/fixtures → migration → endpoint → consumers) so the diff reads in dependency order. CODEOWNERS may want a UI-side and Python-side reviewer in parallel.
- **All listed risks have explicit resolutions.** See "Risk profile after bundling + mitigations" table in Proposal — every entry is now either Eliminated, Resolved, Mitigated, or Documented (no open Investigates).
- **Defaults flipped from earlier draft.** `cleanup_policy` is `never`, `pr_approval` is `false`, `max_concurrent_pipelines` is `10`. Each is justified in the table; flip back if the product preference is to gate / auto-cleanup by default. **Defaults now live in one place** (`src/worca/schemas/keys.json`) — flipping a default is a one-line JSON edit plus a re-run of the drift tests.
- **`pr_approval` timeout is hand-edit only.** Exposing a UI for it adds another control to a tab that's already crowded; users who flip `pr_approval` on are advanced enough to read MIGRATION.md for the timeout knob. Reassess if support questions arise.
- **`deploy_approval` and `transient_retry_count` stay out.** No consumers; would ship UI for non-existent behavior.
- **Asymmetric milestone semantics are intentional and documented.** `plan_approval` is default-true (opt-out); `pr_approval` is default-false (opt-in). The asymmetry is preserved because flipping `plan_approval` to opt-in would silently disable an existing production gate, and shipping `pr_approval` as default-true would hang every autonomous run on upgrade. Inline comment in `runner.py` (§6c) explains the choice for future readers.
- **Single source of truth for defaults eliminates a 5-place drift surface.** `src/worca/schemas/keys.json` (§10.0) is loaded by both languages; per-language drift tests fail loudly when a contributor adds a key in the wrong place.
- **JS / Python strip-on-save duplication is structural, not editorial.** Online (UI server) and offline (`worca init --upgrade`) contexts are mutually exclusive at runtime; both languages must own a standalone implementation. The shared `keys.json` and `tests/fixtures/migration_strip_io.json` keep the two in lockstep on input/output equivalence.
- **Launch race is closed by an in-process mutex** (§5a). Single-server deploy assumption is explicit; multi-server coordination would need a shared lock (e.g., file lock or DB row), out of scope for this PR.
- **`worktree_path` lives in two writers** (registry file via `register_pipeline()`; status.json via `run_worktree.py` per §6b). The registry copy is preserved for back-compat; the status.json copy is the new read surface for §5b's cleanup hook. Future cleanup of the duplication can drop one writer once all readers migrate, but that's out of scope here.
- **Hint copy guidance:** "Hard cap; server returns 409" for max_concurrent. "Auto-removes the worktree after a clean pipeline exit" for cleanup_policy. Don't reuse "soft cap" phrasing anywhere — nothing implements soft caps.
- **Validator / classifier-model coupling.** The new `VALID_MODELS` superset test (§9c) catches drift; add a code comment at `settings-validator.js:15` pointing at the test.
- **Project-over-global merge precedence.** Project wins on overlap. Today there is no overlap in practice (each key lives in exactly one tab and the project validator rejects the global keys). Forward-compatible: if a future feature needs a per-project override of a global key (e.g. per-project disk threshold once anyone asks for it), the merge already does the right thing.
- **Reject misplaced keys produces a clear error.** The error message points users at the global tab, eliminating the "I set it but nothing happened" confusion.
- **Migration:** active. §11 strips template, runs one-shot extraction in `worca init --upgrade`, and surfaces a UI banner that triggers the existing strip-on-save endpoint for users who skip the CLI step (no third migration code path).
- **Governance impact:** none. No hook scripts read these keys; the new `pr_approval` gate uses the existing webhook control mechanism; `removeWorktree` is a `git worktree remove` shell-out (already permitted).

## Files to Create/Modify

| Path | Status | Notes |
|------|--------|---|
| `src/worca/schemas/keys.json` | create | Single source of truth for `GLOBAL_ONLY_KEYS` + per-tier defaults (§10.0) |
| `src/worca/settings.json` | modify | Strip 4 global keys + template-default `pr_approval`/`deploy_approval` (§11a) |
| `src/worca/cli/init.py` | modify | Add `_migrate_global_keys_to_preferences` + `_strip_inert_milestone_keys`; wire both into `--upgrade` (§11b); read `GLOBAL_ONLY_KEYS` from `keys.json` |
| `tests/test_keys_schema.py` | create | Drift test: schema's `GLOBAL_ONLY_KEYS` matches Python consumers (§10.0) |
| `tests/test_init_migration.py` | create | Migration helper tests; iterates `tests/fixtures/migration_strip_io.json` |
| `tests/fixtures/migration_strip_io.json` | create | Shared input/output triples for JS + Python strip-on-save parity (§9a-bis) |
| `worca-ui/server/preferences-routes.js` | create | GET/PUT /api/preferences (§4) |
| `worca-ui/server/preferences-routes.test.js` | create | Endpoint tests |
| `worca-ui/server/settings-reader.js` | modify | `readGlobalSettings` / `writeGlobalSettings` driven by `GLOBAL_DEFAULTS` (§4 + §10.0) |
| `worca-ui/server/settings-validator.js` | modify | `validateGlobalSettings` + project blocks + reject-misplaced-keys helper reading from `keys.json` (§9) |
| `worca-ui/server/settings-validator.test.js` | extend | New blocks + `VALID_MODELS` superset test (§9c) |
| `worca-ui/server/keys-schema.js` | create | JS loader for `keys.json`; exports `GLOBAL_ONLY_KEYS`, `GLOBAL_DEFAULTS`, `PROJECT_DEFAULTS` (§10.0) |
| `worca-ui/server/keys-schema.test.js` | create | Drift test: schema matches JS consumers (§10.0) |
| `worca-ui/server/app.js` | modify | Mount preferences router |
| `worca-ui/server/process-manager.js` | modify | Post-exit cleanup hook reading global prefs + status.json `worktree_path` (§5b) |
| `worca-ui/server/process-manager.test.js` | extend | Cleanup policy branches |
| `worca-ui/server/process-registry.js` | modify | `countRunningPipelinesAcrossProjects` with PID liveness check (§5a) |
| `worca-ui/server/process-registry.test.js` | create | Liveness-check + stale-prune tests |
| `worca-ui/server/launch-lock.js` | create | In-process async mutex for cap-and-register sequence (§5a) |
| `worca-ui/server/launch-lock.test.js` | create | Mutex serializes concurrent calls; rejection doesn't poison chain |
| `worca-ui/server/worktree-ops.js` | create | Shared `removeWorktree` (extracted from `worktrees-routes.js`) (§5b) |
| `worca-ui/server/worktrees-routes.js` | modify | Use shared `removeWorktree` from `worktree-ops.js` |
| `worca-ui/server/global-keys.js` | create | `GLOBAL_ONLY_KEYS` re-export from `keys-schema.js` + `extractAndStripGlobalKeys` (handles both global-key strip and inert-milestone strip) (§9a-bis, §11c) |
| `worca-ui/server/global-keys.test.js` | create | Iterates `tests/fixtures/migration_strip_io.json`; asserts JS implementation matches |
| `worca-ui/server/project-routes.js` | modify | 409 cap check inside launch-lock (§5a) + strip-on-save (§9a-bis) |
| `worca-ui/server/project-routes.test.js` | extend | Cap enforcement + race serialization + strip-on-save |
| `src/worca/utils/settings.py` | modify | `load_settings_with_global_fallback` (§6a) + `keys.json` loader (§10.0) |
| `src/worca/orchestrator/error_classifier.py` | modify | Use fallback helper (§6a) |
| `src/worca/scripts/run_worktree.py` | modify | Read `default_base_branch` + write `worktree_path` to status.json (§6b) |
| `src/worca/state/status.py` | modify | `worktree_path` field; `pr_approved` milestone; `write_status_field` helper if absent (§6c) |
| `src/worca/orchestrator/runner.py` | modify | PR-stage gate + `_check_control_response_with_timeout` local helper (§6c). **No change to `control.py`.** |
| `tests/test_settings_global_fallback.py` | create | Helper merge tests |
| `tests/test_run_worktree.py` | extend | `default_base_branch` cases + `worktree_path` written to status.json |
| `tests/test_runner_pr_approval.py` | create | Gate behavior + timeout (local helper path only — no shared-helper tests) |
| `tests/integration/test_cleanup_policy.py` | create | End-to-end policy branches |
| `tests/integration/test_pr_approval_flow.py` | create | Mock-controlled approve flow |
| `worca-ui/app/main.js` | modify | Bootstrap fetch + threading (§7) |
| `worca-ui/app/store.js` | modify | Four global-derived scalars (§7) |
| `worca-ui/app/views/sidebar.js` | modify | Bug A + Bug C |
| `worca-ui/app/views/sidebar.test.js` | modify | State shape |
| `worca-ui/app/views/worktrees.js` | modify | Bug B + accept threshold |
| `worca-ui/app/views/settings.js` | modify | Project + global tab editors (§§2-3, 8); `loadSettings` reads `PROJECT_DEFAULTS` |
| `worca-ui/app/views/settings-approval-gates.test.js` | create | `plan_approval` + `pr_approval` switches |
| `worca-ui/app/views/settings-circuit-breaker.test.js` | create | Enabled + max-failures |
| `worca-ui/app/views/settings-execution-parallelism.test.js` | create | base-dir + default-branch |
| `worca-ui/app/views/settings-preferences-worktrees.test.js` | create | Disk threshold + cleanup_policy |
| `worca-ui/app/views/settings-preferences-pipeline.test.js` | create | Classifier model + max-concurrent |
| `worca-ui/app/views/run-detail.js` | modify | Approval panel (§6c UI) |
| `worca-ui/app/views/run-detail.test.js` | extend | Approval panel render conditions |
| `worca-ui/app/views/new-pipeline.js` | modify | Disable button at cap + 409 banner + base-branch placeholder |
| `worca-ui/app/views/new-pipeline.test.js` | extend | Cap-disabled state |
| **Test fixtures touched by step 2 sweep** | modify | Any fixture hardcoding `max_concurrent_pipelines: 3`, `cleanup_policy: 'on-success'`, `pr_approval: true`, etc. — list emerges from the grep in step 2 |
| `MIGRATION.md` | modify | Document `worca init --upgrade` migration |
