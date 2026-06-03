---
title: Monitoring a run
description: The live run-detail view — stages, cost, effort, dispatch, and streaming logs.
sidebar:
  order: 2
---

Once a run starts, the **run detail** view streams everything over WebSocket — no polling, no refreshing. The page updates as the pipeline moves.

## The stage pipeline

The run is shown as a sequence of stages. Each stage card carries its iteration count, cost, duration, and a timing bar that splits **Thinking** time from **Tools** time. Stages light up as the pipeline reaches them and loop back when work needs another pass.

:::note[Screenshot — coming soon]
Run detail: the stage pipeline with per-stage cost, turns, and the Thinking-vs-Tools timing bar.
:::

## Drilling into a stage

Expand any stage to see its individual iterations. Each iteration row shows:

- the agent, its turns, cost, duration, and outcome;
- an **effort badge** — the reasoning level the iteration ran at (see [Tuning effort](/advanced/tuning-effort/));
- **Tools / Skills / Subagents** rows, each item badged allow (green) or deny (red) by the [governance](/concepts/governance/) rules, with a **Lockdown** chip when a section is set to `none`.

The expanded **Agent Instructions** panel separates the resolved system prompt from your work-request message, so you can see exactly what the agent was told.

:::note[Screenshot — coming soon]
An expanded Implement stage: per-iteration metrics, the effort badge, and the dispatch allow/deny rows.
:::

## The timeline view

The stage pipeline answers "where is the run now?" The **timeline view** answers "how did it get here?" A **Timeline** button on the pipeline timing bar opens a Gantt-style swimlane chart: one row per stage, one bar per iteration, laid out along a shared time axis. Loopbacks — the moments when a downstream stage sent work back upstream — are drawn as arrows that connect the iteration that *caused* the loopback to the iteration that *resumed* it.

:::note[Screenshot — coming soon]
The timeline view: stage swimlanes with per-iteration bars, gap bands, and loopback arrows.
:::

The bars are color-coded per stage (the same hues used elsewhere in the UI) and their **fill darkness reflects the iteration's status** — success bars are saturated, failed bars are washed out, in-progress bars carry the active hue. **Gap bands** between iterations show where time was spent in *another* stage (with a tooltip naming that stage), so you can see at a glance which loopbacks bled into which downstream waits. For active runs, the view streams over the same WebSocket as the rest of the page — new bars and arrows appear as the pipeline advances.

### Interacting with the timeline

- **Zoom** — `+` / `−` / reset in the top-right toolbar; shift-wheel anywhere over the chart; or drag-select a window directly on the time axis at the bottom.
- **Hover** — bars surface a tooltip with stage, iteration N of total, duration, started/ended, model, status, and cost. Gap bands surface the stage that owned the gap and how long it lasted.
- **Click** — clicking a bar opens a drawer with the iteration's status pill, key metrics, and a collapsed **Raw JSON** block for full inspection. A footer link jumps to that iteration on the run-detail page.
- **Keyboard** — bars and gaps are focusable; **Enter** or **Space** on a focused bar opens the same drawer.
- **Dense rows** — when a single stage has more than 30 iterations, loopback arrows are suppressed and a hint appears so the row stays readable.

## The log viewer

The log viewer streams real-time agent output with per-stage filtering — follow the Implementer's reasoning, the Tester's command output, or the Reviewer's verdict as it happens. Agent prompts, guides, context artifacts, and bead tooltips render as sanitized Markdown.

## Cost and tokens

The **Token & Cost** view breaks the run down per stage with a proportional bar chart and a per-iteration table (cost, turns, duration, API duration). Pricing comes from your project settings, so the figures reflect your configured model rates.

:::tip
To pause, resume, or stop a run from this view, see [Controlling a run](/running-pipelines/controlling-a-run/).
:::
