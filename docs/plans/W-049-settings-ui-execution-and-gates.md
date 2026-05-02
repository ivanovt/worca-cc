# W-049: Settings UI for Execution, Approval Gates, Circuit Breaker, and Worktree Disk Threshold

**Status:** Draft
**Priority:** P2
**Area:** ui
**Date:** 2026-05-02
**Depends on:** W-048 (worktree-isolation-unified-runs — already merged)

## Problem

Several `settings.json` keys under the `worca` namespace ship today with no UI editor. The runner consumes them and the UI reacts to some of them, but to change them users must hand-edit JSON.

Concretely (line numbers refer to `src/worca/settings.json`):

- **`worca.parallel.*`** (`settings.json:286-289`, four keys) — entire section unreachable from the UI:
  - `worktree_base_dir` — read by `src/worca/scripts/run_worktree.py:227`. The documented escape hatch when the in-repo `git rev-parse` resolution is wrong.
  - `default_base_branch` — base branch for the new worktree.
  - `max_concurrent_pipelines` — soft cap honored by the UI when launching multiple runs.
  - `cleanup_policy` — advisory hint; cleanup runs via `worca cleanup` / Worktrees view.
  Post-W-048 these matter more, since worktrees enable real parallelism.
- **`worca.milestones.*`** (`settings.json` 3 booleans, validated at `worca-ui/server/settings-validator.js:248-265`) — `plan_approval`, `pr_approval`, `deploy_approval`. Validator already accepts them; no editor exists.
- **`worca.circuit_breaker.*`** (`settings.json:266-273`) — three user-facing keys (`enabled`, `max_consecutive_failures`, `classifier_model`). The breaker is the safety net that halts after N consecutive failures; users cannot tune it without reading the runner.
- **`worca.ui.worktree_disk_warning_bytes`** — referenced by `worca-ui/app/views/sidebar.js:105` to drive the sidebar warning badge variant. Default `2_000_000_000` (2 GB).

Two secondary defects discovered while wiring the plan:
- `worca-ui/app/views/sidebar.js:105` reads `settings['worca.ui.worktree_disk_warning_bytes']` as a flat-dot key, but the server response from `worca-ui/server/project-routes.js:363` returns the full nested object via `readMergedSettings`. So the threshold key is **silently inert** today — the UI always falls back to the 2 GB default. Tests in `worca-ui/app/views/sidebar.test.js:134,149` pass a flat-dot fixture and so don't catch the mismatch.
- `worca-ui/app/views/worktrees.js:56` hardcodes `over2gb = total > 2_000_000_000` and never reads the setting. The `<sl-alert>` banner mentioned in the issue body cannot be configured at all today.

User-facing impact: power features feel less configurable than they actually are; the W-048 worktree mechanics in particular are invisible.

## Proposal

Two phased waves of small, additive UI work, each landing as its own PR:

- **Wave 1 (W-048 follow-up):** add a project-scoped "Execution & Parallelism" section in the Pipeline tab covering all four `worca.parallel.*` keys, plus a "Worktrees" group in the global Preferences tab covering `worca.ui.worktree_disk_warning_bytes`. Wire up the existing-but-inert disk threshold so it actually flows from the saved value to both the sidebar badge and the worktrees-view banner. ~85 LOC + tests.
- **Wave 2 (backlog cleanup):** add "Approval Gates" and "Circuit Breaker" sections to the Pipeline tab covering `worca.milestones.*` and the user-facing subset of `worca.circuit_breaker.*`. ~90 LOC + tests.

No backend changes. Every new key is already consumed by the runner or UI; the validator only needs additive rules. Two PRs, two reviews, two release boundaries.

## Design

### 1. Pipeline tab section ordering

`worca-ui/app/views/settings.js:514-644` renders the project-scoped `pipelineTab(worca, rerender)` in this order today:

```
Preflight
Stage Configuration
Loop Limits
Plan Path Template
Run Defaults
[Save / Reset]
```

Target ordering after both waves (new sections marked `*`):

```
Preflight
Stage Configuration
Loop Limits
Plan Path Template
Run Defaults
Approval Gates*           (Wave 2)
Circuit Breaker*          (Wave 2)
Execution & Parallelism*  (Wave 1)
[Save / Reset]
```

Execution & Parallelism is last because it is the most environment-specific (paths differ across machines / monorepos); the other new sections affect pipeline shape, which is the tab's primary concern.

### 2. Wave 1 — Execution & Parallelism (Pipeline tab, project-scoped)

| Field | Key | Default | Control |
|---|---|---|---|
| Worktree base directory | `worca.parallel.worktree_base_dir` | `.worktrees` | `<sl-input id="parallel-worktree-base-dir">`. Hint: "Relative paths resolve from project root. Absolute and `~/`-prefixed paths supported." |
| Default PR base branch | `worca.parallel.default_base_branch` | `main` | `<sl-input id="parallel-default-base-branch">`. Hint: "Used as default when launching a new worktree-based run." |
| Max concurrent pipelines | `worca.parallel.max_concurrent_pipelines` | `3` | `<sl-input type="number" min="1" max="20" id="parallel-max-concurrent">`. Hint: "Soft cap honored by the UI when launching multiple runs (not server-enforced)." |
| Auto-cleanup policy | `worca.parallel.cleanup_policy` | `on-success` | `<sl-select id="parallel-cleanup-policy">` with options `never`, `on-success`, `manual-only`. Hint: "Currently advisory; cleanup runs via the Worktrees view or `worca cleanup`." |

Render shape (matches existing sections — `settings-grid` with `settings-field` rows):

```js
<h3 class="settings-section-title">Execution & Parallelism</h3>
<div class="settings-grid">
  <div class="settings-field">
    <label class="settings-label">Worktree base directory</label>
    <sl-input id="parallel-worktree-base-dir" value="${parallel.worktree_base_dir || '.worktrees'}" size="small" placeholder=".worktrees"></sl-input>
    <span class="settings-field-hint">Relative paths resolve from project root. Absolute and ~/-prefixed paths supported.</span>
  </div>
  <div class="settings-field">
    <label class="settings-label">Default PR base branch</label>
    <sl-input id="parallel-default-base-branch" value="${parallel.default_base_branch || 'main'}" size="small" placeholder="main"></sl-input>
  </div>
  <div class="settings-field">
    <label class="settings-label">Max concurrent pipelines</label>
    <sl-input id="parallel-max-concurrent" type="number" min="1" max="20" value="${parallel.max_concurrent_pipelines || 3}" size="small"></sl-input>
    <span class="settings-field-hint">Soft cap honored by the UI when launching multiple runs (not server-enforced).</span>
  </div>
  <div class="settings-field">
    <label class="settings-label">Auto-cleanup policy</label>
    <sl-select id="parallel-cleanup-policy" .value=${parallel.cleanup_policy || 'on-success'} size="small" hoist>
      <sl-option value="never">never</sl-option>
      <sl-option value="on-success">on-success</sl-option>
      <sl-option value="manual-only">manual-only</sl-option>
    </sl-select>
    <span class="settings-field-hint">Currently advisory; cleanup runs via the Worktrees view or worca cleanup.</span>
  </div>
</div>
```

### 3. Wave 1 — Worktrees group (Preferences tab, global)

`worca-ui/app/views/settings.js:1077-1116` renders the global `preferencesTab(preferences, { onThemeToggle, onSaveSourceRepo, rerender })`. Add a new "Worktrees" section between "Development" and the version block.

| Field | Key | Default | Control |
|---|---|---|---|
| Disk warning threshold | `worca.ui.worktree_disk_warning_bytes` | `2_000_000_000` (2 GB) | Number input + unit `<sl-select>` (MB/GB), range 0.5–50 GB. Persists as raw bytes. |

Two-control layout: a number input bound to `pref-worktree-disk-warning-value` and a `<sl-select id="pref-worktree-disk-warning-unit">` with `MB` / `GB`. On save, the read function multiplies value by `1_000_000` (MB) or `1_000_000_000` (GB) and clamps to `[500_000_000, 50_000_000_000]`.

```js
function formatDiskThreshold(bytes) {
  if (bytes >= 1_000_000_000) {
    return { value: bytes / 1_000_000_000, unit: 'GB' };
  }
  return { value: bytes / 1_000_000, unit: 'MB' };
}

function readDiskThresholdFromDom() {
  const valEl = document.getElementById('pref-worktree-disk-warning-value');
  const unitEl = document.getElementById('pref-worktree-disk-warning-unit');
  const v = parseFloat(valEl?.value);
  const unit = unitEl?.value || 'GB';
  if (!Number.isFinite(v) || v <= 0) return 2_000_000_000;
  const factor = unit === 'MB' ? 1_000_000 : 1_000_000_000;
  return Math.min(50_000_000_000, Math.max(500_000_000, Math.round(v * factor)));
}
```

The Save handler in `preferencesTab` already exists for `pref-source-repo`; extend it to also persist the disk threshold via `saveSettings({ worca: { ui: { worktree_disk_warning_bytes: bytes } } }, rerender)`.

#### 3a. Repair the inert flat-key consumer

The threshold setting cannot work end-to-end until two existing bugs are fixed in this same wave:

**Bug A — sidebar reads the wrong shape.**
- Current: `worca-ui/app/views/sidebar.js:105` reads `settings['worca.ui.worktree_disk_warning_bytes']` (flat-dot key).
- Fix: read nested — `settings?.worca?.ui?.worktree_disk_warning_bytes ?? 2_000_000_000`.
- Also update the test fixtures at `worca-ui/app/views/sidebar.test.js:134,149` to use the nested shape (`settings: { worca: { ui: { worktree_disk_warning_bytes: 400_000_000 } } }`).

**Bug B — worktrees view ignores the setting.**
- Current: `worca-ui/app/views/worktrees.js:56` hardcodes `over2gb = total > 2_000_000_000`.
- Fix: take `settings` (or threshold) as an argument; pass it from `main.js` where the worktrees view is rendered. Replace the literal `2_000_000_000` with the resolved threshold.
- Mirror the variable rename: `over2gb` → `overThreshold` to keep the intent clear when 2 GB stops being implied.

The disk threshold UI is otherwise window-dressing: saving a value the UI doesn't read is a worse user experience than no UI at all. Both fixes are <10 LOC each.

### 4. Wave 2 — Approval Gates (Pipeline tab, project-scoped)

`worca.milestones` validator already exists at `worca-ui/server/settings-validator.js:248-265` (`VALID_MILESTONES = ['plan_approval', 'pr_approval', 'deploy_approval']`). No validator change needed; the rule already insists each is a boolean.

| Field | Key | Default | Control |
|---|---|---|---|
| Plan approval required | `worca.milestones.plan_approval` | `true` | `<sl-switch id="milestone-plan-approval">`. Hint: "Pipeline pauses after Plan stage; UI shows approve/reject before Coordinate." |
| PR approval required | `worca.milestones.pr_approval` | `true` | `<sl-switch id="milestone-pr-approval">`. Hint: "Pipeline pauses before guardian creates the PR." |
| Deploy approval required | `worca.milestones.deploy_approval` | `true` | `<sl-switch id="milestone-deploy-approval">`. Hint: "Reserved for future deploy stage." |

Render shape mirrors the existing `settings-switch-row` pattern from Preflight (`settings.js:529-532`).

### 5. Wave 2 — Circuit Breaker (Pipeline tab, project-scoped)

| Field | Key | Default | Control |
|---|---|---|---|
| Enabled | `worca.circuit_breaker.enabled` | `true` | `<sl-switch id="cb-enabled">` |
| Max consecutive failures | `worca.circuit_breaker.max_consecutive_failures` | `3` | `<sl-input type="number" min="1" max="10" id="cb-max-failures">`. Hint: "Stop after N consecutive errors of the same kind." |
| Classifier model | `worca.circuit_breaker.classifier_model` | `haiku` | `<sl-select id="cb-classifier-model">` populated from `Object.keys(worca.models)`. |

The classifier model select must read from `worca.models` aliases (haiku/sonnet/opus today) rather than a hardcoded list, so it tracks future alias additions. See `settings.js:469-512` (`agentsTab`) for the existing pattern.

Out of UI: `transient_retry_count` and `transient_retry_backoff_seconds`. Internal mechanic — exposing them invites surprising retry storms.

### 6. Read / save plumbing

Both waves extend `readPipelineFromDom` and the Save handler at `worca-ui/app/views/settings.js:365-380` and `:625-633`.

After Wave 1:

```js
function readPipelineFromDom() {
  // ...existing loops/plan_path_template/defaults reads...
  const parallel = {
    worktree_base_dir: document.getElementById('parallel-worktree-base-dir')?.value?.trim() || '.worktrees',
    default_base_branch: document.getElementById('parallel-default-base-branch')?.value?.trim() || 'main',
    max_concurrent_pipelines: parseInt(document.getElementById('parallel-max-concurrent')?.value, 10) || 3,
    cleanup_policy: document.getElementById('parallel-cleanup-policy')?.value || 'on-success',
  };
  return { loops, plan_path_template, defaults, parallel };
}
```

After Wave 2:

```js
function readPipelineFromDom() {
  // ...existing reads + parallel from Wave 1...
  const milestones = {
    plan_approval: document.getElementById('milestone-plan-approval')?.checked ?? true,
    pr_approval: document.getElementById('milestone-pr-approval')?.checked ?? true,
    deploy_approval: document.getElementById('milestone-deploy-approval')?.checked ?? true,
  };
  const circuit_breaker = {
    enabled: document.getElementById('cb-enabled')?.checked ?? true,
    max_consecutive_failures: parseInt(document.getElementById('cb-max-failures')?.value, 10) || 3,
    classifier_model: document.getElementById('cb-classifier-model')?.value || 'haiku',
  };
  return { loops, plan_path_template, defaults, parallel, milestones, circuit_breaker };
}
```

Save handler payload (after both waves):

```js
const { loops, plan_path_template, defaults, parallel, milestones, circuit_breaker } = readPipelineFromDom();
const stages = readStagesFromDom();
stages.preflight = readPreflightFromDom();
saveSettings({
  worca: { loops, stages, plan_path_template, defaults, parallel, milestones, circuit_breaker }
}, rerender);
```

### 7. Validator additions

`worca-ui/server/settings-validator.js` — three new top-level blocks (one already exists for `milestones`).

**`worca.parallel`** (Wave 1):

```js
const VALID_CLEANUP_POLICIES = ['never', 'on-success', 'manual-only'];

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
    if (p.max_concurrent_pipelines !== undefined &&
        (!Number.isInteger(p.max_concurrent_pipelines) ||
         p.max_concurrent_pipelines < 1 || p.max_concurrent_pipelines > 20)) {
      details.push('parallel.max_concurrent_pipelines must be an integer between 1 and 20');
    }
    if (p.cleanup_policy !== undefined &&
        !VALID_CLEANUP_POLICIES.includes(p.cleanup_policy)) {
      details.push(`parallel.cleanup_policy must be one of: ${VALID_CLEANUP_POLICIES.join(', ')}`);
    }
  }
}
```

**`worca.ui`** (Wave 1):

```js
if (w.ui !== undefined) {
  if (typeof w.ui !== 'object' || w.ui === null || Array.isArray(w.ui)) {
    details.push('worca.ui must be an object');
  } else if (w.ui.worktree_disk_warning_bytes !== undefined) {
    const v = w.ui.worktree_disk_warning_bytes;
    if (!Number.isInteger(v) || v < 500_000_000 || v > 50_000_000_000) {
      details.push('ui.worktree_disk_warning_bytes must be an integer between 500_000_000 (500 MB) and 50_000_000_000 (50 GB)');
    }
  }
}
```

Note: `worca.ui` currently also holds `worca.ui.stages` (consumed by `worca-ui/server/settings-reader.js:11`). The validator must not reject that key — only assert it's an object if present. The block above only narrows `worktree_disk_warning_bytes`, so an existing `ui.stages` payload passes through unchanged.

**`worca.circuit_breaker`** (Wave 2):

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
    if (cb.classifier_model !== undefined && !VALID_MODELS.includes(cb.classifier_model)) {
      details.push(`circuit_breaker.classifier_model must be one of: ${VALID_MODELS.join(', ')}`);
    }
  }
}
```

`worca.milestones` validator already exists (`settings-validator.js:248-265`); no change needed — Wave 2 only adds a UI editor.

### 8. Default normalization

`loadSettings()` at `worca-ui/app/views/settings.js:160` already deep-merges defaults for stages, pricing, governance, etc. Add three small idempotent blocks:

```js
// Wave 1
if (!settingsData.worca.parallel) {
  settingsData.worca.parallel = {
    worktree_base_dir: '.worktrees',
    default_base_branch: 'main',
    max_concurrent_pipelines: 3,
    cleanup_policy: 'on-success',
  };
}
if (!settingsData.worca.ui) settingsData.worca.ui = {};
if (settingsData.worca.ui.worktree_disk_warning_bytes === undefined) {
  settingsData.worca.ui.worktree_disk_warning_bytes = 2_000_000_000;
}

// Wave 2
if (!settingsData.worca.circuit_breaker) {
  settingsData.worca.circuit_breaker = {
    enabled: true,
    max_consecutive_failures: 3,
    classifier_model: 'haiku',
  };
}
if (!settingsData.worca.milestones) {
  settingsData.worca.milestones = {
    plan_approval: true,
    pr_approval: true,
    deploy_approval: true,
  };
}
```

These defaults match `src/worca/settings.json:266-273,278-282,286-289`.

### 9. Tab-scope decision: project vs global

- `worca.parallel.*` → **project** (`pipelineTab`). Different repos pick different worktree base dirs.
- `worca.milestones.*` → **project** (`pipelineTab`). Approval is per-pipeline-shape.
- `worca.circuit_breaker.*` → **project** (`pipelineTab`). Failure tolerance is per-codebase.
- `worca.ui.worktree_disk_warning_bytes` → **global** (`preferencesTab`). The threshold is a UI preference about *the user's machine*, not the project; the sidebar aggregates worktrees across all projects in global mode (CLAUDE.md: "Fleet and workspace grouping requires global mode"). Lives in the merged settings the same way `preferences.theme` does.

  Caveat: today the server endpoint `/api/projects/:id/runs` returns a per-project merged settings payload. The sidebar currently consumes `state.settings` populated from that endpoint (`main.js:805`). After Wave 1, the sidebar must read the threshold from a settings source that reflects *global* preferences, not whichever project last responded. Two acceptable approaches:
  - **(a)** Save the key into both global `~/.worca/settings.json` and accept that per-project overrides are last-write-wins — minimal-change, matches existing `state.settings` behavior. Document in the hint copy that this is a global preference.
  - **(b)** Add a separate `/api/preferences` fetch and store in `state.preferences.worktreeDiskWarningBytes`. More correct, ~30 extra LOC server-side.

  Recommendation: ship **(a)** in Wave 1 since the existing `state.settings` mechanism already aggregates from any project that responds, and pursuing (b) duplicates W-032's per-project / global split debate. Reassess if user feedback shows the override behavior is confusing.

## Implementation Plan

### Wave 1 — Pipeline parallelism + disk threshold

**Files:**
- `worca-ui/app/views/settings.js`
- `worca-ui/server/settings-validator.js`
- `worca-ui/app/views/sidebar.js` (Bug A fix)
- `worca-ui/app/views/sidebar.test.js` (test fixture update)
- `worca-ui/app/views/worktrees.js` (Bug B fix — accept threshold)
- `worca-ui/app/main.js` (pass threshold into `worktreesView`)
- `worca-ui/app/views/settings-execution-parallelism.test.js` (new)
- `worca-ui/app/views/settings-worktree-disk-threshold.test.js` (new)
- `worca-ui/server/settings-validator.test.js` (extend)

**Steps:**
1. Add `Execution & Parallelism` section to `pipelineTab` between Run Defaults and the action row (`settings.js:622-624` boundary).
2. Extend `readPipelineFromDom` to include `parallel` (Section 6).
3. Add the parallel + ui validator blocks (Section 7).
4. Extend `loadSettings` default normalization (Section 8).
5. Update Save handler to include `parallel` in the payload.
6. Add `Worktrees` group to `preferencesTab` with two-control MB/GB layout (Section 3).
7. Extend the existing Save handler in `preferencesTab` to also persist `worca.ui.worktree_disk_warning_bytes`.
8. Fix `sidebar.js:105` to read nested shape (Bug A).
9. Fix `worktrees.js:56` to accept and read the threshold (Bug B); update `main.js` call site.
10. Update `sidebar.test.js` fixtures to nested shape.
11. Add render tests for both new UI sections; add validator tests for both new keyspaces.
12. `cd worca-ui && npm run lint:fix && npx vitest run && npm run build`.

### Wave 2 — Approval gates + circuit breaker

**Files:**
- `worca-ui/app/views/settings.js`
- `worca-ui/server/settings-validator.js`
- `worca-ui/app/views/settings-approval-gates.test.js` (new)
- `worca-ui/app/views/settings-circuit-breaker.test.js` (new)
- `worca-ui/server/settings-validator.test.js` (extend)

**Steps:**
1. Add `Approval Gates` section to `pipelineTab` (between Run Defaults and Execution & Parallelism).
2. Add `Circuit Breaker` section after Approval Gates.
3. Extend `readPipelineFromDom` to include `milestones` and `circuit_breaker`.
4. Add the circuit_breaker validator block (`milestones` already validated).
5. Extend `loadSettings` default normalization for both keys.
6. Update Save handler payload.
7. Add render tests + validator tests.
8. `cd worca-ui && npm run lint:fix && npx vitest run && npm run build`.

### Files Changed Summary

| File | Wave | Change |
|------|------|--------|
| `worca-ui/app/views/settings.js` | 1, 2 | Three new sections in `pipelineTab`, one new group in `preferencesTab`; extend `readPipelineFromDom`, `loadSettings` defaults, save handlers |
| `worca-ui/server/settings-validator.js` | 1, 2 | New blocks for `worca.parallel`, `worca.ui` (narrow), `worca.circuit_breaker` |
| `worca-ui/app/views/sidebar.js` | 1 | Read nested `settings.worca?.ui?.worktree_disk_warning_bytes` |
| `worca-ui/app/views/sidebar.test.js` | 1 | Update fixtures to nested shape |
| `worca-ui/app/views/worktrees.js` | 1 | Accept threshold from caller, replace hardcoded 2 GB |
| `worca-ui/app/main.js` | 1 | Thread threshold into `worktreesView` call |
| `worca-ui/app/views/settings-execution-parallelism.test.js` | 1 | New — 3–4 render tests |
| `worca-ui/app/views/settings-worktree-disk-threshold.test.js` | 1 | New — 2–3 render tests |
| `worca-ui/app/views/settings-approval-gates.test.js` | 2 | New — 3 render tests |
| `worca-ui/app/views/settings-circuit-breaker.test.js` | 2 | New — 3 render tests |
| `worca-ui/server/settings-validator.test.js` | 1, 2 | Extend with parallel / ui / circuit_breaker rule tests |

## Considerations

- **Two PRs, two reviews.** Bundling waves makes the diff hard to read; the two-PR cost is one extra round-trip but each PR stays under ~150 LOC.
- **Disk threshold is currently inert.** Bug A and Bug B in Section 3a are not "scope creep" — without them, Wave 1's Worktrees-group editor saves a value the UI never reads. Verifying the round-trip (save value → sidebar badge variant changes → worktrees view banner appears/disappears) is the Wave 1 acceptance criterion.
- **Soft caps documented as soft.** `max_concurrent_pipelines` is *not* server-enforced today (no rejection on the `POST /runs` endpoint). The hint copy must say so verbatim — otherwise users will assume launching a 4th run while three are running fails. Same applies to `cleanup_policy`: no background pruner exists.
- **Don't expose:**
  - `worca.models.*` — set-once-per-codebase. The Agents tab already lets users pick between aliases.
  - `worca.circuit_breaker.transient_retry_count` and `transient_retry_backoff_seconds` — internal mechanics; tweaking without context produces surprising retry storms.
  - `worca.events.*` — already exposed in Notifications/Webhooks tab; no gap.
  - Per-run worktree on/off toggle — explicitly out of scope (decided during W-048).
  - `.claude/` skip patterns escape hatch — discussed during W-048 but the setting key isn't shipped yet; add the key first, then the UI.
- **Breaking changes:** none. All keys are additive; existing users with no `worca.parallel` / `worca.circuit_breaker` / `worca.milestones` blocks see hardcoded defaults that match the current runner behavior.
- **Migration:** none. Default normalization in `loadSettings` (Section 8) handles upgrades transparently.
- **Governance impact:** none. No hook scripts read these keys; no permissions gate these editors. The `worca.ui.worktree_disk_warning_bytes` is read by client-only code.

## Test Plan

### Render tests (vitest, `worca-ui/app/views/`)

Use the existing `renderToString` helper.

| Wave | Test file | Test | Validates |
|------|-----------|------|-----------|
| 1 | `settings-execution-parallelism.test.js` | `renders four parallel fields with current values` | Section heading + 4 inputs with defaults |
| 1 | | `renders cleanup_policy select with three options` | Options: never / on-success / manual-only |
| 1 | | `falls back to defaults when worca.parallel is missing` | `loadSettings` normalization |
| 1 | `settings-worktree-disk-threshold.test.js` | `renders disk threshold value + unit selector` | Number + select pair |
| 1 | | `formats 2_000_000_000 as 2 GB` | `formatDiskThreshold` |
| 1 | | `formats 500_000_000 as 500 MB` | sub-GB display |
| 2 | `settings-approval-gates.test.js` | `renders three milestone switches with hint copy` | Three switches checked by default |
| 2 | `settings-circuit-breaker.test.js` | `renders enabled/max-failures/classifier controls` | All three controls visible |
| 2 | | `classifier select reads from worca.models` | Select options driven by alias map |

### Validator tests (vitest, `worca-ui/server/settings-validator.test.js`)

| Wave | Block | Cases |
|------|-------|-------|
| 1 | `worca.parallel` | Accepts complete object; rejects empty `worktree_base_dir`; rejects `max_concurrent_pipelines = 0` and `21`; rejects `cleanup_policy = "wrong"`; passes when section absent |
| 1 | `worca.ui` | Accepts `worktree_disk_warning_bytes = 2_000_000_000`; rejects below `500_000_000`; rejects above `50_000_000_000`; passes through `ui.stages` unchanged |
| 2 | `worca.circuit_breaker` | Accepts complete object; rejects `max_consecutive_failures = 0` / `11`; rejects `classifier_model = "gpt-4"` |

### Integration / E2E

No new e2e flow required — the settings page is already covered by existing playwright specs. Sanity-check by running:

```bash
cd worca-ui && npx playwright test e2e/settings.spec.js --workers=1
```

If the spec exists; if not, no e2e gap to close.

### Existing tests to update

- `worca-ui/app/views/sidebar.test.js:134,149` — change `settings: { 'worca.ui.worktree_disk_warning_bytes': 400_000_000 }` to `settings: { worca: { ui: { worktree_disk_warning_bytes: 400_000_000 } } }`. Both tests assert the warning badge state, so the assertion stays the same after the fixture changes shape.

### Done criteria

- All new vitest tests pass.
- All new validator tests pass.
- `cd worca-ui && npm run lint:fix && npx vitest run` is clean.
- `cd worca-ui && npm run build` produces an updated `app/main.bundle.js`.
- Manual round-trip: change disk threshold to 500 MB, save, exceed it, observe sidebar badge flips to `warning` variant and the worktrees view banner appears.

## Files to Create/Modify

| Path | Wave | Status |
|------|------|--------|
| `worca-ui/app/views/settings.js` | 1, 2 | modify |
| `worca-ui/server/settings-validator.js` | 1, 2 | modify |
| `worca-ui/app/views/sidebar.js` | 1 | modify (Bug A) |
| `worca-ui/app/views/sidebar.test.js` | 1 | modify (fixture shape) |
| `worca-ui/app/views/worktrees.js` | 1 | modify (Bug B) |
| `worca-ui/app/main.js` | 1 | modify (thread threshold) |
| `worca-ui/app/views/settings-execution-parallelism.test.js` | 1 | create |
| `worca-ui/app/views/settings-worktree-disk-threshold.test.js` | 1 | create |
| `worca-ui/app/views/settings-approval-gates.test.js` | 2 | create |
| `worca-ui/app/views/settings-circuit-breaker.test.js` | 2 | create |
| `worca-ui/server/settings-validator.test.js` | 1, 2 | modify |

## Out of Scope

- Server-enforcing `max_concurrent_pipelines` (today it's a UI hint; rejecting on `POST /runs` is a separate W-NNN).
- Auto-pruning worktrees per `cleanup_policy` (today it's advisory; a background reaper is a separate W-NNN).
- Exposing `worca.models.*`, `worca.circuit_breaker.transient_retry_*`, or `worca.events.*` — see Considerations.
- Per-run worktree toggle (decided during W-048).
- Adding `.claude/` skip patterns; setting key not shipped yet.
- Migrating existing per-project `worktree_disk_warning_bytes` overrides into a global preference store — Section 9 documents the chosen tradeoff.
