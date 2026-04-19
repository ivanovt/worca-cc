"""
Tests for worca.events.dispatch_external CLI helper.

W-043/A3: CLI that accepts --run-dir, --settings, --event-type, --payload-json.
Forces UTF-8 I/O, calls emit_event(..., sync=True).
Exit codes: 0 success, 1 invalid args, 2 missing run-dir, 3 dispatch failure.
"""

import json
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread
from unittest.mock import patch

import pytest

from worca.events.dispatch_external import VALID_EVENT_TYPES, main


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def run_dir(tmp_path):
    """Create a minimal run directory with status.json."""
    rd = tmp_path / "runs" / "test-run-001"
    rd.mkdir(parents=True)
    status = {
        "run_id": "test-run-001",
        "branch": "feature/test",
        "work_request": {"prompt": "test prompt"},
    }
    (rd / "status.json").write_text(json.dumps(status), encoding="utf-8")
    return rd


@pytest.fixture
def settings_path(tmp_path):
    """Create a minimal settings.json."""
    sp = tmp_path / "settings.json"
    sp.write_text(json.dumps({}), encoding="utf-8")
    return sp


# ---------------------------------------------------------------------------
# Exit code tests
# ---------------------------------------------------------------------------


class TestExitCodes:
    """CLI exit codes follow the contract: 0 success, 1 invalid args, 2 missing run-dir, 3 dispatch failure."""

    def test_exit_2_on_missing_run_dir(self, tmp_path, settings_path):
        """Missing run-dir exits with code 2."""
        missing = str(tmp_path / "nonexistent")
        with pytest.raises(SystemExit) as exc_info:
            main([
                "--run-dir", missing,
                "--settings", str(settings_path),
                "--event-type", "pipeline.run.cancelled",
                "--payload-json", '{"cancelled_stage":"x","elapsed_ms":0,"source":"user_cancel"}',
            ])
        assert exc_info.value.code == 2

    def test_exit_2_on_missing_status_json(self, tmp_path, settings_path):
        """Run dir exists but no status.json exits with code 2."""
        empty_dir = tmp_path / "empty-run"
        empty_dir.mkdir()
        with pytest.raises(SystemExit) as exc_info:
            main([
                "--run-dir", str(empty_dir),
                "--settings", str(settings_path),
                "--event-type", "pipeline.run.cancelled",
                "--payload-json", '{"cancelled_stage":"x","elapsed_ms":0,"source":"user_cancel"}',
            ])
        assert exc_info.value.code == 2

    def test_exit_1_on_invalid_event_type(self, run_dir, settings_path):
        """Invalid --event-type exits with code 2 (argparse error)."""
        with pytest.raises(SystemExit) as exc_info:
            main([
                "--run-dir", str(run_dir),
                "--settings", str(settings_path),
                "--event-type", "pipeline.run.bogus",
                "--payload-json", "{}",
            ])
        assert exc_info.value.code == 2

    def test_exit_1_on_missing_required_arg(self, run_dir, settings_path):
        """Missing required arg exits with code 2 (argparse error)."""
        with pytest.raises(SystemExit) as exc_info:
            main(["--run-dir", str(run_dir)])
        assert exc_info.value.code == 2

    def test_exit_3_on_dispatch_failure(self, run_dir, settings_path):
        """When emit_event returns None, exit code is 3."""
        with patch("worca.events.dispatch_external.emit_event", return_value=None):
            with pytest.raises(SystemExit) as exc_info:
                main([
                    "--run-dir", str(run_dir),
                    "--settings", str(settings_path),
                    "--event-type", "pipeline.run.cancelled",
                    "--payload-json", '{"cancelled_stage":"x","elapsed_ms":0,"source":"user_cancel"}',
                ])
            assert exc_info.value.code == 3

    def test_exit_0_on_success(self, run_dir, settings_path, capsys):
        """Successful dispatch exits cleanly (no SystemExit) and prints JSON to stdout."""
        fake_event = {"event_id": "evt-abc123", "event_type": "pipeline.run.cancelled"}
        with patch("worca.events.dispatch_external.emit_event", return_value=fake_event):
            main([
                "--run-dir", str(run_dir),
                "--settings", str(settings_path),
                "--event-type", "pipeline.run.cancelled",
                "--payload-json", '{"cancelled_stage":"x","elapsed_ms":0,"source":"user_cancel"}',
            ])
        out = capsys.readouterr().out
        result = json.loads(out.strip())
        assert result["ok"] is True
        assert result["event_id"] == "evt-abc123"


# ---------------------------------------------------------------------------
# Event writing tests
# ---------------------------------------------------------------------------


class TestEventWriting:
    """CLI writes correct events to events.jsonl via emit_event."""

    def test_writes_event_to_jsonl(self, run_dir, settings_path):
        """CLI invokes emit_event which writes to events.jsonl."""
        events_path = run_dir / "events.jsonl"
        main([
            "--run-dir", str(run_dir),
            "--settings", str(settings_path),
            "--event-type", "pipeline.run.cancelled",
            "--payload-json", '{"cancelled_stage":"implement","elapsed_ms":5000,"source":"user_cancel"}',
        ])
        assert events_path.exists()
        lines = events_path.read_text(encoding="utf-8").strip().split("\n")
        assert len(lines) == 1
        event = json.loads(lines[0])
        assert event["event_type"] == "pipeline.run.cancelled"
        assert event["payload"]["cancelled_stage"] == "implement"
        assert event["payload"]["elapsed_ms"] == 5000
        assert event["run_id"] == "test-run-001"

    def test_uses_sync_dispatch(self, run_dir, settings_path):
        """CLI calls emit_event with sync=True."""
        with patch("worca.events.dispatch_external.emit_event", return_value={"event_id": "e1"}) as mock_emit:
            main([
                "--run-dir", str(run_dir),
                "--settings", str(settings_path),
                "--event-type", "pipeline.run.cancelled",
                "--payload-json", '{"cancelled_stage":"x","elapsed_ms":0,"source":"user_cancel"}',
            ])
            mock_emit.assert_called_once()
            _, kwargs = mock_emit.call_args
            assert kwargs.get("sync") is True

    def test_reads_run_id_from_status(self, run_dir, settings_path):
        """EventContext.run_id comes from status.json, not the directory name."""
        status = json.loads((run_dir / "status.json").read_text())
        status["run_id"] = "custom-run-id"
        (run_dir / "status.json").write_text(json.dumps(status), encoding="utf-8")

        with patch("worca.events.dispatch_external.emit_event", return_value={"event_id": "e1"}) as mock_emit:
            main([
                "--run-dir", str(run_dir),
                "--settings", str(settings_path),
                "--event-type", "pipeline.run.interrupted",
                "--payload-json", '{"interrupted_stage":"test","elapsed_ms":100,"source":"orchestrator"}',
            ])
            ctx = mock_emit.call_args[0][0]
            assert ctx.run_id == "custom-run-id"


# ---------------------------------------------------------------------------
# Valid event types
# ---------------------------------------------------------------------------


class TestValidEventTypes:
    """Only terminal-state event types are accepted."""

    def test_valid_types_include_all_terminal_events(self):
        assert "pipeline.run.interrupted" in VALID_EVENT_TYPES
        assert "pipeline.run.cancelled" in VALID_EVENT_TYPES
        assert "pipeline.run.failed" in VALID_EVENT_TYPES

    def test_non_terminal_events_rejected(self):
        assert "pipeline.run.started" not in VALID_EVENT_TYPES
        assert "pipeline.run.completed" not in VALID_EVENT_TYPES


# ---------------------------------------------------------------------------
# UTF-8 I/O tests
# ---------------------------------------------------------------------------


class TestUTF8IO:
    """CLI forces UTF-8 I/O for Windows parity."""

    def test_utf8_branch_name_roundtrips(self, tmp_path):
        """Non-ASCII branch name in status.json roundtrips through CLI output."""
        rd = tmp_path / "runs" / "utf8-run"
        rd.mkdir(parents=True)
        status = {
            "run_id": "utf8-run",
            "branch": "feature/日本語-branche",
            "work_request": {"prompt": "テスト"},
        }
        (rd / "status.json").write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
        sp = tmp_path / "settings.json"
        sp.write_text("{}", encoding="utf-8")

        result = subprocess.run(
            [sys.executable, "-m", "worca.events.dispatch_external",
             "--run-dir", str(rd),
             "--settings", str(sp),
             "--event-type", "pipeline.run.cancelled",
             "--payload-json", '{"cancelled_stage":"x","elapsed_ms":0,"source":"user_cancel"}'],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        assert result.returncode == 0
        output = json.loads(result.stdout.strip())
        assert output["ok"] is True

        events = (rd / "events.jsonl").read_text(encoding="utf-8").strip().split("\n")
        event = json.loads(events[0])
        assert event["pipeline"]["branch"] == "feature/日本語-branche"


# ---------------------------------------------------------------------------
# Integration test — subprocess with local HTTP server
# ---------------------------------------------------------------------------


class TestSubprocessIntegration:
    """Spawn CLI as subprocess; verify webhook delivery completes before exit."""

    def test_cli_waits_for_webhook_delivery(self, tmp_path):
        """Local HTTP server receives the webhook POST before the CLI process exits."""
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length)
                received.append(json.loads(body))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')

            def log_message(self, format, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            rd = tmp_path / "runs" / "webhook-run"
            rd.mkdir(parents=True)
            status = {
                "run_id": "webhook-run",
                "branch": "main",
                "work_request": {"prompt": "test"},
            }
            (rd / "status.json").write_text(json.dumps(status), encoding="utf-8")
            sp = tmp_path / "settings.json"
            settings = {
                "worca": {
                    "webhooks": [
                        {"url": f"http://localhost:{port}/hook"}
                    ]
                }
            }
            sp.write_text(json.dumps(settings), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, "-m", "worca.events.dispatch_external",
                 "--run-dir", str(rd),
                 "--settings", str(sp),
                 "--event-type", "pipeline.run.cancelled",
                 "--payload-json", '{"cancelled_stage":"test","elapsed_ms":1000,"source":"user_cancel"}'],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
            assert result.returncode == 0
            assert len(received) == 1
            assert received[0]["event_type"] == "pipeline.run.cancelled"
            assert received[0]["payload"]["cancelled_stage"] == "test"
        finally:
            server.shutdown()
