"""Workspace-level event emission (W-047 coordinator-layer events).

Eighteen events — workspace.launched, .completed, .failed, .halted, .paused,
.resumed, .plan.started/.completed/.failed, .tier.started/.completed/.failed,
.integration_test.started/.passed/.failed, .umbrella_issue.created,
.circuit_breaker.tripped, .guide_conflict — complement the per-child
pipeline.run.* stream with workspace-level transitions a subscriber would
otherwise have to reconstruct from N children + a workspace.json read.

Each event is delivered to:
  - ~/.worca/workspace-runs/<workspace_id>.events.jsonl   (audit log)
  - shell hooks configured under worca.hooks
  - HTTP webhooks configured under worca.webhooks         (control:true
    skipped — workspace events are observational)

Mirrors src/worca/events/fleet_emitter.py exactly so the two surfaces share
identical envelope shape and dispatch rules. Workspace events never inherit
pipeline-specific fields like run_id; emission happens from the workspace
coordinator process, not from child pipelines.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone

from worca.orchestrator.events import dispatch_shell_hooks
from worca.utils.paths import workspace_runs_dir as resolve_workspace_runs_dir
from worca.utils.settings import load_settings

# Module-level override slot.  See worca.utils.paths.workspace_runs_dir for
# resolution precedence.  Defaulted to None and resolved lazily so tests
# can set $WORCA_HOME (or patch this attribute) after import (issue #162).
_DEFAULT_WORKSPACE_RUNS_DIR: str | None = None


def workspace_events_path(
    workspace_id: str, base_dir: str | None = None
) -> str:
    """Return the absolute path to a workspace's event log."""
    if base_dir is None:
        base_dir = resolve_workspace_runs_dir(_DEFAULT_WORKSPACE_RUNS_DIR)
    return os.path.join(base_dir, f"{workspace_id}.events.jsonl")


def emit_workspace_event(
    workspace_id: str,
    event_type: str,
    payload: dict,
    *,
    settings_path: str = ".claude/settings.json",
    workspace_runs_dir: str | None = None,
) -> dict | None:
    """Emit a workspace-level event.

    Writes the envelope to <workspace_runs_dir>/<workspace_id>.events.jsonl
    and dispatches to worca.hooks + worca.webhooks. Never raises — every
    step is wrapped in best-effort try/except so a misconfigured webhook
    can't bring the workspace down. Returns the envelope dict on success,
    None when serialization fails before any side effect occurred.

    settings_path defaults to ".claude/settings.json" (cwd-relative). The
    workspace coordinator runs from the workspace root, so the default is
    almost always correct; callers wanting an explicit absolute path
    (resume from outside the root, tests) can override.
    """
    try:
        envelope = {
            "schema_version": "1",
            "event_id": str(uuid.uuid4()),
            "event_type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "workspace_id": workspace_id,
            "payload": payload,
        }
        line = json.dumps(envelope, ensure_ascii=False)
    except Exception as exc:
        print(
            f"[worca.events] Workspace event serialization error for {event_type}: {exc}",
            file=sys.stderr,
        )
        return None

    # Audit log
    path = workspace_events_path(workspace_id, base_dir=workspace_runs_dir)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as exc:
        print(
            f"[worca.events] Failed to write workspace event log {path!r}: {exc}",
            file=sys.stderr,
        )

    # Settings-driven hook + webhook dispatch. Load once, share between paths.
    worca_cfg = {}
    try:
        settings = load_settings(settings_path)
        worca_cfg = settings.get("worca", {}) or {}
    except Exception as exc:
        print(
            f"[worca.events] Failed to load settings for workspace event dispatch: {exc}",
            file=sys.stderr,
        )

    hooks_config = worca_cfg.get("hooks") or {}
    if hooks_config:
        try:
            dispatch_shell_hooks(envelope, hooks_config)
        except Exception as exc:
            print(
                f"[worca.events] Workspace shell hook dispatch error: {exc}",
                file=sys.stderr,
            )

    webhooks = worca_cfg.get("webhooks") or []
    if webhooks:
        try:
            from worca.events.webhook import deliver_webhook

            for wh in webhooks:
                # control webhooks are pipeline-only — workspace events are
                # observational and have no control-response shape.
                if wh.get("control"):
                    continue
                try:
                    deliver_webhook(envelope, wh)
                except Exception as exc:
                    print(
                        f"[worca.events] Workspace webhook delivery error "
                        f"({wh.get('url', '?')}): {exc}",
                        file=sys.stderr,
                    )
        except Exception as exc:
            print(
                f"[worca.events] Workspace webhook dispatch error: {exc}",
                file=sys.stderr,
            )

    return envelope
