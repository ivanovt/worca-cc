---
name: worca-docs-help
description: Wire a worca-ui surface to its docs.worca.dev page via the W-061 help-mode toggle — natural-language invocation ("add a docs link for the Pricing tab"). The skill locates the surface in worca-ui/app/views/, searches docs-site/src/content/docs/ for a matching page, picks or extends the HELP_LINKS registry entry, drops a `${helpFor('<id>')}` at the right anchor, updates the mapping table in worca-ui/docs/help-mode-prototype.md, and runs the L1 vitest to verify. If no matching doc page exists, proposes scaffolding a stub or escalating to a docs-authoring skill rather than wiring a 404 link. Triggers on "docs help", "add docs link", "wire help badge", "help-link this surface", "/worca-docs-help".
---

# Wire a worca-ui surface to its docs.worca.dev page

This is the partner skill to the W-061 in-app help system (right-edge Docs tab + sonar `?` badge overlay). The toggle plumbing is already in place — every primary teaching surface that calls `helpFor('<id>')` gets a badge revealed when the user activates help mode. This skill adds one new placement (and, if needed, one new registry entry) per invocation.

## Invocation

Natural language. Examples that should all work:

- `/worca-docs-help add a docs link for the Pricing tab`
- `/worca-docs-help wire help for the Beads panel`
- `/worca-docs-help the Webhook Inbox needs a Docs badge`
- `add a help badge to the Token Costs section pointing at the costs reference page`

If invoked with no description, ask: *"Which UI surface do you want to wire to docs? Describe it the way a user would (e.g. 'the Pricing tab', 'the Run Timeline view', 'the dispatch panel in run detail')."*

## Step 1: Locate the UI surface

Parse the user's description for a surface noun phrase (a tab label, a panel header, a section title, a view name). Then locate it in `worca-ui/app/views/`:

```bash
# Direct text match across all view files. Restrict to source (exclude tests).
grep -rn '<label-or-title-text>' worca-ui/app/views/ --include='*.js' \
  | grep -v '\.test\.js$' | head -20
```

For tab labels, also try the `panel=` slot attribute as a fallback:

```bash
grep -rn 'panel="<kebab-case-form>"' worca-ui/app/views/ --include='*.js' | head -5
```

For panel headers in run-detail or similar, the typical anchor classes are: `.panel-header`, `.section-title`, `.<feature>-header`, slot=summary inside `sl-details`, sl-tab labels, plain `<h2>`/`<h3>`.

**Pick the file + line that's the most plausible anchor.** Multiple plausible candidates → present them to the user as a numbered list and ask which to wire.

**No candidates** → the description didn't map. Ask the user to refine (e.g. "I couldn't find a 'Pricing' element in the views. Is it called something else in the code?").

## Step 2: Check whether the surface is already wired

```bash
# Look ~10 lines around the anchor for an existing helpFor() call.
sed -n '<line-5>,<line+10>p' worca-ui/app/views/<file>
```

If there's already a `${helpFor('<id>')}` near the anchor, **stop and surface it**:

> The <surface> at `<file>:<line>` is already wired to `helpFor('<id>')` → docs page `<slug>`. Not re-instrumenting. (Run `/worca-docs-help` against a different surface if this was a typo.)

## Step 3: Find the matching docs page

Search `docs-site/src/content/docs/` for candidate pages. Strategy (run in this order, stop at first reasonable hit):

1. **Filename match** (case-insensitive, the term as a slug fragment):
   ```bash
   find docs-site/src/content/docs -type f \( -name '*.md' -o -name '*.mdx' \) \
     | grep -i '<keyword>'
   ```

2. **Frontmatter title match**:
   ```bash
   grep -ril '^title:.*<keyword>' docs-site/src/content/docs/
   ```

3. **Heading match anywhere in the doc tree**:
   ```bash
   grep -rli '^#.*<keyword>' docs-site/src/content/docs/
   ```

4. **Content keyword match** (broadest, last resort):
   ```bash
   grep -rli '<keyword>' docs-site/src/content/docs/
   ```

Rank candidates by:
- Filename match > frontmatter > heading > body
- Shorter slugs preferred (more authoritative pages tend to be top-level under each section)
- Pages already referenced by an existing `HELP_LINKS` entry rank highest (registry already curated)

**Validate every candidate** with the L1 rule:

- File must end in `.md` or `.mdx`.
- Slug = path under `docs-site/src/content/docs/` without the extension.
- Slug must not contain `#` (anchors are forbidden — they silently break on heading renames).

## Step 4: Decide based on what was found

### 4a — Doc found, registry already has matching entry

Most common case for established pages.

```bash
# Inspect the registry to find an existing helpId for this slug.
grep -n "slug: '<slug>'" worca-ui/app/utils/help-links.js
```

If a helpId already points at the slug, **reuse it**. Skip Step 5.

### 4b — Doc found, no registry entry for this slug

Add a new entry to `worca-ui/app/utils/help-links.js`. Pick an `<id>`:

- Short, kebab-case.
- Doesn't collide with an existing key.
- Mirrors the slug's leaf when possible (e.g. `configuration/pricing` → `pricing`; `advanced/tuning-effort` → `effort`).

Insert the new `{ slug, title }` pair into the **section block matching the slug's top-level directory**:

| Top-level dir | Comment header in help-links.js |
|---|---|
| `concepts/` | `// Concepts` |
| `configuration/` | `// Configuration` |
| `running-pipelines/` | `// Running pipelines` |
| `advanced/` | `// Advanced` |
| `integrations/` | `// Integrations` |
| `getting-started/` | `// Getting started` |
| `introduction/` / `reference/` / `upgrading/` | append a new section comment if none yet, otherwise group under a new `// Other` block |

The `title` value is the human-readable label used in the badge's `title=` and `aria-label=` attributes — pull it from the doc's frontmatter `title:` field (`grep '^title:' <doc-file>`). Strip leading/trailing whitespace.

### 4c — No matching doc page found

**Do not** add a `helpFor()` pointing at a non-existent slug — that would fail L1 vitest immediately and would render a badge linking to a 404 in any environment where `WORCA_DOCS_BASE` is bypassed.

Surface the gap to the user with these options:

> No matching doc page found for *<surface>*. I can:
>
> 1. **Skip** — don't add a badge here yet. (Recommended if the feature is genuinely too thin to deserve a doc page; the W-061 discipline rule explicitly says skip-if-no-doc.)
> 2. **Scaffold a stub doc page** at `docs-site/src/content/docs/<proposed-slug>.md` with a one-line title + a TODO body. The L1 vitest will then accept the new registry entry. *Caveat:* a thin page is barely better than a 404 for trust. Use this only if you're committing to fleshing it out before the next release.
> 3. **Repoint at an adjacent page** that has some overlap (e.g. `configuration/settings-overview` as a fallback for Preferences). I'll show the top 3 candidates from Step 3.

Wait for the user to pick. Don't auto-scaffold.

> Future: if a dedicated `/worca-docs-create` skill lands (none today as of 2026-06), this skill should delegate option 2 to it for proper frontmatter, sidebar entry, and link to `docs-site/astro.config.mjs`.

## Step 5: Apply the registry edit (only for Step 4b)

Read `worca-ui/app/utils/help-links.js`, locate the matching section block, and insert the new entry **alphabetically by key** within that block (preserves grep-ability). Match the formatting of neighbouring entries — biome will reformat on `npm run lint:fix` if you get whitespace wrong.

Show the diff before applying. Confirm.

## Step 6: Apply the view edit

Read the target view file. Ensure the `helpFor` import is present in the import block:

```js
import { helpFor } from '../utils/help-links.js';
```

If absent, insert it alphabetically into the existing `../utils/` import group.

Insert `${helpFor('<id>')}` at the chosen anchor. Match the surrounding indentation. Conventional placements:

- **Inside an `<sl-tab slot="nav">` label**: append after the existing label text, before the closing `</sl-tab>`.
- **Inside an `slot="summary"` div on sl-details**: append before the closing `</div>`.
- **Inside a panel wrapper `<div class="...">`**: place as the first child (before other content) when the host has its own header content, or as a sibling next to the heading element when the host is a heading-and-body pattern.
- **Inside an empty-state `<div class="empty-state">`**: append directly after the empty-state text, no wrapper.

Show the diff before applying. Confirm.

## Step 7: Update the mapping table

Read `worca-ui/docs/help-mode-prototype.md`. Find the section "Instrumented surfaces — full UI sweep" and the sub-region that matches the surface (Settings, Run Detail, Pipeline Templates, Launchers, etc.). Insert a new row into the relevant markdown table:

```markdown
| <Surface description> | `<id>` | <slug> |
```

If no sub-region fits cleanly (rare — new view category), add a new sub-region heading + table with one row.

Show the diff. Confirm. Apply.

## Step 8: Verify

Run the L1 vitest (fast, no network):

```bash
cd worca-ui && npx vitest run app/utils/help-links.test.js
```

Should pass — the new entry must resolve to a real `.md`/`.mdx` file. If it fails, the edit is wrong; back out and re-investigate.

Optionally probe just the new slug live:

```bash
python3 scripts/check-help-links-live.py 2>&1 | grep '<new-slug>'
```

If the new slug 404s on `docs.worca.dev`, warn the user — the local doc exists but `docs-live` hasn't been fast-forwarded. Fix is `/worca-docs-publish`. Not blocking for the PR; just a heads-up so they don't ship a release with a freshly-broken badge.

## Step 9: Tell the user what to do next

```
Wired <surface> to docs.worca.dev/<slug>/ via helpFor('<id>').
Changed files:
  - worca-ui/app/utils/help-links.js   (+1 registry entry)   [if 4b]
  - worca-ui/app/views/<file>          (+1 helpFor placement)
  - worca-ui/docs/help-mode-prototype.md (+1 mapping row)

L1 vitest: passed.
L2 live check: ok | WARNING: <slug> is 404 on docs.worca.dev — run /worca-docs-publish before the next release.

Rebuild + restart the UI to see it live:
  pnpm worca:ui:restart
```

## Guardrails

The skill **refuses** to:

- Add a `helpFor()` at an anchor that already has one within ~5 lines (one badge per primary teaching surface — the W-061 discipline rule).
- Add a registry entry whose slug doesn't resolve to a local `.md`/`.mdx` file (L1 contract).
- Add a registry entry whose slug contains `#` (anchors silently break on heading renames; only page-level slugs are allowed).
- Add a duplicate registry entry for a slug that's already represented under a different id (suggest reusing the existing id instead).
- Touch the legacy inline `<a href="https://docs.worca.dev/configuration/precedence/">Learn more →</a>` at `settings.js:96`, which has already been migrated through `helpUrl('configuration-precedence')` — point users at `helpUrl(id)` for any new inline-prose anchor case.

The skill **warns** (but does not block) on:

- Slugs that 404 on `docs.worca.dev` (likely `/worca-docs-publish` lag).
- Targeting a surface on the docs-skipped list (Pricing, Notifications, Beads panel, Token costs, Learnings panel, Live output, Log viewer). Surface the discipline rule and confirm — the user may be intentionally instrumenting because a doc finally landed.

## What this skill does NOT do

- Author docs prose. If a doc page is missing and the user picks Step 4c option 2, this skill writes a one-line stub and delegates the actual content authoring back to the user (or to a future `/worca-docs-create` skill).
- Rebuild the UI bundle. The view edit doesn't take effect until `pnpm worca:ui:restart` runs — the skill reminds, doesn't run.
- Publish docs. `/worca-docs-publish` is the explicit affordance for that.
- Push or open PRs. Standard git workflow applies after the skill exits.
