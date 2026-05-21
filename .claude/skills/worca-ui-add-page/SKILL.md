---
name: worca-ui-add-page
description: Scaffold a new worca-ui section (page) across every required wire-up point — view file, route handler, header title, sidebar entry, and WS/fetch hooks. Triggers on "new page", "new section", "add ui page", "add ui section", "worca-ui-add-page", or any request to add a new top-level UI section to worca-ui.
---

# Scaffold a new worca-ui section

worca-ui sections are not registered in a single registry — they're checked as `route.section === '...'` strings in 4-5 places across `main.js` and sidebar. Adding a new section silently breaks if you forget one location. This skill scaffolds them all together.

## Step 0: No-args mode

If invoked with no arguments, print this usage:

```
/worca-ui-add-page --section:<slug> --title:"<display title>" --sidebar-section:<pipeline|work|analytics|configuration> [--project-scoped]

Example:
  /worca-ui-add-page --section:notifications --title:"Notifications" --sidebar-section:work
```

Arguments:
- `--section` — URL slug (kebab-case, e.g. `costs`, `fleet-runs`, `notifications`). Must not collide with existing sections.
- `--title` — display title shown in the page header and sidebar.
- `--sidebar-section` — which sidebar grouping the nav item belongs in (`pipeline`, `work`, `analytics`, or `configuration`).
- `--project-scoped` — optional flag. If present, the section is visible only when a project is selected; if absent, it's visible in both global and project mode.

Stop if no arguments given.

## Step 1: Verify the slug is unique

```bash
grep -nE "route\.section === ['\"]<slug>['\"]|case ['\"]<slug>['\"]" worca-ui/app/main.js worca-ui/app/views/sidebar.js worca-ui/app/router.js
```

If any match, the slug is taken — stop and ask the user for a different one.

Also check the valid-section list in `router.js` (search for `VALID_SECTIONS` or similar) — if such a list exists, the new slug must be added there too.

## Step 2: Create the view file

Create `worca-ui/app/views/<slug>.js` with this skeleton:

```javascript
import { html, nothing } from 'lit-html';

/**
 * <Title> section.
 *
 * @param {object} state - the global store state slice relevant to this view
 * @param {object} settings - global settings (theme, preferences)
 * @param {object} [options] - event callbacks: { onSelectRun, onPause, ... }
 */
export function <camelCaseSlug>View(state, settings, options = {}) {
  // Derive what you need from state
  // const items = state.<slug> ?? [];

  return html`
    <div class="view-<slug>">
      <!-- Empty state — replace with real content -->
      <div class="empty-state">
        <p><Title> view is not implemented yet.</p>
      </div>
    </div>
  `;
}
```

Function naming: `<camelCaseSlug>View` (e.g. `notificationsView`, `fleetRunsView`). This matches the convention in every existing view file.

## Step 3: Add the route dispatch in `main.js`

Find `mainContentView()` in `worca-ui/app/main.js` (it's the function that contains the long `if (route.section === '...')` chain). Add:

```javascript
import { <camelCaseSlug>View } from './views/<slug>.js';

// Inside mainContentView()
if (route.section === '<slug>') {
  return <camelCaseSlug>View(state, settings, {
    // pass relevant callbacks
  });
}
```

If `--project-scoped` was passed, gate it:

```javascript
if (route.section === '<slug>') {
  if (!currentProjectId) {
    return html`<div class="empty-state">Select a project to view <Title>.</div>`;
  }
  return <camelCaseSlug>View(...);
}
```

## Step 4: Add the header title in `contentHeaderView()`

Same file (`main.js`), find `contentHeaderView()` (also a long `if` chain). Add:

```javascript
if (route.section === '<slug>') {
  return { title: '<Title>', actions: nothing };
}
```

If the section has page-level actions (e.g. "New" buttons), add them in the `actions` slot — read a sibling section like `fleet-runs` for the pattern.

## Step 5: Add the sidebar entry in `sidebar.js`

In `worca-ui/app/views/sidebar.js`, find the section group matching `--sidebar-section`:

| `--sidebar-section` | Group label in sidebar.js |
|---|---|
| `pipeline` | "Pipeline" (Runs, History, Worktrees, Fleets, Workspaces) |
| `work` | "Work" (Beads) |
| `analytics` | "Analytics" (Costs, Webhooks) |
| `configuration` | "Configuration" (Project Settings, Workspaces, Settings) |

Add a nav item following the existing pattern. Reuse `statusDotClass` / icons where applicable. For project-scoped sections, copy the conditional rendering pattern used by "Project Settings" (which hides when `!currentProjectId`).

Example shape:

```javascript
${this._navItem({
  section: '<slug>',
  label: '<Title>',
  icon: /* Lucide icon */,
  badge: /* optional count badge */,
  active: route.section === '<slug>',
  onNavigate,
})}
```

## Step 6: Wire WS / fetch hooks (if needed)

If the new section needs live data, two places in `main.js` need updates:

1. **Fetch/poll logic** — find where data is loaded per section (search for `route.section === 'history'` or similar in fetch logic). Add a parallel branch for the new section.
2. **WS message handler** — find where WS messages dispatch to view-specific handlers (search for `wsMessage.type === 'run_updated'` etc.). If the new section consumes WS events, add a handler.

If the section is static (no live data), skip this step but note it explicitly in the summary.

## Step 7: Lint, build, and test

```bash
cd worca-ui && npm run lint:fix && npm run build && npx vitest run
```

Then dispatch `worca-ui-routing-reviewer` to verify all wire-up points are covered before committing.

## Step 8: Print summary

```
New section scaffolded:
  Slug:           <slug>
  Title:          <Title>
  Visibility:     <global | project-scoped>
  View file:      worca-ui/app/views/<slug>.js
  Main dispatch:  worca-ui/app/main.js:<line>
  Header title:   worca-ui/app/main.js:<line>
  Sidebar entry:  worca-ui/app/views/sidebar.js:<line>
  WS/fetch:       <wired | skipped (static)>

Next:
  1. Implement the view content (currently an empty-state placeholder).
  2. Dispatch worca-ui-routing-reviewer to audit wire-up completeness.
  3. Add an e2e test under worca-ui/e2e/ if the section has user-facing flows.
```
