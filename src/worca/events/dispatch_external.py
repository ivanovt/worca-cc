"""
worca.events.dispatch_external — CLI helper for external event dispatch.

Invoked by Node (or other non-Python actors) to emit terminal-state events
through the full Python dispatch machinery (events.jsonl + webhooks + shell
hooks). Uses sync=True to guarantee webhook delivery completes before the
process exits (avoids daemon-thread truncation).

Exit codes: 0 success, 1 invalid args, 2 missing run-dir/status.json, 3 dispatch failure.
"""

import argparse
import io
import json
import sys
from pathlib import Path

from worca.events.emitter import EventContext, emit_event
from worca.events.types import RUN_CANCELLED, RUN_FAILED, RUN_INTERRUPTED

VALID_EVENT_TYPES = {RUN_INTERRUPTED, RUN_CANCELLED, RUN_FAILED}


def _force_utf8():
    """Force UTF-8 on stdout/stderr — Windows defaults to cp1252."""
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", newline="\n")
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", newline="\n")


def main(argv=None):
    p = argparse.ArgumentParser(prog="worca.events.dispatch_external")
    p.add_argument("--run-dir", required=True)
    p.add_argument("--settings", required=True)
    p.add_argument("--event-type", required=True, choices=sorted(VALID_EVENT_TYPES))
    p.add_argument("--payload-json", required=True)
    args = p.parse_args(argv)

    run_dir = Path(args.run_dir)
    status_path = run_dir / "status.json"
    if not run_dir.exists() or not status_path.exists():
        print(f"[dispatch_external] run-dir or status.json not found: {run_dir}", file=sys.stderr)
        sys.exit(2)

    status = json.loads(status_path.read_text(encoding="utf-8"))

    ctx = EventContext(
        run_id=status.get("run_id", run_dir.name),
        branch=status.get("branch", ""),
        work_request=status.get("work_request", {}),
        events_path=str(run_dir / "events.jsonl"),
        settings_path=args.settings,
    )
    try:
        payload = json.loads(args.payload_json)
        event = emit_event(ctx, args.event_type, payload, sync=True)
    finally:
        ctx.close()

    if event is None:
        sys.exit(3)

    print(json.dumps({"ok": True, "event_id": event["event_id"]}))


if __name__ == "__main__":
    _force_utf8()
    main()
