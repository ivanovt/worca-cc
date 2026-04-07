# worca-cc

Autonomous software development pipeline with governance enforcement.

## What it does

worca-cc is a multi-agent pipeline that plans, coordinates, implements, tests, reviews, and learns from code changes autonomously. It runs as a set of Claude Code hooks and scripts you install into any project — with governance enforcement at every stage.

## Installation

```bash
pip install worca-cc
```

## Quick Start

```bash
worca init          # scaffold .claude/ in current project
worca run --prompt "Add user authentication"
```

## Features

- **9-stage pipeline** — Preflight → Plan → Plan Review → Coordinate → Implement → Test → Review → PR → Learn
- **7 specialized agents** — Planner, Plan Reviewer, Coordinator, and Guardian on Opus; Implementer, Tester, and Learner on Sonnet
- **Governance hooks** — block dangerous operations, enforce test gates, validate plans
- **Circuit breakers** — error classification with halt thresholds to prevent runaway cost
- **Preflight checks** — language-agnostic environment validation before spending tokens
- **Pause/resume/stop** — clean checkpointing with real-time state transitions
- **GitHub issue integration** — start from issues, auto-post progress, link PRs, close on completion
- **Parallel pipelines** — run N pipelines concurrently in isolated git worktrees
- **Agent prompt overlays** — customize agent instructions per-project without modifying core templates

## Requirements

- Python 3.8+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- Git

## Documentation

Full documentation, dashboard setup, and configuration reference: [GitHub repository](https://github.com/SinishaDjukic/worca-cc)

## License

[MIT](https://github.com/SinishaDjukic/worca-cc/blob/main/LICENSE)
