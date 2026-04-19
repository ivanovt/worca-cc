---
name: state-action-matrix
description: Load the pipeline state-action matrix specification before developing changes to states, actions, transitions, status rendering, or action gating. Triggers on "state matrix", "action matrix", "pipeline states", "pipeline actions", "state transitions", "actionAllowed", "state-actions", "pipeline_status", "stop_reason", or any work involving pipeline lifecycle state changes.
---

# Pipeline State-Action Matrix

Load the specification and key source files so you have full context before making changes.

## Step 1: Load the specification

Read the state-action matrix specification:

```
docs/state-action-matrix.md
```

This document defines all pipeline states, stop reasons, the action matrix, state transitions, terminal events, and the checklist for making changes.

## Step 2: Load the source of truth

Read the canonical implementation:

```
worca-ui/app/utils/state-actions.js
```

This file exports `STATES`, `ACTION_MATRIX`, and `actionAllowed()`. Both the UI and the server import from it.

## Step 3: Load related files as needed

Depending on the change, also read:

- **Adding/changing a state or badge rendering:** `worca-ui/app/utils/status-badge.js`
- **Changing Python-side state transitions:** `src/worca/orchestrator/runner.py` (search for `pipeline_status` assignments)
- **Changing terminal event dispatch:** `src/worca/events/dispatch_external.py` and `src/worca/events/types.py`
- **Changing UI button gating:** `worca-ui/app/views/run-card.js` and `worca-ui/app/views/multi-dashboard.js`
- **Changing server-side validation:** `worca-ui/server/project-routes.js` (search for `actionAllowed`)
- **Badge colors/variants:** `worca-ui/docs/badge-color-language.md`

## Step 4: Follow the change checklist

When making changes, follow the "Changing the Matrix" section in the specification. At minimum:

1. Update `state-actions.js` (the source of truth)
2. Update `state-actions.test.js` (maintain exhaustive coverage)
3. Update `docs/state-action-matrix.md` (keep spec in sync)
4. Run the relevant tests before committing:

```bash
cd worca-ui && npx vitest run app/utils/state-actions.test.js
pytest tests/test_runner_control_polling.py
```

## Key rules

- **`failed` vs `interrupted`:** `interrupted` = user-initiated stop (control file, signal, webhook). `failed` = something went wrong (exception, crash, stale process). Never confuse these.
- **Stale processes are `failed`, not `interrupted`.** A crash/OOM/SIGKILL is not a user action.
- **The cancel endpoint must re-read status.json after stopPipelineSync.** Python's signal handler may update the file during the stop window.
- **One source of truth.** All action gating flows through `actionAllowed()` from `state-actions.js`. Don't duplicate the matrix elsewhere.
