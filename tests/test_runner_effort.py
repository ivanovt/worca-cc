"""Tests for effort resolution wiring in the pipeline runner."""

import json
import os
from unittest.mock import patch

import pytest


from worca.orchestrator.runner import run_stage, run_pipeline
from worca.orchestrator.stages import Stage
from worca.orchestrator.work_request import WorkRequest

# Pipeline tests trigger run_pipeline which takes non-trivial wall time;
# a background worca-ui server writing to ~/.worca/worca-ui-global.log
# during that window is falsely attributed to the test by the leak detector.
pytestmark = pytest.mark.allow_worca_writes


@pytest.fixture(autouse=True)
def _mock_beads_init():
    with patch("worca.orchestrator.runner._ensure_beads_initialized"):
        yield


@pytest.fixture(autouse=True)
def _reset_signal_event_flag():
    import worca.orchestrator.runner as runner_mod
    runner_mod._signal_event_emitted = False
    runner_mod._pending_signal_event = None
    yield
    runner_mod._signal_event_emitted = False
    runner_mod._pending_signal_event = None


# ---------------------------------------------------------------------------
# run_stage: env_overrides parameter
# ---------------------------------------------------------------------------


class TestRunStageEnvOverrides:
    _BASE_CONFIG = {
        "agent": "planner",
        "model": "claude-opus-4-6",
        "model_env": {"SOME_VAR": "original"},
        "max_turns": 40,
        "effort": None,
        "schema": "plan.json",
    }

    def test_env_overrides_merged_into_model_env(self):
        with patch("worca.orchestrator.runner.get_stage_config", return_value=dict(self._BASE_CONFIG)):
            with patch("worca.orchestrator.runner.run_agent", return_value={"ok": True}) as mock_run:
                run_stage(
                    Stage.PLAN, {"prompt": "test"},
                    env_overrides={"CLAUDE_CODE_EFFORT_LEVEL": "high"},
                )
        kw = mock_run.call_args.kwargs
        assert kw["model_env"]["CLAUDE_CODE_EFFORT_LEVEL"] == "high"
        assert kw["model_env"]["SOME_VAR"] == "original"

    def test_env_overrides_none_passes_original_model_env(self):
        with patch("worca.orchestrator.runner.get_stage_config", return_value=dict(self._BASE_CONFIG)):
            with patch("worca.orchestrator.runner.run_agent", return_value={"ok": True}) as mock_run:
                run_stage(Stage.PLAN, {"prompt": "test"})
        kw = mock_run.call_args.kwargs
        assert kw["model_env"] == {"SOME_VAR": "original"}

    def test_env_overrides_empty_dict_passes_original(self):
        with patch("worca.orchestrator.runner.get_stage_config", return_value=dict(self._BASE_CONFIG)):
            with patch("worca.orchestrator.runner.run_agent", return_value={"ok": True}) as mock_run:
                run_stage(Stage.PLAN, {"prompt": "test"}, env_overrides={})
        kw = mock_run.call_args.kwargs
        assert kw["model_env"] == {"SOME_VAR": "original"}

    def test_env_overrides_none_effort_omitted_from_env(self):
        """When resolve_effort returns None level, CLAUDE_CODE_EFFORT_LEVEL should not be set."""
        with patch("worca.orchestrator.runner.get_stage_config", return_value=dict(self._BASE_CONFIG)):
            with patch("worca.orchestrator.runner.run_agent", return_value={"ok": True}) as mock_run:
                run_stage(Stage.PLAN, {"prompt": "test"}, env_overrides={})
        kw = mock_run.call_args.kwargs
        assert "CLAUDE_CODE_EFFORT_LEVEL" not in kw["model_env"]


# ---------------------------------------------------------------------------
# Pipeline: effort settings read at start
# ---------------------------------------------------------------------------


class TestPipelineEffortSettingsLog:
    """Verify worca.effort is read at pipeline start and logged."""

    def _make_settings(self, tmp_path, effort=None):
        settings = {"worca": {"stages": {}, "agents": {}, "models": {}}}
        if effort is not None:
            settings["worca"]["effort"] = effort
        path = str(tmp_path / "settings.json")
        with open(path, "w") as f:
            json.dump(settings, f)
        return path

    def _make_wr(self):
        return WorkRequest(source_type="prompt", title="test", description="test desc")

    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_logs_effort_settings_at_start(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create, mock_stage, tmp_path
    ):
        settings_path = self._make_settings(tmp_path, effort={
            "auto_mode": "reactive",
            "auto_cap": "high",
        })
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        mock_stage.side_effect = Exception("stop early")

        with pytest.raises(Exception, match="stop early"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        effort_log = [m for m in log_messages if "effort" in m.lower() and ("reactive" in m.lower() or "auto_mode" in m.lower())]
        assert effort_log, f"Expected effort settings log line, got: {log_messages}"

    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_logs_default_effort_when_not_configured(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create, mock_stage, tmp_path
    ):
        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        mock_stage.side_effect = Exception("stop early")

        with pytest.raises(Exception, match="stop early"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        effort_log = [m for m in log_messages if "effort" in m.lower() and "adaptive" in m.lower()]
        assert effort_log, f"Expected default effort log (adaptive), got: {log_messages}"


# ---------------------------------------------------------------------------
# Pipeline: resolve_effort called at stage invocation
# ---------------------------------------------------------------------------


class TestPipelineResolveEffortCall:
    """Verify resolve_effort() is invoked at stage invocation with correct args."""

    def _make_settings(self, tmp_path, effort=None, agents=None):
        settings = {
            "worca": {
                "stages": {},
                "agents": agents or {},
                "models": {},
            },
        }
        if effort is not None:
            settings["worca"]["effort"] = effort
        path = str(tmp_path / "settings.json")
        with open(path, "w") as f:
            json.dump(settings, f)
        return path

    def _make_wr(self):
        return WorkRequest(source_type="prompt", title="test", description="test desc")

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    def test_resolve_effort_called_for_non_preflight_stage(
        self, mock_bead, mock_head, mock_branch, mock_create, mock_stage,
        mock_resolve, tmp_path,
    ):
        mock_resolve.return_value = ("high", "high", "explicit", "high", None, None)

        settings_path = self._make_settings(tmp_path, effort={
            "auto_mode": "reactive",
            "auto_cap": "xhigh",
        })
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        # Plan stage is the first non-preflight stage
        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "test", "tasks_outline": []}, {})
            raise Exception("stop after plan")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop after plan"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        assert mock_resolve.called, "resolve_effort should have been called"
        kw = mock_resolve.call_args.kwargs
        assert kw["auto_mode"] == "reactive"
        assert kw["auto_cap"] == "xhigh"
        assert kw["trigger"] == "initial"
        assert kw["iter_num"] == 1

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    def test_resolve_effort_not_called_for_preflight(
        self, mock_bead, mock_head, mock_branch, mock_create, mock_stage,
        mock_resolve, tmp_path,
    ):
        """Preflight runs its own code path — resolve_effort should not be called for it."""
        mock_resolve.return_value = ("high", "high", "explicit", "high", None, None)

        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        # Make preflight pass then stop at PLAN
        def stage_side_effect(*args, **kwargs):
            raise Exception("stop at plan")

        mock_stage.side_effect = stage_side_effect

        with patch("worca.orchestrator.runner.run_preflight", return_value={"status": "ok", "checks": []}):
            with pytest.raises(Exception, match="stop at plan"):
                run_pipeline(
                    self._make_wr(),
                    settings_path=settings_path,
                    status_path=status_path,
                )

        # resolve_effort should be called for PLAN (the stage_side_effect raises before
        # run_stage completes, but resolve_effort happens before run_stage)
        # The key point is: PREFLIGHT itself does NOT call resolve_effort.
        # Any calls are for stages after PREFLIGHT.
        if mock_resolve.called:
            for c in mock_resolve.call_args_list:
                assert c.kwargs.get("agent") != "preflight"


# ---------------------------------------------------------------------------
# Pipeline: effort level passed as CLAUDE_CODE_EFFORT_LEVEL env var
# ---------------------------------------------------------------------------


class TestPipelineEffortEnvVar:
    """Verify resolved effort is passed to run_stage as CLAUDE_CODE_EFFORT_LEVEL."""

    def _make_settings(self, tmp_path, effort=None):
        settings = {"worca": {"stages": {}, "agents": {}, "models": {}}}
        if effort is not None:
            settings["worca"]["effort"] = effort
        path = str(tmp_path / "settings.json")
        with open(path, "w") as f:
            json.dump(settings, f)
        return path

    def _make_wr(self):
        return WorkRequest(source_type="prompt", title="test", description="test desc")

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    def test_effort_level_in_env_overrides(
        self, mock_bead, mock_head, mock_branch, mock_create, mock_stage,
        mock_resolve, tmp_path,
    ):
        mock_resolve.return_value = ("high", "high", "explicit", "high", None, None)

        settings_path = self._make_settings(tmp_path, effort={
            "auto_mode": "reactive",
            "auto_cap": "xhigh",
        })
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        # First call to run_stage should have env_overrides with effort level
        first_call = mock_stage.call_args_list[0]
        env_overrides = first_call.kwargs.get("env_overrides", {})
        assert env_overrides.get("CLAUDE_CODE_EFFORT_LEVEL") == "high"

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    def test_none_effort_level_omits_env_var(
        self, mock_bead, mock_head, mock_branch, mock_create, mock_stage,
        mock_resolve, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)

        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        first_call = mock_stage.call_args_list[0]
        env_overrides = first_call.kwargs.get("env_overrides", {})
        assert "CLAUDE_CODE_EFFORT_LEVEL" not in env_overrides


# ---------------------------------------------------------------------------
# Pipeline: effort dict persisted in start_iteration
# ---------------------------------------------------------------------------


class TestPipelineEffortPersistence:
    """Verify effort dict is passed to start_iteration for status.json persistence."""

    def _make_settings(self, tmp_path, effort=None):
        settings = {"worca": {"stages": {}, "agents": {}, "models": {}}}
        if effort is not None:
            settings["worca"]["effort"] = effort
        path = str(tmp_path / "settings.json")
        with open(path, "w") as f:
            json.dump(settings, f)
        return path

    def _make_wr(self):
        return WorkRequest(source_type="prompt", title="test", description="test desc")

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.start_iteration", wraps=__import__("worca.state.status", fromlist=["start_iteration"]).start_iteration)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    def test_effort_dict_passed_to_start_iteration(
        self, mock_bead, mock_head, mock_branch, mock_create, mock_stage,
        mock_start_iter, mock_resolve, tmp_path,
    ):
        mock_resolve.return_value = ("high", "high", "explicit", "high", None, None)

        settings_path = self._make_settings(tmp_path, effort={
            "auto_mode": "adaptive",
            "auto_cap": "xhigh",
        })
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        # Find the start_iteration call for the plan stage (first non-preflight)
        plan_calls = [
            c for c in mock_start_iter.call_args_list
            if len(c.args) >= 2 and c.args[1] == "plan"
        ]
        assert plan_calls, "start_iteration should have been called for plan stage"
        kw = plan_calls[0].kwargs
        assert "effort" in kw, f"effort kwarg missing from start_iteration call: {kw}"
        effort = kw["effort"]
        assert effort["level"] == "high"
        assert effort["source"] == "explicit"

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.start_iteration", wraps=__import__("worca.state.status", fromlist=["start_iteration"]).start_iteration)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    def test_none_effort_still_persists_structure(
        self, mock_bead, mock_head, mock_branch, mock_create, mock_stage,
        mock_start_iter, mock_resolve, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)

        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        plan_calls = [
            c for c in mock_start_iter.call_args_list
            if len(c.args) >= 2 and c.args[1] == "plan"
        ]
        assert plan_calls
        kw = plan_calls[0].kwargs
        assert "effort" in kw
        effort = kw["effort"]
        assert effort["level"] is None
        assert effort["source"] == "model_default"


# ---------------------------------------------------------------------------
# Pipeline: implementer receives bead ID in resolve_effort
# ---------------------------------------------------------------------------


class TestPipelineEffortBeadArg:
    """Verify assigned bead is passed for implementer, None for others."""

    def _make_settings(self, tmp_path):
        settings = {"worca": {"stages": {}, "agents": {}, "models": {}}}
        path = str(tmp_path / "settings.json")
        with open(path, "w") as f:
            json.dump(settings, f)
        return path

    def _make_wr(self):
        return WorkRequest(source_type="prompt", title="test", description="test desc")

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    def test_non_implementer_passes_none_bead(
        self, mock_bead, mock_head, mock_branch, mock_create, mock_stage,
        mock_resolve, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)

        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        # Plan stage — should pass bead=None
        plan_calls = [
            c for c in mock_resolve.call_args_list
            if c.kwargs.get("agent") == "planner"
        ]
        assert plan_calls
        assert plan_calls[0].kwargs["bead"] is None


# ---------------------------------------------------------------------------
# format_effort_log_line
# ---------------------------------------------------------------------------


class TestFormatEffortLogLine:
    """Unit tests for the terse key=value effort log formatter."""

    def test_import(self):
        from worca.orchestrator.runner import format_effort_log_line
        assert callable(format_effort_log_line)

    def test_model_default_shows_dash(self):
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": None, "requested": None, "source": "model_default",
            "base": None, "capped_from": None, "bead_classified": None,
        }
        line = format_effort_log_line("IMPLEMENT", 1, effort, trigger="initial")
        assert "effort=- source=model_default" in line
        assert "IMPLEMENT iter 1:" in line

    def test_adaptive_bead_label_used(self):
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "high", "requested": "high", "source": "adaptive:llm",
            "base": "high", "capped_from": None,
            "bead_classified": {"level": "high", "applied": True, "skip_reason": None},
        }
        line = format_effort_log_line("IMPLEMENT", 1, effort, trigger="initial")
        assert "effort=high source=adaptive bead=high" in line
        assert "model-collapsed" not in line
        assert "req=" not in line

    def test_explicit_override_model_collapsed(self):
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "high", "requested": "xhigh", "source": "explicit",
            "base": "xhigh", "capped_from": None,
            "bead_classified": {"level": "medium", "applied": False, "skip_reason": "explicit_override"},
        }
        line = format_effort_log_line("IMPLEMENT", 1, effort, trigger="initial")
        assert "effort=high" in line
        assert "req=xhigh" in line
        assert "source=explicit" in line
        assert "bead=medium(overridden)" in line
        assert "model-collapsed" in line

    def test_reactive_bead_ignored(self):
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "high", "requested": "high", "source": "reactive",
            "base": "high", "capped_from": None,
            "bead_classified": {"level": "medium", "applied": False, "skip_reason": "mode_reactive"},
        }
        line = format_effort_log_line("IMPLEMENT", 1, effort, trigger="initial")
        assert "source=reactive" in line
        assert "bead=medium(ignored)" in line

    def test_disabled_bead_ignored(self):
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "high", "requested": "high", "source": "disabled",
            "base": "high", "capped_from": None,
            "bead_classified": {"level": "medium", "applied": False, "skip_reason": "mode_disabled"},
        }
        line = format_effort_log_line("IMPLEMENT", 1, effort, trigger="initial")
        assert "source=disabled" in line
        assert "bead=medium(ignored)" in line

    def test_escalation_trigger(self):
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "max", "requested": "max", "source": "adaptive:llm",
            "base": "high", "capped_from": None,
            "bead_classified": {"level": "high", "applied": True, "skip_reason": None},
        }
        line = format_effort_log_line("IMPLEMENT", 2, effort, trigger="test_failure")
        assert "effort=max source=adaptive bead=high" in line
        assert "+test_failure" in line

    def test_cap_fired(self):
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "high", "requested": "high", "source": "adaptive:llm",
            "base": "high", "capped_from": "max",
            "bead_classified": {"level": "high", "applied": True, "skip_reason": None},
        }
        line = format_effort_log_line("IMPLEMENT", 3, effort, trigger="test_failure")
        assert "capped_from=max" in line

    def test_non_bead_stage_no_bead_field(self):
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "high", "requested": "xhigh", "source": "explicit",
            "base": "xhigh", "capped_from": None, "bead_classified": None,
        }
        line = format_effort_log_line("PLAN", 1, effort, trigger="initial")
        assert "effort=high" in line
        assert "req=xhigh" in line
        assert "model-collapsed" in line
        assert "bead=" not in line

    def test_none_effort_dict_returns_none(self):
        from worca.orchestrator.runner import format_effort_log_line
        result = format_effort_log_line("PLAN", 1, None, trigger="initial")
        assert result is None

    def test_no_escalation_on_initial_iter2(self):
        """iter_num > 1 but trigger is 'initial' — no +trigger suffix."""
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "high", "requested": "high", "source": "explicit",
            "base": "high", "capped_from": None, "bead_classified": None,
        }
        line = format_effort_log_line("PLAN", 2, effort, trigger="initial")
        assert "+initial" not in line

    def test_escalation_trigger_next_bead_no_suffix(self):
        """next_bead is not an escalation trigger — no +next_bead suffix."""
        from worca.orchestrator.runner import format_effort_log_line
        effort = {
            "level": "high", "requested": "high", "source": "adaptive:llm",
            "base": "high", "capped_from": None,
            "bead_classified": {"level": "high", "applied": True, "skip_reason": None},
        }
        line = format_effort_log_line("IMPLEMENT", 2, effort, trigger="next_bead")
        assert "+next_bead" not in line


# ---------------------------------------------------------------------------
# Pipeline: effort log line emitted at stage start
# ---------------------------------------------------------------------------


class TestPipelineEffortLogLine:
    """Verify the effort log line is emitted at stage start."""

    def _make_settings(self, tmp_path, effort=None):
        settings = {"worca": {"stages": {}, "agents": {}, "models": {}}}
        if effort is not None:
            settings["worca"]["effort"] = effort
        path = str(tmp_path / "settings.json")
        with open(path, "w") as f:
            json.dump(settings, f)
        return path

    def _make_wr(self):
        return WorkRequest(source_type="prompt", title="test", description="test desc")

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_effort_log_line_emitted(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_resolve, tmp_path,
    ):
        mock_resolve.return_value = ("high", "high", "explicit", "high", None, None)

        settings_path = self._make_settings(tmp_path, effort={
            "auto_mode": "reactive",
            "auto_cap": "xhigh",
        })
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        effort_lines = [m for m in log_messages if "effort=" in m and "source=" in m]
        assert effort_lines, f"Expected effort log line, got: {log_messages}"


# ---------------------------------------------------------------------------
# Pipeline: post-COORDINATE unlabeled bead warning
# ---------------------------------------------------------------------------


class TestPostCoordinateUnlabeledBeadWarning:
    """Verify warning is logged when beads lack worca-effort:* labels after COORDINATE."""

    def _make_settings(self, tmp_path):
        settings = {"worca": {"stages": {}, "agents": {}, "models": {}}}
        path = str(tmp_path / "settings.json")
        with open(path, "w") as f:
            json.dump(settings, f)
        return path

    def _make_wr(self):
        return WorkRequest(source_type="prompt", title="test", description="test desc")

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_warns_on_unlabeled_beads(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = None  # no effort label

        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                # PLAN
                return ({"approach": "ok", "tasks_outline": []}, {})
            elif call_count[0] == 2:
                # COORDINATE
                return ({"beads_ids": ["bead-1", "bead-2"], "dependency_graph": {}}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        warn_lines = [m for m in log_messages if "unlabeled" in m.lower() or "missing" in m.lower() and "effort" in m.lower()]
        assert warn_lines, f"Expected unlabeled-bead warning, got: {log_messages}"

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_no_warning_when_all_beads_labeled(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.return_value = "high"  # all beads have labels

        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            elif call_count[0] == 2:
                return ({"beads_ids": ["bead-1", "bead-2"], "dependency_graph": {}}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        warn_lines = [m for m in log_messages if "unlabeled" in m.lower()]
        assert not warn_lines, f"No warning expected when all beads labeled, got: {warn_lines}"

    @patch("worca.orchestrator.runner.bd_get_effort_label")
    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_warning_lists_unlabeled_bead_ids(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, mock_get_effort, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)
        mock_get_effort.side_effect = lambda bid: "high" if bid == "bead-1" else None

        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            elif call_count[0] == 2:
                return ({"beads_ids": ["bead-1", "bead-2"], "dependency_graph": {}}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        warn_lines = [m for m in log_messages if "bead-2" in m and ("unlabeled" in m.lower() or "missing" in m.lower())]
        assert warn_lines, f"Expected warning mentioning bead-2, got: {log_messages}"

    @patch("worca.orchestrator.runner.resolve_effort")
    @patch("worca.orchestrator.runner.bd_label_add", return_value=True)
    @patch("worca.orchestrator.runner.run_stage")
    @patch("worca.orchestrator.runner.create_branch")
    @patch("worca.orchestrator.runner.current_branch", return_value="main")
    @patch("worca.orchestrator.runner.get_current_git_head", return_value="abc123")
    @patch("worca.orchestrator.runner._query_ready_bead", return_value=None)
    @patch("worca.orchestrator.runner._log")
    def test_no_warning_when_no_beads(
        self, mock_log, mock_bead, mock_head, mock_branch, mock_create,
        mock_stage, mock_label, mock_resolve, tmp_path,
    ):
        mock_resolve.return_value = (None, None, "model_default", None, None, None)

        settings_path = self._make_settings(tmp_path)
        status_path = str(tmp_path / "status.json")
        os.makedirs(tmp_path / "runs", exist_ok=True)

        call_count = [0]
        def stage_side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return ({"approach": "ok", "tasks_outline": []}, {})
            elif call_count[0] == 2:
                return ({"beads_ids": [], "dependency_graph": {}}, {})
            raise Exception("stop")

        mock_stage.side_effect = stage_side_effect

        with pytest.raises(Exception, match="stop"):
            run_pipeline(
                self._make_wr(),
                settings_path=settings_path,
                status_path=status_path,
                skip_preflight=True,
            )

        log_messages = [c.args[0] for c in mock_log.call_args_list]
        warn_lines = [m for m in log_messages if "unlabeled" in m.lower()]
        assert not warn_lines, "No warning expected with empty beads list"
