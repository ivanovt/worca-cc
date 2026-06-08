# W-063: Run Timeline View

**Status:** Draft
**Priority:** P3
**Area:** ui
**Date:** 2026-06-01
**Depends on:** None

## Problem

The existing run detail page (`worca-ui/app/views/run-detail.js:1647`) renders pipeline progress as a horizontal stage strip (`stageTimelineView` at `worca-ui/app/views/stage-timeline.js:37`) — circles + connectors + a `↻ N` loop indicator per stage. The strip answers "what stage are we in and how many times has it iterated", but not:

- **Which stage consumed the most wall-clock time** in this run. With 22 IMPLEMENT iterations and 2 PLAN REVIEW iterations on a 5h 34m run, the strip gives the count but no sense of distribution.
- **When each iteration occurred** along the run's timeline. The strip collapses N iterations into a single dot; there is no way to see "Implement iter 7 ran from 02:14 to 02:31, then Test ran for 2m, then Implement iter 8".
- **What it cost per stage / per iteration.** Cost and duration are aggregated only at the run level (`run-detail.js:1288` `_stageCost`); per-iteration breakdown is buried in the Stages accordion.
- **How loopbacks actually wired together.** When Tester bounces Implementer, the strip increments a counter; the temporal relationship (`Test fail at T → Implement retry at T+gap`) is invisible.

User-facing impact: long, looping runs (the common shape — see W-062's 22 IMPLEMENT iterations in the screenshot) are illegible at the strip-only level. Users either accept "Implement took a long time" as opaque, or trawl through the Stages accordion's per-iteration entries to reconstruct the timeline manually.

## Proposal

Add a dedicated `/run/:runId/timeline` page that visualizes a run as a Gantt-style swimlanes chart: one row per pipeline stage, one bar per iteration positioned by wall-clock time, faint loopback arrows for stage retries, and zoomable time axis. Entry point is a right-aligned **Timeline** button under the existing stage strip on the run detail page; a back arrow on the timeline page returns to the run view. The timeline page mirrors the run page header (title, status badge, Pause/Stop) so users can still control the run without leaving. Tooltips on bars surface iteration #/N, duration, cost, model, status. Cost stays in tooltips only — no overlay. The view is a *specialized addition*, not a replacement of the run detail page.

## Design

### 1. Route and navigation

**Current state:** `worca-ui/app/router.js:1` parses the URL hash into `{section, runId, action, projectId}`. The pattern is `#/{section}[/{runId}[/{action}]]`, optionally prefixed by `project/{slug}/`. Sections include `active`, `archive`, `worktree`, `fleet-runs`, etc.

**Obstacle:** No existing pattern for *sub-views* of a run. The current scheme treats `runId` as terminal — `action` is used for one-shot interactions (e.g. `/pause`), not for navigating to a sibling view.

**Resolution:** Reuse the existing `action` slot to model the sub-view, since `runDetailView` already lives under `#/<section>/<runId>`. Path becomes `#/<section>/<runId>/timeline` (or `#/project/<slug>/<section>/<runId>/timeline` in multi-project mode). The `runs` section is the canonical one; other sections (`archive`, `worktree`) inherit the same sub-path by symmetry.

Routing changes in `worca-ui/app/router.js`:

```js
// existing parseHash already returns { section, runId, action, projectId }
// no schema change needed — `action === 'timeline'` becomes the sub-view marker

export function navigate(section, runId, projectId, action) {
  location.hash = buildHash(section, runId, projectId, action);
}
// navigate(section, runId, projectId, 'timeline') → opens timeline page
// navigate(section, runId, projectId, null)      → back to run detail
```

Main dispatcher (`worca-ui/app/main.js`) gains a branch: when `action === 'timeline'` and a `runId` is present, render `runTimelineView(run, settings, options)` instead of `runDetailView(...)`.

**Entry button** (added in `run-detail.js` immediately after `stageTimelineView(...)` at line `1673`):

```js
${stageTimelineView(stages, stageUi, run.active)}
<div class="run-stage-actions">
  <button class="action-btn action-btn--ghost"
          @click=${() => navigate(section, run.id, projectId, 'timeline')}>
    ${unsafeHTML(iconSvg(BarChart3, 14))} Timeline
  </button>
</div>
```

The container is right-aligned via flex (`justify-content: flex-end`). Visually it sits just below the stages row, matching the user's sketch.

**Back arrow** on the timeline page: same `←` icon used on the existing run page header (top-left of the header), wired to `navigate(section, run.id, projectId, null)`. This returns to `#/<section>/<runId>` — the run detail view.

### 2. Page header (mirrored from run view)

The timeline page mounts the same header as the run detail page — back arrow + status badge + title + Pause/Stop buttons — by extracting the current header from `run-detail.js` into a reusable `runPageHeaderView(run, options)` helper. The timeline view imports this helper and renders it above the timeline body.

Rationale: the run is still live. Users browsing the timeline must be able to Pause/Stop without bouncing back to the detail page. Hard-duplicating the header markup invites drift; a shared helper keeps the two pages visually identical and any future header change (e.g. an "Archive" button) lands in both.

The only header difference: the back arrow on the run page goes to the runs list (`navigate(section, null, projectId)`), whereas on the timeline page it goes to the run detail (`navigate(section, runId, projectId, null)`). Pass the back target as an argument to the helper.

### 3. Timeline data model

**Current state:** `src/worca/state/status.py:134` `start_iteration()` stamps `started_at` (ISO 8601) and other fields onto each new iteration; `status.py:177` `complete_iteration()` merges `completed_at`, `duration_ms`, `turns`, `cost_usd`, `status`, `model`, `agent` into the same entry. The full per-iteration timing record is already persisted in `status.json` under `stages.<key>.iterations[]`.

**Obstacle:** None on the backend. Everything the timeline needs is already in `status.json` and surfaced through the existing run-fetch endpoint that `run-detail.js` consumes.

**Resolution:** No new API. The timeline view reads `run.stages` (already on the `run` object delivered to `run-detail.js`) and projects it into the layout model below. Cost computation reuses `_stageCost(iterations)` from `run-detail.js:1288`.

**Layout model** (computed once per render, memoized on `run.updated_at`):

```js
{
  runStart: <ISO>,                    // earliest started_at across all iterations
  runEnd:   <ISO>,                    // latest completed_at OR now() if still active
  totalMs:  <number>,                 // runEnd - runStart
  rows: [
    {
      stageKey: 'implement',
      stageLabel: 'IMPLEMENT',
      stageHue: '#7c3aed',            // per-stage accent color
      iterationCount: 22,
      bars: [
        { number: 1, startMs: 132000, durMs: 125000,
          status: 'completed', cost: 0.42, model: 'sonnet',
          agent: 'implementer' },
        // ... iterations 2..22
      ],
      gaps: [
        { afterIter: 1, startMs: 257000, durMs: 60000,
          inStage: 'test' },          // control was in TEST between iter 1 and iter 2
        // one gap between every pair of consecutive iterations on this row
      ]
    },
    // ... rows in pipeline order
  ],
  loopbacks: [
    { fromStage: 'test', fromIter: 1, toStage: 'implement', toIter: 2 },
    // one entry per retry trigger — derived from gap.inStage
  ]
}
```

**Gap derivation:** between iter K and iter K+1 of stage S, the gap is `[K.completed_at, (K+1).started_at]`. The `inStage` field is the stage that ran during that interval — found by scanning all other rows for an iteration whose `[started_at, completed_at]` overlaps the gap window. If multiple stages fit, attribute to the one whose iteration ended closest to (K+1).started_at — that is the stage that handed control back.

**Skipped stages:** rows where every iteration has `status === 'skipped'` (or where `stages[key]` is missing entirely) are excluded from `rows`. Matches existing logic in `run-detail.js:1665` that already imputes skipped rows for absent preflight/learn.

### 4. Swimlane layout

**Container:** SVG canvas (one `<svg>` per timeline page), width = available content width, height = `headerHeight + rowHeight × rows.length + axisHeight`. Default `rowHeight = 32px`, `axisHeight = 24px`.

**Row structure:**

```
┌─ rowLabel (160px, left-aligned) ──┬─ swimlane (flex, time-mapped) ─┐
│ IMPLEMENT  ↻×22                   │  [bar][gap][bar][gap]…         │
└───────────────────────────────────┴────────────────────────────────┘
```

- **rowLabel** — `<text>` element. Stage display label + `↻ N` iteration badge when N > 1. Same `RefreshCw + count` idiom as the existing strip (`stage-timeline.js:59`) so the two views feel like the same pipeline.
- **swimlane** — `<g>` containing one `<rect>` per iteration bar, one `<rect class="gap">` per gap span, and zero or more `<path class="loopback">` arrows.

**Bar geometry:**

- `x = (bar.startMs / totalMs) × swimlaneWidth` (mapped under current zoom transform)
- `width = max(MIN_BAR_PX, (bar.durMs / totalMs) × swimlaneWidth)` — `MIN_BAR_PX = 12` so sub-second bars remain hoverable
- `fill = statusColor(bar.status)` (green = completed, blue = in_progress, red = failed, grey = skipped — reuses palette from existing `statusClass` in `worca-ui/app/utils/status-badge.js`)
- `stroke-left = stageHue` (3px left-edge accent) — implemented as a separate `<rect>` 3px wide at `x`, fill = stageHue, so the bar identity is readable when zoomed past the row label
- **Stage hue palette** (canonical, keyed by `Stage` enum from `src/worca/orchestrator/stages.py:7`). These are *identity* colours for the 3px left-edge accent, not status colours — the bar fill continues to use the existing status palette from `worca-ui/app/utils/status-badge.js`. Exposed as `--stage-hue-<key>` CSS variables on `:root` (not hardcoded into SVG attributes) so light/dark mode and future palette tweaks land in one place:

  | Stage | Hue | Hex |
  |---|---|---|
  | `PREFLIGHT` | slate | `#64748b` |
  | `PLAN` | indigo | `#4f46e5` |
  | `PLAN_REVIEW` | violet | `#7c3aed` |
  | `COORDINATE` | teal | `#0d9488` |
  | `IMPLEMENT` | purple | `#9333ea` |
  | `TEST` | amber | `#d97706` |
  | `REVIEW` | emerald | `#059669` |
  | `PR` | cyan | `#0891b2` |
  | `LEARN` | rose | `#e11d48` |

**Centered duration badge:**

- `<text>` inside each bar, centered, content = formatted duration (`125000ms` → `2m 5s`)
- Hidden when the bar width is below `LABEL_MIN_PX = 36` (label would not fit)
- Class `.bar-label` — pointer-events: none so it does not interfere with bar hover

**Gap bands:**

- `<rect class="gap">` between consecutive bars on the same row
- `fill = url(#gapHatch)` — a diagonal-stripe SVG pattern (light grey, 6px spacing) defined once in `<defs>`
- Fully hoverable; tooltip text: `Control was in <inStage> for <Xs> before iteration N+1`

**Loopback arrows:**

- For each entry in `layout.loopbacks`, draw an SVG `<path>` from the end of the source iteration to the start of the destination iteration
- Curve: cubic Bezier above the swimlanes (control points lifted by 1.5 × rowHeight)
- `stroke = currentColor`, `stroke-opacity: 0.15` by default; arrowhead via `marker-end`
- On hover of either endpoint bar, the matched arrow brightens to `stroke-opacity: 1.0` via JS event handlers toggling a class on the path
- Suppressed entirely when `iterationCount > LOOPBACK_HIDE_THRESHOLD` (default 30) to prevent visual chaos on pathological runs; replaced by a small `(loopbacks hidden — hover an iteration to highlight)` hint above the row

### 5. Zoom and pan

**Zoom model:** a single `scale` factor (1.0 = fit-to-run) and a `panMs` offset (0 = start of run at left edge). All bar/gap/arrow positions are computed from `(timestamp - panMs) × pxPerMs × scale`.

**Controls** (toolbar, top-right of timeline body):

- `[− zoom out]` — halves `scale`, clamped to a minimum of 1.0
- `[⤺ reset]` — sets `scale = 1.0, panMs = 0`
- `[+ zoom in]` — doubles `scale`, clamped to a maximum of 32 (allows ~2px-per-second on a 12m run)

**Wheel zoom:** `wheel` event on the SVG canvas, `deltaY > 0` zooms out, `deltaY < 0` zooms in. Zoom is anchored at the mouse pointer's time coordinate: `panMs` is adjusted so the time under the cursor stays put.

**Drag-to-zoom region:** both triggers are in-scope for phase 1 — mouse-down on the time axis *and* shift+drag on the canvas. Either gesture renders a translucent selection rectangle; mouse-up sets `scale, panMs` to fit the selected window. Standard pattern from D3 brush. Two triggers because the axis is a small target at fit-to-run zoom but is the discoverable gesture for first-time users; shift+drag becomes natural once the user is already manipulating the canvas.

**Pan:** middle-mouse drag *and* shift+wheel for horizontal scroll when zoomed in. Both are in-scope for phase 1 — shift+wheel costs ~10 lines once wheel-zoom exists; middle-mouse drag is a routine `mousedown/mousemove/mouseup` handler set. Pan is bounded so the canvas cannot scroll past the run's `[runStart, runEnd]` window.

**Time axis:** `<g class="axis">` at the bottom of the SVG. Tick spacing is adaptive: minutes at `scale < 4`, 10-second ticks at `4 ≤ scale < 16`, 1-second ticks at `scale ≥ 16`. Tick labels formatted as `m:ss` (mm:ss for runs > 1h). The axis itself is hoverable, surfacing the wall-clock time under the cursor.

### 6. Tooltips

**Library:** Shoelace's `sl-tooltip` does not handle dynamic SVG children well (it expects a static slot). Use a single floating `<div class="timeline-tooltip">` positioned via `mousemove` listeners on bars / gaps / arrows.

**Bar tooltip:**

```
PLAN REVIEW · Iteration 2 of 2
Duration:  28s
Started:   00:01:48
Ended:     00:02:16
Model:     opus
Status:    completed
Cost:      $0.18
```

**Gap tooltip:**

```
Gap on IMPLEMENT
Duration:  1m 5s
Control:   TEST  (1 iteration)
Returned at 00:04:21
```

**Loopback arrow tooltip:** suppressed — the arrow itself is informational; bar tooltips carry the substantive data.

### 7. Click-to-drill

Clicking an iteration bar opens an `sl-drawer` from the right, showing per-iteration detail: bead links, model, effort level, token usage, raw `iterations[k]` JSON (collapsed by default).

**Phase-1 scope — minimal rendering, no extraction.** The drawer ships with its own self-contained rendering: status pip, formatted duration, cost, model, agent, and the raw `iterations[k]` JSON in a collapsed `<details>` block. It does **not** consume the run detail page's per-iteration accordion content (`_effortRowView`, `_classificationRowView`, `_dispatchEventsRowsView`, `_planIterationButton`, `_planReviewIssuesButton`, and their supporting helpers — ~30 functions in `run-detail.js`).

**Rationale for deferring extraction.** Pulling those helpers across the file boundary also requires relocating the module-level dialog singletons (`_issuesDialogIter`, `_planArtifactDialog`) and converting many `function _x()` declarations to exported symbols. Bundling that refactor with a brand-new view forces the reviewer to mentally separate two unrelated changes. The end state — a shared `iterationDetailView(iteration, stageKey, run)` consumed by both pages — is still the target, just filed as a clean follow-up that touches only `run-detail.js` and the new file. The bar tooltip already carries the dense per-iteration info, so the minimal drawer is functionally sufficient on day 1.

Out of scope for phase 1 (and tracked under the follow-up): full extraction into a shared `iterationDetailView` helper; streaming log tail inside the drawer (the run detail page already has its own log panel). The drawer's "Open logs" button deep-links to `#/<section>/<runId>` with a query param that scrolls to the iteration's log entry.

## Implementation Plan

### Phase 1: Routing, entry/back navigation, page skeleton

**Files:** `worca-ui/app/router.js`, `worca-ui/app/main.js`, `worca-ui/app/views/run-detail.js`

**Tasks:**

1. Confirm `parseHash()` already exposes `action`; document `'timeline'` as a recognized value in router tests.
2. Add `runTimelineView(run, settings, options)` stub in new file `worca-ui/app/views/run-timeline.js` — renders the shared header + a placeholder "timeline coming" div.
3. Extract the run page header (lines `~1647-1675` of `run-detail.js`, the title bar with status badge + Pause/Stop) into `runPageHeaderView(run, options)` in a new file `worca-ui/app/views/run-page-header.js`. Parameter `options.backTarget = { section, runId, projectId, action }` controls the `←` destination.
4. Wire `main.js` dispatch: when `action === 'timeline'` and a run is loaded, render `runTimelineView` instead of `runDetailView`.
5. Add the **Timeline** entry button in `run-detail.js` immediately after the `stageTimelineView(...)` call at line `1673`, right-aligned via a new `.run-stage-actions` flex container.

### Phase 2: Data layout and SVG rendering

**Files:** `worca-ui/app/views/run-timeline.js`, `worca-ui/app/utils/timeline-layout.js` (new)

**Tasks:**

1. Implement `computeTimelineLayout(stages, runEndTime)` in `worca-ui/app/utils/timeline-layout.js`. Pure function — input is `run.stages`, output is the `{ runStart, runEnd, totalMs, rows, loopbacks }` shape from Design §3.
2. Render SVG skeleton in `run-timeline.js`: container, row labels, swimlane background, time axis. No zoom yet — single fixed scale at `scale = 1.0`.
3. Render bars: status fill + 3px left-edge accent in `stageHue`. Define stage hues centrally in `worca-ui/app/utils/stage-hues.js` (new) — one entry per stage key from `src/worca/orchestrator/stages.py:9`.
4. Render centered duration badges with `LABEL_MIN_PX` guard.
5. Render gap bands using SVG `<pattern>` for the hatch fill.
6. Render loopback arrows with `marker-end` arrowhead and default `stroke-opacity: 0.15`.

### Phase 3: Zoom, pan, and adaptive time axis

**Files:** `worca-ui/app/views/run-timeline.js`, `worca-ui/app/utils/timeline-zoom.js` (new)

**Tasks:**

1. Hold `scale` and `panMs` as component-local state (closure or module-level since the rest of the app is lit-html functional).
2. Wire the toolbar buttons: `−`, `⤺ reset`, `+`. Re-render on each click.
3. Wheel listener on SVG canvas; compute mouse-time anchor and adjust `panMs`.
4. Drag-to-zoom region on the time axis: track `mousedown → mousemove → mouseup`, render selection rect, commit on release.
5. Adaptive axis tick spacing — switch units based on current `scale`.

### Phase 4: Tooltips and click-to-drill

**Files:** `worca-ui/app/views/run-timeline.js`

**Tasks:**

1. Single floating tooltip `<div>`; show/hide and reposition via `mousemove` on bars and gaps.
2. Format tooltip content per Design §6.
3. Click on a bar opens an `sl-drawer` mounting a self-contained minimal iteration-detail body (status, duration, cost, model, agent, collapsed raw JSON) — inlined in `run-timeline.js`, **not** extracted from `run-detail.js`. See §7 for rationale; full extraction is filed as a follow-up.
4. Loopback arrow highlight: bar `mouseenter` adds a `.highlight` class to matching arrows; `mouseleave` removes it.

### Phase 5: Loopback hide threshold + polish

**Files:** `worca-ui/app/views/run-timeline.js`, `worca-ui/app/styles.css`

**Tasks:**

1. If `iterationCount > LOOPBACK_HIDE_THRESHOLD`, suppress arrows on that row and render a small hint.
2. CSS polish: bar hover state (slight brightness lift), gap hover (slight opacity lift), focus rings for keyboard navigation.
3. Empty-state handling: if `rows.length === 0` (no iterations recorded yet), render an `<div class="empty-state">Run has not started any stages yet</div>`.
4. Live-update integration: on `run` prop change (WS update), recompute layout. For active runs the runtime end is `now()`, so the right edge advances every refresh.

### Files Changed Summary

| File | Change |
|------|--------|
| `worca-ui/app/router.js` | Document `action === 'timeline'` as the run sub-view marker; no schema change |
| `worca-ui/app/main.js` | Dispatch `runTimelineView` when `action === 'timeline'` and a run is loaded |
| `worca-ui/app/views/run-detail.js` | Extract header to shared helper; add right-aligned `Timeline` button under stages strip |
| `worca-ui/app/views/run-page-header.js` | New — shared header (back, status badge, title, Pause/Stop) for run and timeline pages |
| `worca-ui/app/views/run-timeline.js` | New — top-level timeline page: header + SVG canvas + toolbar + tooltip layer + self-contained drawer body (no extraction from `run-detail.js`) |
| `worca-ui/app/utils/timeline-layout.js` | New — pure projection from `run.stages` to swimlane layout model |
| `worca-ui/app/utils/timeline-zoom.js` | New — scale/pan math, mouse-anchored zoom, drag-to-zoom helpers |
| `worca-ui/app/utils/stage-hues.js` | New — canonical per-stage accent color map keyed by `Stage` enum values from `src/worca/orchestrator/stages.py` |
| `worca-ui/app/styles.css` | Timeline classes: `.timeline-page`, `.timeline-row`, `.timeline-bar`, `.timeline-gap`, `.timeline-loopback`, `.timeline-tooltip`, `.run-stage-actions` |

## Considerations

- **Active runs and the runtime right edge.** For runs still in progress, `runEnd = now()` — meaning the right edge of the timeline advances with each WS update. Layout recomputes on every render; cost is `O(stages × iterations)` per recompute, which is negligible for the observed iteration counts (~25 max).
- **Long runs (5h+).** With `scale = 1.0` on a 5h 34m run, 1 second ≈ 0.05 pixels at a 1000px-wide swimlane. Sub-minute iterations collapse to single-pixel bars without the `MIN_BAR_PX = 12` guard. The minimum-width rule means bars are *not strictly proportional* at fit-to-run zoom for tiny stages — acceptable trade-off for hover-discoverability, surfaced to users implicitly by the duration badge inside the bar.
- **Cost is a tooltip-only field.** No visible $-overlays per Design §6 and the brainstorm decision. Users wanting cost-vs-duration comparison have the Stages accordion on the run detail page.
- **Skipped stages stay hidden.** Per the brainstorm decision, disabled or unrun stages (e.g. `plan_review` and `learn` when disabled by default) produce no row. The strip's current behavior of imputing placeholder `skipped` entries (`run-detail.js:1665`) is bypassed for the timeline layout.
- **Implementer parallelism.** Multi-bead parallel implementation is not yet implemented in the orchestrator. The timeline uses a single bar per IMPLEMENT iteration. When parallelism lands, the schema will need to widen (sub-rows or stacked bars) — out of scope here, but the layout model leaves room: `rows[].bars[]` could become `rows[].lanes[].bars[]` without breaking the rest of the rendering.
- **Loopback arrow density.** With 22 IMPLEMENT iterations alternating with 22 TEST iterations, naively we draw 21 arrows on each row. The `LOOPBACK_HIDE_THRESHOLD = 30` rule suppresses arrows on rows exceeding the threshold and falls back to a hint. Picking 30 leaves the typical 2-5 iteration case fully wired while protecting the pathological 22-iteration case.
- **Mobile / narrow viewports.** Not in scope — the timeline page assumes desktop-class width (≥ 1024px). The run detail page already targets desktop.
- **Accessibility.** SVG rects get `role="img"` and `aria-label` matching the tooltip text. Keyboard navigation: `Tab` cycles iteration bars in chronological order; `Enter` opens the drawer. Loopback arrows are decorative, marked `aria-hidden="true"`.
- **Breaking changes:** None. The route addition is purely additive; the entry button is a new control in an existing view; the extracted `runPageHeaderView` helper is consumed only by the existing run page (no other caller).
- **Migration:** None — no settings keys, no schema changes.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| JS  | `timeline-layout.computes-runStart-from-earliest-iteration.test.js` | `runStart` = earliest `started_at` across all rows |
| JS  | `timeline-layout.computes-runEnd-as-now-for-active-runs.test.js` | Active runs (`run.completed_at == null`) use `Date.now()` as `runEnd` |
| JS  | `timeline-layout.derives-gap-inStage-by-overlap.test.js` | Gap between IMPLEMENT iter 1 and 2 is attributed to TEST when TEST iter 1 overlaps the window |
| JS  | `timeline-layout.hides-skipped-rows.test.js` | Rows with all-skipped iterations are omitted |
| JS  | `timeline-layout.builds-loopbacks-from-gap-inStage.test.js` | One `loopbacks[]` entry per iteration gap, source = `gap.inStage`'s overlapping iteration |
| JS  | `timeline-zoom.wheel-anchors-on-cursor-time.test.js` | Wheel-zoom keeps the time under the cursor at the same x-coord after scale change |
| JS  | `timeline-zoom.reset-restores-fit.test.js` | Reset returns `scale = 1.0, panMs = 0` |
| JS  | `stage-hues.exports-entry-per-stage-enum-value.test.js` | One entry in `stage-hues.js` for each `Stage` value in `src/worca/orchestrator/stages.py` |

### Integration / E2E Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Playwright | `e2e/run-timeline-navigation.spec.js` | Click Timeline button on run page → URL changes to `…/timeline` → SVG canvas is rendered |
| Playwright | `e2e/run-timeline-back-nav.spec.js` | Back arrow on timeline page → URL drops `…/timeline` → run detail is rendered |
| Playwright | `e2e/run-timeline-tooltip-hover.spec.js` | Hovering an iteration bar shows tooltip with stage label, iteration #/N, duration, model, status |
| Playwright | `e2e/run-timeline-zoom-controls.spec.js` | Clicking `+` doubles bar widths; clicking reset returns to fit-to-run |
| Playwright | `e2e/run-timeline-loopback-highlight.spec.js` | Hovering an IMPLEMENT iter 2 bar brightens the arrow connecting it to TEST iter 1 |
| Playwright | `e2e/run-timeline-click-drill.spec.js` | Clicking a bar opens the iteration drawer with bead links and raw JSON |
| Playwright | `e2e/run-timeline-active-run-updates.spec.js` | While a run is active, the right edge advances on WS update (mock active run, advance time, assert bar grows) |

### Existing Tests to Update

- `worca-ui/app/router.test.js` — add a case covering `action === 'timeline'` parse / build round-trip
- `worca-ui/app/main-header-buttons.test.js` — add an assertion that the Timeline button is rendered after the stage strip and routes to the timeline sub-view
- `worca-ui/app/views/run-detail-template.test.js` — confirm the extracted `runPageHeaderView` helper still renders the same header on the run page (no visual regression)

## Files to Create/Modify

| File | Action |
|------|--------|
| `worca-ui/app/views/run-timeline.js` | Create |
| `worca-ui/app/views/run-page-header.js` | Create |
| `worca-ui/app/utils/timeline-layout.js` | Create |
| `worca-ui/app/utils/timeline-zoom.js` | Create |
| `worca-ui/app/utils/stage-hues.js` | Create |
| `worca-ui/app/views/run-detail.js` | Modify — add Timeline button under stage strip; consume shared header helper |
| `worca-ui/app/main.js` | Modify — dispatch `runTimelineView` when `action === 'timeline'` |
| `worca-ui/app/router.js` | No code change — `action` slot already supports the sub-view marker |
| `worca-ui/app/styles.css` | Modify — add `.timeline-*` classes and `.run-stage-actions` |
| `worca-ui/package.json` | Modify if new directory under `app/` needs an `files` allowlist update (CLAUDE.md ships rule) |
| `docs/plans/W-063-run-timeline-view.md` | Create (this plan) |
| Tests (8 unit + 7 e2e) | Create |

## Out of Scope

- **`iterationDetailView` extraction.** The drawer ships with self-contained minimal rendering in phase 1; pulling the ~30 `_iter*` / `_effort*` / `_dispatch*` / `_classification*` / dispatch-event helpers and the module-level dialog singletons (`_issuesDialogIter`, `_planArtifactDialog`) out of `run-detail.js` into a shared `iterationDetailView(iteration, stageKey, run)` is filed as a clean follow-up that touches only `run-detail.js` and the new file. End state unchanged; just sequenced after this PR lands.
- **Replacement of the run detail page.** The timeline is a *specialized addition*; the existing dot-and-line stage strip stays as the at-a-glance summary on the run page.
- **Cost overlay.** Cost lives in tooltips only. No per-stage `$` label below the bar, no run-level cost chart.
- **Implementer parallelism rendering.** Multi-bead parallel iterations get a single bar each — sub-row / stacked-bar layout is deferred until orchestrator-side parallelism is implemented.
- **Mobile / narrow viewports.** Desktop only.
- **Comparison view across multiple runs.** "Timeline of run A vs run B" is interesting but a separate feature.
- **Streaming log tail in the drawer.** The drawer surfaces structured per-iteration metadata; raw logs stay on the run detail page.
- **Server-side API additions.** All data is already on `run.stages.iterations[]` — no new endpoint.
- **Settings/configuration.** No new settings keys. Thresholds (`MIN_BAR_PX`, `LABEL_MIN_PX`, `LOOPBACK_HIDE_THRESHOLD`) are module-level constants in their respective files; can be promoted to settings if a future need emerges.
