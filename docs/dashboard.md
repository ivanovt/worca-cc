# Dashboard (worca-ui)

A real-time web dashboard for monitoring and controlling the pipeline. All updates stream via WebSocket — no polling, no page refreshes.

```bash
worca-ui                                  # Monitor all projects (default, port 3400)
worca-ui --project /path                  # Monitor single project
```

## Pipeline Detail

Stage pipeline with iteration counts, costs, duration, and a timing bar showing Thinking vs Tools breakdown. Expand any stage to drill into per-iteration metrics. Pause, resume, and stop controls in the header.

![Pipeline detail — stage pipeline with costs, turns, and timing bar](screenshots/run-detail-stages.png)

Expand a stage to see individual iterations — each shows agent, turns, cost, duration, and outcome. The log viewer streams real-time agent output with per-stage filtering.

![Pipeline detail — IMPLEMENT expanded](screenshots/pipeline-detail-implement.png)

The header shows lifecycle controls — pause, resume, and stop buttons with real-time state transitions and a status badge.

![Lifecycle controls — Failed status badge with Resume and Stop buttons](screenshots/lifecycle-controls.png)

## Learnings

After a run completes, the LEARN stage produces ranked observations and actionable suggestions. Copy-to-clipboard buttons let you feed insights directly into future runs or agent prompts.

![Learnings panel](screenshots/learn-stage.png)

## Global Dashboard

In global mode (the default), the sidebar shows a project picker with all registered projects, live status indicators, and a "New Pipeline" button. Select a project to see its runs, beads, costs, and settings.

![Global dashboard — project-scoped history view with sidebar navigation](screenshots/global-dashboard.png)

The sidebar project picker shows all registered projects with live status dots (green = healthy, red = errors) and run count badges.

![Sidebar project picker with status dots and 20 registered projects](screenshots/sidebar-projects.png)

## Add Project

Click the **+** button next to the project picker to register a new project. The dialog validates the project path and auto-generates a slug for the project name.

![Add project dialog](screenshots/add-project-dialog.png)

## Run History

Browse completed and interrupted runs sorted newest-first. Each card shows the branch, timing, and stage completion badges.

![Run History](screenshots/history.png)

## New Pipeline

Start a run from a prompt, GitHub issue, or spec file. Advanced options for size/loop multipliers, branch selection, and pre-made plan files.

![New Pipeline](screenshots/new-pipeline.png)

## Beads Task Board

Kanban view of tasks created by the Coordinator, filtered by run. Shows priority badges, dependency chains, and status across Open/In Progress/Closed columns. Badge shows closed/total count (e.g., "3/5 beads").

![Beads Kanban](screenshots/beads-kanban.png)

## Token & Cost Dashboard

Per-run cost breakdown with a stage-proportional bar chart. Detailed table showing cost, turns, duration, and API duration per iteration.

![Cost Dashboard](screenshots/costs.png)

## Settings

Configure agent models and max turns, pipeline stages, governance rules, pricing, webhooks, and preflight checks — all saved to `.claude/settings.json` and effective immediately without restarting.

![Settings](screenshots/settings.png)

Preflight checks validate the environment before spending tokens — catching git state issues, missing dependencies, and configuration problems. Each check can be toggled independently.

![Preflight settings](screenshots/preflight-settings.png)

The webhooks panel configures event subscriptions, budget limits, and HMAC-SHA256 signing for pipeline event delivery.

![Webhooks settings — event system toggles, budget limits, and webhook configuration](screenshots/webhooks-settings.png)
