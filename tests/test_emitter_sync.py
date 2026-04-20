"""
Tests for sync parameter on dispatch_event() and emit_event().

W-043/A2: When sync=True, webhook delivery uses deliver_webhook_sync()
instead of the default daemon-thread deliver_webhook(). Default (sync=False)
preserves existing async behavior.
"""

import json
import os
from unittest.mock import patch

import pytest

from worca.events.emitter import EventContext, dispatch_event, emit_event


@pytest.fixture
def tmp_events_dir(tmp_path):
    return tmp_path


@pytest.fixture
def ctx(tmp_events_dir):
    """Minimal EventContext with one webhook configured."""
    events_path = str(tmp_events_dir / "events.jsonl")
    settings_path = str(tmp_events_dir / "settings.json")
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w") as f:
        json.dump({}, f)
    return EventContext(
        run_id="test-run",
        branch="main",
        work_request={"prompt": "test"},
        events_path=events_path,
        settings_path=settings_path,
        _webhooks=[{"url": "https://example.com/hook"}],
    )


@pytest.fixture
def sample_event():
    return {
        "schema_version": "1",
        "event_id": "evt-1",
        "event_type": "pipeline.run.completed",
        "timestamp": "2026-01-01T00:00:00+00:00",
        "run_id": "test-run",
        "pipeline": {"branch": "main", "work_request": {}},
        "payload": {},
    }


# ---------------------------------------------------------------------------
# dispatch_event tests
# ---------------------------------------------------------------------------


class TestDispatchEventSync:
    """dispatch_event(ctx, event, sync=True) uses deliver_webhook_sync."""

    @patch("worca.events.emitter.dispatch_event.__module__", create=True)
    def test_dispatch_default_is_async(self, _mod, ctx, sample_event):
        """Default sync=False calls deliver_webhook (async)."""
        with patch("worca.events.webhook.deliver_webhook") as mock_async:
            dispatch_event(ctx, sample_event)
            mock_async.assert_called_once()

    def test_dispatch_sync_true_uses_sync_delivery(self, ctx, sample_event):
        """sync=True routes to deliver_webhook_sync instead of deliver_webhook."""
        with patch("worca.events.webhook.deliver_webhook_sync") as mock_sync,                 patch("worca.events.webhook.deliver_webhook") as mock_async:
            dispatch_event(ctx, sample_event, sync=True)
            mock_sync.assert_called_once_with(sample_event, ctx._webhooks[0])
            mock_async.assert_not_called()

    def test_dispatch_sync_false_uses_async_delivery(self, ctx, sample_event):
        """Explicit sync=False calls deliver_webhook (async)."""
        with patch("worca.events.webhook.deliver_webhook_sync") as mock_sync,                 patch("worca.events.webhook.deliver_webhook") as mock_async:
            dispatch_event(ctx, sample_event, sync=False)
            mock_async.assert_called_once_with(sample_event, ctx._webhooks[0])
            mock_sync.assert_not_called()


# ---------------------------------------------------------------------------
# emit_event tests
# ---------------------------------------------------------------------------


class TestEmitEventSync:
    """emit_event(ctx, event_type, payload, sync=True) passes sync through."""

    def test_emit_default_is_async(self, ctx):
        """Default emit_event calls dispatch_event with sync=False."""
        with patch("worca.events.emitter.dispatch_event") as mock_dispatch:
            emit_event(ctx, "pipeline.run.completed", {"duration_ms": 100})
            mock_dispatch.assert_called_once()
            _args, kwargs = mock_dispatch.call_args
            assert kwargs.get("sync", False) is False or len(_args) == 2

    def test_emit_sync_true_passes_through(self, ctx):
        """sync=True on emit_event is forwarded to dispatch_event."""
        with patch("worca.events.emitter.dispatch_event") as mock_dispatch:
            emit_event(ctx, "pipeline.run.completed", {"duration_ms": 100}, sync=True)
            mock_dispatch.assert_called_once()
            _args, kwargs = mock_dispatch.call_args
            assert kwargs.get("sync") is True

    def test_emit_sync_false_passes_through(self, ctx):
        """Explicit sync=False on emit_event is forwarded to dispatch_event."""
        with patch("worca.events.emitter.dispatch_event") as mock_dispatch:
            emit_event(ctx, "pipeline.run.completed", {"duration_ms": 100}, sync=False)
            mock_dispatch.assert_called_once()
            _args, kwargs = mock_dispatch.call_args
            assert kwargs.get("sync", False) is False


# ---------------------------------------------------------------------------
# Shell hook dispatch — sync flag must not affect shell hooks
# ---------------------------------------------------------------------------


class TestShellHookUnaffected:
    """Shell hooks always fire the same way regardless of sync flag."""

    def test_shell_hooks_fire_regardless_of_sync(self, tmp_events_dir):
        """Shell hooks dispatch is called even when sync=True."""
        events_path = str(tmp_events_dir / "events.jsonl")
        settings_path = str(tmp_events_dir / "settings.json")
        with open(settings_path, "w") as f:
            json.dump({}, f)
        ctx = EventContext(
            run_id="test-run",
            branch="main",
            work_request={"prompt": "test"},
            events_path=events_path,
            settings_path=settings_path,
            _webhooks=[{"url": "https://example.com/hook"}],
            _shell_hooks={"on_complete": "echo done"},
        )
        event = {
            "event_type": "pipeline.run.completed",
            "run_id": "test-run",
            "payload": {},
        }
        with patch("worca.events.webhook.deliver_webhook_sync"),                 patch("worca.orchestrator.events.dispatch_shell_hooks") as mock_sh_real:
            dispatch_event(ctx, event, sync=True)
            mock_sh_real.assert_called_once()
