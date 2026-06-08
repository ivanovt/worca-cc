---
title: Installation
description: Install the worca packages and launch the dashboard.
sidebar:
  order: 2
---

worca ships as two packages: the Python pipeline (which provides the `worca` CLI) and the `worca-ui` dashboard.

## Install the packages

These are the Python pipeline (which gives you the `worca` CLI), the dashboard, and beads for task tracking:

```bash
pip install worca-cc
npm install -g @worca/ui
npm install -g @beads/bd@0.49.0
```

## Launch the dashboard

Start the dashboard. It runs in **global mode** by default — one browser tab monitors every project you add — and serves at **http://localhost:3400**:

```bash
worca-ui
```

Manage the running server with `worca-ui restart` (rebuild and restart), `worca-ui stop`, and `worca-ui status` (check whether it's running):

```bash
worca-ui restart
worca-ui stop
worca-ui status
```

Open **http://localhost:3400**. You'll see the dashboard with an empty project list — you'll add your first project next.

![The dashboard on first launch: the empty global view with the sidebar project picker and the + add-project button.](/screenshots/installation/01-first-launch.png)

## Keeping worca up to date

```bash
pip install --upgrade worca-cc
npm install -g @worca/ui@latest
```

After upgrading `worca-cc`, the dashboard can update an existing project's pipeline in place from its **Settings** (it re-runs `worca init --upgrade` for you) — no manual file copying.

Next: [add your project](/getting-started/add-your-project/).
