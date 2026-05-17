"""Fleet-level event emission (W-040 fleet lifecycle webhooks).

Five events — fleet.launched, fleet.halted, fleet.completed, fleet.failed,
fleet.circuit_breaker.tripped — complement the per-child pipeline.run.*
stream with aggregated, fleet-level transitions a subscriber would
otherwise have to reconstruct from N children.

Each event is delivered to:
  - ~/.worca/fleet-runs/<fleet_id>.events.jsonl    (audit log)
  - shell hooks configured under worca.hooks
  - HTTP webhooks configured under worca.webhooks  (control:true skipped —
    fleet events are observational)

Design notes
------------
This module deliberately re-implements a small slice of events/emitter.py
rather than reusing EventContext: the per-pipeline emitter is heavyweight
(per-run JSONL handle, signal-safe path, control-webhook routing), and the
fleet path doesn't need any of that. Fleet events fire infrequently and
from short-lived call sites (run_fleet.py dispatch tail, fleet_lifecycle's
stop_fleet, the manifest reconciler), so allocating a dataclass + opening a
file handle per emission is acceptable. Keeping the two emitters separate
also means fleet events never accidentally inherit pipeline-specific
fields like `run_id`, `pipeline.branch`, or per-stage iteration counters.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone

from worca.orchestrator.events import dispatch_shell_hooks
from worca.utils.paths import fleet_runs_dir as resolve_fleet_runs_dir
from worca.utils.settings import load_settings

# Module-level override slot.  See worca.utils.paths.fleet_runs_dir for
# resolution precedence.  Defaulted to None and resolved lazily so tests
# can set $WORCA_HOME (or patch this attribute) after import (issue #162).
_DEFAULT_FLEET_RUNS_DIR: str | None = None


def fleet_events_path(fleet_id: str, base_dir: str | None = None) -> str:
    """Return the absolute path to a fleet's event log."""
    if base_dir is None:
        base_dir = resolve_fleet_runs_dir(_DEFAULT_FLEET_RUNS_DIR)
    return os.path.join(base_dir, f"{fleet_id}.events.jsonl")


def emit_fleet_event(
    fleet_id: str,
    event_type: str,
    payload: dict,
    *,
    settings_path: str = ".claude/settings.json",
    fleet_runs_dir: str | None = None,
) -> dict | None:
    """Emit a fleet-level event.

    Writes the envelope to <fleet_runs_dir>/<fleet_id>.events.jsonl and
    dispatches to worca.hooks + worca.webhooks. Never raises — every step
    is wrapped in best-effort try/except so a misconfigured webhook can't
    bring the fleet down. Returns the envelope dict on success, None when
    serialization fails before any side effect occurred.

    settings_path defaults to ".claude/settings.json" (cwd-relative).
    Callers that run from outside the project root (the manifest poller
    runs from anywhere) should pass an absolute path resolved against the
    fleet's originating project — see fleet_manifest.py for the pattern.
    """
    try:
        envelope = {
            "schema_version": "1",
            "event_id": str(uuid.uuid4()),
            "event_type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "fleet_id": fleet_id,
            "payload": payload,
        }
        line = json.dumps(envelope, ensure_ascii=False)
    except Exception as exc:
        print(
            f"[worca.events] Fleet event serialization error for {event_type}: {exc}",
            file=sys.stderr,
        )
        return None

    # Audit log
    path = fleet_events_path(fleet_id, base_dir=fleet_runs_dir)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as exc:
        print(
            f"[worca.events] Failed to write fleet event log {path!r}: {exc}",
            file=sys.stderr,
        )

    # Settings-driven hook + webhook dispatch. Load once, share between paths.
    worca_cfg = {}
    try:
        settings = load_settings(settings_path)
        worca_cfg = settings.get("worca", {}) or {}
    except Exception as exc:
        print(
            f"[worca.events] Failed to load settings for fleet event dispatch: {exc}",
            file=sys.stderr,
        )

    hooks_config = worca_cfg.get("hooks") or {}
    if hooks_config:
        try:
            dispatch_shell_hooks(envelope, hooks_config)
        except Exception as exc:
            print(
                f"[worca.events] Fleet shell hook dispatch error: {exc}",
                file=sys.stderr,
            )

    webhooks = worca_cfg.get("webhooks") or []
    if webhooks:
        try:
            from worca.events.webhook import deliver_webhook

            for wh in webhooks:
                # control webhooks are pipeline-only — fleet events are
                # observational and have no control-response shape.
                if wh.get("control"):
                    continue
                try:
                    deliver_webhook(envelope, wh)
                except Exception as exc:
                    print(
                        f"[worca.events] Fleet webhook delivery error "
                        f"({wh.get('url', '?')}): {exc}",
                        file=sys.stderr,
                    )
        except Exception as exc:
            print(
                f"[worca.events] Fleet webhook dispatch error: {exc}",
                file=sys.stderr,
            )

    return envelope
