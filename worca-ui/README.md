# @worca/ui

Real-time pipeline monitoring dashboard for [worca-cc](https://github.com/SinishaDjukic/worca-cc).

## What it does

A web dashboard for monitoring worca pipelines in real-time: stage progress with cost/duration breakdown, beads kanban board, token & cost dashboard, run history, and settings editor. All updates stream via WebSocket — no polling.

## Installation

```bash
npm install -g @worca/ui
```

## Quick Start

```bash
worca-ui                         # monitor all projects (default, port 3400)
worca-ui --project /path         # monitor single project
worca-ui --help                  # show all commands and options
worca-ui --version               # print version
```

> **Don't watch the same project from two servers.** Global mode (the default)
> already watches every project registered in `~/.worca/projects.d/`. Running a
> second `--project /path` server on a project that global mode already covers
> points two watchers at the same `.beads` directory. Each watcher's `bd` reads
> mutate the SQLite WAL, which the other watcher sees as an external change — a
> cheap mutual refresh that never settles. The watcher bails cheaply on an
> unchanged content fingerprint, so this is harmless, but it's wasted work: use
> either global mode **or** a single `--project` server for a given project, not
> both.

## Features

- **Real-time WebSocket streaming** — no polling, no page refreshes
- **Multi-project sidebar** — live status dots and run count badges
- **Stage pipeline** — cost, duration, and timing bar per stage with drill-down to iterations
- **Beads kanban board** — task status across Open/In Progress/Closed columns
- **Token & cost dashboard** — per-run cost breakdown with stage-proportional bar chart
- **Run history** — browse completed and interrupted runs sorted newest-first
- **Settings editor** — configure agents, stages, governance, pricing, and webhooks from the UI
- **Lifecycle controls** — pause, resume, and stop pipelines from the header

## Requirements

- Node.js 22+
- worca-cc pipeline installed in target projects (`pip install worca-cc`)

## Documentation

Full documentation and screenshots: [GitHub repository](https://github.com/SinishaDjukic/worca-cc)

## License

[MIT](https://github.com/SinishaDjukic/worca-cc/blob/main/LICENSE)
