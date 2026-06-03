# W-061: In-app help via right-edge "Docs" toggle + glowing `?` badge overlay

**Status:** Prototype on `prototype/W-061-help-mode-toggle`
**Priority:** P2
**Area:** ui
**Date:** 2026-05-30 (revised 2026-06-03 after prototype evaluation)
**Depends on:** None

> **Pattern revision note.** The original 2026-05-30 draft of this plan
> shipped an always-on inline `?` icon at every primary teaching surface
> (`helpLink(id)` rendering a muted 16px CircleHelp). After prototype
> evaluation we switched to an **opt-in toggle** pattern: badges are
> hidden by default and revealed together when the user activates "help
> mode" via a right-edge "Docs" tab or the `?` keyboard shortcut. The
> rest of this plan reflects the toggle pattern. The pre-W-062 settings
> tab inventory in the original draft is also corrected throughout.

## Problem

worca-ui has no in-app pointers to the comprehensive docs at
[docs.worca.dev](https://docs.worca.dev). Users land on a settings tab,
a run-detail panel, a launcher, a template editor (W-062), or the new
timeline view (W-063) with no affordance to "learn more about this."

The docs themselves are rich (49 pages across 9 sections under
`docs-site/src/content/docs/`), but discovery is poor. Users either
guess slugs, navigate from the docs site root, or never find them at
all. The one inline anchor that does exist today (`worca-ui/app/views/settings.js:96` →
`https://docs.worca.dev/configuration/precedence/`) is exactly the kind
of one-off hardcoded link this plan is meant to prevent from
proliferating.

User-facing impact: every onboarding question that the docs already
answer (what's an effort level? what does halted mean? how do I
configure a webhook?) becomes a support touch instead of a self-serve
click.

## Proposal

Three-part affordance:

1. **A persistent right-edge "Docs" tab** (`worca-ui/app/views/help-edge-tab.js`)
   anchored 100px from the viewport top, rotated `-90deg`, monospace
   label matching the sidebar WORCA wordmark, 75% opacity idle / 100%
   opaque on hover. Click toggles help mode. Same affordance bound to
   the `?` keyboard shortcut (Shift+/), with an input-focus guard so
   text fields stay typeable.
2. **A central registry** (`worca-ui/app/utils/help-links.js`) exporting
   `HELP_LINKS` (frozen helpId → `{slug, title}` map), `helpUrl(id)`,
   and `helpFor(id)` — the lit-html template that renders a
   `display: none` violet badge anchored to its host. The badge is
   revealed only when `body.help-mode-active` is set.
3. **A help-mode state machine** (`worca-ui/app/utils/help-mode.js`)
   owning `isActive()` / `setActive()` / `toggle()` / `subscribe()`
   and the body-class toggle. Single source of truth for both
   the edge tab and any future help-mode indicator.

**Discipline rule** (unchanged from original): one `?` per primary
teaching surface — section header, panel header, settings tab label,
launcher form, top-level view. Never on individual buttons, badges, or
form fields. Skip if no doc page exists (404 destroys trust).
Tooltips remain the tool for term-level explanation; `?` is for
whole-topic onboarding. The full UI sweep instruments **34 surfaces**
across 14 view files (see `worca-ui/docs/help-mode-prototype.md` for
the table).

**Visual language** — deliberately *not* blue: blue is already used for
primary actions + the `running` status, green for `completed`, orange
for caution per the badge color language, red for `failed`, yellow for
circuit-breaker warning. Help mode uses **violet (`#7c3aed`)** so it
reads as informational and never competes with status semantics. The
badge is a 27×27 violet disc at 75% opacity with a 21px white `?`
glyph (plain text, not an SVG, so there's no lucide
container-around-the-glyph artifact). A sonar wave (`::after`
pseudo-element) scales 1 → 1.5 with opacity 0.55 → 0 across 2.4s
infinite, giving the badge a slow signal-style pulse. `prefers-reduced-motion`
collapses the wave to a static dim halo.

**Sync — two CI layers** (unchanged from the original plan):

- **L1 — source check** (every PR): vitest in
  `worca-ui/app/utils/help-links.test.js` resolves each slug against
  the local `docs-site/src/content/docs/` tree. No network. Catches
  typos, missing pages, accidental anchors.
- **L2 — live check** (release time): `scripts/check-help-links-live.py`
  wired into the `worca-release-preflight` subagent HEAD-checks
  `https://docs.worca.dev/<slug>/` for every entry. Catches the
  "added a doc to master but `/worca-docs-publish` was never run"
  case — the same root cause behind the user's discovery of the live
  404 on `running-pipelines/timeline-view/` during this prototype.

**Slug discipline:** page-level only, no anchors. Starlight
auto-generates anchor IDs from heading text → renaming a heading
silently breaks deep links. Page slugs require an explicit file
rename, which a reviewer notices.

**`DOCS_BASE`:** defaults to `https://docs.worca.dev`; overridable at
esbuild build time via `WORCA_DOCS_BASE` env var
(`worca-ui/scripts/build-frontend.js`) for local Starlight preview
against `http://localhost:4321` or `http://staging.docs.worca.dev`.

## Considerations

- **Pattern trade-off — toggle vs always-on.** An always-on icon makes
  every help link self-evident at first glance but adds visual density
  to ~30 surfaces. A toggle adds zero baseline noise but costs one
  extra click + makes discoverability of the edge tab the new problem.
  The right-edge "Docs" label + `?` hotkey hint mitigates that. Both
  patterns respect the same "one per surface" discipline rule.
- **Trade-off — page-level vs anchor-level deep links:** anchors land
  users on the exact paragraph but break silently on heading renames.
  Page-level is more resilient at the cost of one extra scroll.
- **Trade-off — centralised module vs raw URL helper:** the module +
  renderer adds ~200 LOC and removes every chance of an inline anchor
  diverging. Net win for theming, a11y consistency, and CI-checked
  freshness.
- **Sync gap acknowledgment:** UI ships in `@worca/ui` npm releases,
  but `docs.worca.dev` only updates when `/worca-docs-publish` runs.
  L2 catches mismatches at release time; it does not eliminate the
  gap during day-to-day development. Acceptable because (1) day-to-day
  UI dev uses local `npm run build` against current master where L1
  passes, (2) released versions are gated by L2.
- **Surfaces skipped (no doc today):** Pricing tab, Notifications tab,
  Beads panel, Token costs panel, Learnings panel, Live output, Log
  viewer. Deliberately skipped — adding a `?` to a 404 destroys trust.
  When those docs land, the helpId is added in the same PR.
- **Browser support:** `body.help-mode-active *:has(> .help-badge)`
  uses CSS `:has()` (Chrome 105+, Safari 15.4+, Firefox 121+). Older
  browsers will see the badge fall back to anchoring against the
  next positioned ancestor (degraded but not broken).
- **No breaking changes.** Pure additive: new modules, new CSS, no
  existing API touched.

## Design

### 1. The central module — `worca-ui/app/utils/help-links.js`

Public API is exactly three exports — `HELP_LINKS`, `helpUrl(id)`,
`helpFor(id)`. All view-layer consumers import `helpFor`; the map and
`helpUrl` are exposed for tests and for the rare case where the URL
is needed without the icon (e.g., the inline "Learn more →" anchor in
`settings.js:96`'s `TEMPLATE_DRIVEN_BANNER` was migrated to
`helpUrl('configuration-precedence')`).

```js
// worca-ui/app/utils/help-links.js (excerpt)
import { html } from 'lit-html';

const DOCS_BASE =
  typeof WORCA_DOCS_BASE !== 'undefined'
    ? WORCA_DOCS_BASE
    : 'https://docs.worca.dev';

export const HELP_LINKS = Object.freeze({
  'pipeline-stages':    { slug: 'concepts/the-pipeline-and-stages',          title: 'Pipeline & stages' },
  governance:           { slug: 'concepts/governance',                        title: 'Governance' },
  // …~30 entries spanning concepts / configuration / running-pipelines /
  //    advanced / integrations / getting-started …
});

export function helpUrl(id) {
  const entry = HELP_LINKS[id];
  if (!entry) return null;
  return `${DOCS_BASE}/${entry.slug}/`;
}

export function helpFor(id) {
  const entry = HELP_LINKS[id];
  if (!entry) {
    if (typeof console !== 'undefined') console.warn(`helpFor: unknown id "${id}"`);
    return null;
  }
  const url = `${DOCS_BASE}/${entry.slug}/`;
  return html`<a class="help-badge" href=${url} target="_blank"
    rel="noopener noreferrer" title="Help: ${entry.title}"
    aria-label="Open help: ${entry.title}" data-help-id=${id}
  ><span class="help-badge__glyph" aria-hidden="true">?</span></a>`;
}
```

The glyph is a plain text `?` rather than a lucide SVG so we don't get
the container-around-the-glyph artifact baked into every lucide
help-icon variant (`circle-question-mark`, `badge-question-mark`,
`file-question-mark`, …).

### 2. The state machine — `worca-ui/app/utils/help-mode.js`

Owns:
- `body.help-mode-active` class (gates badge visibility).
- Subscribers via `subscribe(cb)` (the edge tab's `aria-pressed` state listens).
- Global `?` (Shift+/) keybinding with input-focus guard — does not
  fire inside `<input>`, `<textarea>`, `<select>`, `contentEditable`,
  or any `sl-*` host whose tag contains `input`/`textarea`.
- Global `Escape` keybinding to close help mode when it's on.

### 3. The edge tab — `worca-ui/app/views/help-edge-tab.js`

Vertical pill anchored 100px from the viewport top, right-edge flush.
30×105 px, monospace label "Docs" matching the sidebar `.logo-text`
style (JetBrains Mono, weight 700, letter-spacing 0.08em). The whole
inner row (`[?-icon] [Docs]`) is rotated `-90deg` so it reads
bottom-to-top along the right edge (book-spine convention). Mounted
once at app bootstrap into a `<div id="help-edge-tab-root">` appended
to `<body>`, outside the lit-html app render root, so route changes
don't unmount it.

### 4. The badge — `.help-badge` + `::after` sonar wave

Three stacked layers (see `worca-ui/docs/help-mode-prototype.md` §
"The badge has three stacked visual layers" for the detailed anatomy):

| Layer | Element | Role |
|---|---|---|
| 1 | `.help-badge` (an `<a>`) | The clickable 27×27 violet disc at 75% opacity, `position: absolute; top: 50%; right: 6px; transform: translateY(-50%)`. Vertically centred on the host's right edge so the sonar wave has equal headroom. |
| 2 | `.help-badge__glyph` (a `<span>?</span>`) | Plain-text 18px white `?` glyph, font-weight 700, optical-centre nudged with `margin-top: 1px`. |
| 3 | `.help-badge::after` | Same-violet pseudo-element behind the disc (`z-index: -1`), animated `help-badge-sonar` 2.4s ease-out infinite: scale 1 → 1.5, opacity 0.55 → 0. Static dim halo under `prefers-reduced-motion: reduce`. |

`body.help-mode-active *:has(> .help-badge) { position: relative }`
auto-promotes the badge's parent so absolute positioning anchors
locally. `body.help-mode-active sl-tab { overflow: visible }` lifts
Shoelace's default tab-strip clipping so the sonar wave isn't cut at
the edges.

### 5. Slug discipline — page-level only, no anchors

Same rationale as the original plan. The L1 vitest enforces this by
checking `existsSync(slug + '.md' | '.mdx')` — anchors would never
resolve to a file and would always fail.

### 6. UX rule — visible but not overwhelming

> One `?` per primary teaching surface — section header, panel
> header, settings tab title, launcher form header, top-level view.
> Never on individual buttons, badges, or form fields.

| Rule | Reason |
|---|---|
| `?` lives at the header, never inline mid-text. | Eyes scan headers first; one consistent location to look. |
| Max 1 `?` per visible viewport-sized region. | If two would appear close together, fold them into the parent header. |
| Skip if no doc exists. | A `?` linking to a 404 (or a thin page) destroys trust. |
| Tooltips for terms; `?` for whole topics. | Status badges already have tooltips — that's the right tool for "what does 'halted' mean." `?` is for "tell me how this whole concept works." |

### 7. Build-time `DOCS_BASE` override

```js
// worca-ui/scripts/build-frontend.js
const docsBase = process.env.WORCA_DOCS_BASE;
await esbuild.build({
  // …
  define: docsBase
    ? { WORCA_DOCS_BASE: JSON.stringify(docsBase) }
    : undefined,
});
```

Usage:

```bash
cd worca-ui && WORCA_DOCS_BASE=http://localhost:4321 npm run build
cd worca-ui && WORCA_DOCS_BASE=http://staging.docs.worca.dev npm run build
```

Production / npm-published builds leave `WORCA_DOCS_BASE` unset → default `https://docs.worca.dev`.

### 8. Sync — two CI layers

#### L1 — source check (every PR)

`worca-ui/app/utils/help-links.test.js` reads `HELP_LINKS`, asserts:

- Each `slug` resolves to `docs-site/src/content/docs/<slug>.{md,mdx}`.
- No slug contains `#` (slug discipline).
- Every `title` is a non-empty string.
- `helpUrl(unknown)` → `null`.
- `helpUrl(known)` → canonical URL ending in `/<slug>/`.
- `helpFor(unknown)` → `null` (soft fail).

#### L2 — live check (release time)

`scripts/check-help-links-live.py` parses `worca-ui/app/utils/help-links.js`
for slug literals (the file format is locked by the L1 test), HEAD-checks
`https://docs.worca.dev/<slug>/` for every entry, exits non-zero on any
non-200 with a summary including the fix hint:

> Fix: run `/worca-docs-publish` to fast-forward `docs-live` to master,
> then re-run the release.

Wired into `.claude/agents/worca-release-preflight.md` as an additional
checklist item alongside version-file parity, master/CI state, and
MIGRATION.md coverage audits.

### 9. Placement — concrete map

Full mapping table lives in `worca-ui/docs/help-mode-prototype.md` § "Instrumented surfaces — full UI sweep". 34 placements across 14 view files. Summary by region:

| Region | Surfaces | helpIds |
|---|---|---|
| Settings — global tabs | 3 of 4 (Notifications skipped) | `add-project`, `settings-overview`, `chat` |
| Settings — project tabs | 6 of 7 (Pricing skipped) | `agents-models`, `stages-config`, `governance`, `webhooks`, `graphify`, `crg` |
| Settings — inline anchor migration | 1 | `configuration-precedence` (via `helpUrl`, not `helpFor`) |
| Run Detail panels | 7 | `lifecycle`, `pipeline-stages`, `plans-guides`, `dispatch`, `loops`, `agent-prompt`, `reviewing` |
| Pipeline Templates (W-062) | 5 | `templates`, `authoring-templates`, plus reuse of `agents-models`, `stages-config`, `dispatch` for the editor's 3 tabs |
| Run Timeline (W-063) | 1 | `timeline-view` |
| Launchers | 3 | `launching`, `fleet-runs`/`workspace-runs` (mode-switched), `workspace-runs` |
| Dashboard / sidebar | 3 | `monitoring` (header), `first-run` (empty state), `worktrees` (sidebar item) |
| Integrations / webhooks | 2 | `chat`, `webhooks` |
| Detail + edit + listing | 5 | `fleet-runs`, `workspace-runs` ×3, `worktrees` |

## Implementation Plan

### Phase 1 — Infrastructure

**Files:**
- `worca-ui/app/utils/help-links.js` (new)
- `worca-ui/app/utils/help-links.test.js` (new — L1)
- `worca-ui/app/utils/help-mode.js` (new)
- `worca-ui/app/views/help-edge-tab.js` (new)
- `worca-ui/app/utils/icons.js` (re-export `CircleHelp` for edge tab)
- `worca-ui/app/styles.css` (`.help-edge-tab`, `.help-badge`, sonar `@keyframes`, dark-mode + reduced-motion blocks)
- `worca-ui/app/main.js` (mount edge tab at bootstrap, bind keyboard)
- `worca-ui/scripts/build-frontend.js` (conditional `WORCA_DOCS_BASE` define)
- `scripts/check-help-links-live.py` (new — L2)
- `.claude/agents/worca-release-preflight.md` (wire L2 into checklist)

**Done-criteria:** module + state machine + edge tab exist, L1 passes against current docs, L2 passes against currently-published docs (baseline), no `?` icons appear in the UI yet.

### Phase 2 — Highest-payoff placement (Settings + Run Detail)

**Files:** `worca-ui/app/views/settings.js`, `worca-ui/app/views/run-detail.js`

**Done-criteria:** every row in the Settings + Run Detail rows of Design §9 has its `?` badge. Inline `settings.js:96` anchor migrated through `helpUrl('configuration-precedence')`. Manual UX review confirms no surface has more than one badge after help mode activates.

### Phase 3 — Remaining surfaces

**Files:**
- `worca-ui/app/views/pipelines.js`
- `worca-ui/app/views/pipelines-editor.js`
- `worca-ui/app/views/run-timeline.js`
- `worca-ui/app/views/new-run.js`
- `worca-ui/app/views/fleet-launcher.js`
- `worca-ui/app/views/workspace-create.js`
- `worca-ui/app/views/dashboard.js`
- `worca-ui/app/views/sidebar.js`
- `worca-ui/app/views/integrations.js`
- `worca-ui/app/views/webhook-inbox.js`
- `worca-ui/app/views/fleet-detail.js`
- `worca-ui/app/views/workspace-detail.js`
- `worca-ui/app/views/workspace-edit.js`
- `worca-ui/app/views/workspaces-config.js`
- `worca-ui/app/views/worktrees.js`
- `worca-ui/e2e/help-mode.spec.js` (new — Playwright)

**Done-criteria:** 34 badges in place. CI green. `worca-ui-a11y-reviewer` and `worca-ui-design-reviewer` subagent reviews report no high-confidence findings.

### Files Changed Summary

| File | Change |
|------|--------|
| `worca-ui/app/utils/help-links.js` | NEW — `HELP_LINKS`, `helpUrl`, `helpFor` |
| `worca-ui/app/utils/help-links.test.js` | NEW — L1 source-resolution test |
| `worca-ui/app/utils/help-mode.js` | NEW — state machine, keybindings |
| `worca-ui/app/views/help-edge-tab.js` | NEW — right-edge "Docs" tab component |
| `worca-ui/app/utils/icons.js` | Add `CircleHelp` lucide import + re-export (used by edge tab) |
| `worca-ui/app/styles.css` | Add `.help-edge-tab` + `.help-badge` blocks + sonar `@keyframes` + reduced-motion + dark-mode |
| `worca-ui/app/main.js` | Mount edge tab at bootstrap; bind global `?` / Escape |
| `worca-ui/scripts/build-frontend.js` | Conditional `define: { WORCA_DOCS_BASE }` esbuild option |
| `worca-ui/app/views/settings.js` | Inject `helpFor()` at each tab (11 tabs, 9 with helpIds); migrate inline anchor at `:96` through `helpUrl('configuration-precedence')` |
| `worca-ui/app/views/run-detail.js` | Inject `helpFor()` at each panel header (7 panels) |
| `worca-ui/app/views/pipelines.js` | Inject `helpFor('templates')` at list page |
| `worca-ui/app/views/pipelines-editor.js` | Inject `helpFor('authoring-templates')` at subheader + per-tab `helpFor` on the 3 editor tabs |
| `worca-ui/app/views/run-timeline.js` | Inject `helpFor('timeline-view')` |
| `worca-ui/app/views/new-run.js` | Inject `helpFor('launching')` at form header |
| `worca-ui/app/views/fleet-launcher.js` | Inject `helpFor('fleet-runs')` / `helpFor('workspace-runs')` (mode-switched) |
| `worca-ui/app/views/workspace-create.js` | Inject `helpFor('workspace-runs')` |
| `worca-ui/app/views/dashboard.js` | `helpFor('monitoring')` at top + `helpFor('first-run')` at empty state |
| `worca-ui/app/views/sidebar.js` | `helpFor('worktrees')` at Worktrees item; `helpFor('events')` at Integrations item |
| `worca-ui/app/views/integrations.js` | `helpFor('chat')` at settings panel |
| `worca-ui/app/views/webhook-inbox.js` | `helpFor('webhooks')` at view header |
| `worca-ui/app/views/fleet-detail.js` | `helpFor('fleet-runs')` |
| `worca-ui/app/views/workspace-detail.js` | `helpFor('workspace-runs')` |
| `worca-ui/app/views/workspace-edit.js` | `helpFor('workspace-runs')` |
| `worca-ui/app/views/workspaces-config.js` | `helpFor('workspace-runs')` |
| `worca-ui/app/views/worktrees.js` | `helpFor('worktrees')` |
| `worca-ui/e2e/help-mode.spec.js` | NEW — Playwright spec covering toggle → reveal → click |
| `scripts/check-help-links-live.py` | NEW — L2 release-time HEAD checker |
| `.claude/agents/worca-release-preflight.md` | Add L2 to preflight checklist |

## Test Plan

### Unit Tests (vitest)

| Test | Validates |
|---|---|
| `help-links.test.js: every helpId resolves to a docs page` | L1 — each `slug` resolves to `.md` or `.mdx` under `docs-site/src/content/docs/` |
| `help-links.test.js: no slug contains an anchor` | Slug discipline (Design §5) |
| `help-links.test.js: every entry has a non-empty title` | Tooltip + a11y label are never empty |
| `help-links.test.js: helpUrl returns null for unknown id` | `helpUrl('does-not-exist') === null` |
| `help-links.test.js: helpUrl returns canonical URL for known id` | `helpUrl('crg')` ends with `/advanced/code-review-graph/` |
| `help-links.test.js: helpFor returns null for unknown id` | Soft-fail behaviour (Design §1) |

### E2E (Playwright, `--workers=1`)

| Test | Validates |
|---|---|
| `help-mode.spec.js: edge tab is visible at startup` | The "Docs" tab renders into `<div id="help-edge-tab-root">` on bootstrap |
| `help-mode.spec.js: clicking the edge tab reveals badges` | `body.help-mode-active` flips; an instrumented settings tab carries a `.help-badge` with the right `href` |
| `help-mode.spec.js: `?` hotkey toggles help mode outside text inputs` | Global keybind respects the input-focus guard |
| `help-mode.spec.js: Escape closes help mode` | `body.help-mode-active` removed on Escape |
| `help-mode.spec.js: badge opens docs in a new tab` | `target="_blank" rel="noopener noreferrer"` honoured |

### Release-time (L2)

| Layer | Test | Validates |
|---|---|---|
| Shell | `python scripts/check-help-links-live.py` | Every `HELP_LINKS` slug returns 200 on `https://docs.worca.dev/<slug>/` |

### Existing Tests to Update

None — this is additive. Existing view tests assert presence of specific
selectors, not exhaustive child lists, so the extra `.help-badge` child
elements don't break them. The `workspace-css.test.js` CSS-variable
allowlist was extended once (in the prototype commits) to allow the
Shoelace `--sl-color-neutral-*` / `--sl-color-primary-*` shades the
prototype uses; that change is part of the rollout.

## Out of Scope

- **Deep anchor links** to specific headings within a doc page. Page-level only (Design §5).
- **Per-field `?` icons.** Deliberately ruled out by the UX rule (Design §6).
- **Automatic generation of help-link IDs from the docs sidebar.** Manual curation IS the value.
- **Versioned docs / pinning a UI release to a specific docs commit.** `DOCS_BASE` extends naturally to `${DOCS_BASE}/v0.40/` if we adopt versioned docs later.
- **Localisation of help titles.** English-only, matches the rest of the UI.
- **In-app inline docs viewer** (iframe, panel, etc.). `target="_blank"` to docs.worca.dev is the deliberate UX.
- **Backfilling missing docs** for currently-skipped surfaces (Pricing, Notifications, Beads, Token costs, Learnings, Live output, Log viewer). Tracked separately as docs-area issues; this plan ships the infra so they can be added in one-line PRs once their docs exist.
