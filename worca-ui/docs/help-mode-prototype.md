# Help-mode prototype (W-061 alternative)

**Branch:** `prototype/W-061-help-mode-toggle`
**Status:** Prototype — for design evaluation, not for merge.
**Replaces:** the always-on inline `?` icon approach in `docs/plans/W-061-in-app-help-links.md`.

## What it does

A persistent **right-edge "Help" tab** (rotated label + `?` kbd hint) and the
**`?` keyboard shortcut** both toggle "help mode." When help mode is on, every
UI surface that registered a `helpFor(id)` call reveals a glowing primary-coloured
badge anchored to its top-right corner. Click the badge → opens the relevant
`docs.worca.dev` page in a new tab. `Escape` closes help mode.

When help mode is off, the UI is unchanged — zero baseline visual noise.

## Why prototype this instead of the inline-icon plan

The original W-061 plan placed ~22 always-on `?` icons across the UI (now
closer to ~30 after W-062 + W-063). That's defensible but visually heavy in
dense ops panels (dispatch governance, run-detail). This prototype tests
whether an opt-in reveal pattern works better.

Trade-off awareness (see also `.worca/analyses/issue-259.md`):
- **Win**: zero baseline noise; single discoverable affordance.
- **Loss**: two-click cost per lookup (toggle, then click); right-edge tabs
  carry "chat widget" association in users' muscle memory.
- **Novel**: this pattern is uncommon for ongoing docs discovery (it's the
  norm for one-shot product tours via Pendo/Appcues, less so for reference).

## Architecture

| File | Role |
|---|---|
| `app/utils/help-links.js` | Frozen `HELP_LINKS` registry (helpId → `{slug, title}`), `helpUrl(id)`, `helpFor(id)` lit-html template. |
| `app/utils/help-mode.js` | `isActive()` / `setActive()` / `toggle()` / `subscribe()`. Owns `body.help-mode-active`. Binds `?` and `Escape` globally with an input-focus guard. |
| `app/views/help-edge-tab.js` | The right-edge tab. Re-renders only when help-mode state flips (subscribed via `help-mode.subscribe`). Lives in its own fixed-position root outside the lit-html app, so route changes don't unmount it. |
| `app/styles.css` (appended block) | `.help-edge-tab` (rotated label, hover, active state), `.help-badge` (hidden until `body.help-mode-active`, absolute top-right of parent, glow pulse, `prefers-reduced-motion` fallback to static highlight), dark-mode tokens. |
| `app/main.js` | Bootstrap: mount the edge tab into `<div id="help-edge-tab-root">` appended to `<body>`, bind keyboard. |

## Instrumented surfaces (this prototype)

**Settings — 8 of 11 tabs** (3 skipped because no doc page exists yet):

| Tab | helpId |
|---|---|
| Global: Projects | `add-project` |
| Global: Notifications | *(skip — no doc)* |
| Global: Preferences | `settings-overview` |
| Global: Integrations | `chat` |
| Project: Models | `agents-models` |
| Project: Pipeline | `stages-config` |
| Project: Governance | `governance` |
| Project: Pricing | *(skip — no doc)* |
| Project: Webhooks | `webhooks` |
| Project: Graphify | `graphify` |
| Project: Code Review Graph | `crg` |

**Run Detail — 7 panels**:

| Surface | helpId |
|---|---|
| `.run-detail-overview` (lifecycle/run header) | `lifecycle` |
| `.stage-timeline` wrapper | `pipeline-stages` |
| `.plan-iter-selector` (plan revisions) | `plans-guides` |
| `.dispatch-events-section` | `dispatch` |
| `.circuit-breaker-banner` (sl-alert) | `loops` |
| `.agent-prompt-header` (sl-details summary) | `agent-prompt` |
| `.approval-panel` (sl-card PR approval) | `reviewing` |

**Other:** the inline `<a href="https://docs.worca.dev/configuration/precedence/">Learn more →</a>` at `settings.js:96` was migrated to use `helpUrl('configuration-precedence')` — keeping the inline-prose treatment but routing through the registry.

Out of scope for this prototype (intentionally — covered after pattern validation): launchers (new-run, fleet, workspace), dashboard, sidebar, Pipeline Templates list page, Run Timeline view header.

## How to evaluate

1. `cd worca-ui && pnpm worca:ui:restart` (or `npm run build && pnpm worca:ui:restart`).
2. Look for the vertical **"Help (?)"** tab on the right edge of the viewport. It should be muted-neutral idle, primary when active.
3. Press `?` (Shift+/ on US keyboards) or click the edge tab.
4. Navigate to Settings → Pipeline Templates and watch every instrumented tab reveal a glowing badge in its top-right corner.
5. Open a run → Run Detail. Every panel header listed above should sprout a badge.
6. Click any badge → opens `docs.worca.dev/<slug>/` in a new tab.
7. Press `Escape` or click the edge tab again to close.
8. Test reduced-motion: enable "Reduce motion" in macOS System Settings → Accessibility → Display. Reload. Help mode should still reveal badges but with no pulse animation.

## Known limitations / things to evaluate

- **`:has()` selector dependency.** The CSS uses `body.help-mode-active *:has(> .help-badge)` to auto-`position: relative` any direct parent of a badge. Supported in Chrome 105+, Safari 15.4+, Firefox 121+. Older browsers will see the badge mis-position to the nearest positioned ancestor (degraded but not broken).
- **sl-tab badge placement.** Inside sl-tab label slots, the badge is nudged outward (`top: -6px; right: -6px`) so it sits at the tab's corner rather than overlapping the label text. Visually evaluate this on Settings tabs — it may need further tuning per Shoelace version.
- **No tests.** This is a prototype; if the pattern survives evaluation, write `help-links.test.js` (L1 source-resolution), `help-mode.test.js` (state machine + keyboard), and `e2e/help-mode.spec.js` (toggle → reveal → click).
- **No L2 release check.** The `scripts/check-help-links-live.py` from the original plan is unimplemented in this prototype.
- **No build-time `WORCA_DOCS_BASE` override.** The original plan's esbuild `define` is also unimplemented; the registry defaults to production docs.
- **Not all surfaces instrumented.** Launchers, dashboard, sidebar, Pipeline Templates page, and Run Timeline header are deliberately uncovered so they don't dilute the evaluation. The pattern works regardless; fan-out is mechanical.

## Decision points for "should we merge this approach"

After clicking through, the question to answer is:

> Is the **opt-in reveal** discoverable enough for new users, given that the edge tab is the only persistent affordance? Or do users actually want the always-on inline `?` from the original plan, density cost included?

If opt-in survives, the follow-ups are: (1) instrument remaining surfaces, (2) write the test suite, (3) implement L1 + L2 sync checks, (4) reconcile with the W-061 plan file.

If opt-in does not survive, fall back to the inline-icon plan but apply the **coarser placement discipline** (Option A from the analysis): one `?` per route/section rather than per panel, dropping the inventory from ~30 to ~12.
