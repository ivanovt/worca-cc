# Badge Color Language

Style guide for `sl-badge` pill variants and status colors across the worca-ui dashboard.

## Shoelace Badge Variants

| Variant | CSS Color | Hex | Meaning |
|---|---|---|---|
| `success` | Green | `#22c55e` | Positive — completed, approved, allowed, ready |
| `primary` | Blue | `#3b82f6` | Active — running, in-progress, resuming |
| `warning` | Orange | `#f59e0b` | Caution — paused, interrupted, needs attention |
| `danger` | Red | `#ef4444` | Negative — failed, blocked, rejected, critical |
| `neutral` | Grey | — | Inactive — pending, skipped, unknown, informational |

## CSS Variables

Defined in `worca-ui/app/styles.css`:

```css
--status-running: #3b82f6;      /* blue  — maps to primary */
--status-in-progress: #3b82f6;  /* blue  — maps to primary */
--status-paused: #f59e0b;       /* amber — maps to warning */
--status-completed: #22c55e;    /* green — maps to success */
--status-failed: #ef4444;       /* red   — maps to danger  */
--status-error: #ef4444;        /* red   — maps to danger  */
```

Use CSS variables for custom-styled elements (spans, icons, borders). Use Shoelace `variant` for `sl-badge` components. Both must map to the same color for each state.

## Per-Context Badge Rules

### Pipeline Status (header badge)

File: `app/main.js`

| Value | Variant | Example |
|---|---|---|
| `running` | `primary` | [Running] in blue |
| `resuming` | `primary` | [Resuming] in blue |
| `paused` | `warning` | [Paused] in orange |
| `completed` | `success` | [Completed] in green |
| `failed` | `danger` | [Failed] in red |

### Stage Status (stage card badge)

File: `app/views/run-detail.js` — `_badgeVariant()`

| Value | Variant |
|---|---|
| `completed` | `success` |
| `in_progress` | `primary` |
| `interrupted` | `warning` |
| `error` | `danger` |
| `pending` / `skipped` | `neutral` |

### Stage Badges in Run Card

File: `app/views/run-card.js` — `BADGE_VARIANT`

Same mapping as stage status above.

### Iteration Trigger

File: `app/views/run-detail.js` — `_triggerBadge()`

| Value | Variant | Label |
|---|---|---|
| All triggers | `neutral` always | Grey — trigger is informational ("why"), not a judgment |

Display label: `Iteration Trigger:`

### Iteration Outcome

File: `app/views/run-detail.js` — `_outcomeVariant()`

| Value | Variant | Rationale |
|---|---|---|
| `success` / `approve` | `success` | Positive result |
| `revise` / `request_changes` | `warning` | Needs rework, not a hard failure |
| `rejected` / `restart_planning` | `danger` | Hard rejection |
| `skipped` / unknown | `neutral` | Unknown or skipped |

Display label: `Iteration Outcome:`

### Subagent Dispatch

File: `app/views/run-detail.js` — `_dispatchEventsRowView()`

| Value | Variant | Example |
|---|---|---|
| `dispatch_allowed` | `success` | [Explore dispatched (x3)] in green |
| `dispatch_blocked` | `danger` | [Explore blocked] in red, reason on hover |

Display label: `Subagents:`

Blocked badges show the reason as a native tooltip via `title` attribute.

### Preflight Checks

File: `app/views/run-detail.js` — `_preflightCheckBadgeVariant()`

| Value | Variant |
|---|---|
| `pass` | `success` |
| `warn` | `warning` |
| `fail` | `danger` |
| unknown | `neutral` |

### Bead Status

File: `app/views/beads-panel.js` — `statusVariant()`

| Value | Variant | Rationale |
|---|---|---|
| blocked (has `blocked_by`) | `warning` | Waiting on dependencies |
| `open` | `success` | Ready to work |
| `in_progress` | `primary` | Currently being worked on |
| `closed` | `neutral` | Done |

### Bead Priority

File: `app/views/beads-panel.js` — `priorityVariant()`

| Value | Variant |
|---|---|
| P0 / P1 | `danger` |
| P2 | `warning` |
| P3 / P4 | `neutral` |

### Beads Count Badge

File: `app/views/run-detail.js` — beads section header

| Condition | Variant | Example |
|---|---|---|
| `closed < total` | `primary` | [6/10] in blue — work remaining |
| `closed === total` | `success` | [10/10] in green — all done |
| `total === 0` | `neutral` | [0/0] in grey |

### Learning Importance

File: `app/views/learnings-panel.js` — `importanceBadge()`

| Value | Variant |
|---|---|
| `critical` | `danger` |
| `high` | `warning` |
| `medium` | `primary` |
| `low` / unknown | `neutral` |

## Design Rules

1. **Blue means active, not orange.** In-progress, running, and resuming states use `primary` (blue). Orange (`warning`) is reserved for states that need user attention: paused, interrupted, blocked.

2. **Trigger badges are always grey.** The trigger tells you *why* an iteration started — it's context, not a judgment. No semantic color.

3. **Outcome badges follow a three-tier scale.** Green = positive, orange = needs rework (not fatal), red = hard failure. This mirrors the review/plan-review stage semantics where `revise` is a softer signal than `rejected`.

4. **Dispatch badges use only green and red.** A dispatch is binary: allowed or blocked. No intermediate state.

5. **Labels before badges.** Every badge group gets a muted label prefix (`Iteration Trigger:`, `Iteration Outcome:`, `Subagents:`, `Fail Category:`) using the `.meta-label` CSS class. This makes the role of each badge self-documenting.

6. **Absent data = absent row.** When a field is null/undefined/empty, the entire row (label + badges) is not rendered. No empty space or placeholder.

7. **Tooltip for long text.** If a badge's full explanation is too long for a pill (e.g., dispatch block reason), put the short form in the badge and the full text in `title=""` for hover.
