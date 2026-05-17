"""Tests for workspace-level webhook events (W-047 coordinator events).

Mirrors tests/test_fleet_events.py for the fleet emitter. Covers:
  - workspace_emitter.emit_workspace_event envelope shape + audit log
  - dispatch to worca.hooks (shell) + worca.webhooks (HTTP) settings paths
  - never-raises contract (bad settings, bad payload)
  - DagExecutor emits tier.started/.completed/.failed +
    circuit_breaker.tripped + halted at the right transitions
  - lifecycle.halt_workspace emits workspace.halted with halt_reason="user"
"""
import json
from unittest.mock import patch


# ---------------------------------------------------------------------------
# workspace_emitter — envelope shape + audit log
# ---------------------------------------------------------------------------


class TestEnvelopeShape:
    def test_envelope_has_required_top_level_fields(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        env = emit_workspace_event(
            "ws_202605120900_test1234",
            "workspace.launched",
            {"projects": ["repo-a"], "workspace_name": "my-ws"},
            workspace_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        assert env is not None
        assert env["schema_version"] == "1"
        assert "event_id" in env and env["event_id"]
        assert env["event_type"] == "workspace.launched"
        assert "timestamp" in env and "T" in env["timestamp"]
        assert env["workspace_id"] == "ws_202605120900_test1234"
        assert env["payload"]["projects"] == ["repo-a"]
        assert env["payload"]["workspace_name"] == "my-ws"

    def test_event_id_is_unique_across_calls(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        a = emit_workspace_event(
            "ws_X", "workspace.launched", {"projects": []},
            workspace_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        b = emit_workspace_event(
            "ws_X", "workspace.launched", {"projects": []},
            workspace_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        assert a["event_id"] != b["event_id"]


class TestAuditLog:
    def test_writes_to_per_workspace_jsonl(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        emit_workspace_event(
            "ws_X", "workspace.completed", {"workspace_name": "x", "child_count": 3},
            workspace_runs_dir=str(tmp_path),
            settings_path=str(tmp_path / "settings-missing.json"),
        )
        path = tmp_path / "ws_X.events.jsonl"
        assert path.exists()
        lines = path.read_text().strip().splitlines()
        assert len(lines) == 1
        record = json.loads(lines[0])
        assert record["event_type"] == "workspace.completed"
        assert record["workspace_id"] == "ws_X"

    def test_appends_multiple_events(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        for et in [
            "workspace.launched",
            "workspace.tier.started",
            "workspace.tier.completed",
            "workspace.completed",
        ]:
            emit_workspace_event(
                "ws_X", et, {"workspace_name": "x"},
                workspace_runs_dir=str(tmp_path),
                settings_path=str(tmp_path / "settings-missing.json"),
            )
        path = tmp_path / "ws_X.events.jsonl"
        lines = path.read_text().strip().splitlines()
        assert len(lines) == 4
        types = [json.loads(line)["event_type"] for line in lines]
        assert types == [
            "workspace.launched",
            "workspace.tier.started",
            "workspace.tier.completed",
            "workspace.completed",
        ]


class TestNeverRaisesContract:
    def test_returns_envelope_when_settings_missing(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        env = emit_workspace_event(
            "ws_X", "workspace.launched", {"projects": []},
            workspace_runs_dir=str(tmp_path),
            settings_path="/nonexistent/path/settings.json",
        )
        # Audit log still written, envelope returned — settings-load failure
        # must not abort emission.
        assert env is not None
        assert (tmp_path / "ws_X.events.jsonl").exists()

    def test_unserializable_payload_returns_none_without_raising(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        # Sets aren't JSON-serializable.
        env = emit_workspace_event(
            "ws_X", "workspace.launched", {"oops": {1, 2, 3}},
            workspace_runs_dir=str(tmp_path),
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
        from worca.events.workspace_emitter import emit_workspace_event

        settings_path = self._write_settings(
            tmp_path, hooks={"workspace.launched": ["echo dummy"]}
        )
        with patch(
            "worca.events.workspace_emitter.dispatch_shell_hooks"
        ) as mock_disp:
            emit_workspace_event(
                "ws_X", "workspace.launched", {"workspace_name": "x"},
                workspace_runs_dir=str(tmp_path),
                settings_path=str(settings_path),
            )
        assert mock_disp.called
        envelope, config = mock_disp.call_args[0]
        assert envelope["event_type"] == "workspace.launched"
        assert config == {"workspace.launched": ["echo dummy"]}

    def test_does_not_dispatch_when_no_hooks(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        settings_path = self._write_settings(tmp_path)  # empty worca
        with patch(
            "worca.events.workspace_emitter.dispatch_shell_hooks"
        ) as mock_disp:
            emit_workspace_event(
                "ws_X", "workspace.launched", {"workspace_name": "x"},
                workspace_runs_dir=str(tmp_path),
                settings_path=str(settings_path),
            )
        assert not mock_disp.called


class TestWebhookDispatch:
    def _write_settings(self, tmp_path, webhooks):
        path = tmp_path / "settings.json"
        path.write_text(json.dumps({"worca": {"webhooks": webhooks}}))
        return path

    def test_observational_webhooks_receive_event(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        wh = {"url": "https://example.invalid/hook", "secret": "x"}
        settings_path = self._write_settings(tmp_path, [wh])
        with patch("worca.events.webhook.deliver_webhook") as mock_deliver:
            emit_workspace_event(
                "ws_X", "workspace.completed",
                {"workspace_name": "x", "child_count": 1},
                workspace_runs_dir=str(tmp_path),
                settings_path=str(settings_path),
            )
        assert mock_deliver.called
        envelope, webhook_arg = mock_deliver.call_args[0]
        assert envelope["event_type"] == "workspace.completed"
        assert webhook_arg["url"] == wh["url"]

    def test_control_webhooks_skipped(self, tmp_path):
        from worca.events.workspace_emitter import emit_workspace_event

        wh = {
            "url": "https://example.invalid/control",
            "control": True,
            "secret": "x",
        }
        settings_path = self._write_settings(tmp_path, [wh])
        with patch("worca.events.webhook.deliver_webhook") as mock_deliver:
            emit_workspace_event(
                "ws_X", "workspace.halted",
                {"workspace_name": "x", "halt_reason": "user"},
                workspace_runs_dir=str(tmp_path),
                settings_path=str(settings_path),
            )
        # control:true webhooks are pipeline-only — workspace events skip them.
        assert not mock_deliver.called


# ---------------------------------------------------------------------------
# halt_workspace lifecycle — workspace.halted emission
# ---------------------------------------------------------------------------


class TestHaltWorkspaceEmission:
    def test_halt_emits_halted_with_user_reason(self, tmp_path):
        """halt_workspace emits workspace.halted with halt_reason='user'."""
        from worca.scripts.run_workspace import (
            create_workspace_run_dir,
            write_pointer_file,
            write_workspace_manifest,
        )
        from worca.workspace.lifecycle import halt_workspace

        workspace_root = tmp_path / "ws_root"
        workspace_root.mkdir()
        run_dir = create_workspace_run_dir(
            str(workspace_root), "ws_halt_test_1234"
        )
        pointer_dir = tmp_path / "pointers"
        write_pointer_file(
            "ws_halt_test_1234",
            str(workspace_root),
            pointer_dir=str(pointer_dir),
        )

        manifest = {
            "workspace_id": "ws_halt_test_1234",
            "workspace_name": "my-platform",
            "workspace_root": str(workspace_root),
            "status": "running",
            "halt_reason": None,
            "dag": {
                "tiers": [
                    {"tier": 0, "projects": ["a"], "status": "completed"},
                    {"tier": 1, "projects": ["b"], "status": "pending"},
                ],
                "dependency_graph": {"a": [], "b": ["a"]},
            },
            "children": [
                {"project": "a", "status": "completed", "tier": 0},
            ],
        }
        write_workspace_manifest(manifest, run_dir)

        with patch(
            "worca.events.workspace_emitter.emit_workspace_event"
        ) as mock_emit:
            ok = halt_workspace(
                "ws_halt_test_1234", pointer_dir=str(pointer_dir),
            )

        assert ok is True
        assert mock_emit.called
        args = mock_emit.call_args.args
        assert args[0] == "ws_halt_test_1234"
        assert args[1] == "workspace.halted"
        payload = args[2]
        assert payload["halt_reason"] == "user"
        assert payload["workspace_name"] == "my-platform"
        assert payload["completed_tiers"] == 1

    def test_halt_already_terminal_does_not_emit(self, tmp_path):
        from worca.scripts.run_workspace import (
            create_workspace_run_dir,
            write_pointer_file,
            write_workspace_manifest,
        )
        from worca.workspace.lifecycle import halt_workspace

        workspace_root = tmp_path / "ws_root"
        workspace_root.mkdir()
        run_dir = create_workspace_run_dir(
            str(workspace_root), "ws_term_test_1234"
        )
        pointer_dir = tmp_path / "pointers"
        write_pointer_file(
            "ws_term_test_1234",
            str(workspace_root),
            pointer_dir=str(pointer_dir),
        )

        manifest = {
            "workspace_id": "ws_term_test_1234",
            "workspace_name": "x",
            "workspace_root": str(workspace_root),
            "status": "completed",  # already terminal
            "halt_reason": None,
            "dag": {"tiers": [], "dependency_graph": {}},
            "children": [],
        }
        write_workspace_manifest(manifest, run_dir)

        with patch(
            "worca.events.workspace_emitter.emit_workspace_event"
        ) as mock_emit:
            ok = halt_workspace(
                "ws_term_test_1234", pointer_dir=str(pointer_dir),
            )

        assert ok is False
        assert not mock_emit.called


# ---------------------------------------------------------------------------
# DagExecutor tier + circuit-breaker emissions
# ---------------------------------------------------------------------------


def _build_minimal_dag_manifest(tmp_path, *, tiers, dependency_graph=None,
                                projects_by_name=None, threshold=None):
    """Minimal manifest for DagExecutor.execute() — no real subprocess."""
    if dependency_graph is None:
        dependency_graph = {}
    if projects_by_name is None:
        projects_by_name = {}
        for tier in tiers:
            for p in tier:
                projects_by_name[p] = p
    workspace_root = tmp_path / "ws_root"
    workspace_root.mkdir(exist_ok=True)
    return {
        "workspace_id": "ws_dag_test_5678",
        "workspace_name": "dag-test",
        "workspace_root": str(workspace_root),
        "max_parallel": 5,
        "work_request": {"description": "test prompt"},
        "guide": {"paths": []},
        "plan": {"project_plans": {}},
        "projects_by_name": projects_by_name,
        "failure_threshold": threshold,
        "children": [],
        "dag": {
            "tiers": [
                {"tier": i, "projects": list(t), "status": "pending"}
                for i, t in enumerate(tiers)
            ],
            "dependency_graph": dependency_graph,
        },
    }


class TestDagExecutorEmissions:
    def test_tier_started_and_completed_emit(self, tmp_path):
        """A single-tier all-pass run emits tier.started + tier.completed."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _build_minimal_dag_manifest(
            tmp_path, tiers=[["a", "b"]],
        )
        run_dir = tmp_path / "run_dir"
        run_dir.mkdir()

        with patch(
            "worca.workspace.dag_executor._emit",
        ) as mock_emit, patch.object(
            DagExecutor, "_run_child",
            return_value={"status": "completed", "run_id": "r1",
                          "worktree_path": "/wt/a"},
        ), patch(
            "worca.scripts.run_workspace.write_workspace_manifest",
        ):
            ex = DagExecutor(manifest, str(run_dir))
            result = ex.execute()

        assert result["status"] == "completed"

        types_emitted = [c.args[0] for c in mock_emit.call_args_list]
        assert "workspace.tier.started" in types_emitted
        assert "workspace.tier.completed" in types_emitted
        assert "workspace.tier.failed" not in types_emitted

        # Tier started payload includes both projects.
        started_calls = [
            c for c in mock_emit.call_args_list
            if c.args[0] == "workspace.tier.started"
        ]
        assert len(started_calls) == 1
        assert sorted(started_calls[0].args[1]["projects"]) == ["a", "b"]

    def test_tier_failed_emit_when_child_fails(self, tmp_path):
        from worca.workspace.dag_executor import DagExecutor

        manifest = _build_minimal_dag_manifest(
            tmp_path, tiers=[["a"]],
        )
        run_dir = tmp_path / "run_dir"
        run_dir.mkdir()

        with patch(
            "worca.workspace.dag_executor._emit",
        ) as mock_emit, patch.object(
            DagExecutor, "_run_child",
            return_value={"status": "failed", "run_id": None,
                          "worktree_path": None},
        ), patch(
            "worca.scripts.run_workspace.write_workspace_manifest",
        ):
            ex = DagExecutor(manifest, str(run_dir))
            result = ex.execute()

        assert result["status"] == "failed"
        types_emitted = [c.args[0] for c in mock_emit.call_args_list]
        assert "workspace.tier.failed" in types_emitted
        assert "workspace.tier.completed" not in types_emitted
        failed_call = next(
            c for c in mock_emit.call_args_list
            if c.args[0] == "workspace.tier.failed"
        )
        assert failed_call.args[1]["failed_projects"] == ["a"]

    def test_circuit_breaker_emits_tripped_and_halted(self, tmp_path):
        """When the failure threshold trips mid-execution, both events fire."""
        from worca.workspace.dag_executor import DagExecutor

        # Three-tier run — first tier fails all 3 with threshold 0.30,
        # which trips the breaker entering tier 1.
        manifest = _build_minimal_dag_manifest(
            tmp_path,
            tiers=[["a", "b", "c"], ["d"], ["e"]],
            threshold=0.30,
        )
        run_dir = tmp_path / "run_dir"
        run_dir.mkdir()

        with patch(
            "worca.workspace.dag_executor._emit",
        ) as mock_emit, patch.object(
            DagExecutor, "_run_child",
            return_value={"status": "failed", "run_id": None,
                          "worktree_path": None},
        ), patch(
            "worca.scripts.run_workspace.write_workspace_manifest",
        ):
            ex = DagExecutor(manifest, str(run_dir))
            result = ex.execute()

        assert result["status"] == "halted"
        types_emitted = [c.args[0] for c in mock_emit.call_args_list]
        assert "workspace.circuit_breaker.tripped" in types_emitted
        assert "workspace.halted" in types_emitted
        # The halted payload carries halt_reason="circuit_breaker".
        halted_call = next(
            c for c in mock_emit.call_args_list if c.args[0] == "workspace.halted"
        )
        assert halted_call.args[1]["halt_reason"] == "circuit_breaker"

    def test_no_emission_for_skipped_already_completed_tier(self, tmp_path):
        """Re-running a manifest with a completed tier shouldn't re-emit it."""
        from worca.workspace.dag_executor import DagExecutor

        manifest = _build_minimal_dag_manifest(
            tmp_path, tiers=[["a"], ["b"]],
        )
        # Mark tier 0 already completed + child registered.
        manifest["dag"]["tiers"][0]["status"] = "completed"
        manifest["children"].append({
            "project": "a", "status": "completed", "tier": 0,
            "worktree_path": "/wt/a", "run_id": "r1",
        })

        run_dir = tmp_path / "run_dir"
        run_dir.mkdir()

        with patch(
            "worca.workspace.dag_executor._emit",
        ) as mock_emit, patch.object(
            DagExecutor, "_run_child",
            return_value={"status": "completed", "run_id": "r2",
                          "worktree_path": "/wt/b"},
        ), patch(
            "worca.scripts.run_workspace.write_workspace_manifest",
        ):
            ex = DagExecutor(manifest, str(run_dir))
            ex.execute()

        started_payloads = [
            c.args[1] for c in mock_emit.call_args_list
            if c.args[0] == "workspace.tier.started"
        ]
        # Only tier 1 should emit tier.started — tier 0 was already completed.
        assert len(started_payloads) == 1
        assert started_payloads[0]["tier"] == 1
