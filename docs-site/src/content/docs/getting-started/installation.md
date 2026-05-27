---
title: Installation
description: Install the worca packages and launch the dashboard.
sidebar:
  order: 2
---

worca ships as two packages: the Python pipeline (which provides the `worca` CLI) and the `worca-ui` dashboard.

## Install the packages

```bash
pip install worca-cc            # pipeline + the `worca` CLI
npm install -g @worca/ui        # the dashboard
npm install -g @beads/bd@0.49.0 # task tracking (pin 0.49.0)
```

## Launch the dashboard

```bash
worca-ui                        # starts the dashboard on http://localhost:3400
```

`worca-ui` runs in **global mode** by default — one browser tab monitors every project you add. Manage the server with:

```bash
worca-ui restart                # rebuild and restart
worca-ui stop                   # stop it
worca-ui status                 # check whether it's running
```

Open **http://localhost:3400**. You'll see the dashboard with an empty project list — you'll add your first project next.

:::note[Screenshot — coming soon]
The dashboard on first launch: the empty global view with the sidebar project picker and the **+** add-project button.
:::

## Keeping worca up to date

```bash
pip install --upgrade worca-cc
npm install -g @worca/ui@latest
```

After upgrading `worca-cc`, the dashboard can update an existing project's pipeline in place from its **Settings** (it re-runs `worca init --upgrade` for you) — no manual file copying.

Next: [add your project](/getting-started/add-your-project/).
