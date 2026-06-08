"""Standalone vs delta template export.

Covers the W-0xx "export a self-contained bundle" work:
  - default_pipeline_config() / materialize_config() correctness
  - a drift guard asserting the snapshot still matches the live resolver defaults
  - CLI export in standalone mode (config materialised, prompts resolved,
    export_mode marker, secret scrubbing still applied)
  - CLI export in delta mode (sparse config preserved)
"""

import json
import zipfile
from unittest.mock import patch

from worca.cli.main import main
from worca.orchestrator.stages import (
    STAGE_AGENT_MAP,
    Stage,
    get_enabled_stages,
    get_stage_config,
)
from worca.orchestrator.templates import (
    default_pipeline_config,
    materialize_config,
)


def _minimal(tid, tier="project"):
    return {
        "id": tid,
        "name": tid.title(),
        "description": f"{tid} template",
        "builtin": tier == "builtin",
        "created_at": "2026-01-01T00:00:00Z",
        "tags": [],
        "params": {},
        "config": {},
    }


def _write_template(tmpl_dir, data):
    tmpl_dir.mkdir(parents=True, exist_ok=True)
    (tmpl_dir / "template.json").write_text(json.dumps(data), encoding="utf-8")


def _write_core(core_dir):
    """A minimal core prompt set: two roles + one block."""
    core_dir.mkdir(parents=True, exist_ok=True)
    (core_dir / "planner.md").write_text(
        "# Planner\n\n## Rules\nPlan carefully.\n", encoding="utf-8"
    )
    (core_dir / "coordinator.md").write_text(
        "# Coordinator\n\nDecompose the work.\n", encoding="utf-8"
    )
    (core_dir / "shared.block.md").write_text(
        "Shared block body.\n", encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# materialize_config / default_pipeline_config
# ---------------------------------------------------------------------------


class TestMaterializeConfig:
    def test_default_snapshot_has_expected_keys(self):
        d = default_pipeline_config()
        assert set(d.keys()) == {
            "stages",
            "agents",
            "effort",
            "loops",
            "circuit_breaker",
        }
        # Governance / milestones deliberately NOT materialised (allowlist-stripped).
        assert "governance" not in d
        assert "milestones" not in d

    def test_default_snapshot_covers_every_stage_and_agent(self):
        d = default_pipeline_config()
        for stage in (*[s for s in Stage], Stage.LEARN):
            assert stage.value in d["stages"]
        for agent in (a for a in STAGE_AGENT_MAP.values() if a is not None):
            assert agent in d["agents"]

    def test_template_delta_wins_over_defaults(self):
        m = materialize_config(
            {
                "agents": {"implementer": {"model": "opus"}},
                "stages": {"learn": {"enabled": True}},
            }
        )
        # Override applied...
        assert m["agents"]["implementer"]["model"] == "opus"
        assert m["stages"]["learn"]["enabled"] is True
        # ...but untouched agents keep the default, and the rest of the
        # implementer config (max_turns) is filled from the snapshot.
        assert m["agents"]["tester"]["model"] == "sonnet"
        assert m["agents"]["implementer"]["max_turns"] == 30

    def test_materialize_preserves_unknown_template_keys(self):
        m = materialize_config({"models": {"glm": {"id": "opus"}}})
        assert m["models"] == {"glm": {"id": "opus"}}

    def test_materialize_does_not_mutate_input(self):
        src = {"agents": {"implementer": {"model": "opus"}}}
        materialize_config(src)
        assert src == {"agents": {"implementer": {"model": "opus"}}}


class TestDefaultSnapshotDrift:
    """Guard: the hand-authored snapshot must match the live inline defaults the
    resolvers apply, so a future change to a default doesn't silently desync."""

    def test_agent_defaults_match_resolver(self, tmp_path):
        settings_path = tmp_path / "settings.json"
        settings_path.write_text(json.dumps({"worca": {}}), encoding="utf-8")
        snapshot = default_pipeline_config()
        for stage, agent in STAGE_AGENT_MAP.items():
            if agent is None:
                continue
            resolved = get_stage_config(stage, str(settings_path))
            # model shorthand stays "sonnet" (snapshot stores shorthand, not the
            # resolved id), so compare against the resolver's raw default.
            assert snapshot["agents"][agent]["max_turns"] == resolved["max_turns"]
            if agent == "coordinator":
                assert snapshot["agents"][agent]["max_beads"] == resolved["max_beads"]

    def test_stage_enabled_defaults_match_resolver(self, tmp_path):
        settings_path = tmp_path / "settings.json"
        settings_path.write_text(json.dumps({"worca": {}}), encoding="utf-8")
        snapshot = default_pipeline_config()
        enabled = {s.value for s in get_enabled_stages(str(settings_path))}
        for stage_value, entry in snapshot["stages"].items():
            if stage_value == Stage.LEARN.value:
                continue  # LEARN isn't in STAGE_ORDER / get_enabled_stages
            assert entry["enabled"] == (stage_value in enabled), stage_value


# ---------------------------------------------------------------------------
# CLI export — standalone vs delta
# ---------------------------------------------------------------------------


class TestStandaloneExport:
    def _dirs(self, tmp_path):
        builtin = tmp_path / "templates" / "builtin"
        project = tmp_path / "templates" / "project"
        user = tmp_path / "templates" / "user"
        # Core prompts as a sibling of the templates tier dirs.
        _write_core(tmp_path / "templates" / "agents" / "core")
        return builtin, project, user

    def _export(self, args, tmp_path, settings=None):
        builtin, project, user = self._dirs(tmp_path)
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin, project, user),
        ), patch(
            "worca.cli.templates._load_current_worca_config",
            return_value=settings or {},
        ):
            main(["templates", "export", *args])
        return builtin, project, user

    def _read_zip(self, path):
        with zipfile.ZipFile(path) as zf:
            tmpl = json.loads(zf.read("template.json"))
            overlays = {
                n.split("/", 1)[1]: zf.read(n).decode()
                for n in zf.namelist()
                if n.startswith("agents/")
            }
        return tmpl, overlays

    def test_standalone_materializes_full_config(self, tmp_path):
        project = tmp_path / "templates" / "project"
        _write_template(
            project / "feat",
            {**_minimal("feat"), "config": {"agents": {"implementer": {"model": "opus"}}}},
        )
        out = tmp_path / "feat-bundle.zip"
        # default mode is standalone — pass nothing.
        self._export(["--to", str(out), "--templates", "feat"], tmp_path)
        assert out.exists()
        tmpl, _ = self._read_zip(out)
        cfg = tmpl["config"]
        # Full snapshot present, override applied, defaults filled.
        assert cfg["agents"]["implementer"]["model"] == "opus"
        assert cfg["agents"]["tester"]["model"] == "sonnet"
        assert "effort" in cfg and "loops" in cfg and "circuit_breaker" in cfg
        assert set(cfg["stages"]) >= {"plan", "implement", "review", "pr"}

    def test_standalone_resolves_self_contained_prompts(self, tmp_path):
        project = tmp_path / "templates" / "project"
        _write_template(project / "feat", _minimal("feat"))
        # Template overlay appends to the planner's Rules section.
        agents = project / "feat" / "agents"
        agents.mkdir(parents=True)
        (agents / "planner.md").write_text(
            "<!-- append -->\n## Override: Rules\nAlso fix the bug.\n",
            encoding="utf-8",
        )
        out = tmp_path / "feat-bundle.zip"
        self._export(["--to", str(out), "--templates", "feat"], tmp_path)
        _, overlays = self._read_zip(out)
        # Every core role + block is materialised, not just the overridden one.
        assert set(overlays) == {"planner.md", "coordinator.md", "shared.block.md"}
        # planner carries core content AND the overlay (append mode).
        assert "Plan carefully." in overlays["planner.md"]
        assert "Also fix the bug." in overlays["planner.md"]
        # coordinator is the core prompt verbatim (no overlay existed).
        assert "Decompose the work." in overlays["coordinator.md"]

    def test_standalone_zip_export_mode_round_trips(self, tmp_path):
        from worca.orchestrator.bundle import fetch_bundle

        project = tmp_path / "templates" / "project"
        _write_template(project / "feat", _minimal("feat"))
        out = tmp_path / "feat-bundle.zip"
        self._export(["--to", str(out), "--templates", "feat"], tmp_path)

        # The marker rides inside template.json...
        tmpl, _ = self._read_zip(out)
        assert tmpl["export_mode"] == "standalone"

        # ...and is lifted back to the manifest on parse, then popped off the
        # entry so the imported template.json stays clean.
        manifest = fetch_bundle(str(out))
        assert manifest["export_mode"] == "standalone"
        assert "export_mode" not in manifest["templates"][0]

    def test_standalone_scrubs_secrets_in_materialized_config(self, tmp_path):
        project = tmp_path / "templates" / "project"
        # A secret-shaped value tucked into an allowlisted subtree (agents.*.env-like).
        _write_template(
            project / "feat",
            {
                **_minimal("feat"),
                "config": {
                    "models": {
                        "glm": {
                            "id": "opus",
                            "env": {"ANTHROPIC_API_KEY": "sk-" + "a" * 40},
                        }
                    }
                },
            },
        )
        out = tmp_path / "feat-bundle.zip"
        self._export(["--to", str(out), "--templates", "feat"], tmp_path)
        tmpl, _ = self._read_zip(out)
        secret = tmpl["config"]["models"]["glm"]["env"]["ANTHROPIC_API_KEY"]
        assert secret == "<YOUR-SECRET-HERE>"

    def test_delta_keeps_sparse_config_and_marks_mode(self, tmp_path):
        project = tmp_path / "templates" / "project"
        _write_template(
            project / "feat",
            {**_minimal("feat"), "config": {"agents": {"implementer": {"model": "opus"}}}},
        )
        out = tmp_path / "feat.json"
        self._export(
            ["--to", str(out), "--templates", "feat", "--mode", "delta"], tmp_path
        )
        bundle = json.loads(out.read_text())
        assert bundle["export_mode"] == "delta"
        cfg = bundle["templates"][0]["config"]
        # Sparse: only what the template declared, no materialised defaults.
        assert cfg == {"agents": {"implementer": {"model": "opus"}}}

    def test_standalone_json_carries_export_mode(self, tmp_path):
        # A template with no overlays and no core dir → JSON output, but config
        # is still materialised and the manifest carries export_mode.
        project = tmp_path / "templates" / "project"
        _write_template(project / "feat", _minimal("feat"))
        builtin, _, user = (
            tmp_path / "t2" / "builtin",
            None,
            tmp_path / "t2" / "user",
        )
        out = tmp_path / "feat.json"
        # No core dir under this tree → self-contained pass skipped → JSON.
        with patch(
            "worca.cli.templates._resolve_dirs",
            return_value=(builtin, project, user),
        ), patch(
            "worca.cli.templates._load_current_worca_config",
            return_value={},
        ):
            main(["templates", "export", "--to", str(out), "--templates", "feat"])
        bundle = json.loads(out.read_text())
        assert bundle["export_mode"] == "standalone"
        assert "effort" in bundle["templates"][0]["config"]
