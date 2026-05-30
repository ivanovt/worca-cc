# W-061: In-app help links — central registry, standardized renderer, and CI sync checks

**Status:** Draft
**Priority:** P2
**Area:** ui
**Date:** 2026-05-30
**Depends on:** None

## Problem

worca-ui currently has no in-app pointers to the comprehensive docs at [docs.worca.dev](https://docs.worca.dev). Users land on a settings tab (`worca-ui/app/views/settings.js:3497-3534` — 9 project-scoped tabs covering Models, Effort, Permissions, Pipeline, Pricing, Webhooks, Graphify, Code Review Graph, plus 4 global tabs at `:3444-3466`), a run-detail panel (`worca-ui/app/views/run-detail.js` — stage timeline, plan iterations, CRG badge at `:1148`, Graphify badge at `:1067`, dispatch section at `:880`, circuit breaker at `:916/:925`, PR details), or a launcher (`new-run.js`, `fleet-launcher.js`, `workspace-create.js`) with no affordance to "learn more about this."

The docs themselves are rich (45 pages across 9 sections under `docs-site/src/content/docs/`), but discovery is poor. Users either guess slugs, navigate from the docs site root, or never find them at all. A grep across `worca-ui/app/` confirms no existing pattern: no `target="_blank"` anchors to `docs.worca.dev`, no help icon, no `?` affordance anywhere in the UI today.

User-facing impact: every onboarding question that the docs already answer (what's an effort level? what does halted mean? how do I configure a webhook?) becomes a support touch instead of a self-serve click.

## Proposal

Add a single centralized help-link module — `worca-ui/app/utils/help-links.js` — with a frozen `HELP_LINKS` map (helpId → {slug, title}), a `helpUrl(id)` lookup, and a standardized `helpLink(id)` lit-html renderer. Every in-app `?` icon flows through `helpLink()` — never inline `<a target="_blank">` — making it the single point of control for URL, icon, color, hover, dark/light styling, and a11y.

Enforce sync with two CI layers: an L1 vitest that resolves each slug against the local `docs-site/src/content/docs/` tree (no network, every PR), and an L2 live HEAD check wired into the `worca-release-preflight` subagent (catches "doc added to master but `/worca-docs-publish` not yet run").

Roll out by UX rule — **one `?` per primary teaching surface** (section/tab/panel/launcher header), never on individual buttons, badges, or form fields. ~22 icons total across the entire UI.

Note on map size vs. placement count: `HELP_LINKS` ships with 25 entries (full coverage of the docs surface area). Initial placement uses ~22 because several helpIds are reused across surfaces (e.g. `agents-models` covers both the Agents and Models settings tabs; `crg` and `graphify` each cover both a settings tab and a run-detail badge area) and a handful are reserved for future surfaces (`monitoring`, `controlling`, `templates`) so they don't need to be added in a separate map-edit PR later.

## Design

### 1. The central module — `worca-ui/app/utils/help-links.js`

- **Current state:** no module exists; closest analogs are `worca-ui/app/utils/status-badge.js` and `worca-ui/app/utils/effort-badge.js` (small focused helpers exporting both data maps and lit-html renderers).
- **Obstacle:** scattered `<a target="_blank" href="https://docs.worca.dev/...">` would re-introduce the divergence problem the registry is meant to solve. A second team member adding a help link would either copy-paste an existing anchor (fragile) or invent their own styling (inconsistent).
- **Resolution:** ship the module + renderer together. Public API is exactly three exports — `HELP_LINKS`, `helpUrl(id)`, `helpLink(id)`. All consumers import `helpLink` only; the map and `helpUrl` are exposed for tests and for the rare case where the URL is needed without the icon (e.g., a "Learn more" inline anchor in copy).

```js
// worca-ui/app/utils/help-links.js
import { html } from 'lit-html';
import { CircleHelp, iconSvg } from './icons.js';

// Build-time override (see Design §5). Defaults to production docs.
const DOCS_BASE =
  typeof WORCA_DOCS_BASE !== 'undefined' ? WORCA_DOCS_BASE : 'https://docs.worca.dev';

// Map helpId → { slug, title }.
// slug: path under docs-site/src/content/docs/ without extension or leading slash.
// title: shows in the tooltip (`Help: <title>`) and aria-label.
export const HELP_LINKS = Object.freeze({
  // Concepts
  'pipeline-stages':    { slug: 'concepts/the-pipeline-and-stages',          title: 'Pipeline & stages' },
  'governance':         { slug: 'concepts/governance',                        title: 'Governance' },
  'lifecycle':          { slug: 'concepts/lifecycle-and-state',               title: 'Run lifecycle & state' },
  'templates':          { slug: 'concepts/pipeline-templates',                title: 'Pipeline templates' },
  'plans-guides':       { slug: 'concepts/plans-work-requests-and-guides',    title: 'Plans, work requests & guides' },

  // Configuration
  'agents-models':      { slug: 'configuration/agents-and-models',            title: 'Agents & models' },
  'stages-config':      { slug: 'configuration/stages',                       title: 'Stage configuration' },
  'loops':              { slug: 'configuration/loops-and-circuit-breaker',    title: 'Loops & circuit breaker' },
  'secrets':            { slug: 'configuration/secrets',                      title: 'Secrets' },

  // Running pipelines
  'launching':          { slug: 'running-pipelines/launching-a-run',          title: 'Launching a run' },
  'monitoring':         { slug: 'running-pipelines/monitoring-a-run',         title: 'Monitoring a run' },
  'controlling':        { slug: 'running-pipelines/controlling-a-run',        title: 'Controlling a run' },
  'reviewing':          { slug: 'running-pipelines/reviewing-the-result',     title: 'Reviewing the result' },

  // Advanced
  'effort':             { slug: 'advanced/tuning-effort',                     title: 'Effort levels' },
  'dispatch':           { slug: 'advanced/dispatch-governance',               title: 'Dispatch governance' },
  'crg':                { slug: 'advanced/code-review-graph',                 title: 'Code Review Graph' },
  'graphify':           { slug: 'advanced/knowledge-graph',                   title: 'Knowledge graph (Graphify)' },
  'fleet-runs':         { slug: 'advanced/fleet-runs',                        title: 'Fleet runs' },
  'workspace-runs':     { slug: 'advanced/workspace-runs',                    title: 'Workspace runs' },
  'worktrees':          { slug: 'advanced/worktree-cleanup',                  title: 'Worktree cleanup' },

  // Integrations
  'webhooks':           { slug: 'integrations/webhooks',                      title: 'Webhooks' },
  'chat':               { slug: 'integrations/chat-integrations',             title: 'Chat integrations' },
  'events':             { slug: 'integrations/events-overview',               title: 'Events overview' },

  // Getting started
  'first-run':          { slug: 'getting-started/your-first-run',             title: 'Your first run' },
  'add-project':        { slug: 'getting-started/add-your-project',           title: 'Add your project' },
});

export function helpUrl(id) {
  const entry = HELP_LINKS[id];
  if (!entry) return null;
  return `${DOCS_BASE}/${entry.slug}/`;
}

// The standardized renderer. Every in-app `?` MUST go through this — never
// hand-written <a target="_blank"> in views. This is the single point of
// control for URL, icon glyph, color, dark/light theming, hover, and a11y.
export function helpLink(id) {
  const entry = HELP_LINKS[id];
  if (!entry) {
    // Soft fail: warn in dev console but never crash a view.
    if (typeof console !== 'undefined') console.warn(`helpLink: unknown id "${id}"`);
    return null;
  }
  const url = `${DOCS_BASE}/${entry.slug}/`;
  return html`
    <a class="help-link"
       href=${url}
       target="_blank"
       rel="noopener noreferrer"
       title="Help: ${entry.title}"
       aria-label="Open help: ${entry.title}">
      ${iconSvg(CircleHelp)}
    </a>
  `;
}
```

### 2. Icon and styling

- **Current state:** `worca-ui/app/utils/icons.js` already imports ~50 lucide icons; `CircleHelp` is NOT in the current import list. `worca-ui/app/styles.css` has the global stylesheet.
- **Obstacle:** the `?` icon must look "muted but discoverable" — visible enough to invite a click, quiet enough not to compete with primary actions. Hardcoding inline styles in `helpLink()` would defeat the centralization goal (no dark-mode handling, no hover state).
- **Resolution:**
  1. Add `import CircleHelp from 'lucide/dist/esm/icons/circle-help';` to `worca-ui/app/utils/icons.js`, and re-export.
  2. Add one `.help-link` rule block to `worca-ui/app/styles.css`. Single grep target; theming and hover live here only.

```css
/* worca-ui/app/styles.css */
.help-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-inline-start: 0.5rem;
  color: var(--sl-color-neutral-500);
  text-decoration: none;
  vertical-align: middle;
  transition: color 120ms ease;
  border-radius: 2px;
}

.help-link:hover,
.help-link:focus-visible {
  color: var(--sl-color-primary-600);
}

.help-link:focus-visible {
  outline: 2px solid var(--sl-color-primary-600);
  outline-offset: 2px;
}

.help-link svg {
  width: 16px;
  height: 16px;
}
```

Color choices route through Shoelace CSS variables so dark mode is handled automatically by the existing theme. No hardcoded hex values.

### 3. Slug discipline — page-level only, no anchors

- **Current state:** the docs site is Astro Starlight. Heading anchors (`#section-id`) are auto-generated from heading text by the markdown renderer.
- **Obstacle:** if `HELP_LINKS` stored `slug: 'concepts/governance#dispatch-rules'` and someone later renames the H2 from "Dispatch rules" to "Dispatch governance", the anchor silently breaks. Starlight's slugifier emits a new ID; the old one 404s. Nothing in CI catches it — the page still exists.
- **Resolution:** **only page-level slugs are allowed in `HELP_LINKS`.** Page slugs require an explicit file rename, which a reviewer notices. The L1 vitest enforces this by checking `existsSync(slug + '.md' | '.mdx')` — anchors would never resolve to a file and would always fail.

Edge case: if a single doc page genuinely covers two distinct UI concepts, that's a signal to split the page, not to add anchor links.

### 4. UX rule — visible but not overwhelming

The single discipline rule:

> **One `?` per primary teaching surface** — section header, panel header, settings tab title, launcher form header. Never on individual buttons, badges, or form fields.

Four corollaries:

| Rule | Reason |
|---|---|
| `?` lives at the header, never inline mid-text. | Eyes scan headers first; one consistent location to look. |
| Max 1 `?` per visible viewport-sized region. | If two appear close together, fold them into the parent header. |
| Skip if no doc exists. | A `?` linking to a 404 (or a thin page) destroys trust. Better absent than wrong. |
| Tooltips for terms; `?` for whole topics. | Status badges already have tooltips (`status-badge.js`) — that's the right tool for "what does 'halted' mean." `?` is for "tell me how this whole concept works." |

Visual treatment (matches existing `lucide` icon conventions):

- `CircleHelp`, 16px
- Muted color (`var(--sl-color-neutral-500)`; hover → primary)
- Placed at the end of the section/tab/panel label with `margin-inline-start: 0.5rem`
- Always `target="_blank" rel="noopener noreferrer"`
- `aria-label="Open help: <topic>"` + native `title` for tooltip
- No external-link glyph in addition to the `?` — the question-mark + new-tab opening is the affordance; extra glyphs add noise

### 5. Build-time `DOCS_BASE` override

- **Current state:** esbuild config lives at `worca-ui/scripts/build-frontend.js:120-130`. No `define` option is currently set.
- **Obstacle:** devs running a local Starlight preview (`npm run dev` in `docs-site/`) want `?` icons to point at `http://localhost:4321` instead of production. Hardcoding `https://docs.worca.dev` removes this option.
- **Resolution:** add a `define` option to the esbuild call, conditional on the `WORCA_DOCS_BASE` env var. Production builds (CI, `npm publish`) leave it unset → fall through to the production default in the module.

```js
// worca-ui/scripts/build-frontend.js
const docsBase = process.env.WORCA_DOCS_BASE;
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile,
  sourcemap: true,
  minify: true,
  legalComments: 'none',
  define: docsBase
    ? { WORCA_DOCS_BASE: JSON.stringify(docsBase) }
    : undefined,
});
```

Usage:

```bash
# Local Starlight preview
cd worca-ui && WORCA_DOCS_BASE=http://localhost:4321 npm run build

# Staging preview
cd worca-ui && WORCA_DOCS_BASE=http://staging.docs.worca.dev npm run build
```

Production / npm-published builds leave `WORCA_DOCS_BASE` unset → default `https://docs.worca.dev`.

### 6. Sync — two CI layers

#### L1 — source check (every PR)

A vitest in `worca-ui/app/utils/help-links.test.js` reads `HELP_LINKS`, resolves each slug against `docs-site/src/content/docs/<slug>.{md,mdx}`. No network. Runs alongside the existing vitest suite.

```js
// worca-ui/app/utils/help-links.test.js
import { describe, it, expect } from 'vitest';
import { HELP_LINKS } from './help-links.js';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(__dirname, '../../../docs-site/src/content/docs');

describe('help-links', () => {
  for (const [id, entry] of Object.entries(HELP_LINKS)) {
    it(`${id} → ${entry.slug} resolves to a docs page`, () => {
      const md  = resolve(DOCS_ROOT, `${entry.slug}.md`);
      const mdx = resolve(DOCS_ROOT, `${entry.slug}.mdx`);
      expect(existsSync(md) || existsSync(mdx)).toBe(true);
    });

    it(`${id} slug has no anchor fragment`, () => {
      expect(entry.slug).not.toContain('#');
    });

    it(`${id} has a non-empty title`, () => {
      expect(entry.title).toMatch(/\S/);
    });
  }
});
```

Failure modes the test catches:
- Typo'd slug
- Doc page deleted without removing the helpId
- Anchor accidentally added to a slug
- Empty title

Failure mode it deliberately does NOT catch: doc page exists but is thin or wrong. That's a docs-quality issue, not a sync issue.

#### L2 — live check (release time)

A new script — `scripts/check-help-links-live.py` — wired into the `worca-release-preflight` subagent at `.claude/agents/worca-release-preflight.md`. Runs only when cutting a release.

```python
# scripts/check-help-links-live.py
import json, re, sys, urllib.request

BASE = "https://docs.worca.dev"
HELP_LINKS_JS = "worca-ui/app/utils/help-links.js"

# Parse the `slug: '...'` literals out of the JS map (regex is fine — the
# file format is locked by the L1 test and a hand-curated map).
text = open(HELP_LINKS_JS).read()
slugs = re.findall(r"slug:\s*'([^']+)'", text)

failed = []
for slug in slugs:
    url = f"{BASE}/{slug}/"
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                failed.append((url, resp.status))
    except Exception as e:
        failed.append((url, str(e)))

if failed:
    print(f"FAIL: {len(failed)} help-link URL(s) not live on {BASE}:")
    for url, why in failed:
        print(f"  {url}  →  {why}")
    print()
    print("Fix: run /worca-docs-publish to fast-forward docs-live to master,")
    print("then re-run the release. The docs publish ordering is already the")
    print("recommended sequence; this check just enforces it.")
    sys.exit(1)

print(f"OK: {len(slugs)} help-link URL(s) are live on {BASE}")
```

Wire into `.claude/agents/worca-release-preflight.md` as an additional checklist item alongside the existing version-file parity, master/CI state, and MIGRATION.md coverage audits.

The release-skill `.claude/skills/worca-release/SKILL.md` already recommends running `/worca-docs-publish` before a release; L2 makes this enforceable instead of an honor-system reminder.

### 7. Placement — concrete map

Every row below is exactly one `?`. Total: ~22 icons across the UI. Rule from §4 holds throughout — placement is at the section/tab/panel header, never inline.

#### Settings (`worca-ui/app/views/settings.js`)

Project-scoped tabs (lines `:3497-3534`):

| Tab | panel name | helpId |
|---|---|---|
| Agents | `agents` | `agents-models` |
| Models | `models` | `agents-models` |
| Effort | `effort` | `effort` |
| Pipeline | `pipeline` | `stages-config` |
| Governance | `governance` | `governance` |
| Pricing | `pricing` | *(no doc — skip)* |
| Webhooks | `webhooks` | `webhooks` |
| Graphify | `graphify` | `graphify` |
| Code Review Graph | `code-review-graph` | `crg` |

Global-scope tabs (lines `:3444-3466`):

| Tab | panel name | helpId |
|---|---|---|
| Projects | `projects` | `add-project` |
| Notifications | `notifications` | *(no dedicated doc — skip for now)* |
| Preferences | `preferences` | `stages-config` |
| Integrations | `integrations` | `chat` |

#### Launchers — `?` at form header

| View | helpId |
|---|---|
| `worca-ui/app/views/new-run.js` header | `launching` |
| `worca-ui/app/views/fleet-launcher.js` header | `fleet-runs` |
| `worca-ui/app/views/workspace-create.js` header | `workspace-runs` |

#### Run Detail (`worca-ui/app/views/run-detail.js`)

| Panel / surface | citation | helpId |
|---|---|---|
| Run header (status/lifecycle) | top of view | `lifecycle` |
| Stage Timeline panel | `stage-timeline.js` import at `:37` | `pipeline-stages` |
| Plan iterations panel | iter tabs at `:1950` | `plans-guides` |
| Code Review Graph badge area | `:1148` | `crg` |
| Graphify badge area | `:1067` | `graphify` |
| PR details panel | grep `pr-details` | `reviewing` |
| Dispatch panel | `data-dispatch-section` at `:880` | `dispatch` |
| Circuit breaker banner | `:916, :925` | `loops` |
| Beads panel | `beads-panel.js` | *(no doc — skip)* |
| Token costs | `token-costs.js` | *(no doc — skip)* |

#### Dashboard, sidebar, integrations (sparing)

| Surface | helpId |
|---|---|
| `worca-ui/app/views/dashboard.js` — empty state ("no runs yet") | `first-run` |
| `worca-ui/app/views/sidebar.js` — Worktrees section label | `worktrees` |
| `worca-ui/app/views/sidebar.js` — Integrations entry | `events` |
| `worca-ui/app/views/integrations.js` header | `chat` |
| `worca-ui/app/views/webhook-inbox.js` header | `webhooks` |

## Implementation Plan

### Phase 1 — Infrastructure (module + renderer + CSS + L1 + L2)

**Files:**
- `worca-ui/app/utils/help-links.js` (new)
- `worca-ui/app/utils/help-links.test.js` (new)
- `worca-ui/app/utils/icons.js` (add `CircleHelp` import + export)
- `worca-ui/app/styles.css` (add `.help-link` block)
- `worca-ui/scripts/build-frontend.js` (add optional `define` for `WORCA_DOCS_BASE`)
- `scripts/check-help-links-live.py` (new)
- `.claude/agents/worca-release-preflight.md` (add L2 check to checklist)

**Tasks:**
1. Add `CircleHelp` import + re-export in `worca-ui/app/utils/icons.js`.
2. Write `help-links.js` with `HELP_LINKS`, `helpUrl`, `helpLink` exactly as in Design §1. Include all 25 entries.
3. Add `.help-link` CSS block to `worca-ui/app/styles.css`.
4. Write `help-links.test.js` (Design §6 L1).
5. Update `build-frontend.js:120-130` to honor `WORCA_DOCS_BASE` env var.
6. Write `scripts/check-help-links-live.py` (Design §6 L2).
7. Update `worca-release-preflight.md` to invoke the L2 script as a checklist item.
8. Verify: `cd worca-ui && npm run lint:fix && npx vitest run` (L1 passes against current docs).
9. Verify: `python scripts/check-help-links-live.py` against `docs.worca.dev` (L2 passes against currently-published docs — this is the baseline).

Done-criteria for Phase 1: module exists, L1 test passes, L2 script exists and passes against today's `docs.worca.dev`, no `?` icons appear in the UI yet (placement is Phase 2+).

### Phase 2 — Highest-payoff placement (Settings + Run Detail)

**Files:**
- `worca-ui/app/views/settings.js`
- `worca-ui/app/views/run-detail.js`

**Tasks:**
1. Import `helpLink` in `settings.js`.
2. For each `<sl-tab>` in lines `:3444-3466` (global) and `:3497-3534` (project-scoped), add `${helpLink('<id>')}` inside the tab label slot for the rows in Design §7.
3. Import `helpLink` in `run-detail.js`.
4. Add `${helpLink(...)}` at each panel header listed in Design §7.
5. Rebuild bundle: `cd worca-ui && npm run build`.
6. Run lint + vitest: `cd worca-ui && npm run lint:fix && npx vitest run`.
7. Manual visual check (light + dark mode): all `?` icons render muted, hover turns primary, click opens new tab.
8. Add/update Playwright spec — `worca-ui/e2e/help-links.spec.js` — that asserts the presence of a `.help-link` element with the correct `href` for at least one settings tab and one run-detail panel. Per CLAUDE.md: serial runner only (`npx playwright test --workers=1`).

Done-criteria for Phase 2: every row in Settings + Run Detail tables of Design §7 has its `?` icon. Manual UX review confirms no surface has more than one `?`.

### Phase 3 — Remaining surfaces (Launchers + Dashboard + Sidebar + Integrations)

**Files:**
- `worca-ui/app/views/new-run.js`
- `worca-ui/app/views/fleet-launcher.js`
- `worca-ui/app/views/workspace-create.js`
- `worca-ui/app/views/dashboard.js`
- `worca-ui/app/views/sidebar.js`
- `worca-ui/app/views/integrations.js`
- `worca-ui/app/views/webhook-inbox.js`

**Tasks:**
1. Import `helpLink` and add at the surfaces enumerated in Design §7 (launchers, dashboard, sidebar, integrations).
2. Rebuild bundle.
3. Run lint + vitest + playwright.
4. Manual visual sweep: walk through every view, confirm density target (~22 icons total, max 1 per viewport-sized region).
5. Dispatch `worca-ui-a11y-reviewer` and `worca-ui-design-reviewer` subagents on the diff.

Done-criteria for Phase 3: all 22 `?` icons in place. CI green. Subagent reviews report no high-confidence findings.

### Files Changed Summary

| File | Change |
|------|--------|
| `worca-ui/app/utils/help-links.js` | NEW — `HELP_LINKS`, `helpUrl`, `helpLink` |
| `worca-ui/app/utils/help-links.test.js` | NEW — L1 source-resolution test |
| `worca-ui/app/utils/icons.js` | Add `CircleHelp` import + export |
| `worca-ui/app/styles.css` | Add `.help-link` CSS block |
| `worca-ui/scripts/build-frontend.js` | Add `define: { WORCA_DOCS_BASE }` conditional |
| `worca-ui/app/views/settings.js` | Inject `helpLink()` at each tab in Design §7 |
| `worca-ui/app/views/run-detail.js` | Inject `helpLink()` at each panel header in Design §7 |
| `worca-ui/app/views/new-run.js` | Inject `helpLink()` at form header |
| `worca-ui/app/views/fleet-launcher.js` | Inject `helpLink()` at form header |
| `worca-ui/app/views/workspace-create.js` | Inject `helpLink()` at form header |
| `worca-ui/app/views/dashboard.js` | Inject `helpLink()` at empty-state |
| `worca-ui/app/views/sidebar.js` | Inject `helpLink()` at Worktrees + Integrations |
| `worca-ui/app/views/integrations.js` | Inject `helpLink()` at header |
| `worca-ui/app/views/webhook-inbox.js` | Inject `helpLink()` at header |
| `worca-ui/e2e/help-links.spec.js` | NEW — Playwright spec covering settings + run-detail rendering |
| `scripts/check-help-links-live.py` | NEW — L2 release-time HEAD checker |
| `.claude/agents/worca-release-preflight.md` | Add L2 to preflight checklist |

## Considerations

### Trade-offs

- **Page-level slugs only vs. anchor-level deep linking.** Anchor linking would land users on the exact paragraph but breaks silently on heading renames. Page-level is more resilient at the cost of one extra scroll for the user. Worth it.
- **Centralized renderer vs. raw URL helper.** The renderer adds a 5-line module and removes every chance of an inline anchor diverging. Net win.
- **22 icons vs. more density.** Could go to 40+ by adding one per form field. Doesn't scale visually. The "one per primary teaching surface" rule caps density without leaving important surfaces uncovered.

### Edge cases

- **Pricing tab and Beads/Token-costs panels have no doc today.** Deliberately skipped — adding a `?` to a 404 destroys trust. When those docs land, add the helpId in the same PR as the new doc.
- **`Notifications` and `Preferences` tabs.** No clean canonical doc. Mapped to closest fit; revisit when there's a dedicated doc page.
- **User on staging UI with `WORCA_DOCS_BASE=http://staging.docs.worca.dev`.** L1 still passes (it reads local source). L2 only runs at release time on production — staging deploys don't gate on it. Acceptable: staging is internal.

### Breaking changes

None. Pure additive: new module, new icons, no existing API touched.

### Migration

None.

### Governance

No impact on `worca.governance.dispatch`, hooks, or agent prompts. This is pure UI surface work.

### Sync gap acknowledgment

The fundamental coupling — UI ships in `@worca/ui` npm releases, but `docs.worca.dev` only updates when `/worca-docs-publish` runs (which fast-forwards the `docs-live` branch from `master`) — means there's always a possible window where master ahead of docs-live. L2 catches this at release time; it does not eliminate the gap during day-to-day development. That's acceptable because:

1. Day-to-day UI dev uses local `npm run build` against current master, where L1 already passes (the doc exists in master).
2. Released `@worca/ui` versions are gated by L2 at release-preflight.
3. Doc deletions are rare and any deletion PR will fail L1 unless it also removes the matching helpId from `HELP_LINKS`.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Vitest | `help-links.test.js: every helpId resolves to a docs page` | L1 — each `slug` resolves to `.md` or `.mdx` under `docs-site/src/content/docs/` |
| Vitest | `help-links.test.js: no slug contains an anchor` | Slug discipline (Design §3) |
| Vitest | `help-links.test.js: every entry has a non-empty title` | Tooltip + a11y label are never empty |
| Vitest | `help-links.test.js: helpUrl returns null for unknown id` | `helpUrl('does-not-exist') === null` |
| Vitest | `help-links.test.js: helpUrl returns canonical URL for known id` | `helpUrl('crg')` ends with `/advanced/code-review-graph/` |
| Vitest | `help-links.test.js: helpLink renders an anchor with target=_blank and rel=noopener` | Renderer contract |
| Vitest | `help-links.test.js: helpLink returns null for unknown id` | Soft-fail behavior (Design §1) |

### Integration / E2E Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Playwright | `help-links.spec.js: settings tab renders a help-link` | One `?` per tab label, correct `href` |
| Playwright | `help-links.spec.js: run-detail panel renders a help-link` | One `?` per panel header, correct `href` |
| Playwright | `help-links.spec.js: help-link opens in a new tab` | `target="_blank"` honored |
| Manual | Dark + light mode visual sweep | `.help-link` muted color readable in both themes; hover state visible |

### Release-time (L2)

| Layer | Test | Validates |
|-------|------|-----------|
| Shell | `python scripts/check-help-links-live.py` | Every `HELP_LINKS` slug returns 200 on `https://docs.worca.dev/<slug>/` |

### Existing Tests to Update

None — this is additive. Existing settings, run-detail, sidebar, integrations, dashboard tests already pass templates rendered with extra child elements (each view test asserts presence of specific selectors, not exhaustive child lists).

If any test asserts `await page.locator('sl-tab').count()` and counts a specific number, it should not change — `?` icons go inside the tab label slot, not as new tabs. Verify in Phase 2.

## Files to Create/Modify

| File | Status | Purpose |
|------|--------|---------|
| `worca-ui/app/utils/help-links.js` | new | `HELP_LINKS` map + `helpUrl()` + `helpLink()` renderer |
| `worca-ui/app/utils/help-links.test.js` | new | L1 source-resolution test (every slug → `.md`/`.mdx`) |
| `worca-ui/app/utils/icons.js` | modify | Add `CircleHelp` lucide import + re-export |
| `worca-ui/app/styles.css` | modify | Add `.help-link` CSS block (color, hover, focus, sizing) |
| `worca-ui/scripts/build-frontend.js` | modify | Conditional `define: { WORCA_DOCS_BASE }` esbuild option |
| `worca-ui/app/views/settings.js` | modify | Inject `helpLink()` at each tab in Design §7 (13 tabs, 11 with helpIds) |
| `worca-ui/app/views/run-detail.js` | modify | Inject `helpLink()` at each panel header in Design §7 (8 panels) |
| `worca-ui/app/views/new-run.js` | modify | Inject `helpLink('launching')` at form header |
| `worca-ui/app/views/fleet-launcher.js` | modify | Inject `helpLink('fleet-runs')` at form header |
| `worca-ui/app/views/workspace-create.js` | modify | Inject `helpLink('workspace-runs')` at form header |
| `worca-ui/app/views/dashboard.js` | modify | Inject `helpLink('first-run')` at empty-state |
| `worca-ui/app/views/sidebar.js` | modify | Inject `helpLink()` at Worktrees + Integrations entries |
| `worca-ui/app/views/integrations.js` | modify | Inject `helpLink('chat')` at header |
| `worca-ui/app/views/webhook-inbox.js` | modify | Inject `helpLink('webhooks')` at header |
| `worca-ui/e2e/help-links.spec.js` | new | Playwright spec — settings + run-detail rendering, `target="_blank"` honored |
| `scripts/check-help-links-live.py` | new | L2 release-time HEAD checker against `docs.worca.dev` |
| `.claude/agents/worca-release-preflight.md` | modify | Add L2 script invocation to preflight checklist |

## Out of Scope

- **Deep anchor links** to specific headings within a doc page. Page-level only (Design §3).
- **Per-field `?` icons.** Deliberately ruled out by the UX rule (Design §4).
- **Automatic generation of help-link IDs from the docs sidebar.** Manual curation IS the value — it forces a conscious "should this surface have a doc?" decision per placement.
- **Versioned docs / pinning a UI release to a specific docs commit.** Worca currently ships unversioned docs; if we adopt versioned docs in the future, `DOCS_BASE` extends naturally to `${DOCS_BASE}/v0.36/`.
- **Localization of help titles.** English-only, matches the rest of the UI.
- **In-app inline docs viewer** (iframe, panel, etc.). Out of scope — `target="_blank"` to docs.worca.dev is the deliberate UX.
- **Backfilling missing docs** for surfaces currently skipped (Pricing, Beads, Token costs, Notifications, Preferences). Tracked separately as docs-area issues; this plan ships the infra so they can be added in one-line PRs once their docs exist.
