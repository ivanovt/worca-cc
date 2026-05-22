"""Tests for graphify preflight script and runner integration."""

import subprocess
from unittest.mock import patch, MagicMock

from worca.scripts.graphify_preflight import run_graphify_preflight
from worca.utils.graphify import GraphifyDetect, EffectiveGraphifyConfig


def _make_config(
    enabled=True,
    mode="structural",
    backend=None,
    model_profile=None,
    out_dir="graphify-out",
    update_on_preflight=True,
    update_on_guardian_post_commit=True,
    min_repo_files=100,
    version_range=">=4,<5",
    reason=None,
):
    return EffectiveGraphifyConfig(
        enabled=enabled,
        mode=mode,
        backend=backend,
        model_profile=model_profile,
        out_dir=out_dir,
        update_on_preflight=update_on_preflight,
        update_on_guardian_post_commit=update_on_guardian_post_commit,
        min_repo_files=min_repo_files,
        version_range=version_range,
        reason=reason,
    )


class TestGraphifyPreflightDisabled:
    def test_disabled_returns_skipped(self, tmp_path):
        """When graphify is disabled in config, returns skipped without subprocess."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": false}}}')

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=_make_config(enabled=False, reason="global-off"),
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify"
        ) as mock_detect:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "skipped"
        assert "disabled" in result["reason"]
        mock_detect.assert_not_called()

    def test_update_on_preflight_false_returns_skipped(self, tmp_path):
        """When update_on.preflight is False, returns skipped even if enabled."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        cfg = _make_config(enabled=True, update_on_preflight=False)
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run"
        ) as mock_run:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "skipped"
        assert "update_on_preflight" in result["reason"]
        mock_run.assert_not_called()


class TestGraphifyPreflightStructural:
    def test_structural_uses_no_llm_flag(self, tmp_path):
        """In structural mode, graphify is invoked with --no-llm."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')
        report_path = tmp_path / "graphify-out" / "GRAPH_REPORT.md"
        report_path.parent.mkdir(parents=True)
        report_path.write_text("# Graph Report")

        cfg = _make_config(enabled=True, mode="structural", out_dir=str(tmp_path / "graphify-out"))
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""
        mock_proc.stderr = ""

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
            return_value=mock_proc,
        ) as mock_run:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "ready"
        cmd = mock_run.call_args[0][0]
        assert "--no-llm" in cmd
        assert "--update" in cmd

    def test_full_mode_omits_no_llm_flag(self, tmp_path):
        """In full mode, graphify is invoked without --no-llm."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')
        report_path = tmp_path / "graphify-out" / "GRAPH_REPORT.md"
        report_path.parent.mkdir(parents=True)
        report_path.write_text("# Graph Report")

        cfg = _make_config(enabled=True, mode="full", out_dir=str(tmp_path / "graphify-out"))
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""
        mock_proc.stderr = ""

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
            return_value=mock_proc,
        ) as mock_run:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "ready"
        cmd = mock_run.call_args[0][0]
        assert "--no-llm" not in cmd
        assert "--update" in cmd


class TestGraphifyPreflightDegraded:
    def test_degraded_on_missing_cli(self, tmp_path):
        """When graphify is not installed, returns degraded without failure."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        cfg = _make_config(enabled=True)
        detect = GraphifyDetect(
            installed=False, version=None, compatible=False,
            backend_env_present=[], error="graphify CLI not found on PATH",
        )

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ):
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "degraded"
        assert "not found" in result["reason"] or "not installed" in result["reason"]

    def test_degraded_on_incompatible_version(self, tmp_path):
        """When graphify version is incompatible, returns degraded."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        cfg = _make_config(enabled=True)
        detect = GraphifyDetect(
            installed=True, version="3.0.0", compatible=False,
            backend_env_present=[], error="version 3.0.0 not in >=4,<5",
        )

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ):
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "degraded"
        assert "version" in result["reason"] or "incompatible" in result["reason"]

    def test_degraded_on_build_failure(self, tmp_path):
        """When graphify --update fails, returns degraded without raising."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        cfg = _make_config(enabled=True, out_dir=str(tmp_path / "graphify-out"))
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.stdout = ""
        mock_proc.stderr = "Error: parse failed"

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
            return_value=mock_proc,
        ):
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "degraded"
        assert "build_failed" in result["reason"]


class TestGraphifyPreflightModelProfile:
    def test_model_profile_env_merge(self, tmp_path):
        """model_profile env vars are merged into the subprocess environment."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}, "models": {"graphify-llm": {"id": "gpt-4", "env": {"OPENAI_API_KEY": "sk-test", "OPENAI_BASE_URL": "https://example.com"}}}}}')
        report_path = tmp_path / "graphify-out" / "GRAPH_REPORT.md"
        report_path.parent.mkdir(parents=True)
        report_path.write_text("# Graph Report")

        cfg = _make_config(
            enabled=True,
            mode="full",
            model_profile="graphify-llm",
            out_dir=str(tmp_path / "graphify-out"),
        )
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""
        mock_proc.stderr = ""

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
            return_value=mock_proc,
        ) as mock_run:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "ready"
        call_kwargs = mock_run.call_args[1]
        env = call_kwargs["env"]
        assert env["OPENAI_API_KEY"] == "sk-test"
        assert env["OPENAI_BASE_URL"] == "https://example.com"


class TestGraphifyPreflightTimeout:
    def test_timeout_returns_degraded(self, tmp_path):
        """When graphify --update times out, returns degraded."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        cfg = _make_config(enabled=True, out_dir=str(tmp_path / "graphify-out"))
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="graphify", timeout=300),
        ):
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "degraded"
        assert "timeout" in result["reason"]

    def test_custom_timeout_passed_to_subprocess(self, tmp_path):
        """Custom timeout value is passed to subprocess.run."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')
        report_path = tmp_path / "graphify-out" / "GRAPH_REPORT.md"
        report_path.parent.mkdir(parents=True)
        report_path.write_text("# Graph Report")

        cfg = _make_config(enabled=True, out_dir=str(tmp_path / "graphify-out"))
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""
        mock_proc.stderr = ""

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
            return_value=mock_proc,
        ) as mock_run:
            run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
                timeout=120,
            )

        call_kwargs = mock_run.call_args[1]
        assert call_kwargs["timeout"] == 120

    def test_default_timeout_is_300(self, tmp_path):
        """Default timeout is 300 seconds."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')
        report_path = tmp_path / "graphify-out" / "GRAPH_REPORT.md"
        report_path.parent.mkdir(parents=True)
        report_path.write_text("# Graph Report")

        cfg = _make_config(enabled=True, out_dir=str(tmp_path / "graphify-out"))
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""
        mock_proc.stderr = ""

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
            return_value=mock_proc,
        ) as mock_run:
            run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        call_kwargs = mock_run.call_args[1]
        assert call_kwargs["timeout"] == 300


class TestGraphifyPreflightReportPath:
    def test_ready_includes_report_path(self, tmp_path):
        """When graphify succeeds, report_path points to GRAPH_REPORT.md."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')
        out_dir = tmp_path / "graphify-out"
        report_path = out_dir / "GRAPH_REPORT.md"
        report_path.parent.mkdir(parents=True)
        report_path.write_text("# Graph Report")

        cfg = _make_config(enabled=True, out_dir=str(out_dir))
        detect = GraphifyDetect(
            installed=True, version="4.2.1", compatible=True,
            backend_env_present=[], error=None,
        )

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""
        mock_proc.stderr = ""

        with patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=cfg,
        ), patch(
            "worca.scripts.graphify_preflight.detect_graphify",
            return_value=detect,
        ), patch(
            "worca.scripts.graphify_preflight.subprocess.run",
            return_value=mock_proc,
        ):
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        assert result["status"] == "ready"
        assert result["report_path"] == str(report_path)


class TestGraphifyPreflightGlobalKillSwitch:
    """Global enabled=false must override project enabled=true."""

    def test_global_off_overrides_project_on(self, tmp_path):
        """When global has enabled=false and project has enabled=true, preflight is skipped."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        global_settings = {"worca": {"graphify": {"enabled": False}}}

        with patch(
            "worca.scripts.graphify_preflight.detect_graphify"
        ) as mock_detect, patch(
            "worca.scripts.graphify_preflight.subprocess.run"
        ) as mock_run:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
                global_settings=global_settings,
            )

        assert result["status"] == "skipped"
        assert "disabled" in result["reason"]
        mock_detect.assert_not_called()
        mock_run.assert_not_called()

    def test_default_loads_global_from_home(self, tmp_path):
        """When global_settings is not passed, load_global_settings() is called."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        with patch(
            "worca.scripts.graphify_preflight.load_global_settings",
            return_value={"worca": {"graphify": {"enabled": False}}},
        ) as mock_load_global, patch(
            "worca.scripts.graphify_preflight.detect_graphify"
        ) as mock_detect:
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
            )

        mock_load_global.assert_called_once()
        assert result["status"] == "skipped"
        mock_detect.assert_not_called()

    def test_explicit_global_settings_skips_load(self, tmp_path):
        """When global_settings is provided explicitly, load_global_settings() is not called."""
        settings_file = tmp_path / "settings.json"
        settings_file.write_text('{"worca": {"graphify": {"enabled": true}}}')

        with patch(
            "worca.scripts.graphify_preflight.load_global_settings",
        ) as mock_load_global, patch(
            "worca.scripts.graphify_preflight.effective_graphify_config",
            return_value=_make_config(enabled=False, reason="global-off"),
        ):
            result = run_graphify_preflight(
                settings_path=str(settings_file),
                project_root=str(tmp_path),
                global_settings={"worca": {"graphify": {"enabled": False}}},
            )

        mock_load_global.assert_not_called()
        assert result["status"] == "skipped"


class TestRunnerGraphifyIntegration:
    """Tests that runner.run_preflight chains graphify when enabled."""

    def test_runner_chains_graphify_after_base_preflight(self, tmp_path, monkeypatch):
        """run_preflight calls run_graphify_preflight after base preflight succeeds."""
        from worca.orchestrator.runner import run_preflight

        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()

        preflight_script = tmp_path / "preflight.py"
        preflight_script.write_text('import json, sys; print(json.dumps({"status":"pass","checks":[],"summary":"ok"}))')

        monkeypatch.setattr(
            "worca.orchestrator.runner.load_settings",
            lambda *a, **kw: {"worca": {"graphify": {"enabled": True}, "stages": {"preflight": {"script": str(preflight_script)}}}},
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_graphify_preflight",
            lambda **kw: {"status": "ready", "report_path": "/tmp/report.md"},
        )

        context = {"_logs_dir": str(logs_dir)}
        result = run_preflight(context, settings_path="unused")

        assert result.get("graphify_status") == "ready"
        assert result.get("graphify_report_path") == "/tmp/report.md"

    def test_runner_skips_graphify_when_disabled(self, tmp_path, monkeypatch):
        """run_preflight does not call graphify preflight when disabled."""
        from worca.orchestrator.runner import run_preflight

        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()

        preflight_script = tmp_path / "preflight.py"
        preflight_script.write_text('import json, sys; print(json.dumps({"status":"pass","checks":[],"summary":"ok"}))')

        monkeypatch.setattr(
            "worca.orchestrator.runner.load_settings",
            lambda *a, **kw: {"worca": {"graphify": {"enabled": False}, "stages": {"preflight": {"script": str(preflight_script)}}}},
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_graphify_preflight",
            lambda **kw: {"status": "skipped", "reason": "disabled"},
        )

        context = {"_logs_dir": str(logs_dir)}
        result = run_preflight(context, settings_path="unused")

        assert result.get("graphify_status") == "skipped"

    def test_runner_graphify_degraded_does_not_fail_preflight(self, tmp_path, monkeypatch):
        """When graphify returns degraded, the overall preflight still passes."""
        from worca.orchestrator.runner import run_preflight

        logs_dir = tmp_path / "logs"
        logs_dir.mkdir()

        preflight_script = tmp_path / "preflight.py"
        preflight_script.write_text('import json, sys; print(json.dumps({"status":"pass","checks":[],"summary":"ok"}))')

        monkeypatch.setattr(
            "worca.orchestrator.runner.load_settings",
            lambda *a, **kw: {"worca": {"graphify": {"enabled": True}, "stages": {"preflight": {"script": str(preflight_script)}}}},
        )
        monkeypatch.setattr(
            "worca.orchestrator.runner.run_graphify_preflight",
            lambda **kw: {"status": "degraded", "reason": "build_failed"},
        )

        context = {"_logs_dir": str(logs_dir)}
        result = run_preflight(context, settings_path="unused")

        assert result["status"] == "pass"
        assert result["graphify_status"] == "degraded"
