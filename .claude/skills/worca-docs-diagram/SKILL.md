---
name: worca-docs-diagram
description: Author a diagram on the worca docs site (docs.worca.dev) in the canonical animated-SVG style — nodes + directional edges + hover tooltips, blue forward / amber return, light+dark, reduced-motion. Wraps the shared `docs-site/src/components/FlowDiagram.astro` so every diagram (pipeline, state graph, DAG) stays visually consistent. Triggers on "add a diagram", "stage graph", "state diagram", "flow diagram", "worca-docs-diagram", or any request to add/edit a diagram on the docs site.
---

# Author a docs-site diagram in the canonical style

All diagrams on the docs site share ONE renderer: `docs-site/src/components/FlowDiagram.astro`. It owns the visual language (colours, node rects, animated edges, tooltips, theming, accessibility). You author a new diagram by supplying **data** to it — never by re-styling. `PipelineDiagram.astro` is the reference example.

This guarantees consistency by construction: the style lives in one place.

## Step 0: No-args mode

If invoked with no specifics, print this usage and stop:

```
/worca-docs-diagram --name:<Name> --page:<docs-path>

Example:
  /worca-docs-diagram --name:RunState --page:concepts/lifecycle-and-state
Describe the nodes and edges (or point at a source of truth) and I'll build it.
```

## Step 1: Read the contract and the reference

1. Read `docs-site/src/components/FlowDiagram.astro` — the prop contract:
   - `nodes`: `{ id, label, sublabel?, tip?, cx, cy, w?, h?, optional? }[]`
     - `cx`/`cy` = node **centre**; default size 190×40.
     - `sublabel` renders to the right of the rect (the pipeline's "purpose").
     - `tip` is the hover/focus tooltip body. `optional: true` = dashed grey node.
   - `edges`: `{ from?, to?, path?, kind?, label?, labelX?, labelY? }[]`
     - With `from`/`to` (node ids) and **no** `path`: a straight line is auto-drawn from `from`'s bottom-centre to `to`'s top-centre (use for a top-down flow).
     - With `path`: an explicit SVG path is rendered as-is — use this for **return/transition edges** and anything not a straight vertical drop. Right-angled connectors only (e.g. `M165,188 H128 V112 H165`); no arcs.
     - `kind: 'return'` = amber (loopbacks, back-transitions); omit/`'forward'` = blue.
     - `label` + `labelX`/`labelY` place a short horizontal edge label.
   - `width`/`height` = SVG viewBox; `ariaLabel` = full text description of the whole graph.
2. Read `docs-site/src/components/PipelineDiagram.astro` as the worked example.

## Step 2: Gather the graph spec

From the user (or a source of truth — e.g. a state machine in `src/worca/state/`, the stage list, a DAG), collect:

- **Nodes**: label, a one-line `sublabel`, a fuller `tip`, and which are `optional`.
- **Forward flow**: the main path (top-down) → `from`/`to` edges.
- **Returns / transitions**: loopbacks or back-edges → explicit `path` + `label`.

For a **state graph** (e.g. lifecycle-and-state: running → paused → interrupted → completed/failed/halted), nodes are states and edges are transitions (`pause`, `resume`, `stop`, …). Forward transitions are blue; back/recovery transitions (e.g. resume) are amber returns.

## Step 3: Lay out coordinates

- **Linear top-down flow** (like the pipeline): one column at `cx: 260`, first node `cy: 36`, step **76px** per node (`36, 112, 188, …`), `viewBox` height = last `cy` + ~56. Forward edges need no `path`.
- **Branching / state graphs**: place nodes deliberately (columns for parallel branches, rows for tiers), then author each transition as an explicit right-angled `path` between node edges. Keep labels horizontal, placed beside the bend. Node left edge = `cx - 95`, right edge = `cx + 95` (default width), top = `cy - 20`, bottom = `cy + 20`.

Keep nodes inside the `viewBox`. Mirror the pipeline's spacing so diagrams feel like siblings.

## Step 4: Create a wrapper component

Create `docs-site/src/components/<Name>Diagram.astro` modeled on `PipelineDiagram.astro`: define the `nodes`/`edges`/`ariaLabel` in the frontmatter and render `<FlowDiagram .../>`. Keep ALL data here — the wrapper has no `<style>` or `<script>` of its own.

## Step 5: Embed it in the page

The target page must be **`.mdx`** (rename `.md` → `.mdx` if needed; update any sidebar/links). Import and place the component:

```mdx
import RunStateDiagram from '../../../components/RunStateDiagram.astro';

<RunStateDiagram />

*Hover or focus any node to see what it does.*
```

## Step 6: Build and verify (required)

```bash
cd docs-site && npm run build
```

Then verify in a browser in **both light and dark mode** (this repo's rule — always verify UI in Playwright before reporting done):

- nodes/edges/labels count matches the spec;
- forward edges blue, returns amber; in dark mode amber brightens (`#fbbf24`);
- tooltips appear on hover **and** keyboard focus, and dismiss on blur/Escape;
- `prefers-reduced-motion` stops the marching-ants animation.

## Style & safety rules (do not violate)

- **One style, one place.** Never copy FlowDiagram's CSS into a wrapper or page. If the *style itself* must change, edit `FlowDiagram.astro` once — it updates every diagram.
- **Tooltips use `textContent` / safe DOM — never `innerHTML`.** The repo's security hook blocks `innerHTML`, and tip text is data.
- **Theme via Starlight CSS vars** (`--sl-color-*`); always provide light + dark. Respect `prefers-reduced-motion`.
- **Accessibility**: the `<svg>` has `role="img"` + a full `ariaLabel`; nodes are focusable (`tabindex="0"`) with per-node `aria-label`.
- **Colour semantics**: blue = forward progression, amber = return/loopback/recovery. Optional nodes are dashed grey.
- **Right-angled connectors**, not arcs; labels horizontal.
