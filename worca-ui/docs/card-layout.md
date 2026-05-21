# worca-ui Card Layout

Every card-style view in worca-ui — run cards, fleet cards, workspace cards, worktree cards — shares the same base structure and CSS hierarchy. This document is the spec; new card types should follow it.

## Why a shared layout

Cards are the primary visual unit for listing pipeline runs and their groupings. Visual coherence matters: a user scanning the Dashboard or History view sees runs, fleets, and workspaces side by side. Identical structure (status pip on the left, title, badge on the right, meta rows, action row at the bottom) makes the page legible without effort.

Implementation today: each card type (run, fleet, workspace, worktree) implements its own render function but **reuses the `.run-card` base class and structural sub-elements** from `worca-ui/app/styles.css`. New card types should do the same — extend `.run-card`, do not create parallel `.foo-card` hierarchies.

## Base class: `.run-card`

Defined in `worca-ui/app/styles.css` (search for `.run-card {`). Provides:

- Flex column layout with `gap: 10px`, `padding: 14px 18px`
- `border`, `border-radius: var(--radius-lg)`, `background: var(--surface)`
- Hover state with elevated shadow + 1px Y translation
- **Status-colored left border** via `.run-card.status-<status>` modifier classes (running, paused, completed, failed, etc. — already covered for the full pipeline status enum)

The status modifier comes from `statusClass(status)` in `worca-ui/app/utils/status-badge.js`. Always go through that — do not write inline status→class mappings.

## The 4-section structure

```html
<div class="run-card ${statusClass(status)}" @click=${onClick}>

  <!-- 1. TOP: status pip + title + (optional inline icons) + status badge -->
  <div class="run-card-top">
    <span class="run-card-status" title=${tooltip}>${unsafeHTML(statusIcon(status, 16))}</span>
    <span class="run-card-title">${title}</span>
    <!-- optional badge or inline icons go here -->
    <sl-badge variant=${variant} pill class="status-badge-${status}">${status}</sl-badge>
  </div>

  <!-- 2. META: one or more rows of label/value pairs -->
  <div class="run-card-meta">
    <span class="run-card-meta-item">
      <span class="meta-label">Project:</span>
      <span class="meta-value">${projectName}</span>
    </span>
    <span class="run-card-meta-item">
      <span class="meta-label">Started:</span>
      <span class="meta-value">${formatTimestamp(startedAt)}</span>
    </span>
    <!-- Add more items as needed. Multiple .run-card-meta divs are fine for visual grouping. -->
  </div>

  <!-- 3. STAGES / PROGRESS (optional): badges, counters, or progress indicators -->
  <div class="run-card-stages">
    ${stages.map(s => html`
      <sl-badge variant=${badgeVariantFor(s)} pill class="run-card-stage-badge">${s.label}</sl-badge>
    `)}
  </div>

  <!-- 4. ACTIONS: button row at the bottom -->
  <div class="run-card-actions">
    ${pauseBtn}${stopBtn}${resumeBtn}${cancelBtn}${archiveBtn}
  </div>
</div>
```

Sections are vertically stacked with 10px gap. Any section can be omitted (use `nothing` from lit-html, not an empty `<div>`). The order is fixed.

## Mandatory utilities

These come from `worca-ui/app/utils/`:

| Need | Use this | Don't do this |
|---|---|---|
| Card top-level class | `statusClass(status)` | Inline `class="status-${status}"` |
| Icon in `.run-card-status` | `statusIcon(status, 16)` (wrap with `unsafeHTML`) | Lucide icon directly per-card |
| Status badge variant in `.run-card-top` | A central variant map (see below) | Inline `variant="success"` ladder |
| Stage/sub-status badge variant in `.run-card-stages` | A central variant map | Inline mapping |
| Timestamps and durations | `formatTimestamp`, `formatDuration`, `elapsed` from `utils/duration.js` | `Date.toLocaleString()` |
| Status resolution (e.g. promoting `pending` to `running`) | `resolveStatus(status, isActive)` | Reimplementing the rule |

### Badge variants — current state

The repo has several variant maps that all do the same thing for different domains: `RUN_STATUS_VARIANT` (run-card.js), `WS_STATUS_VARIANT` (workspace-card.js), `fleetStatusVariant()` (group-rendering.js), `BADGE_VARIANT` (run-card.js, stages), and various private `_*Variant()` helpers in run-detail.js. New card types should add their own per-domain map at the top of the file, mirroring this pattern. **Do not hardcode `variant="success"` inline** — drift will be caught by `worca-ui-card-consistency-reviewer`.

(A future refactor may consolidate these into one `variantFor({domain, status})` resolver — see the survey note. Until then, add a typed map per card.)

## Required elements

A card MUST have:

1. **Status pip** in `.run-card-status` — first child of `.run-card-top`. This anchors the card visually; users scan the left edge for state at a glance.
2. **Title** in `.run-card-title` — `flex: 1`, ellipsis on overflow. Use a single line.
3. **`statusClass()` modifier on the root** — drives the colored left border.

A card SHOULD have:

4. **Status badge** at the end of `.run-card-top` — redundant with the pip but accessible (the badge text reads as the status name).
5. **Meta row(s)** — at minimum, the timestamp the card represents (`Started:`, `Created:`, etc.).
6. **Action row** at the bottom — even if empty. Future actions land here without restructuring.

A card MAY have:

7. **Multiple `.run-card-meta` rows** for visual grouping (e.g. project info on row 1, timing on row 2).
8. **`.run-card-template`** row — for showing the pipeline template name with `padding-left: 26px` to align under the title.
9. **`.run-card-stages`** row — for stage badges, beads count, or other progress indicators.
10. **Type-specific decorations** — e.g. fleet cards add a `.fleet-card-stack` ::before/::after layered silhouette. These go on a per-type wrapper class (`.fleet-card`) that lives alongside `.run-card`, not in place of it.

## What NOT to do

- **Do not** create a parallel CSS hierarchy (e.g. `.foo-card`, `.foo-card-top`, `.foo-card-title`). Use `.run-card` as base and add only the type-specific extras under a `.foo-card` modifier class.
- **Do not** put click handlers on inner elements without `e.stopPropagation()` — the whole card is clickable, and inner links/buttons must opt out explicitly.
- **Do not** inline `variant="success"` / `variant="warning"` / etc. on `sl-badge` inside cards. Route through a per-domain variant map keyed by status.
- **Do not** put icons directly in templates with `<sl-icon name="...">` for *status* purposes. Status icons go through `statusIcon()`. Decorative icons (worktree folder, conflict warning) may use `sl-icon` directly.
- **Do not** vary the section order. Top → Meta → (Template) → (Stages) → Actions. Always.

## Adding a new card type

Use the `/worca-ui-add-card` skill — it scaffolds the file with the right imports, structure, and variant-map skeleton, and reminds you to add the type-specific CSS modifier in `styles.css`.

After scaffolding, dispatch the `worca-ui-card-consistency-reviewer` subagent to verify the layout follows this spec before committing.

## Reference implementations

- `worca-ui/app/views/run-card.js` — the canonical example
- `worca-ui/app/views/fleet-card.js` — extension with stack-of-cards silhouette and project badge row
- `worca-ui/app/views/workspace-card.js` — extension with project listing
- `worca-ui/app/views/run-card.test.js` — vitest patterns for cards
