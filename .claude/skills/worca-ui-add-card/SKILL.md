---
name: worca-ui-add-card
description: Scaffold a new worca-ui card view following the `.run-card` layout pattern documented in `worca-ui/docs/card-layout.md` — top/meta/(stages)/actions, status pip via `statusIcon`, central variant map, no inline badge variants. Triggers on "new card", "add card", "card view", "worca-ui-add-card", or any request to add a new card-style view to worca-ui.
---

# Scaffold a new worca-ui card view

Card views (run, fleet, workspace, worktree) all share the `.run-card` base structure documented in `worca-ui/docs/card-layout.md`. This skill scaffolds a new card type following that spec so new cards stay consistent with the rest.

## Step 0: No-args mode

If invoked with no arguments, print this usage:

```
/worca-ui-add-card --name:<name> --domain:<domain> [--with-stages] [--with-template]

Example:
  /worca-ui-add-card --name:integration --domain:integration_run --with-stages
```

Arguments:
- `--name` — kebab-case name (e.g. `integration`, `cohort`). The view file becomes `<name>-card.js`, the function `<name>CardView`, the CSS modifier `.<name>-card`.
- `--domain` — the status domain this card represents (e.g. `run`, `fleet`, `workspace`, `worktree`, or a new domain). Used in the variant map name.
- `--with-stages` — include the `.run-card-stages` section
- `--with-template` — include the `.run-card-template` row

Stop if no arguments given.

## Step 1: Read the spec

Before generating anything, load:

1. `worca-ui/docs/card-layout.md` — the spec
2. `worca-ui/app/views/run-card.js` — canonical reference
3. `worca-ui/app/styles.css` (search for `.run-card`) — base CSS

## Step 2: Create the view file

Create `worca-ui/app/views/<name>-card.js` with this skeleton:

```javascript
import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { formatDuration, formatTimestamp } from '../utils/duration.js';
import {
  resolveStatus,
  statusClass,
  statusIcon,
} from '../utils/status-badge.js';

// Per-domain status → variant map. Do NOT inline variant="..." values in
// templates below — drift will be flagged by worca-ui-card-consistency-reviewer.
// If a unified variantFor({domain, status}) resolver lands later, route through
// it instead of this local map.
const <UPPER_DOMAIN>_STATUS_VARIANT = {
  pending: 'neutral',
  running: 'primary',
  paused: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

/**
 * <Name> card view.
 *
 * @param {object} item - the <domain> object to render
 * @param {object} [options] - event callbacks: { onClick, onPause, onResume, ... }
 */
export function <camelCaseName>CardView(item, options = {}) {
  const { onClick } = options;
  const status = resolveStatus(item.status || 'pending', /* isActive */ false);
  const variant = <UPPER_DOMAIN>_STATUS_VARIANT[status] || 'neutral';
  const title = item.title || item.id || '(untitled)';

  return html`
    <div class="run-card <name>-card ${statusClass(status)}" @click=${onClick ? () => onClick(item.id) : null}>

      <!-- 1. TOP: status pip + title + status badge -->
      <div class="run-card-top">
        <span class="run-card-status">${unsafeHTML(statusIcon(status, 16))}</span>
        <span class="run-card-title">${title}</span>
        <sl-badge variant=${variant} pill class="status-badge-${status}">${status}</sl-badge>
      </div>

      <!-- 2. META: at least one row -->
      <div class="run-card-meta">
        ${item.started_at ? html`
          <span class="run-card-meta-item">
            <span class="meta-label">Started:</span>
            <span class="meta-value">${formatTimestamp(item.started_at)}</span>
          </span>
        ` : nothing}
        <!-- Add more meta-items here. -->
      </div>

      <!-- Generated only if --with-template was passed -->
      <!-- 3. TEMPLATE: pipeline template name (optional) -->

      <!-- Generated only if --with-stages was passed -->
      <!-- 4. STAGES: progress indicators (optional) -->

      <!-- 5. ACTIONS: button row (always present, may be empty) -->
      <div class="run-card-actions">
        <!-- Buttons here. Use sl-button. Stop propagation on clicks. -->
      </div>
    </div>
  `;
}
```

Substitutions:
- `<name>` — the kebab-case name from `--name`
- `<camelCaseName>` — camelCased version (e.g. `integration` → `integration`, but `my-thing` → `myThing`)
- `<Name>` — Pascalized for docs
- `<UPPER_DOMAIN>` — uppercase domain (e.g. `INTEGRATION_RUN`)

Variants of the skeleton:

- If `--with-template`: insert after meta row:
  ```html
  ${item.template ? html`<div class="run-card-template"><span class="meta-label">Template:</span> <span class="meta-value">${item.template}</span></div>` : nothing}
  ```

- If `--with-stages`: insert after meta/template, before actions:
  ```html
  ${(item.stages || []).length > 0 ? html`
    <div class="run-card-stages">
      ${item.stages.map(s => html`<sl-badge variant=${variantForStage(s)} pill class="run-card-stage-badge">${s.label}</sl-badge>`)}
    </div>
  ` : nothing}
  ```

## Step 3: Add CSS modifier (only if type-specific styling is needed)

Append to `worca-ui/app/styles.css`:

```css
/* ── <Name> card ───────────────────────────────────────────────────────
   Reuses .run-card base + structural sub-elements. Only add type-specific
   extras here (e.g. decorative layers, type-specific badge rows).
   Do NOT duplicate .run-card layout rules. */
.<name>-card {
  /* type-specific extras only */
}
```

If the new card needs no type-specific styling, **skip this step** — the `.run-card` base is enough.

## Step 4: Add a test file

Create `worca-ui/app/views/<name>-card.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { <camelCaseName>CardView } from './<name>-card.js';
import { renderToString } from '../test-helpers/render.js'; // or the project's existing helper

describe('<camelCaseName>CardView', () => {
  it('renders the status pip + title + badge', () => {
    const html = renderToString(<camelCaseName>CardView({
      id: 'test-1',
      status: 'running',
      title: 'Test item',
    }));
    expect(html).toContain('run-card-status');
    expect(html).toContain('run-card-title');
    expect(html).toContain('Test item');
  });

  it('routes status to the correct variant', () => {
    const html = renderToString(<camelCaseName>CardView({
      id: 'test-2',
      status: 'failed',
      title: 'Failed item',
    }));
    expect(html).toContain('variant="danger"');
  });
});
```

Reference an existing card test (`run-card.test.js`) for the right `renderToString` helper import path in this project.

## Step 5: Lint, build, test

```bash
cd worca-ui && npm run lint:fix && npm run build && npx vitest run
```

Then dispatch `worca-ui-card-consistency-reviewer` to verify the layout follows the spec before committing.

## Step 6: Print summary

```
New card scaffolded:
  Name:            <name>
  Domain:          <domain>
  View file:       worca-ui/app/views/<name>-card.js
  CSS modifier:    <added at styles.css:<line> | skipped (no type-specific styling)>
  Test file:       worca-ui/app/views/<name>-card.test.js
  Has stages:      <yes | no>
  Has template:    <yes | no>

Spec reference: worca-ui/docs/card-layout.md

Next:
  1. Fill in real meta rows and actions for the <domain> domain.
  2. Wire the card into its container view (which dashboard/list renders it).
  3. Dispatch worca-ui-card-consistency-reviewer to audit.
```
