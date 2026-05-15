"""Tests for fleet-level webhook events (W-040 fleet lifecycle events).

Covers:
  - fleet_emitter.emit_fleet_event basic envelope shape + JSONL audit log
  - dispatch to worca.hooks (shell) + worca.webhooks (HTTP) settings paths
  - never-raises contract (bad settings, bad write path)
  - fleet_manifest.poll_and_update emits fleet.completed / fleet.failed /
    fleet.halted / fleet.circuit_breaker.tripped on actual transitions only
  - fleet_lifecycle.stop_fleet emits fleet.halted with halt_reason="stopped"
"""
import json
from unittest.mock import patch


# ---------------------------------------------------------------------------
# fleet_emitter — envelope shape + audit log
# ---------------------------------------------------------------------------


class TestEnvelopeShape:
    def test_envelope_has_required_top_level_fields(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        env = emit_fleet_event(
            "f_202605120900_test1234",
            "fleet.launched",
            {"projects": ["/repo/a"]},
            fleet_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        assert env is not None
        assert env["schema_version"] == "1"
        assert "event_id" in env and env["event_id"]
        assert env["event_type"] == "fleet.launched"
        assert "timestamp" in env and "T" in env["timestamp"]
        assert env["fleet_id"] == "f_202605120900_test1234"
        assert env["payload"] == {"projects": ["/repo/a"]}

    def test_event_id_is_unique_across_calls(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        a = emit_fleet_event(
            "f_202605120900_test1234", "fleet.launched", {"projects": []},
            fleet_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        b = emit_fleet_event(
            "f_202605120900_test1234", "fleet.launched", {"projects": []},
            fleet_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        assert a["event_id"] != b["event_id"]


class TestAuditLog:
    def test_writes_to_per_fleet_jsonl(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        emit_fleet_event(
            "f_X", "fleet.completed", {"child_count": 3},
            fleet_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        path = tmp_path / "f_X.events.jsonl"
        assert path.exists()
        lines = path.read_text().strip().splitlines()
        assert len(lines) == 1
        record = json.loads(lines[0])
        assert record["event_type"] == "fleet.completed"

    def test_appends_multiple_events(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        for et in ["fleet.launched", "fleet.completed"]:
            emit_fleet_event(
                "f_X", et, {},
                fleet_runs_dir=str(tmp_path),
                settings_path=str(tmp_path / "settings-missing.json"),
            )
        path = tmp_path / "f_X.events.jsonl"
        lines = path.read_text().strip().splitlines()
        assert len(lines) == 2
        types = [json.loads(line)["event_type"] for line in lines]
        assert types == ["fleet.launched", "fleet.completed"]


class TestNeverRaisesContract:
    def test_returns_envelope_when_settings_missing(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        env = emit_fleet_event(
            "f_X", "fleet.launched", {"projects": []},
            fleet_runs_dir=str(tmp_path),
            settings_path="/nonexistent/path/settings.json",
        )
        # Audit log still written, envelope returned — settings-load failure
        # must not abort emission.
        assert env is not None
        assert (tmp_path / "f_X.events.jsonl").exists()

    def test_unserializable_payload_returns_none_without_raising(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        # Sets aren't JSON-serializable.
        env = emit_fleet_event(
            "f_X", "fleet.launched", {"oops": {1, 2, 3}},
            fleet_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        assert env is None


class TestShellHookDispatch:
    def _write_settings(self, tmp_path, hooks=None, webhooks=None):
        settings = {"worca": {}}
        if hooks is not None:
            settings["worca"]["hooks"] = hooks
        if webhooks is not None:
            settings["worca"]["webhooks"] = webhooks
        path = tmp_path / "settings.json"
        path.write_text(json.dumps(settings))
        return path

    def test_dispatches_to_event_type_match(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        settings_path = self._write_settings(
            tmp_path, hooks={"fleet.launched": ["echo dummy"]}
        )
        with patch(
            "worca.events.fleet_emitter.dispatch_shell_hooks"
        ) as mock_disp:
            emit_fleet_event(
                "f_X", "fleet.launched", {},
                fleet_runs_dir=str(tmp_path),
                settings_path=str(settings_path),
            )
        assert mock_disp.called
        envelope, config = mock_disp.call_args[0]
        assert envelope["event_type"] == "fleet.launched"
        assert config == {"fleet.launched": ["echo dummy"]}

    def test_does_not_dispatch_when_no_hooks(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        settings_path = self._write_settings(tmp_path)  # empty worca
        with patch(
            "worca.events.fleet_emitter.dispatch_shell_hooks"
        ) as mock_disp:
            emit_fleet_event(
                "f_X", "fleet.launched", {},
                fleet_runs_dir=str(tmp_path),
                settings_path=str(settings_path),
            )
        assert not mock_disp.called


class TestWebhookDispatch:
    def _write_settings(self, tmp_path, webhooks):
        path = tmp_path / "settings.json"
        path.write_text(json.dumps({"worca": {"webhooks": webhooks}}))
        return path

    def test_observational_webhooks_receive_event(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        wh = {"url": "https://example.invalid/hook", "secret": "x"}
        settings_path = self._write_settings(tmp_path, [wh])
        with patch("worca.events.webhook.deliver_webhook") as mock_deliver:
            emit_fleet_event(
                "f_X", "fleet.completed", {"child_count": 1},
                fleet_runs_dir=str(tmp_path),
                settings_path=str(settings_path),
            )
        assert mock_deliver.called
        envelope, webhook_arg = mock_deliver.call_args[0]
        assert envelope["event_type"] == "fleet.completed"
        assert webhook_arg["url"] == wh["url"]

    def test_control_webhooks_skipped(self, tmp_path):
        from worca.events.fleet_emitter import emit_fleet_event

        wh = {
            "url": "https://example.invalid/control",
            "control": True,
            "secret": "x",
        }
        settings_path = self._write_settings(tmp_path, [wh])
        with patch("worca.events.webhook.deliver_webhook") as mock_deliver:
            emit_fleet_event(
                "f_X", "fleet.halted", {"halt_reason": "stopped"},
                fleet_runs_dir=str(tmp_path),
                settings_path=str(settings_path),
            )
        # control:true webhooks are pipeline-only — fleet events skip them.
        assert not mock_deliver.called


# ---------------------------------------------------------------------------
# fleet_manifest.poll_and_update_fleet_manifest — transition emission
# ---------------------------------------------------------------------------


def _seed_manifest_with_children(tmp_path, fleet_id, child_statuses, status="running"):
    """Synthesise a fleet manifest + per-project registry entries."""
    from worca.orchestrator.fleet_manifest import write_fleet_manifest

    children = []
    for i, child_status in enumerate(child_statuses):
        project = tmp_path / f"repo_{i}"
        (project / ".worca" / "multi" / "pipelines.d").mkdir(
            parents=True, exist_ok=True
        )
        run_id = f"run_{i}"
        entry_path = (
            project / ".worca" / "multi" / "pipelines.d" / f"{run_id}.json"
        )
        entry_path.write_text(json.dumps({"run_id": run_id, "status": child_status}))
        children.append({"project_path": str(project), "run_id": run_id})

    manifest = {
        "fleet_id": fleet_id,
        "fleet_id_short": fleet_id.rsplit("_", 1)[-1],
        "status": status,
        "halt_reason": None,
        "fleet_failure_threshold": 0.30,
        "children": children,
    }
    fleet_runs_dir = tmp_path / "fleet-runs"
    fleet_runs_dir.mkdir(exist_ok=True)
    write_fleet_manifest(manifest, base_dir=str(fleet_runs_dir))
    return fleet_runs_dir


class TestPollAndUpdateEmission:
    def test_completed_transition_emits_fleet_completed(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest

        fleet_runs_dir = _seed_manifest_with_children(
            tmp_path, "f_complete", ["completed", "completed"]
        )
        with patch(
            "worca.events.fleet_emitter.emit_fleet_event"
        ) as mock_emit:
            poll_and_update_fleet_manifest(
                "f_complete", manifest_base_dir=str(fleet_runs_dir)
            )
        # Exactly one emit, fleet.completed.
        assert mock_emit.call_count == 1
        args, _ = mock_emit.call_args
        assert args[1] == "fleet.completed"
        assert args[2]["child_count"] == 2
        assert args[2]["completed_count"] == 2

    def test_failed_transition_emits_fleet_failed(self, tmp_path):
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest

        fleet_runs_dir = _seed_manifest_with_children(
            tmp_path, "f_failed", ["failed", "completed"]
        )
        with patch(
            "worca.events.fleet_emitter.emit_fleet_event"
        ) as mock_emit:
            poll_and_update_fleet_manifest(
                "f_failed", manifest_base_dir=str(fleet_runs_dir)
            )
        types = [c.args[1] for c in mock_emit.call_args_list]
        assert "fleet.failed" in types
        # No spurious completed/halted firings.
        assert "fleet.completed" not in types

    def test_circuit_breaker_emits_two_events(self, tmp_path):
        """The breaker tripping is BOTH halt + breaker-specific."""
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest

        # 3 failed + 2 running, threshold 0.30 → trips.
        fleet_runs_dir = _seed_manifest_with_children(
            tmp_path,
            "f_breaker",
            ["failed", "failed", "failed", "running", "running"],
        )
        with patch(
            "worca.events.fleet_emitter.emit_fleet_event"
        ) as mock_emit:
            poll_and_update_fleet_manifest(
                "f_breaker", manifest_base_dir=str(fleet_runs_dir)
            )
        types = [c.args[1] for c in mock_emit.call_args_list]
        assert "fleet.circuit_breaker.tripped" in types
        assert "fleet.halted" in types

    def test_no_emission_on_no_op_poll(self, tmp_path):
        """Polling a stable 'running' fleet must NOT spam events."""
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest

        fleet_runs_dir = _seed_manifest_with_children(
            tmp_path, "f_stable", ["running", "running"]
        )
        with patch(
            "worca.events.fleet_emitter.emit_fleet_event"
        ) as mock_emit:
            for _ in range(3):
                poll_and_update_fleet_manifest(
                    "f_stable", manifest_base_dir=str(fleet_runs_dir)
                )
        assert mock_emit.call_count == 0

    def test_sticky_halt_no_re_emit(self, tmp_path):
        """A fleet already in 'halted' state must not re-emit on re-poll."""
        from worca.orchestrator.fleet_manifest import poll_and_update_fleet_manifest

        fleet_runs_dir = _seed_manifest_with_children(
            tmp_path, "f_held", ["completed"], status="halted"
        )
        with patch(
            "worca.events.fleet_emitter.emit_fleet_event"
        ) as mock_emit:
            poll_and_update_fleet_manifest(
                "f_held", manifest_base_dir=str(fleet_runs_dir)
            )
        assert mock_emit.call_count == 0


# ---------------------------------------------------------------------------
# fleet_lifecycle.stop_fleet — halt emission
# ---------------------------------------------------------------------------


class TestStopFleetEmission:
    def test_stop_fleet_emits_halted_event(self, tmp_path, monkeypatch):
        """stop_fleet emits fleet.halted with halt_reason=stopped."""
        from worca.orchestrator import fleet_lifecycle
        from worca.orchestrator.fleet_manifest import write_fleet_manifest

        # Manifest in the default location (lifecycle.py reads it without
        # a base_dir override). Monkeypatch _FLEET_RUNS_DIR.
        monkeypatch.setattr(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", str(tmp_path)
        )

        project = tmp_path / "repo_a"
        (project / ".worca" / "multi" / "pipelines.d").mkdir(parents=True)
        entry_path = (
            project / ".worca" / "multi" / "pipelines.d" / "run_a.json"
        )
        entry_path.write_text(
            json.dumps({"run_id": "run_a", "status": "running"})
        )

        write_fleet_manifest(
            {
                "fleet_id": "f_stop",
                "fleet_id_short": "stop",
                "status": "running",
                "halt_reason": None,
                "children": [
                    {"project_path": str(project), "run_id": "run_a"}
                ],
            },
            base_dir=str(tmp_path),
        )

        # Mock cmd_stop so we don't actually try to SIGTERM anything.
        with patch(
            "worca.scripts.worca_lifecycle.cmd_stop"
        ) as mock_cmd_stop, patch(
            "worca.events.fleet_emitter.emit_fleet_event"
        ) as mock_emit:
            count = fleet_lifecycle.stop_fleet("f_stop")

        assert count == 1
        mock_cmd_stop.assert_called_once()
        assert mock_emit.called
        args = mock_emit.call_args.args
        assert args[1] == "fleet.halted"
        assert args[2]["halt_reason"] == "stopped"
        assert args[2]["in_flight_count"] == 1

    def test_stop_fleet_missing_manifest_no_emit(self, tmp_path, monkeypatch):
        from worca.orchestrator import fleet_lifecycle

        monkeypatch.setattr(
            "worca.orchestrator.fleet_manifest._FLEET_RUNS_DIR", str(tmp_path)
        )
        with patch(
            "worca.events.fleet_emitter.emit_fleet_event"
        ) as mock_emit:
            result = fleet_lifecycle.stop_fleet("f_does_not_exist")
        assert result is None
        assert not mock_emit.called


# ---------------------------------------------------------------------------
# Payload builders — keep the wire format stable
# ---------------------------------------------------------------------------


class TestPayloadBuilders:
    def test_launched_required_only(self):
        from worca.events.types import fleet_launched_payload

        p = fleet_launched_payload(["/repo/a", "/repo/b"])
        assert p["projects"] == ["/repo/a", "/repo/b"]
        assert p["plan_mode"] == "none"
        assert p["guide_attached"] is False
        # Optional fields omitted when None.
        assert "head_template" not in p
        assert "max_parallel" not in p

    def test_launched_with_optionals(self):
        from worca.events.types import fleet_launched_payload

        p = fleet_launched_payload(
            ["/repo/a"],
            head_template="m/{project}",
            base_branch="main",
            plan_mode="plan-first",
            plan_path="/abs/plan.md",
            guide_attached=True,
            max_parallel=5,
            failure_threshold=0.30,
            child_count=1,
        )
        assert p["head_template"] == "m/{project}"
        assert p["base_branch"] == "main"
        assert p["plan_mode"] == "plan-first"
        assert p["plan_path"] == "/abs/plan.md"
        assert p["guide_attached"] is True
        assert p["max_parallel"] == 5
        assert p["failure_threshold"] == 0.30

    def test_halted_payload(self):
        from worca.events.types import fleet_halted_payload

        p = fleet_halted_payload("stopped", in_flight_count=3, pending_count=2)
        assert p["halt_reason"] == "stopped"
        assert p["in_flight_count"] == 3
        assert p["pending_count"] == 2

    def test_circuit_breaker_payload_computes_ratio(self):
        from worca.events.types import fleet_circuit_breaker_tripped_payload

        p = fleet_circuit_breaker_tripped_payload(
            failed_count=3, terminal_count=4, total_count=5, threshold=0.30
        )
        assert p["failure_ratio"] == 0.75
        assert p["threshold"] == 0.30

    def test_circuit_breaker_payload_handles_zero_terminal(self):
        from worca.events.types import fleet_circuit_breaker_tripped_payload

        p = fleet_circuit_breaker_tripped_payload(
            failed_count=0, terminal_count=0, total_count=5, threshold=0.30
        )
        assert p["failure_ratio"] == 0.0  # no zero-division
