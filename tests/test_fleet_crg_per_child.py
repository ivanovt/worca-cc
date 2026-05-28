"""Fleet CRG per-child enablement (W-057 §10, Phase 4).

Mirrors the graphify per-child pattern: each child's effective CRG config
is resolved independently, crg_status is recorded in the fleet manifest,
and CRG-degraded does NOT count as a pipeline failure for the circuit breaker.
"""

import json
import os


from worca.orchestrator.fleet_manifest import (
    GRAPH_STATUS_DEGRADED,
    GRAPH_STATUS_DISABLED,
    GRAPH_STATUS_READY,
    read_fleet_manifest,
    register_fleet_child,
    write_fleet_manifest,
)


# ---------------------------------------------------------------------------
# detect_child_crg_status
# ---------------------------------------------------------------------------


class TestDetectChildCrgStatus:
    """detect_child_crg_status resolves each child's CRG config independently."""

    def test_disabled_when_project_has_no_crg_config(self, tmp_path):
        """A project with no code_review_graph block → disabled."""
        from worca.scripts.run_fleet import detect_child_crg_status

        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir(parents=True)
        (settings_dir / "settings.json").write_text(json.dumps({"worca": {}}))

        assert detect_child_crg_status(str(tmp_path)) == GRAPH_STATUS_DISABLED

    def test_disabled_when_global_kills(self, tmp_path, monkeypatch):
        """Global enabled:false overrides project enabled:true → disabled."""
        from worca.scripts.run_fleet import detect_child_crg_status

        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir(parents=True)
        (settings_dir / "settings.json").write_text(
            json.dumps({"worca": {"code_review_graph": {"enabled": True}}})
        )

        monkeypatch.setattr(
            "worca.scripts.run_fleet.load_global_settings",
            lambda: {"worca": {"code_review_graph": {"enabled": False}}},
        )
        assert detect_child_crg_status(str(tmp_path)) == GRAPH_STATUS_DISABLED

    def test_degraded_when_cli_missing(self, tmp_path, monkeypatch):
        """Enabled but CLI not installed → degraded."""
        from worca.scripts.run_fleet import detect_child_crg_status
        from worca.utils.code_review_graph import CrgDetect

        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir(parents=True)
        (settings_dir / "settings.json").write_text(
            json.dumps({"worca": {"code_review_graph": {"enabled": True}}})
        )
        monkeypatch.setattr(
            "worca.scripts.run_fleet.load_global_settings",
            lambda: {},
        )
        monkeypatch.setattr(
            "worca.scripts.run_fleet.detect_code_review_graph",
            lambda **kw: CrgDetect(
                installed=False, version=None, compatible=False,
                fastmcp_ok=False, error="not found",
            ),
        )
        assert detect_child_crg_status(str(tmp_path)) == GRAPH_STATUS_DEGRADED

    def test_degraded_when_fastmcp_missing(self, tmp_path, monkeypatch):
        """Enabled, CRG installed, but fastmcp missing → degraded."""
        from worca.scripts.run_fleet import detect_child_crg_status
        from worca.utils.code_review_graph import CrgDetect

        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir(parents=True)
        (settings_dir / "settings.json").write_text(
            json.dumps({"worca": {"code_review_graph": {"enabled": True}}})
        )
        monkeypatch.setattr(
            "worca.scripts.run_fleet.load_global_settings",
            lambda: {},
        )
        monkeypatch.setattr(
            "worca.scripts.run_fleet.detect_code_review_graph",
            lambda **kw: CrgDetect(
                installed=True, version="2.2.3", compatible=True,
                fastmcp_ok=False, error="fastmcp not found",
            ),
        )
        assert detect_child_crg_status(str(tmp_path)) == GRAPH_STATUS_DEGRADED

    def test_ready_when_all_present(self, tmp_path, monkeypatch):
        """Enabled, CLI + fastmcp present → ready."""
        from worca.scripts.run_fleet import detect_child_crg_status
        from worca.utils.code_review_graph import CrgDetect

        settings_dir = tmp_path / ".claude"
        settings_dir.mkdir(parents=True)
        (settings_dir / "settings.json").write_text(
            json.dumps({"worca": {"code_review_graph": {"enabled": True}}})
        )
        monkeypatch.setattr(
            "worca.scripts.run_fleet.load_global_settings",
            lambda: {},
        )
        monkeypatch.setattr(
            "worca.scripts.run_fleet.detect_code_review_graph",
            lambda **kw: CrgDetect(
                installed=True, version="2.2.3", compatible=True,
                fastmcp_ok=True, error=None,
            ),
        )
        assert detect_child_crg_status(str(tmp_path)) == GRAPH_STATUS_READY

    def test_disabled_on_exception(self, tmp_path):
        """If settings can't be loaded, returns disabled (never crashes)."""
        from worca.scripts.run_fleet import detect_child_crg_status

        assert detect_child_crg_status(str(tmp_path / "nonexistent")) == GRAPH_STATUS_DISABLED


# ---------------------------------------------------------------------------
# register_fleet_child with crg_status
# ---------------------------------------------------------------------------


class TestRegisterFleetChildCrgStatus:
    """register_fleet_child records crg_status in the manifest."""

    def _make_manifest(self, tmp_path, fleet_id="fleet-test"):
        base_dir = str(tmp_path / "fleet-runs")
        os.makedirs(base_dir, exist_ok=True)
        manifest = {
            "fleet_id": fleet_id,
            "status": "running",
            "children": [],
        }
        write_fleet_manifest(manifest, base_dir=base_dir)
        return base_dir

    def test_crg_status_recorded(self, tmp_path):
        base_dir = self._make_manifest(tmp_path)
        register_fleet_child(
            "fleet-test", "/proj/a", "run-001",
            graph_status="ready",
            crg_status="degraded",
            base_dir=base_dir,
        )
        m = read_fleet_manifest("fleet-test", base_dir=base_dir)
        child = m["children"][0]
        assert child["crg_status"] == "degraded"
        assert child["graph_status"] == "ready"

    def test_crg_status_omitted_when_none(self, tmp_path):
        base_dir = self._make_manifest(tmp_path)
        register_fleet_child(
            "fleet-test", "/proj/a", "run-001",
            base_dir=base_dir,
        )
        m = read_fleet_manifest("fleet-test", base_dir=base_dir)
        child = m["children"][0]
        assert "crg_status" not in child

    def test_crg_status_disabled(self, tmp_path):
        base_dir = self._make_manifest(tmp_path)
        register_fleet_child(
            "fleet-test", "/proj/a", "run-001",
            crg_status="disabled",
            base_dir=base_dir,
        )
        m = read_fleet_manifest("fleet-test", base_dir=base_dir)
        assert m["children"][0]["crg_status"] == "disabled"


# ---------------------------------------------------------------------------
# Circuit breaker ignores CRG degradation
# ---------------------------------------------------------------------------


class TestCircuitBreakerIgnoresCrgDegraded:
    """CRG-degraded children that complete successfully do NOT trip the breaker."""

    def test_completed_with_crg_degraded_is_not_failure(self, tmp_path):
        base_dir = str(tmp_path / "fleet-runs")
        os.makedirs(base_dir, exist_ok=True)
        manifest = {
            "fleet_id": "fleet-cb",
            "status": "running",
            "children": [],
        }
        write_fleet_manifest(manifest, base_dir=base_dir)

        for i in range(5):
            register_fleet_child(
                "fleet-cb", f"/proj/{i}", f"run-{i:03d}",
                crg_status="degraded",
                base_dir=base_dir,
            )

        m = read_fleet_manifest("fleet-cb", base_dir=base_dir)
        assert len(m["children"]) == 5
        for child in m["children"]:
            assert child["crg_status"] == "degraded"
            assert child["status"] == "running"
