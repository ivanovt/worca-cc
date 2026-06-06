"""Tests for max_beads validation in validate_merged_config and prompt_builder resolution."""

import json
import pytest
from unittest.mock import patch, MagicMock

from worca.orchestrator.templates import validate_merged_config
from worca.orchestrator.prompt_builder import PromptBuilder
from worca.orchestrator.overlay import resolve_placeholders
from worca.scripts.run_pipeline import create_parser


def _errors(issues):
    return [i for i in issues if i["severity"] == "error"]


def test_max_beads_non_int():
    issues = validate_merged_config({"agents": {"coordinator": {"max_beads": "ten"}}})
    errs = [i for i in issues if "max_beads" in i["field"]]
    assert len(errs) == 1
    assert errs[0]["severity"] == "error"


def test_max_beads_negative():
    issues = validate_merged_config({"agents": {"coordinator": {"max_beads": -1}}})
    errs = [i for i in issues if "max_beads" in i["field"]]
    assert len(errs) == 1
    assert errs[0]["severity"] == "error"


def test_max_beads_over_ceiling():
    issues = validate_merged_config({"agents": {"coordinator": {"max_beads": 51}}})
    errs = [i for i in issues if "max_beads" in i["field"]]
    assert len(errs) == 1
    assert errs[0]["severity"] == "error"


def test_max_beads_zero_valid():
    issues = validate_merged_config({"agents": {"coordinator": {"max_beads": 0}}})
    errs = [i for i in issues if "max_beads" in i["field"]]
    assert errs == []


def test_max_beads_valid():
    issues = validate_merged_config({"agents": {"coordinator": {"max_beads": 10}}})
    errs = [i for i in issues if "max_beads" in i["field"]]
    assert errs == []


def test_max_beads_at_ceiling():
    issues = validate_merged_config({"agents": {"coordinator": {"max_beads": 50}}})
    errs = [i for i in issues if "max_beads" in i["field"]]
    assert errs == []


def test_max_beads_float_non_int():
    issues = validate_merged_config({"agents": {"coordinator": {"max_beads": 5.5}}})
    errs = [i for i in issues if "max_beads" in i["field"]]
    assert len(errs) == 1
    assert errs[0]["severity"] == "error"


# --- PromptBuilder: max_beads resolution ---

def _make_pb(**ctx_keys):
    pb = PromptBuilder(work_request_title="Test", work_request_description="desc")
    for k, v in ctx_keys.items():
        pb.update_context(k, v)
    return pb


class TestPromptBuilderResolvesMaxBeads:
    def test_override_wins_over_config(self):
        pb = _make_pb(max_beads_override=3, max_beads_config=7)
        ctx = pb.build_context("coordinate")
        assert ctx["max_beads"] == 3
        assert ctx["bead_cap_multi"] is True
        assert ctx["bead_cap_single"] is False

    def test_config_used_when_no_override(self):
        pb = _make_pb(max_beads_config=5)
        ctx = pb.build_context("coordinate")
        assert ctx["max_beads"] == 5
        assert ctx["bead_cap_multi"] is True
        assert ctx["bead_cap_single"] is False

    def test_zero_when_neither_set(self):
        pb = _make_pb()
        ctx = pb.build_context("coordinate")
        assert ctx["max_beads"] == 0
        assert ctx["bead_cap_single"] is False
        assert ctx["bead_cap_multi"] is False

    def test_cap_single_when_one(self):
        pb = _make_pb(max_beads_config=1)
        ctx = pb.build_context("coordinate")
        assert ctx["max_beads"] == 1
        assert ctx["bead_cap_single"] is True
        assert ctx["bead_cap_multi"] is False

    def test_override_none_falls_to_config(self):
        pb = _make_pb(max_beads_override=None, max_beads_config=4)
        ctx = pb.build_context("coordinate")
        assert ctx["max_beads"] == 4

    def test_max_beads_str_coercion(self):
        pb = _make_pb(max_beads_config=8)
        ctx = pb.build_context("coordinate")
        # The overlay renders {{max_beads}} via str(); ensure it's an int in context
        assert isinstance(ctx["max_beads"], int)


class TestPromptBuilderPRRevisionSuppressesCap:
    def test_review_comments_suppresses_cap(self):
        pb = _make_pb(max_beads_config=5, review_comments="some comments")
        ctx = pb.build_context("coordinate")
        assert ctx["max_beads"] == 0
        assert ctx["bead_cap_single"] is False
        assert ctx["bead_cap_multi"] is False

    def test_review_comments_overrides_override_too(self):
        pb = _make_pb(max_beads_override=1, review_comments="comments")
        ctx = pb.build_context("coordinate")
        assert ctx["max_beads"] == 0
        assert ctx["bead_cap_single"] is False
        assert ctx["bead_cap_multi"] is False

    def test_no_review_comments_keeps_cap(self):
        pb = _make_pb(max_beads_config=3, review_comments="")
        ctx = pb.build_context("coordinate")
        assert ctx["max_beads"] == 3
        assert ctx["bead_cap_multi"] is True


class TestOverlayBeadCapBlocks:
    TEMPLATE = (
        "{{#if bead_cap_single}}SINGLE{{/if}}"
        "{{#if bead_cap_multi}}MULTI {{max_beads}}{{/if}}"
        "{{#if !bead_cap_single}}{{#if !bead_cap_multi}}NONE{{/if}}{{/if}}"
    )

    def test_cap_single_renders_single_block(self):
        pb = _make_pb(max_beads_config=1)
        ctx = pb.build_context("coordinate")
        result = resolve_placeholders(self.TEMPLATE, ctx)
        assert "SINGLE" in result
        assert "MULTI" not in result

    def test_cap_multi_renders_multi_block_with_count(self):
        pb = _make_pb(max_beads_config=5)
        ctx = pb.build_context("coordinate")
        result = resolve_placeholders(self.TEMPLATE, ctx)
        assert "MULTI 5" in result
        assert "SINGLE" not in result

    def test_zero_cap_renders_neither(self):
        pb = _make_pb()
        ctx = pb.build_context("coordinate")
        result = resolve_placeholders(self.TEMPLATE, ctx)
        assert "SINGLE" not in result
        assert "MULTI" not in result


# --- run_pipeline.py: --max-beads CLI flag ---

class TestRunPipelineMaxBeadsFlag:
    """--max-beads flag parsed, threaded, persisted, and reused on resume."""

    def test_flag_absent_defaults_to_none(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix bug"])
        assert args.max_beads is None

    def test_flag_parsed_as_int(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix bug", "--max-beads", "3"])
        assert args.max_beads == 3

    def test_flag_zero_is_valid(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix bug", "--max-beads", "0"])
        assert args.max_beads == 0

    @patch("worca.scripts.run_pipeline.run_pipeline")
    @patch("worca.utils.settings.load_settings", return_value={})
    @patch("worca.scripts.run_pipeline.load_settings", return_value={})
    @patch("worca.scripts.run_pipeline.normalize")
    def test_flag_threaded_into_run_pipeline(
        self, mock_normalize, _mock_settings1, _mock_settings2, mock_run_pipeline
    ):
        """--max-beads N is passed as max_beads_override=N to run_pipeline()."""
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(source_type="prompt", title="Fix bug")
        mock_run_pipeline.return_value = {"run_id": "test-run", "pipeline_status": "completed"}

        import sys
        from worca.scripts import run_pipeline as rp_mod
        with patch.object(
            sys, "argv",
            ["run_pipeline.py", "--prompt", "Fix bug", "--max-beads", "5",
             "--status-dir", "/tmp"],
        ):
            with patch("worca.scripts.run_pipeline._ensure_bd_daemon_at_cwd"):
                with patch("worca.scripts.run_pipeline.gh_issue_fail"):
                    with patch("builtins.print"):
                        try:
                            rp_mod.main()
                        except SystemExit:
                            pass
        assert mock_run_pipeline.call_args is not None
        assert mock_run_pipeline.call_args.kwargs.get("max_beads_override") == 5

    @patch("worca.scripts.run_pipeline.run_pipeline")
    @patch("worca.utils.settings.load_settings", return_value={})
    @patch("worca.scripts.run_pipeline.load_settings", return_value={})
    @patch("worca.scripts.run_pipeline.normalize")
    def test_max_beads_threaded_as_none_when_absent(
        self, mock_normalize, _mock_settings1, _mock_settings2, mock_run_pipeline
    ):
        """When --max-beads is not given, max_beads_override=None is passed."""
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(source_type="prompt", title="Fix bug")
        mock_run_pipeline.return_value = {"run_id": "r1", "pipeline_status": "completed"}

        import sys
        from worca.scripts import run_pipeline as rp_mod
        with patch.object(
            sys, "argv",
            ["run_pipeline.py", "--prompt", "Fix bug", "--status-dir", "/tmp"],
        ):
            with patch("worca.scripts.run_pipeline._ensure_bd_daemon_at_cwd"):
                with patch("worca.scripts.run_pipeline.gh_issue_fail"):
                    with patch("builtins.print"):
                        try:
                            rp_mod.main()
                        except SystemExit:
                            pass
        assert mock_run_pipeline.call_args is not None
        assert mock_run_pipeline.call_args.kwargs.get("max_beads_override") is None

    def test_resume_restores_max_beads_from_status(self, tmp_path):
        """On --resume, max_beads_override is reloaded from persisted status.json."""
        wr = {"source_type": "prompt", "title": "Fix bug", "description": "Fix it"}
        status = {
            "schema_version": 1,
            "work_request": wr,
            "pipeline_status": "interrupted",
            "stage": "plan",
            "run_id": "run-abc",
            "branch": "fix-bug",
            "max_beads_override": 4,
            "stages": {},
            "loop_counters": {},
        }
        run_dir = tmp_path / "runs" / "run-abc"
        run_dir.mkdir(parents=True)
        status_file = run_dir / "status.json"
        status_file.write_text(json.dumps(status))

        captured = {}

        import sys
        from worca.scripts import run_pipeline as rp_mod
        with patch("worca.scripts.run_pipeline.run_pipeline") as mock_rp, \
             patch("worca.utils.settings.load_settings", return_value={}), \
             patch("worca.scripts.run_pipeline.load_settings", return_value={}), \
             patch("worca.scripts.run_pipeline._find_active_runs",
                   return_value=[("run-abc", str(status_file))]), \
             patch("worca.scripts.run_pipeline.load_status", return_value=status), \
             patch("worca.scripts.run_pipeline._ensure_bd_daemon_at_cwd"), \
             patch("worca.scripts.run_pipeline.gh_issue_fail"), \
             patch("builtins.print"), \
             patch.object(sys, "argv",
                          ["run_pipeline.py", "--resume",
                           "--status-dir", str(tmp_path)]):
            mock_rp.side_effect = (
                lambda wr, **kw: captured.update(kw) or
                {"run_id": "run-abc", "pipeline_status": "completed"}
            )
            try:
                rp_mod.main()
            except SystemExit:
                pass
        assert captured.get("max_beads_override") == 4

    def test_resume_with_explicit_max_beads_overrides_persisted(self, tmp_path):
        """--max-beads on resume overrides the persisted value without --force flag."""
        status = {
            "schema_version": 1,
            "work_request": {"source_type": "prompt", "title": "Fix bug", "description": ""},
            "pipeline_status": "interrupted",
            "stage": "plan",
            "run_id": "run-abc",
            "branch": "fix-bug",
            "max_beads_override": 2,
            "stages": {},
            "loop_counters": {},
        }
        run_dir = tmp_path / "runs" / "run-abc"
        run_dir.mkdir(parents=True)
        status_file = run_dir / "status.json"
        status_file.write_text(json.dumps(status))

        captured = {}

        import sys
        from worca.scripts import run_pipeline as rp_mod
        with patch("worca.scripts.run_pipeline.run_pipeline") as mock_rp, \
             patch("worca.utils.settings.load_settings", return_value={}), \
             patch("worca.scripts.run_pipeline.load_settings", return_value={}), \
             patch("worca.scripts.run_pipeline._find_active_runs",
                   return_value=[("run-abc", str(status_file))]), \
             patch("worca.scripts.run_pipeline.load_status", return_value=status), \
             patch("worca.scripts.run_pipeline._ensure_bd_daemon_at_cwd"), \
             patch("worca.scripts.run_pipeline.gh_issue_fail"), \
             patch("builtins.print"), \
             patch.object(sys, "argv",
                          ["run_pipeline.py", "--resume", "--max-beads", "9",
                           "--status-dir", str(tmp_path)]):
            mock_rp.side_effect = (
                lambda wr, **kw: captured.update(kw) or
                {"run_id": "run-abc", "pipeline_status": "completed"}
            )
            try:
                rp_mod.main()
            except SystemExit:
                pass
        # CLI value wins over persisted value
        assert captured.get("max_beads_override") == 9


# --- Runner: soft enforcement warnings ---

class TestRunnerSoftWarnsOnCapDeviation:
    """_warn_if_cap_deviation logs on deviation; run proceeds regardless."""

    def _call(self, effective_cap, created_count, is_pr_revision=False):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch, call
        warnings = []
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(effective_cap, created_count, is_pr_revision)
            warn_calls = [c for c in mock_log.call_args_list if c == call(c.args[0], "warn")]
            return mock_log.call_args_list

    def test_cap_one_exact_no_warning(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(1, 1, False)
            assert not any(
                c.args[1] == "warn" for c in mock_log.call_args_list
            )

    def test_cap_one_count_two_warns(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(1, 2, False)
            assert any(c.args[1] == "warn" for c in mock_log.call_args_list)

    def test_cap_one_count_zero_warns(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(1, 0, False)
            assert any(c.args[1] == "warn" for c in mock_log.call_args_list)

    def test_cap_multi_within_cap_no_warning(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(5, 5, False)
            assert not any(c.args[1] == "warn" for c in mock_log.call_args_list)

    def test_cap_multi_over_cap_warns(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(3, 5, False)
            assert any(c.args[1] == "warn" for c in mock_log.call_args_list)

    def test_cap_zero_no_warning(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(0, 10, False)
            assert not any(c.args[1] == "warn" for c in mock_log.call_args_list)

    def test_pr_revision_suppresses_warning(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(1, 5, True)
            assert not any(c.args[1] == "warn" for c in mock_log.call_args_list)

    def test_warning_message_mentions_count_and_cap_single(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(1, 3, False)
            warn_msgs = [c.args[0] for c in mock_log.call_args_list if c.args[1:] == ("warn",)]
            assert any("3" in m and "1" in m for m in warn_msgs)

    def test_warning_message_mentions_count_and_cap_multi(self):
        from worca.orchestrator.runner import _warn_if_cap_deviation
        from unittest.mock import patch
        with patch("worca.orchestrator.runner._log") as mock_log:
            _warn_if_cap_deviation(4, 7, False)
            warn_msgs = [c.args[0] for c in mock_log.call_args_list if c.args[1:] == ("warn",)]
            assert any("7" in m and "4" in m for m in warn_msgs)


# --- quick-fix template: max_beads=1 ---

class TestQuickFixTemplateMaxBeads:
    """quick-fix template must set coordinator.max_beads=1 and pass validate_merged_config."""

    def _load_quick_fix_config(self):
        import importlib.resources as pkg_resources
        from pathlib import Path
        # Locate the builtin template from the installed package
        pkg_dir = Path(__file__).parent.parent / "src" / "worca" / "templates" / "quick-fix"
        manifest = pkg_dir / "template.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        return data["config"]

    def test_coordinator_max_beads_is_one(self):
        config = self._load_quick_fix_config()
        assert config["agents"]["coordinator"]["max_beads"] == 1

    def test_quick_fix_config_passes_validation(self):
        config = self._load_quick_fix_config()
        issues = validate_merged_config(config)
        errors = [i for i in issues if i["severity"] == "error"]
        assert errors == []

    def test_other_templates_do_not_set_max_beads(self):
        from pathlib import Path
        templates_dir = Path(__file__).parent.parent / "src" / "worca" / "templates"
        for tmpl_dir in templates_dir.iterdir():
            if not tmpl_dir.is_dir():
                continue
            if tmpl_dir.name == "quick-fix":
                continue
            manifest = tmpl_dir / "template.json"
            if not manifest.exists():
                continue
            data = json.loads(manifest.read_text(encoding="utf-8"))
            coordinator = data.get("config", {}).get("agents", {}).get("coordinator", {})
            max_beads = coordinator.get("max_beads", 0)
            assert max_beads == 0, (
                f"Template '{tmpl_dir.name}' has coordinator.max_beads={max_beads!r}; "
                "only quick-fix should set this to a non-zero value"
            )
