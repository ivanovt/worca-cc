"""Tests for worca.scripts.run_pipeline arg parsing and prompt merging."""
import json
import os
import pytest
from unittest.mock import patch, MagicMock

from worca.scripts.run_pipeline import create_parser, build_work_request


class TestCreateParser:
    """Test that the parser accepts the expected argument combinations."""

    def test_prompt_file_arg(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt-file", "/tmp/prompt.md"])
        assert args.prompt_file == "/tmp/prompt.md"

    def test_prompt_only(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Add auth"])
        assert args.prompt == "Add auth"
        assert args.source is None
        assert args.spec is None
        assert args.plan is None

    def test_source_only(self):
        parser = create_parser()
        args = parser.parse_args(["--source", "gh:issue:42"])
        assert args.source == "gh:issue:42"
        assert args.prompt is None

    def test_spec_only(self):
        parser = create_parser()
        args = parser.parse_args(["--spec", "docs/spec.md"])
        assert args.spec == "docs/spec.md"
        assert args.prompt is None

    def test_plan_only(self):
        parser = create_parser()
        args = parser.parse_args(["--plan", "docs/plans/W-027.md"])
        assert args.plan == "docs/plans/W-027.md"
        assert args.prompt is None
        assert args.source is None

    def test_source_plus_prompt(self):
        parser = create_parser()
        args = parser.parse_args(["--source", "gh:issue:42", "--prompt", "focus on auth"])
        assert args.source == "gh:issue:42"
        assert args.prompt == "focus on auth"

    def test_spec_plus_prompt(self):
        parser = create_parser()
        args = parser.parse_args(["--spec", "spec.md", "--prompt", "extra context"])
        assert args.spec == "spec.md"
        assert args.prompt == "extra context"

    def test_plan_plus_prompt(self):
        parser = create_parser()
        args = parser.parse_args(["--plan", "plan.md", "--prompt", "additional notes"])
        assert args.plan == "plan.md"
        assert args.prompt == "additional notes"

    def test_no_args_still_parses(self):
        """Parser should accept no args — validation happens later."""
        parser = create_parser()
        args = parser.parse_args([])
        assert args.prompt is None
        assert args.source is None
        assert args.spec is None
        assert args.plan is None


class TestBuildWorkRequest:
    """Test build_work_request validation and prompt merging."""

    def test_no_args_raises_system_exit(self):
        parser = create_parser()
        args = parser.parse_args([])
        with pytest.raises(SystemExit):
            build_work_request(args)

    def test_source_and_spec_raises_system_exit(self):
        parser = create_parser()
        args = parser.parse_args(["--source", "gh:issue:1", "--spec", "spec.md"])
        with pytest.raises(SystemExit):
            build_work_request(args)

    @patch("worca.scripts.run_pipeline.normalize")
    def test_prompt_only_backwards_compat(self, mock_normalize):
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="prompt", title="Add auth"
        )
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Add auth"])
        wr = build_work_request(args)
        mock_normalize.assert_called_once_with("prompt", "Add auth")
        assert wr.title == "Add auth"

    @patch("worca.scripts.run_pipeline.load_settings", return_value={})
    @patch("worca.scripts.run_pipeline.normalize")
    def test_source_dispatches_normalize(self, mock_normalize, _mock_settings):
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="github_issue", title="Fix bug", description="Body text"
        )
        parser = create_parser()
        args = parser.parse_args(["--source", "gh:issue:42"])
        wr = build_work_request(args)
        # plan_path_template is threaded through from settings (None when no
        # template configured, which the mocked load_settings ensures here).
        mock_normalize.assert_called_once_with(
            "source", "gh:issue:42", plan_path_template=None
        )
        assert wr.title == "Fix bug"

    @patch("worca.scripts.run_pipeline.load_settings")
    @patch("worca.scripts.run_pipeline.normalize")
    def test_source_threads_configured_plan_path_template(
        self, mock_normalize, mock_settings
    ):
        from worca.orchestrator.work_request import WorkRequest
        mock_settings.return_value = {
            "worca": {"plan_path_template": "plans/{title_slug}.md"}
        }
        mock_normalize.return_value = WorkRequest(
            source_type="github_issue", title="W-031", description=""
        )
        parser = create_parser()
        args = parser.parse_args(["--source", "gh:issue:31"])
        build_work_request(args)
        mock_normalize.assert_called_once_with(
            "source", "gh:issue:31", plan_path_template="plans/{title_slug}.md"
        )

    @patch("worca.scripts.run_pipeline.normalize")
    def test_spec_dispatches_normalize(self, mock_normalize):
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="spec_file", title="Spec Title", description="Spec body"
        )
        parser = create_parser()
        args = parser.parse_args(["--spec", "spec.md"])
        _wr = build_work_request(args)
        mock_normalize.assert_called_once_with("spec", "spec.md")

    @patch("worca.scripts.run_pipeline.normalize")
    def test_plan_only_dispatches_normalize(self, mock_normalize):
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="plan_file", title="Plan Title",
            description="Plan content", plan_path="plan.md"
        )
        parser = create_parser()
        args = parser.parse_args(["--plan", "plan.md"])
        _wr = build_work_request(args)
        mock_normalize.assert_called_once_with("plan", "plan.md")

    @patch("worca.scripts.run_pipeline.normalize")
    def test_prompt_merging_with_source(self, mock_normalize):
        """When --prompt accompanies --source, append as Additional Instructions."""
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="github_issue", title="Fix bug",
            description="Original issue body"
        )
        parser = create_parser()
        args = parser.parse_args(["--source", "gh:issue:42", "--prompt", "focus on auth"])
        wr = build_work_request(args)
        assert "Original issue body" in wr.description
        assert "## Additional Instructions" in wr.description
        assert "focus on auth" in wr.description

    @patch("worca.scripts.run_pipeline.normalize")
    def test_prompt_merging_with_spec(self, mock_normalize):
        """When --prompt accompanies --spec, append as Additional Instructions."""
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="spec_file", title="Spec Title",
            description="Spec content here"
        )
        parser = create_parser()
        args = parser.parse_args(["--spec", "spec.md", "--prompt", "extra context"])
        wr = build_work_request(args)
        assert "Spec content here" in wr.description
        assert "## Additional Instructions" in wr.description
        assert "extra context" in wr.description

    @patch("worca.scripts.run_pipeline.normalize")
    def test_prompt_merging_with_plan(self, mock_normalize):
        """When --prompt accompanies --plan, append as Additional Instructions."""
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="plan_file", title="Plan Title",
            description="Plan content", plan_path="plan.md"
        )
        parser = create_parser()
        args = parser.parse_args(["--plan", "plan.md", "--prompt", "additional notes"])
        wr = build_work_request(args)
        assert "Plan content" in wr.description
        assert "## Additional Instructions" in wr.description
        assert "additional notes" in wr.description

    @patch("worca.scripts.run_pipeline.normalize")
    def test_prompt_only_no_merging(self, mock_normalize):
        """When only --prompt is given, no merging — just normal prompt flow."""
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="prompt", title="Add auth"
        )
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Add auth"])
        wr = build_work_request(args)
        assert "Additional Instructions" not in wr.description

    @patch("worca.scripts.run_pipeline.load_settings", return_value={})
    @patch("worca.scripts.run_pipeline.normalize")
    def test_source_priority_over_plan(self, mock_normalize, _mock_settings):
        """When both --source and --plan given, source is primary, plan is plan_file."""
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="github_issue", title="Issue Title",
            description="Issue body"
        )
        parser = create_parser()
        args = parser.parse_args(["--source", "gh:issue:42", "--plan", "plan.md"])
        _wr = build_work_request(args)
        mock_normalize.assert_called_once_with(
            "source", "gh:issue:42", plan_path_template=None
        )


class TestPromptFile:
    """Test --prompt-file reads content and deletes the file."""

    def test_prompt_file_reads_content(self, tmp_path):
        pf = tmp_path / "prompt.md"
        pf.write_text("Large prompt content here")
        parser = create_parser()
        args = parser.parse_args(["--prompt-file", str(pf)])
        # Simulate what main() does before build_work_request
        with open(args.prompt_file) as f:
            args.prompt = f.read()
        assert args.prompt == "Large prompt content here"

    def test_prompt_file_deleted_after_read(self, tmp_path):
        """Simulate the main() logic: read file then delete it."""
        pf = tmp_path / "prompt.md"
        pf.write_text("prompt data")
        parser = create_parser()
        args = parser.parse_args(["--prompt-file", str(pf)])
        with open(args.prompt_file) as f:
            args.prompt = f.read()
        os.unlink(args.prompt_file)
        assert not pf.exists()

    @patch("worca.scripts.run_pipeline.normalize")
    def test_prompt_file_used_as_prompt_in_build(self, mock_normalize, tmp_path):
        """--prompt-file content should be used as if --prompt was passed."""
        from worca.orchestrator.work_request import WorkRequest
        mock_normalize.return_value = WorkRequest(
            source_type="prompt", title="From file"
        )
        pf = tmp_path / "prompt.md"
        pf.write_text("Build a feature")
        parser = create_parser()
        args = parser.parse_args(["--prompt-file", str(pf)])
        # Simulate main()'s prompt-file handling
        with open(args.prompt_file) as f:
            args.prompt = f.read()
        os.unlink(args.prompt_file)
        _wr = build_work_request(args)
        mock_normalize.assert_called_once_with("prompt", "Build a feature")


class TestTemplateArgs:
    """Test that --template and --param are registered in create_parser()."""

    def test_template_arg_present(self):
        parser = create_parser()
        args = parser.parse_args(["--template", "bugfix", "--prompt", "Fix login"])
        assert args.template == "bugfix"

    def test_template_absent_by_default(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix login"])
        assert args.template is None

    def test_param_arg_single(self):
        parser = create_parser()
        args = parser.parse_args([
            "--template", "bugfix", "--param", "key=val", "--prompt", "Fix",
        ])
        assert args.param == ["key=val"]

    def test_param_arg_multiple(self):
        parser = create_parser()
        args = parser.parse_args([
            "--template", "bugfix",
            "--param", "a=1",
            "--param", "b=hello",
            "--prompt", "Fix",
        ])
        assert args.param == ["a=1", "b=hello"]

    def test_param_absent_by_default(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix"])
        assert args.param is None

    def test_force_template_change_default_false(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix"])
        assert args.force_template_change is False

    def test_force_template_change_flag_sets_true(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix", "--force-template-change"])
        assert args.force_template_change is True


class TestParseParams:
    """Test the _parse_params helper."""

    def test_none_returns_empty(self):
        from worca.scripts.run_pipeline import _parse_params
        assert _parse_params(None) == {}

    def test_empty_list_returns_empty(self):
        from worca.scripts.run_pipeline import _parse_params
        assert _parse_params([]) == {}

    def test_single_pair(self):
        from worca.scripts.run_pipeline import _parse_params
        assert _parse_params(["key=val"]) == {"key": "val"}

    def test_multiple_pairs(self):
        from worca.scripts.run_pipeline import _parse_params
        assert _parse_params(["a=1", "b=two"]) == {"a": "1", "b": "two"}

    def test_value_contains_equals(self):
        from worca.scripts.run_pipeline import _parse_params
        assert _parse_params(["url=http://x.com/a=b"]) == {"url": "http://x.com/a=b"}

    def test_no_equals_raises_system_exit(self):
        from worca.scripts.run_pipeline import _parse_params
        with pytest.raises(SystemExit) as exc_info:
            _parse_params(["badformat"])
        assert exc_info.value.code == 2


class TestTemplateMain:
    """Integration tests for --template flag in main()."""

    def _make_settings(self, tmp_path, worca_config=None):
        """Write a minimal settings.json and return its path."""
        data = {"worca": worca_config or {}}
        p = tmp_path / ".claude" / "settings.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data))
        return str(p)

    def test_unknown_template_exits_with_error(self, tmp_path, capsys):
        from worca.scripts.run_pipeline import main
        from worca.orchestrator.templates import TemplateError
        settings_path = self._make_settings(tmp_path)

        mock_resolver = MagicMock()
        mock_resolver.apply.side_effect = TemplateError("Template 'nope' not found.", "not_found")

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "nope",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with pytest.raises(SystemExit) as exc_info:
                    main()
        assert exc_info.value.code == 2
        captured = capsys.readouterr()
        assert "nope" in captured.err

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_template_config_merged_before_launch(self, mock_run_pipeline, tmp_path):
        """Template apply() is called with a STRIPPED current worca config (Phase 1):
        template-owned keys (loops) are removed before merge; cross-template keys (models) survive.
        Merged settings then land in the temp settings file passed to the runner."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(
            tmp_path,
            {"loops": {"test": 2}, "models": {"opus": "claude-opus-4-7"}},
        )

        # Capture the temp settings content before the finally block deletes it
        captured_settings = {}

        def capture_and_return(*args, **kwargs):
            temp_path = kwargs.get("settings_path", "")
            if temp_path and os.path.exists(temp_path):
                with open(temp_path) as f:
                    captured_settings["data"] = json.load(f)
                captured_settings["path"] = temp_path
            return {"pipeline_status": "completed", "run_id": "run-001"}

        mock_run_pipeline.side_effect = capture_and_return

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {
            "loops": {"test": 3},
            "stages": {},
            "models": {"opus": "claude-opus-4-7"},
        }
        mock_resolver.get.return_value = MagicMock(agents_dir=None)

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "bugfix",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        # apply() called with the STRIPPED worca dict (loops removed, models kept)
        mock_resolver.apply.assert_called_once()
        call_args = mock_resolver.apply.call_args
        assert call_args[0][0] == "bugfix"
        assert call_args[0][1] == {"models": {"opus": "claude-opus-4-7"}}

        # run_pipeline called with a temp settings path (not the original)
        call_kwargs = mock_run_pipeline.call_args[1]
        assert call_kwargs["settings_path"] != settings_path

        # Temp file contained merged worca config at call time
        assert "data" in captured_settings, "Temp settings file was not readable during run_pipeline call"
        assert captured_settings["data"]["worca"]["loops"]["test"] == 3

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_template_snapshot_written_to_run_dir(self, mock_run_pipeline, tmp_path):
        """After run_pipeline returns, snapshot_to_run is called with the correct run_dir."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)
        status_dir = tmp_path / ".worca"
        run_id = "20260408-120000-123-abcd"
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_resolver.get.return_value = MagicMock(agents_dir=None)

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "bugfix",
            "--settings", settings_path,
            "--status-dir", str(status_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        expected_run_dir = str(status_dir / "runs" / run_id)
        mock_resolver.snapshot_to_run.assert_called_once_with("bugfix", expected_run_dir, {})

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_param_overrides_passed_to_apply_and_snapshot(self, mock_run_pipeline, tmp_path):
        """--param values are parsed and forwarded to apply() and snapshot_to_run()."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)
        status_dir = tmp_path / ".worca"
        run_id = "20260408-120000-456-efgh"
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_resolver.get.return_value = MagicMock(agents_dir=None)

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "quick-fix",
            "--param", "severity=high",
            "--param", "scope=auth",
            "--settings", settings_path,
            "--status-dir", str(status_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        expected_params = {"severity": "high", "scope": "auth"}
        # params forwarded to apply()
        assert mock_resolver.apply.call_args[0][2] == expected_params
        # params forwarded to snapshot_to_run()
        mock_resolver.snapshot_to_run.assert_called_once_with(
            "quick-fix",
            str(status_dir / "runs" / run_id),
            expected_params,
        )

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_merged_settings_written_to_run_dir(self, mock_run_pipeline, tmp_path):
        """After template run, merged settings.json is written to run_dir."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path, {"loops": {"test": 1}})
        status_dir = tmp_path / ".worca"
        run_id = "20260408-120000-789-ijkl"
        run_dir = status_dir / "runs" / run_id
        run_dir.mkdir(parents=True, exist_ok=True)

        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {"loops": {"test": 5}}
        mock_resolver.get.return_value = MagicMock(agents_dir=None)
        mock_resolver.snapshot_to_run.return_value = None

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "bugfix",
            "--settings", settings_path,
            "--status-dir", str(status_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        settings_file = run_dir / "settings.json"
        assert settings_file.exists(), "settings.json should be written to run_dir"
        written = json.loads(settings_file.read_text())
        assert written["worca"]["loops"]["test"] == 5

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_no_template_no_regression(self, mock_run_pipeline, tmp_path):
        """Without --template, run_pipeline is called with the original settings path."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                from worca.orchestrator.work_request import WorkRequest
                mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                main()

        call_kwargs = mock_run_pipeline.call_args[1]
        assert call_kwargs["settings_path"] == settings_path

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_agents_dir_stored_in_merged_settings(self, mock_run_pipeline, tmp_path):
        """If template has agents_dir, it is stored in merged worca config."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)
        status_dir = tmp_path / ".worca"
        run_id = "20260408-120000-000-mnop"
        run_dir = status_dir / "runs" / run_id
        run_dir.mkdir(parents=True, exist_ok=True)

        captured_settings = {}

        def capture_and_return(*args, **kwargs):
            temp_path = kwargs.get("settings_path", "")
            if temp_path and os.path.exists(temp_path):
                with open(temp_path) as f:
                    captured_settings["data"] = json.load(f)
            return {"pipeline_status": "completed", "run_id": run_id}

        mock_run_pipeline.side_effect = capture_and_return

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_template = MagicMock()
        mock_template.agents_dir = "/some/template/agents"
        mock_resolver.get.return_value = mock_template
        mock_resolver.snapshot_to_run.return_value = None

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "bugfix",
            "--settings", settings_path,
            "--status-dir", str(status_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        assert "data" in captured_settings, "Temp settings file was not readable during run_pipeline call"
        assert captured_settings["data"]["worca"].get("_template_agents_dir") == "/some/template/agents"


class TestTemplatePhase1Stripping:
    """Phase 1: when a template is in play, TEMPLATE_OWNED_KEYS are stripped
    from the project-settings merge base BEFORE the template applies. This
    makes shared templates behave identically across machines."""

    def _make_settings(self, tmp_path, worca_config=None):
        data = {"worca": worca_config or {}}
        p = tmp_path / ".claude" / "settings.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data))
        return str(p)

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_template_strips_all_owned_keys(self, mock_run_pipeline, tmp_path):
        """Every TEMPLATE_OWNED_KEYS path is removed from the merge base; cross-template keys survive."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(
            tmp_path,
            {
                # All template-owned — should be stripped
                "agents": {"implementer": {"model": "sonnet"}},
                "stages": {"plan_review": {"enabled": True}},
                "loops": {"implement_test": 7},
                "circuit_breaker": {"max_consecutive_failures": 9},
                "effort": {"auto_mode": "reactive"},
                "governance": {
                    "dispatch": {"_defaults": {"tools": ["Bash"]}},
                    "guards": {"block_graphify_mutation": True},  # cross-template, kept
                },
                # Cross-template — should survive
                "models": {"opus": "claude-opus-4-7"},
                "webhooks": [{"url": "https://x"}],
                "default_template": "bugfix",
            },
        )

        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}
        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_resolver.get.return_value = MagicMock(agents_dir=None, tier="builtin")

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "bugfix",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        base_passed_to_apply = mock_resolver.apply.call_args[0][1]
        # Template-owned keys gone
        for key in ("agents", "stages", "loops", "circuit_breaker", "effort"):
            assert key not in base_passed_to_apply, f"{key} should have been stripped"
        # governance.dispatch gone but governance.guards preserved
        assert "dispatch" not in base_passed_to_apply.get("governance", {})
        assert base_passed_to_apply["governance"]["guards"] == {"block_graphify_mutation": True}
        # Cross-template keys preserved
        assert base_passed_to_apply["models"] == {"opus": "claude-opus-4-7"}
        assert base_passed_to_apply["webhooks"] == [{"url": "https://x"}]
        assert base_passed_to_apply["default_template"] == "bugfix"


class TestDefaultTemplateResolution:
    """Phase 1: when --template is not passed, worca.default_template is used."""

    def _make_settings(self, tmp_path, worca_config=None):
        data = {"worca": worca_config or {}}
        p = tmp_path / ".claude" / "settings.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data))
        return str(p)

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_default_template_used_when_arg_missing(self, mock_run_pipeline, tmp_path):
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path, {"default_template": "quick-fix"})
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_resolver.get.return_value = MagicMock(agents_dir=None, tier="builtin")

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        # apply was called with the default template id
        assert mock_resolver.apply.call_args[0][0] == "quick-fix"

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_explicit_template_overrides_default(self, mock_run_pipeline, tmp_path):
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path, {"default_template": "quick-fix"})
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_resolver.get.return_value = MagicMock(agents_dir=None, tier="builtin")

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "bugfix",  # explicit overrides default
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        assert mock_resolver.apply.call_args[0][0] == "bugfix"

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_no_default_no_arg_runs_without_template(self, mock_run_pipeline, tmp_path):
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)  # no default_template
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                from worca.orchestrator.work_request import WorkRequest
                mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                main()

        # run_pipeline saw the ORIGINAL settings path — no temp file written
        assert mock_run_pipeline.call_args[1]["settings_path"] == settings_path

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_invalid_default_template_value_is_ignored(self, mock_run_pipeline, tmp_path):
        """Non-string or empty default_template is treated as not set."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path, {"default_template": ""})
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                from worca.orchestrator.work_request import WorkRequest
                mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                main()

        # Empty string treated as no default → original settings path used
        assert mock_run_pipeline.call_args[1]["settings_path"] == settings_path


class TestPipelineTemplateFormatting:
    """Test that pipeline_template is formatted as tier:id and passed to run_pipeline()."""

    def _make_settings(self, tmp_path, worca_config=None):
        data = {"worca": worca_config or {}}
        p = tmp_path / ".claude" / "settings.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data))
        return str(p)

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_builtin_template_formatted_as_builtin_colon_id(self, mock_run_pipeline, tmp_path):
        """Builtin tier template is formatted as 'builtin:{id}'.

        The prefix used to be 'worca:' but was aligned with the tier name
        ('builtin') in the PipelineTemplates UI redesign so the run card,
        the resolver, and the Pipelines page all read the same word.
        """
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_tmpl = MagicMock()
        mock_tmpl.agents_dir = None
        mock_tmpl.tier = "builtin"
        mock_resolver.get.return_value = mock_tmpl

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--template", "bugfix",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                    main()

        call_kwargs = mock_run_pipeline.call_args[1]
        assert call_kwargs["pipeline_template"] == "builtin:bugfix"

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_project_template_formatted_as_project_colon_id(self, mock_run_pipeline, tmp_path):
        """Project tier template is formatted as 'project:{id}'."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_tmpl = MagicMock()
        mock_tmpl.agents_dir = None
        mock_tmpl.tier = "project"
        mock_resolver.get.return_value = mock_tmpl

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Refactor code",
            "--template", "my-template",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Refactor code")
                    main()

        call_kwargs = mock_run_pipeline.call_args[1]
        assert call_kwargs["pipeline_template"] == "project:my-template"

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_user_template_formatted_as_user_colon_id(self, mock_run_pipeline, tmp_path):
        """User tier template is formatted as 'user:{id}'."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_tmpl = MagicMock()
        mock_tmpl.agents_dir = None
        mock_tmpl.tier = "user"
        mock_resolver.get.return_value = mock_tmpl

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Add feature",
            "--template", "my-custom",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                    from worca.orchestrator.work_request import WorkRequest
                    mock_norm.return_value = WorkRequest(source_type="prompt", title="Add feature")
                    main()

        call_kwargs = mock_run_pipeline.call_args[1]
        assert call_kwargs["pipeline_template"] == "user:my-custom"

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_no_template_passes_none_pipeline_template(self, mock_run_pipeline, tmp_path):
        """When no --template flag, pipeline_template is None."""
        from worca.scripts.run_pipeline import main

        settings_path = self._make_settings(tmp_path)
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": "run-001"}

        with patch("sys.argv", [
            "run_pipeline.py", "--prompt", "Fix bug",
            "--settings", settings_path,
            "--status-dir", str(tmp_path / ".worca"),
        ]):
            with patch("worca.scripts.run_pipeline.normalize") as mock_norm:
                from worca.orchestrator.work_request import WorkRequest
                mock_norm.return_value = WorkRequest(source_type="prompt", title="Fix bug")
                main()

        call_kwargs = mock_run_pipeline.call_args[1]
        assert call_kwargs.get("pipeline_template") is None


class TestResumeRestoresPipelineTemplate:
    """On resume, pipeline_template from status.json is restored when --template not passed."""

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_restores_template_from_status(self, mock_run_pipeline, tmp_path):
        """When resuming without --template, persisted pipeline_template is applied."""
        from worca.scripts.run_pipeline import main

        worca_dir = tmp_path / ".worca"
        run_id = "20260601-120000-000-abcd"
        run_dir = worca_dir / "runs" / run_id
        run_dir.mkdir(parents=True)
        status = {
            "pipeline_status": "paused",
            "run_id": run_id,
            "pipeline_template": "worca:bugfix",
            "work_request": {
                "source_type": "prompt",
                "title": "Fix bug",
                "description": "desc",
            },
        }
        (run_dir / "status.json").write_text(json.dumps(status))
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}

        settings_path = tmp_path / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({"worca": {}}))

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_tmpl = MagicMock()
        mock_tmpl.agents_dir = None
        mock_tmpl.tier = "builtin"
        mock_resolver.get.return_value = mock_tmpl

        with patch("sys.argv", [
            "run_pipeline.py",
            "--resume",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                main()

        call_kwargs = mock_run_pipeline.call_args[1]
        # status.json on disk used the legacy "worca:" prefix; the run loop
        # parses the bare id ("bugfix") off it and re-formats with the
        # current "<tier>:<id>" convention, which is "builtin:bugfix".
        assert call_kwargs.get("pipeline_template") == "builtin:bugfix"

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_explicit_template_overrides_status_with_force(self, mock_run_pipeline, tmp_path):
        """When resuming with --template and --force-template-change, explicit flag wins."""
        from worca.scripts.run_pipeline import main

        worca_dir = tmp_path / ".worca"
        run_id = "20260601-120000-000-efgh"
        run_dir = worca_dir / "runs" / run_id
        run_dir.mkdir(parents=True)
        status = {
            "pipeline_status": "paused",
            "run_id": run_id,
            "pipeline_template": "worca:bugfix",
            "work_request": {
                "source_type": "prompt",
                "title": "Fix bug",
                "description": "desc",
            },
        }
        (run_dir / "status.json").write_text(json.dumps(status))
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}

        settings_path = tmp_path / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({"worca": {}}))

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_tmpl = MagicMock()
        mock_tmpl.agents_dir = None
        mock_tmpl.tier = "builtin"
        mock_resolver.get.return_value = mock_tmpl

        with patch("sys.argv", [
            "run_pipeline.py",
            "--resume",
            "--template", "hotfix",
            "--force-template-change",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                main()

        call_kwargs = mock_run_pipeline.call_args[1]
        # See note in test_resume_restores_template_from_status — the new
        # prefix is "builtin:" regardless of what was on disk.
        assert call_kwargs.get("pipeline_template") == "builtin:hotfix"

    def test_resume_conflicting_template_exits_2(self, tmp_path, capsys):
        """Resuming with --template that conflicts with persisted template exits 2."""
        from worca.scripts.run_pipeline import main

        worca_dir = tmp_path / ".worca"
        run_id = "20260601-120000-000-conf"
        run_dir = worca_dir / "runs" / run_id
        run_dir.mkdir(parents=True)
        status = {
            "pipeline_status": "paused",
            "run_id": run_id,
            "pipeline_template": "worca:bugfix",
            "work_request": {
                "source_type": "prompt",
                "title": "Fix bug",
                "description": "desc",
            },
        }
        (run_dir / "status.json").write_text(json.dumps(status))

        settings_path = tmp_path / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({"worca": {}}))

        with patch("sys.argv", [
            "run_pipeline.py",
            "--resume",
            "--template", "hotfix",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 2
        captured = capsys.readouterr()
        assert "hotfix" in captured.err
        assert "bugfix" in captured.err

    def test_resume_matching_template_no_conflict(self, tmp_path):
        """Resuming with --template matching persisted bare ID does not exit."""
        from worca.scripts.run_pipeline import main

        worca_dir = tmp_path / ".worca"
        run_id = "20260601-120000-000-match"
        run_dir = worca_dir / "runs" / run_id
        run_dir.mkdir(parents=True)
        status = {
            "pipeline_status": "paused",
            "run_id": run_id,
            "pipeline_template": "worca:bugfix",
            "work_request": {
                "source_type": "prompt",
                "title": "Fix bug",
                "description": "desc",
            },
        }
        (run_dir / "status.json").write_text(json.dumps(status))

        settings_path = tmp_path / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({"worca": {}}))

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_tmpl = MagicMock()
        mock_tmpl.agents_dir = None
        mock_tmpl.tier = "builtin"
        mock_resolver.get.return_value = mock_tmpl

        with patch("worca.scripts.run_pipeline.run_pipeline") as mock_run:
            mock_run.return_value = {"pipeline_status": "completed", "run_id": run_id}
            with patch("sys.argv", [
                "run_pipeline.py",
                "--resume",
                "--template", "bugfix",
                "--settings", str(settings_path),
                "--status-dir", str(worca_dir),
            ]):
                with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                    main()  # should not raise

        mock_run.assert_called_once()

    def test_resume_force_template_change_allows_different_template(self, tmp_path):
        """--force-template-change bypasses conflict guard even when templates differ."""
        from worca.scripts.run_pipeline import main

        worca_dir = tmp_path / ".worca"
        run_id = "20260601-120000-000-force"
        run_dir = worca_dir / "runs" / run_id
        run_dir.mkdir(parents=True)
        status = {
            "pipeline_status": "paused",
            "run_id": run_id,
            "pipeline_template": "project:special",
            "work_request": {
                "source_type": "prompt",
                "title": "Fix bug",
                "description": "desc",
            },
        }
        (run_dir / "status.json").write_text(json.dumps(status))

        settings_path = tmp_path / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({"worca": {}}))

        mock_resolver = MagicMock()
        mock_resolver.apply.return_value = {}
        mock_tmpl = MagicMock()
        mock_tmpl.agents_dir = None
        mock_tmpl.tier = "builtin"
        mock_resolver.get.return_value = mock_tmpl

        with patch("worca.scripts.run_pipeline.run_pipeline") as mock_run:
            mock_run.return_value = {"pipeline_status": "completed", "run_id": run_id}
            with patch("sys.argv", [
                "run_pipeline.py",
                "--resume",
                "--template", "hotfix",
                "--force-template-change",
                "--settings", str(settings_path),
                "--status-dir", str(worca_dir),
            ]):
                with patch("worca.scripts.run_pipeline._make_template_resolver", return_value=mock_resolver):
                    main()  # should not raise

        mock_run.assert_called_once()


class TestResumeTemplateRestoration:
    """Unit tests for pipeline_template restoration and conflict guard on resume.

    Tests use pipeline_template: "project:my-template" as the canonical persisted value.
    """

    def _make_status(self, base_dir, run_id, pipeline_template="project:my-template"):
        """Write status.json with a paused run under base_dir/.worca/runs/run_id/."""
        worca_dir = base_dir / ".worca"
        run_dir = worca_dir / "runs" / run_id
        run_dir.mkdir(parents=True)
        status = {
            "pipeline_status": "paused",
            "run_id": run_id,
            "work_request": {
                "source_type": "prompt",
                "title": "Template restore test",
                "description": "test",
            },
        }
        if pipeline_template is not None:
            status["pipeline_template"] = pipeline_template
        (run_dir / "status.json").write_text(json.dumps(status))
        return worca_dir

    def _make_settings(self, base_dir, worca_config=None):
        settings_path = base_dir / ".claude" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps({"worca": worca_config or {}}))
        return settings_path

    def _mock_resolver(self, tier="project"):
        resolver = MagicMock()
        resolver.apply.return_value = {}
        tmpl = MagicMock()
        tmpl.agents_dir = None
        tmpl.tier = tier
        resolver.get.return_value = tmpl
        return resolver

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_restores_pipeline_template_from_status(self, mock_run_pipeline, tmp_path):
        """Resume without --template reads pipeline_template from status.json and applies it."""
        from worca.scripts.run_pipeline import main

        run_id = "20260601-trt-0001-aaaa"
        worca_dir = self._make_status(tmp_path, run_id, "project:my-template")
        settings_path = self._make_settings(tmp_path)
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}
        mock_resolver = self._mock_resolver("project")

        with patch("sys.argv", [
            "run_pipeline.py", "--resume",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver",
                       return_value=mock_resolver):
                main()

        # Bare ID extracted from "project:my-template" and passed to apply()
        mock_resolver.apply.assert_called_once()
        assert mock_resolver.apply.call_args[0][0] == "my-template"
        # Temp (merged) settings file was used, not the original
        call_kwargs = mock_run_pipeline.call_args[1]
        assert call_kwargs["settings_path"] != str(settings_path)

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_without_persisted_template_falls_back_to_default(
        self, mock_run_pipeline, tmp_path
    ):
        """Resume with no pipeline_template in status.json falls back to worca.default_template."""
        from worca.scripts.run_pipeline import main

        run_id = "20260601-trt-0002-bbbb"
        # pipeline_template=None → key absent from status.json
        worca_dir = self._make_status(tmp_path, run_id, pipeline_template=None)
        settings_path = self._make_settings(tmp_path, {"default_template": "quick-fix"})
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}
        mock_resolver = self._mock_resolver("builtin")

        with patch("sys.argv", [
            "run_pipeline.py", "--resume",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver",
                       return_value=mock_resolver):
                main()

        # Fell through to worca.default_template
        mock_resolver.apply.assert_called_once()
        assert mock_resolver.apply.call_args[0][0] == "quick-fix"

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_with_explicit_matching_template_succeeds(
        self, mock_run_pipeline, tmp_path
    ):
        """--template my-template on resume matches persisted project:my-template — no error."""
        from worca.scripts.run_pipeline import main

        run_id = "20260601-trt-0003-cccc"
        worca_dir = self._make_status(tmp_path, run_id, "project:my-template")
        settings_path = self._make_settings(tmp_path)
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}
        mock_resolver = self._mock_resolver("project")

        with patch("sys.argv", [
            "run_pipeline.py", "--resume",
            "--template", "my-template",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver",
                       return_value=mock_resolver):
                main()  # must not raise

        mock_run_pipeline.assert_called_once()

    def test_resume_with_conflicting_template_errors(self, tmp_path, capsys):
        """--template other-template conflicts with persisted project:my-template → SystemExit(2)."""
        from worca.scripts.run_pipeline import main

        run_id = "20260601-trt-0004-dddd"
        worca_dir = self._make_status(tmp_path, run_id, "project:my-template")
        settings_path = self._make_settings(tmp_path)

        with patch("sys.argv", [
            "run_pipeline.py", "--resume",
            "--template", "other-template",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 2
        captured = capsys.readouterr()
        assert "other-template" in captured.err
        assert "my-template" in captured.err

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_with_conflicting_template_force_override(
        self, mock_run_pipeline, tmp_path
    ):
        """--force-template-change bypasses the conflict guard; explicit --template wins."""
        from worca.scripts.run_pipeline import main

        run_id = "20260601-trt-0005-eeee"
        worca_dir = self._make_status(tmp_path, run_id, "project:my-template")
        settings_path = self._make_settings(tmp_path)
        mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}
        mock_resolver = self._mock_resolver("builtin")

        with patch("sys.argv", [
            "run_pipeline.py", "--resume",
            "--template", "other-template",
            "--force-template-change",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver",
                       return_value=mock_resolver):
                main()  # must not raise

        # The override template was applied, not the persisted one
        mock_resolver.apply.assert_called_once()
        assert mock_resolver.apply.call_args[0][0] == "other-template"

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_handles_malformed_pipeline_template(self, mock_run_pipeline, tmp_path):
        """Malformed pipeline_template (empty string, non-string) is ignored gracefully."""
        from worca.scripts.run_pipeline import main

        for bad_value, label in [("", "empty"), (42, "int"), (None, "null")]:
            sub = tmp_path / label
            sub.mkdir()
            run_id = "20260601-trt-0006-ffff"
            worca_dir = self._make_status(sub, run_id, pipeline_template=bad_value)
            settings_path = self._make_settings(sub)
            mock_run_pipeline.reset_mock()
            mock_run_pipeline.return_value = {"pipeline_status": "completed", "run_id": run_id}

            with patch("sys.argv", [
                "run_pipeline.py", "--resume",
                "--settings", str(settings_path),
                "--status-dir", str(worca_dir),
            ]):
                main()  # must not raise

            # No template applied — run_pipeline received the original settings path
            call_kwargs = mock_run_pipeline.call_args[1]
            assert call_kwargs["settings_path"] == str(settings_path), (
                f"malformed pipeline_template {bad_value!r} should not trigger template application"
            )

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_writes_snapshot_before_run_pipeline(self, mock_run_pipeline, tmp_path):
        """On resume with a template, snapshot_to_run is called before run_pipeline()."""
        from worca.scripts.run_pipeline import main

        run_id = "20260601-trt-0007-gggg"
        worca_dir = self._make_status(tmp_path, run_id, "project:my-template")
        settings_path = self._make_settings(tmp_path)
        run_dir = worca_dir / "runs" / run_id

        call_order = []

        def record_snapshot(*args, **kwargs):
            call_order.append("snapshot")

        def record_run_pipeline(*args, **kwargs):
            call_order.append("run_pipeline")
            return {"pipeline_status": "completed", "run_id": run_id}

        mock_run_pipeline.side_effect = record_run_pipeline
        mock_resolver = self._mock_resolver("project")
        mock_resolver.snapshot_to_run.side_effect = record_snapshot

        with patch("sys.argv", [
            "run_pipeline.py", "--resume",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver",
                       return_value=mock_resolver):
                main()

        assert call_order.index("snapshot") < call_order.index("run_pipeline"), (
            "snapshot_to_run must be called before run_pipeline on resume"
        )
        mock_resolver.snapshot_to_run.assert_called_once_with("my-template", str(run_dir), {})

    @patch("worca.scripts.run_pipeline.run_pipeline")
    def test_resume_writes_merged_settings_before_run_pipeline(self, mock_run_pipeline, tmp_path):
        """On resume with a template, merged settings.json is written before run_pipeline()."""
        from worca.scripts.run_pipeline import main

        run_id = "20260601-trt-0008-hhhh"
        worca_dir = self._make_status(tmp_path, run_id, "project:my-template")
        settings_path = self._make_settings(tmp_path, {"loops": {"test": 3}})
        run_dir = worca_dir / "runs" / run_id

        settings_written_before_run = []

        def check_and_record_run(*args, **kwargs):
            # Check if settings.json already exists in run_dir at the time run_pipeline is called
            sf = run_dir / "settings.json"
            settings_written_before_run.append(sf.exists())
            return {"pipeline_status": "completed", "run_id": run_id}

        mock_run_pipeline.side_effect = check_and_record_run
        mock_resolver = self._mock_resolver("project")
        mock_resolver.apply.return_value = {"loops": {"test": 9}}

        with patch("sys.argv", [
            "run_pipeline.py", "--resume",
            "--settings", str(settings_path),
            "--status-dir", str(worca_dir),
        ]):
            with patch("worca.scripts.run_pipeline._make_template_resolver",
                       return_value=mock_resolver):
                main()

        assert settings_written_before_run == [True], (
            "merged settings.json must exist in run_dir before run_pipeline is called"
        )
        written = json.loads((run_dir / "settings.json").read_text())
        assert written["worca"]["loops"]["test"] == 9


class TestResumeAmbiguousError:
    def test_resume_ambiguous_error(self, tmp_path, capsys):
        """--resume with multiple non-terminal runs exits 2 with an explanatory message."""
        from worca.scripts.run_pipeline import main

        worca_dir = tmp_path / ".worca"
        for run_id in ["20260426-100000-000-aaaa", "20260426-110000-000-bbbb"]:
            run_dir = worca_dir / "runs" / run_id
            run_dir.mkdir(parents=True)
            (run_dir / "status.json").write_text(json.dumps({
                "pipeline_status": "running",
                "run_id": run_id,
            }))

        with patch("sys.argv", [
            "run_pipeline.py",
            "--resume",
            "--status-dir", str(worca_dir),
        ]):
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 2
        captured = capsys.readouterr()
        assert "multiple" in captured.err.lower() or "specify" in captured.err.lower()


class TestGuideFlag:
    """Tests for --guide flag: parser registration and error when attach_guide unavailable."""

    def test_guide_arg_parsed(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix", "--guide", "spec.md"])
        assert args.guide == ["spec.md"]

    def test_guide_repeatable(self):
        parser = create_parser()
        args = parser.parse_args([
            "--prompt", "Fix", "--guide", "a.md", "--guide", "b.md",
        ])
        assert args.guide == ["a.md", "b.md"]

    def test_guide_absent_by_default(self):
        parser = create_parser()
        args = parser.parse_args(["--prompt", "Fix"])
        assert args.guide is None


class TestEnsureBdDaemonAtCwd:
    """Verify run_pipeline starts the bd daemon up-front so subsequent bd
    subprocess calls go through the Unix-socket RPC."""

    def test_calls_bd_daemon_ensure_when_beads_dir_present(self, tmp_path, monkeypatch):
        from worca.scripts.run_pipeline import _ensure_bd_daemon_at_cwd

        beads_dir = tmp_path / ".beads"
        beads_dir.mkdir()
        monkeypatch.chdir(tmp_path)

        with patch("worca.scripts.run_pipeline.bd_daemon_ensure") as mock_ensure:
            _ensure_bd_daemon_at_cwd()

        mock_ensure.assert_called_once_with(str(beads_dir))

    def test_no_op_when_beads_dir_absent(self, tmp_path, monkeypatch):
        from worca.scripts.run_pipeline import _ensure_bd_daemon_at_cwd

        monkeypatch.chdir(tmp_path)

        with patch("worca.scripts.run_pipeline.bd_daemon_ensure") as mock_ensure:
            _ensure_bd_daemon_at_cwd()

        mock_ensure.assert_not_called()

    def test_swallows_exceptions(self, tmp_path, monkeypatch):
        """Daemon-ensure failures must not block pipeline startup."""
        from worca.scripts.run_pipeline import _ensure_bd_daemon_at_cwd

        beads_dir = tmp_path / ".beads"
        beads_dir.mkdir()
        monkeypatch.chdir(tmp_path)

        with patch(
            "worca.scripts.run_pipeline.bd_daemon_ensure",
            side_effect=RuntimeError("bd missing"),
        ):
            # Must not raise.
            _ensure_bd_daemon_at_cwd()
