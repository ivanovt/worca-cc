# W-068: File Access ("Access Map") UI

**Status:** Draft
**Priority:** P2
**Area:** ui
**Date:** 2026-06-05
**Depends on:** W-064 (agent file-access telemetry)

## Problem

W-064 (PR #285, closes #278) ships agent file-access & search telemetry as a **passive, data-only** feature — it records every Read/Write/Glob/Grep per agent subprocess and aggregates them at `complete_iteration` into a `pipeline.iteration.access` Tier-2 event, written to `.worca/runs/<run-id>/events.jsonl`. The PR explicitly states: *"Visualization/UI explicitly out of scope (deferred to a future `area:ui` plan)."* Today this rich per-iteration footprint — which files each stage read, wrote, and searched, plus capture-integrity metrics — is **invisible**: there is no surface in worca-ui that reads `pipeline.iteration.access` events. The data accrues and is never seen. Users debugging an agent's behavior ("why did the implementer keep re-reading `path_canon.py`?", "did the tester touch files outside its bead?", "why are searches returning zero hits?") have no way to inspect it short of hand-grepping `events.jsonl`.

## Proposal

Add a per-run sub-view titled **"File Access"** (nav/button label **"Access"**), mirroring the W-063 Timeline pattern: a button in the run-detail timing-bar action group next to Timeline, routing to `#/{section}/{runId}/access`. The page renders a **treetable** of files (rows, hierarchical) × stage→iteration→bead (columns), with operation badges per cell, a heatmap, category toggles, file/cell drawers, a separate searches lane, and a capture-integrity strip. Data is served by a thin server aggregator that reads `events.jsonl`, filters `pipeline.iteration.access`, and returns a pre-built row/column model.

## Design

### 1. Entry point & routing (mirror W-063 Timeline)

- **Current state:** Timeline is reached via a primary button in the `pipeline-timing-bar-actions` group — `worca-ui/app/views/run-detail.js:1829-1835` (`BarChart3` icon, `@click=${options.onOpenTimeline}`). It dispatches at `worca-ui/app/main.js:4102-4131` (`if (route.action === 'timeline' && route.runId) { return runTimelineView(...) }`), wired via `onOpenTimeline: () => navigate(route.section, route.runId, route.projectId, 'timeline')` (`main.js:4202`). Hash format `#/{section}/{runId}/{action}` is parsed in `worca-ui/app/router.js`.
- **Obstacle:** none structural — the pattern is established and reusable. The only design choice is button grouping and the new action keyword.
- **Resolution:** add an **"Access"** primary button immediately after the Timeline button inside the same `pipeline-timing-bar-actions` div, gated on `options.onOpenAccess`. Add a route action `access`. View module: `worca-ui/app/views/run-file-access.js`, export `runFileAccessView(run, settings, options)`.

```js
// run-detail.js — inside pipeline-timing-bar-actions, after the Timeline button
${options.onOpenAccess
  ? html`<button class="action-btn action-btn--primary" @click=${options.onOpenAccess}>
      <span aria-hidden="true">${unsafeHTML(iconSvg(FolderTree, 14))}</span> Access</button>`
  : nothing}
```

```js
// main.js — before the catch-all runId handler, sibling to the timeline short-circuit (~main.js:4102)
if (route.action === 'access' && route.runId) {
  const run = /* same run resolution as timeline branch */;
  return runFileAccessView(run, settings, {
    section: route.section, runId: route.runId, projectId: route.projectId,
    onBack: () => navigate(route.section, route.runId, route.projectId),
  });
}
// and in the run-detail options block (~main.js:4202):
onOpenAccess: () => navigate(route.section, route.runId, route.projectId, 'access'),
```

**Wire-up checklist** (per `/worca-ui-add-page` discipline, adapted for a run sub-view — Timeline does NOT add a sidebar/header-title entry since it is run-scoped, and neither does this):
1. View file `run-file-access.js`.
2. Import + dispatch in `main.js` (3 anchors: the two early `route.action === 'timeline'` guards at `main.js:3338` and `main.js:3803` have siblings for `access`, plus the render branch at `main.js:4102`).
3. `onOpenAccess` button in `run-detail.js`.
4. `onOpenAccess` callback in the run-detail options block in `main.js`.
5. Server endpoint (§3) + client fetch hook.

### 2. Data model — server aggregator

- **Current state:** `pipeline.iteration.access` events land in `.worca/runs/<run-id>/events.jsonl`. The server already reads this file via the WS `get-events` handler — `worca-ui/server/ws-message-router.js:785-808` (`proj.wset.eventWatcher.readEventsFromFile(runId, {...})`). The Python event payload is built by `iteration_access_payload(run_id, stage, agent, iteration, bead_id, file_access)` (`src/worca/events/types.py:470`); the `file_access` shape is produced by `aggregate_file_access()` in `src/worca/orchestrator/file_access_aggregation.py`.
- **Obstacle:** the raw `file_access` dict is per-(stage, iteration, bead) and keyed by path→count for reads/writes. Shipping every event's full reads/writes maps to the browser and rebuilding the file tree + column matrix in JS on every render is wasteful for large runs (hundreds of files × many iterations). Searches are pattern-level, not file-level, so they cannot live in the file-tree rows.
- **Resolution:** add a server-side aggregator that reads the run's `pipeline.iteration.access` events once and returns a **pre-built row/column model**. New WS message `get-file-access` (sibling to `get-events`), backed by a helper module `worca-ui/server/file-access-aggregator.js`.

Per-event input (from each `pipeline.iteration.access` payload):

```jsonc
{
  "run_id": "…", "stage": "implement", "agent": "implementer",
  "iteration": 1, "bead_id": "w-064-a",
  "file_access": {
    "reads":  { "src/worca/runner.py": 3 },
    "writes": { "src/worca/path_canon.py": 5 },
    "searches": [ { "tool": "Grep", "pattern": "def respell", "scope": "src/worca", "result_count": 12 } ],
    "totals": { "distinct_read": 1, "total_read": 3, "distinct_write": 1, "total_write": 5,
                "grep": 1, "glob": 0, "zero_result": 0, "root_scoped": 0 },
    "capture": { "hook_writes": 1, "git_writes": 1, "leakage_pct": 0.0, "oracle": "ok" }
  }
}
```

Aggregated server response (`get-file-access` reply):

```jsonc
{
  "runId": "…",
  "enabled": true,                  // false → telemetry off / pre-W-064 run → empty-state
  "columns": [                      // ordered: stage order → iteration → bead
    { "key": "plan:1",      "stage": "plan",     "iteration": 1, "bead_id": null,      "agent": "planner" },
    { "key": "implement:1:w-064-a", "stage": "implement", "iteration": 1, "bead_id": "w-064-a", "agent": "implementer" },
    { "key": "implement:1:w-064-b", "stage": "implement", "iteration": 1, "bead_id": "w-064-b", "agent": "implementer" }
  ],
  "tree": [                         // hierarchical; dirs contain children, files are leaves
    { "type": "dir", "path": "src/worca", "name": "src/worca",
      "children": [
        { "type": "file", "path": "src/worca/runner.py", "name": "runner.py",
          "tracked": true,          // appeared in a git-respelled write set
          "category": "read",       // dominant: read | write | leaked
          "cells": {                // keyed by column.key
            "plan:1": { "read": 1 },
            "implement:1:w-064-a": { "write": 3, "read": 1 }
          },
          "totals": { "read": 6, "write": 5 }
        }
      ]
    }
  ],
  "searches": [                     // flattened, with column.key back-reference
    { "colKey": "implement:1:w-064-a", "stage": "implement", "iteration": 1,
      "tool": "Grep", "pattern": "def respell", "scope": "src/worca",
      "result_count": 12, "broad": false, "zero_hit": false, "filter": null }
  ],
  "summary": {
    "files_touched": 142, "distinct_read": 97, "total_read": 412,
    "distinct_write": 38, "total_write": 71, "searches": 23,
    "grep": 18, "glob": 5, "zero_result": 4, "root_scoped": 6,
    "leakage_pct_max": 1.2, "oracle": "ok"     // oracle: "degraded" if ANY event degraded
  }
}
```

Derivation rules (server):
- **Column order** follows the canonical stage order (reuse the stage-ordering helper used by Timeline / `stage-hues.js` / `computeTimelineLayout`); within a stage, ascending iteration, then bead_id (nulls first).
- **Tree build** = union of all `reads` ∪ `writes` paths across all events, split on `/` into a nested dir/file structure; dir rows carry rolled-up child totals (computed client-side or server-side — server-side preferred for large trees).
- **`category`** per file: `write` if any write recorded; `leaked` if written but `tracked === false` (hook saw a write git didn't, or gitignored — drives amber); else `read`. (`tracked` ← whether the path survived git respelling, inferable because gitignored writes are dropped from `writes` in `aggregate_file_access`.)
- **`broad`** ← `scope` ∈ {".", ""} (equivalent to `totals.root_scoped` contributor). **`zero_hit`** ← `result_count === 0`.
- **`oracle: "degraded"`** if any contributing event had `capture.oracle === "degraded"` → drives the integrity banner.

### 3. Server endpoint

- **Current state:** `ws-message-router.js:785` `get-events` reads events via `eventWatcher.readEventsFromFile`.
- **Resolution:** add `get-file-access` handler that calls the new `file-access-aggregator.js`, which reuses `readEventsFromFile(runId)` (or reads `events.jsonl` directly), filters `type === 'pipeline.iteration.access'`, and folds payloads into the §2 response shape. Returns `{ enabled: false, … }` when zero access events exist (pre-W-064 run or telemetry disabled) so the client can render the empty-state without guessing.

```js
// ws-message-router.js — sibling to get-events
if (req.type === 'get-file-access') {
  const { runId } = req;
  const model = buildFileAccessModel(proj.wset.eventWatcher, runId); // from file-access-aggregator.js
  ws.send(JSON.stringify({ type: 'file-access', runId, ...model }));
  return;
}
```

**Packaging:** `file-access-aggregator.js` is a new file under `worca-ui/server/` — verify it ships via `cd worca-ui && npm pack --dry-run | grep file-access-aggregator` (the `files` allowlist gotcha). The current glob `server/**/*.js` should already cover it; confirm.

### 4. Page layout & visual encoding

Four stacked regions inside `run-file-access.js` (single scroll, sticky table header):

**(a) KPI strip** — stat cards: files touched · read (distinct + ops) · written (distinct + ops) · searches (with zero-hit count) · broad scans · capture (leakage_pct + oracle badge). Amber on: broad>0, zero_result>0, leakage>0, oracle degraded.

**(b) Treetable (centerpiece)** — files (rows) × columns (stage→iteration→bead).
- First column sticky (file tree); header row sticky. Stage column groups **collapsible to a single aggregate column** (collapsed by default for stages other than the most-active; handles width — "expect it to be wide").
- Cell = badge(s): `R` (blue, eye), `W` (green, pencil), `RW` (both); superscript = op count; `·` = untouched.
- **Heatmap toggle** ⊞ — shade cell background by op-count density.
- **Category toggle chips** `[▣ Reads] [▣ Writes] [▣ Searches]` — show/hide layers.
- **Path filter** (glob) + **sort** (tree | most-read | most-written | churn).
- File-name text color by `category`: read→blue, write→green, leaked→amber; `✎` decoration for `tracked`.
- Per-file Σ column (read/write totals) on the right.

**(c) Searches lane** — separate table (searches are pattern-level, not per-file): columns stage/iteration · tool · pattern · scope · hits · filter. Amber chips for `broad` ("broad") and `zero_hit` ("0 hits"). Group-by-stage toggle. Optional tree overlay: violet search-dot on directories that appear as a `scope` (hint only — no fabricated per-file match data).

**(d) Capture-integrity strip** — `leakage_pct` gauge + oracle status; amber banner when `oracle === "degraded"` ("path canonicalization degraded — counts approximate").

ASCII reference (collapsed/expanded stages, badges, heatmap):

```
FILE                      │ PLAN│COORD│  IMPLEMENT   │TEST │REVIEW│  Σ
                          │  1  │  1  │  1   2   3   │ 1 2 │ 1  2 │ R / W
▼ src/worca/orchestrator/ │ R²  │ R   │ RW⁴  W   ·  │ R   │ R    │ 6 / 5
    runner.py         ✎   │ R   │ R   │ W³   W²  ·  │ R   │ R    │ 4 / 5
    path_canon.py     ✎   │ ·   │ ·   │ W⁵   W   W  │ R²  │ R    │ 3 / 7
▶ docs/  (3 files)        │ R   │ ·   │ W    ·   ·  │ ·   │ R    │ 4 / 1
legend  R read(blue) · W write(green) · ⁿ op count · ✎ git-tracked · shade=density
```

### 5. Drawers (reuse Timeline's `sl-drawer` pattern)

- **File-row click** → per-file history drawer: chronological list of every (stage, iteration, agent, bead) that read/wrote it, with an **"Open in Timeline ↗"** deep-link to the matching Timeline iteration. (Timeline ↔ Access cross-linking both directions.)
- **Cell click** → scoped drawer: exact read/write counts for that (file, stage, iteration, bead) + agent.

### 6. Color mapping (per `worca-ui/docs/badge-color-language.md`)

Read = **blue** (active/informational) · Write = **green** (done/mutation) · Caution = **amber**, reused for broad scans, zero-hit searches, write leakage, degraded oracle. No new color vocabulary. Dispatch `worca-ui-design-reviewer` after build for badge-color + lit-html binding + `files`-allowlist audit; `worca-ui-a11y-reviewer` for the treetable (keyboard nav of collapse/expand, aria on toggles); `worca-ui-routing-reviewer` for the sub-view wire-up.

## Implementation Plan

### Phase 1: Server aggregator
**Files:** `worca-ui/server/file-access-aggregator.js` (new), `worca-ui/server/ws-message-router.js`
**Tasks:**
1. `buildFileAccessModel(eventWatcher, runId)` — read events, filter `pipeline.iteration.access`, fold into the §2 response (columns, tree, searches, summary). Return `{ enabled: false }` when no access events.
2. Add `get-file-access` WS handler (sibling to `get-events` at `ws-message-router.js:785`).
3. `npm pack --dry-run | grep file-access-aggregator` to confirm packaging.

### Phase 2: View — KPI strip + treetable
**Files:** `worca-ui/app/views/run-file-access.js` (new), `worca-ui/app/views/run-detail.js`, `worca-ui/app/main.js`, `worca-ui/app/styles.css`
**Tasks:**
1. `runFileAccessView(run, settings, options)` — fetch model via `get-file-access`, render KPI strip + treetable (sticky panes, collapsible stage groups, badges, heatmap toggle, category chips, filter, sort, Σ column).
2. Add `onOpenAccess` button in `run-detail.js` (after Timeline button, `run-detail.js:1829`), `access` route dispatch + `onOpenAccess` callback in `main.js` (anchors `main.js:3338`, `3803`, `4102`, `4202`).
3. CSS for `.access-treetable`, sticky header/first-col, badge cells, heatmap shading, file-name category colors.

### Phase 3: Searches lane + capture strip + drawers
**Files:** `worca-ui/app/views/run-file-access.js`, `worca-ui/app/styles.css`
**Tasks:**
1. Searches table with broad/zero-hit amber chips + group-by-stage.
2. Capture-integrity strip + degraded-oracle banner.
3. File-row and cell `sl-drawer`s with "Open in Timeline ↗" cross-link; optional Timeline→Access deep-link.

### Phase 4: Build, tests, reviewers
**Tasks:** `cd worca-ui && npm run build`; vitest (server + view); Playwright e2e (`e2e/file-access.spec.js`); dispatch `worca-ui-design-reviewer`, `worca-ui-a11y-reviewer`, `worca-ui-routing-reviewer`.

### Files Changed Summary

| File | Change |
|------|--------|
| `worca-ui/server/file-access-aggregator.js` | **New** — fold `pipeline.iteration.access` events into row/column model |
| `worca-ui/server/ws-message-router.js` | Add `get-file-access` WS handler |
| `worca-ui/app/views/run-file-access.js` | **New** — `runFileAccessView`: KPI strip, treetable, searches lane, capture strip, drawers |
| `worca-ui/app/views/run-detail.js` | Add "Access" button to `pipeline-timing-bar-actions` |
| `worca-ui/app/main.js` | `access` route dispatch + `onOpenAccess` wiring (anchors 3338, 3803, 4102, 4202) |
| `worca-ui/app/styles.css` | Treetable, sticky panes, badge cells, heatmap, category colors |
| `worca-ui/package.json` | Confirm `files` allowlist covers new server file (likely no change) |

## Considerations

- **Read-only & opt-in-data:** the page only reads events; zero pipeline behavior change. When `worca.telemetry.file_access.enabled` is off (gate `_is_file_access_telemetry_enabled`, `src/worca/orchestrator/runner.py`) or a run predates W-064, no `pipeline.iteration.access` events exist → server returns `enabled: false` → page shows an informative empty-state ("File-access telemetry not recorded for this run"). The button can still render; the page explains the absence.
- **Width / scale:** runs with many beads/iterations make the matrix very wide; collapsible stage groups + horizontal scroll + the per-file Σ column mitigate. Server-side tree pre-build avoids client-side O(files×events) work each render.
- **Searches are pattern-level:** deliberately a separate lane, not file-tree rows — the telemetry has no per-file match attribution (only pattern, scope, result_count). The tree search-dot overlay is a hint, not a claim.
- **Degraded oracle:** when git canonicalization degraded, counts are approximate and case may be Layer-1 form; the integrity banner states this rather than hiding it.
- **Breaking changes:** none — additive UI + one new read-only WS message.
- **Migration:** none.
- **Governance:** no hook/governance changes; this is pure worca-ui.

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| JS (vitest) | `file-access-aggregator.test.js` — `builds tree from reads+writes union` | Nested dir/file tree, dir rollups |
| JS (vitest) | `…` — `orders columns by stage→iteration→bead` | Column order matches stage order |
| JS (vitest) | `…` — `marks broad + zero_hit searches` | `broad`/`zero_hit` flags from scope/result_count |
| JS (vitest) | `…` — `category=leaked when written but untracked` | Leakage → amber category |
| JS (vitest) | `…` — `enabled:false when no access events` | Empty-state contract |
| JS (vitest) | `…` — `oracle=degraded if any event degraded` | Integrity summary |
| JS (vitest) | `run-file-access.test.js` (renderToString) | KPI strip, badge cells, category chips, searches lane render |

### Integration / E2E Tests
- `worca-ui/e2e/file-access.spec.js` (`--workers=1`): seed a run fixture with `pipeline.iteration.access` events → click "Access" button on run-detail → treetable renders with R/W badges; toggle a category chip hides a layer; collapse a stage group; click a file row → drawer with history + "Open in Timeline" link; searches lane shows a broad-scan amber chip. Empty-state path: run with no access events → empty-state copy.

### Existing Tests to Update
- None expected (additive). If `run-detail` snapshot tests assert the timing-bar action set, update them to include the new "Access" button.

## Files to Create/Modify

| Path | New? | Purpose |
|------|------|---------|
| `worca-ui/server/file-access-aggregator.js` | ✅ | Event-fold → row/column model |
| `worca-ui/server/ws-message-router.js` | — | `get-file-access` handler |
| `worca-ui/app/views/run-file-access.js` | ✅ | The page |
| `worca-ui/app/views/run-detail.js` | — | "Access" entry button |
| `worca-ui/app/main.js` | — | Route dispatch + `onOpenAccess` |
| `worca-ui/app/styles.css` | — | Treetable / badge / heatmap CSS |
| `worca-ui/server/file-access-aggregator.test.js` | ✅ | Aggregator unit tests |
| `worca-ui/app/views/run-file-access.test.js` | ✅ | View render tests |
| `worca-ui/e2e/file-access.spec.js` | ✅ | Browser e2e |

## Out of Scope

- **Cross-run / fleet / workspace aggregation** — this is a single-run sub-view only.
- **Per-file content diffs** — this shows *access*, not *changes*; diffs remain in PRs.
- **Per-file search-match attribution** — telemetry has none; searches stay pattern-level.
- **Treemap/icicle overview visualization** — a possible v2 secondary view; v1 is the treetable.
- **Writing/altering telemetry** — W-068 only reads W-064 data; no changes to hooks, recorder, aggregation, or the event schema.
- **New top-level section / sidebar entry** — like Timeline, this is run-scoped only.
