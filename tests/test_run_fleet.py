"""Tests for worca.scripts.run_fleet — arg parser skeleton + provisioning (W-040 Phase 2a)."""
import subprocess
import pytest
from unittest.mock import patch


def _completed(stdout="", stderr="", returncode=0):
    return subprocess.CompletedProcess(
        args=[], returncode=returncode, stdout=stdout, stderr=stderr
    )


class TestCreateParser:
    """Arg parser shape tests — pure-function, no subprocess."""

    def _parse(self, argv):
        from worca.scripts.run_fleet import create_parser
        return create_parser().parse_args(argv)

    # --- project targets ---

    def test_projects_single(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.projects == ["/repo/a"]

    def test_projects_multiple(self):
        args = self._parse(["--projects", "/repo/a", "/repo/b", "--prompt", "x"])
        assert args.projects == ["/repo/a", "/repo/b"]

    def test_projects_file_flag(self):
        args = self._parse(["--projects-file", "repos.txt", "--prompt", "x"])
        assert args.projects_file == "repos.txt"

    def test_projects_absent_by_default(self):
        args = self._parse(["--prompt", "x"])
        assert args.projects is None

    def test_projects_file_absent_by_default(self):
        args = self._parse(["--prompt", "x"])
        assert args.projects_file is None

    # --- work request source ---

    def test_prompt_flag(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "Migrate auth"])
        assert args.prompt == "Migrate auth"

    def test_source_flag(self):
        args = self._parse(["--projects", "/repo/a", "--source", "gh:issue:42"])
        assert args.source == "gh:issue:42"

    def test_prompt_absent_by_default(self):
        args = self._parse(["--projects", "/repo/a"])
        assert args.prompt is None

    def test_source_absent_by_default(self):
        args = self._parse(["--projects", "/repo/a"])
        assert args.source is None

    # --- branch flags (§4 semantics) ---

    def test_head_template_flag(self):
        args = self._parse([
            "--projects", "/repo/a", "--prompt", "x",
            "--head-template", "migration/v2/{project}",
        ])
        assert args.head_template == "migration/v2/{project}"

    def test_head_template_absent_by_default(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.head_template is None

    def test_base_flag(self):
        args = self._parse([
            "--projects", "/repo/a", "--prompt", "x",
            "--base", "dev",
        ])
        assert args.base == "dev"

    def test_base_absent_by_default(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.base is None

    # --- guide ---

    def test_guide_single(self):
        args = self._parse([
            "--projects", "/repo/a", "--prompt", "x",
            "--guide", "docs/spec.md",
        ])
        assert args.guide == ["docs/spec.md"]

    def test_guide_repeatable(self):
        args = self._parse([
            "--projects", "/repo/a", "--prompt", "x",
            "--guide", "a.md", "--guide", "b.md",
        ])
        assert args.guide == ["a.md", "b.md"]

    def test_guide_absent_by_default(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.guide is None

    # --- plan modes ---

    def test_plan_flag(self):
        args = self._parse([
            "--projects", "/repo/a", "--prompt", "x",
            "--plan", "docs/plans/W-040.md",
        ])
        assert args.plan == "docs/plans/W-040.md"

    def test_plan_absent_by_default(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.plan is None

    def test_plan_first_flag_no_arg(self):
        args = self._parse([
            "--projects", "/repo/a", "/repo/b", "--prompt", "x",
            "--plan-first",
        ])
        assert args.plan_first is True

    def test_plan_first_absent_by_default(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.plan_first is False

    # --- concurrency / circuit breaker ---

    def test_max_parallel_flag(self):
        args = self._parse([
            "--projects", "/repo/a", "--prompt", "x",
            "--max-parallel", "3",
        ])
        assert args.max_parallel == 3

    def test_max_parallel_default(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.max_parallel == 5

    def test_fleet_failure_threshold_flag(self):
        args = self._parse([
            "--projects", "/repo/a", "--prompt", "x",
            "--fleet-failure-threshold", "0.5",
        ])
        assert args.fleet_failure_threshold == pytest.approx(0.5)

    def test_fleet_failure_threshold_default(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.fleet_failure_threshold == pytest.approx(0.30)

    # --- resume ---

    def test_resume_flag(self):
        args = self._parse(["--resume", "f_20260512_abc"])
        assert args.resume == "f_20260512_abc"

    def test_resume_absent_by_default(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.resume is None


class TestBranchFlagRejected:
    """--branch must be explicitly rejected at argparse time per §4."""

    def test_branch_flag_exits_with_error(self, capsys):
        from worca.scripts.run_fleet import create_parser
        with pytest.raises(SystemExit) as exc_info:
            create_parser().parse_args([
                "--projects", "/repo/a", "--prompt", "x",
                "--branch", "dev",
            ])
        assert exc_info.value.code != 0

    def test_branch_error_message_references_base(self, capsys):
        from worca.scripts.run_fleet import create_parser
        with pytest.raises(SystemExit):
            create_parser().parse_args([
                "--projects", "/repo/a", "--prompt", "x",
                "--branch", "dev",
            ])
        captured = capsys.readouterr()
        output = captured.err + captured.out
        assert "--base" in output

    def test_branch_error_message_references_head_template(self, capsys):
        from worca.scripts.run_fleet import create_parser
        with pytest.raises(SystemExit):
            create_parser().parse_args([
                "--projects", "/repo/a", "--prompt", "x",
                "--branch", "dev",
            ])
        captured = capsys.readouterr()
        output = captured.err + captured.out
        assert "--head-template" in output


class TestMainStub:
    """main() skeleton — exits cleanly without dispatching real work."""

    def test_main_returns_int(self, tmp_path):
        """main() must return an integer exit code."""
        from worca.scripts.run_fleet import main
        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)):
            result = main(["--projects", str(tmp_path), "--prompt", "x"])
        assert isinstance(result, int)

    def test_main_missing_work_request_exits_nonzero(self):
        from worca.scripts.run_fleet import main
        result = main(["--projects", "/repo/a"])
        assert result != 0


class TestValidateBaseBranch:
    """Unit tests for validate_base_branch() — mocked subprocess, no real git."""

    def _call(self, projects, base, side_effect):
        from worca.scripts.run_fleet import validate_base_branch
        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=side_effect):
            return validate_base_branch(projects, base)

    def test_all_present_returns_empty(self):
        result = self._call(
            ["/repo/a", "/repo/b"],
            "dev",
            [_completed("  dev\n"), _completed("  dev\n")],
        )
        assert result == []

    def test_one_missing_returns_that_path(self):
        result = self._call(
            ["/repo/a", "/repo/b"],
            "dev",
            [_completed("  dev\n"), _completed("")],
        )
        assert result == ["/repo/b"]

    def test_all_missing_returns_all_paths(self):
        result = self._call(
            ["/repo/a", "/repo/b", "/repo/c"],
            "release",
            [_completed(""), _completed(""), _completed("")],
        )
        assert result == ["/repo/a", "/repo/b", "/repo/c"]

    def test_empty_project_list_returns_empty(self):
        from worca.scripts.run_fleet import validate_base_branch
        with patch("worca.scripts.run_fleet.subprocess.run") as mock_run:
            result = validate_base_branch([], "dev")
        assert result == []
        mock_run.assert_not_called()

    def test_uses_git_C_branch_list(self):
        from worca.scripts.run_fleet import validate_base_branch
        with patch("worca.scripts.run_fleet.subprocess.run") as mock_run:
            mock_run.return_value = _completed("  main\n")
            validate_base_branch(["/repo/a"], "main")
        cmd = mock_run.call_args[0][0]
        assert cmd == ["git", "-C", "/repo/a", "branch", "--list", "main"]

    def test_whitespace_only_stdout_counts_as_missing(self):
        result = self._call(["/repo/a"], "dev", [_completed("   \n")])
        assert result == ["/repo/a"]

    def test_present_branch_stdout_not_missing(self):
        result = self._call(["/repo/a"], "main", [_completed("  main\n")])
        assert result == []


class TestMainBaseBranchValidation:
    """main() aborts with exit code 1 when --base branch is absent from some repos."""

    def test_base_missing_exits_nonzero(self):
        from worca.scripts.run_fleet import main
        with patch("worca.scripts.run_fleet.validate_base_branch", return_value=["/repo/b"]):
            result = main([
                "--projects", "/repo/a", "/repo/b",
                "--prompt", "x",
                "--base", "dev",
            ])
        assert result != 0

    def test_base_present_everywhere_continues(self):
        from worca.scripts.run_fleet import main
        with (
            patch("worca.scripts.run_fleet.validate_base_branch", return_value=[]),
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
            patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"),
        ):
            result = main(["--projects", "/repo/a", "--prompt", "x", "--base", "dev"])
        assert isinstance(result, int)
        assert result == 0

    def test_base_absent_skips_validation(self):
        from worca.scripts.run_fleet import main
        with (
            patch("worca.scripts.run_fleet.validate_base_branch") as mock_vbv,
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
            patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"),
        ):
            main(["--projects", "/repo/a", "--prompt", "x"])
        mock_vbv.assert_not_called()

    def test_error_message_lists_missing_repos(self, capsys):
        from worca.scripts.run_fleet import main
        with patch("worca.scripts.run_fleet.validate_base_branch",
                   return_value=["/repo/b", "/repo/c"]):
            main([
                "--projects", "/repo/a", "/repo/b", "/repo/c",
                "--prompt", "x",
                "--base", "dev",
            ])
        captured = capsys.readouterr()
        output = captured.err + captured.out
        assert "/repo/b" in output
        assert "/repo/c" in output

    def test_error_message_names_base_branch(self, capsys):
        from worca.scripts.run_fleet import main
        with patch("worca.scripts.run_fleet.validate_base_branch",
                   return_value=["/repo/a"]):
            main([
                "--projects", "/repo/a",
                "--prompt", "x",
                "--base", "my-branch",
            ])
        captured = capsys.readouterr()
        output = captured.err + captured.out
        assert "my-branch" in output


# ---------------------------------------------------------------------------
# Phase 2a task 4 — Per-target worca init --upgrade provisioning (§2)
# ---------------------------------------------------------------------------


class TestProvisionTarget:
    """Unit tests for provision_target() — mocked subprocess, no real worca."""

    def _call(self, project_dir, timeout, side_effect):
        from worca.scripts.run_fleet import provision_target
        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=side_effect):
            return provision_target(project_dir, timeout)

    def test_success_returns_true_no_error(self):
        success, error = self._call("/repo/a", 60, [_completed()])
        assert success is True
        assert error is None

    def test_nonzero_exit_returns_false(self):
        success, error = self._call(
            "/repo/a", 60, [_completed(stderr="bad config", returncode=1)]
        )
        assert success is False
        assert error is not None

    def test_nonzero_includes_stderr_in_error(self):
        success, error = self._call(
            "/repo/a", 60, [_completed(stderr="permission denied", returncode=2)]
        )
        assert success is False
        assert "permission denied" in error

    def test_timeout_returns_false(self):
        from worca.scripts.run_fleet import provision_target
        with patch(
            "worca.scripts.run_fleet.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="worca", timeout=60),
        ):
            success, error = provision_target("/repo/a", 60)
        assert success is False
        assert error is not None

    def test_timeout_message_mentions_seconds(self):
        from worca.scripts.run_fleet import provision_target
        with patch(
            "worca.scripts.run_fleet.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="worca", timeout=30),
        ):
            _, error = provision_target("/repo/a", 30)
        assert "30" in error

    def test_timeout_message_mentions_unreachable(self):
        from worca.scripts.run_fleet import provision_target
        with patch(
            "worca.scripts.run_fleet.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd="worca", timeout=60),
        ):
            _, error = provision_target("/repo/a", 60)
        assert "unreachable" in error

    def test_calls_worca_init_upgrade(self):
        from worca.scripts.run_fleet import provision_target
        with patch("worca.scripts.run_fleet.subprocess.run") as mock_run:
            mock_run.return_value = _completed()
            provision_target("/repo/a", 60)
        cmd = mock_run.call_args[0][0]
        assert cmd == ["worca", "init", "--upgrade"]

    def test_calls_with_project_as_cwd(self):
        from worca.scripts.run_fleet import provision_target
        with patch("worca.scripts.run_fleet.subprocess.run") as mock_run:
            mock_run.return_value = _completed()
            provision_target("/repo/a", 60)
        kwargs = mock_run.call_args[1]
        assert kwargs.get("cwd") == "/repo/a"

    def test_uses_timeout_parameter(self):
        from worca.scripts.run_fleet import provision_target
        with patch("worca.scripts.run_fleet.subprocess.run") as mock_run:
            mock_run.return_value = _completed()
            provision_target("/repo/a", 45)
        kwargs = mock_run.call_args[1]
        assert kwargs.get("timeout") == 45


class TestInitTimeoutFlag:
    """--init-timeout flag for per-fleet init timeout."""

    def _parse(self, argv):
        from worca.scripts.run_fleet import create_parser
        return create_parser().parse_args(argv)

    def test_init_timeout_flag(self):
        args = self._parse([
            "--projects", "/repo/a", "--prompt", "x",
            "--init-timeout", "30",
        ])
        assert args.init_timeout == 30

    def test_init_timeout_absent_default_is_none(self):
        args = self._parse(["--projects", "/repo/a", "--prompt", "x"])
        assert args.init_timeout is None


class TestResolveInitTimeout:
    """Unit tests for _resolve_init_timeout() — pure function, no I/O."""

    def test_flag_takes_precedence_over_settings(self):
        from worca.scripts.run_fleet import _resolve_init_timeout
        result = _resolve_init_timeout(
            30, {"worca": {"fleet": {"init_timeout_seconds": 90}}}
        )
        assert result == 30

    def test_settings_used_when_flag_is_none(self):
        from worca.scripts.run_fleet import _resolve_init_timeout
        result = _resolve_init_timeout(
            None, {"worca": {"fleet": {"init_timeout_seconds": 90}}}
        )
        assert result == 90

    def test_default_60_when_settings_empty(self):
        from worca.scripts.run_fleet import _resolve_init_timeout
        result = _resolve_init_timeout(None, {})
        assert result == 60

    def test_default_60_when_fleet_key_absent(self):
        from worca.scripts.run_fleet import _resolve_init_timeout
        result = _resolve_init_timeout(None, {"worca": {"guide": {"max_bytes": 65536}}})
        assert result == 60


class TestMainProvisioning:
    """main() provisions each target with worca init --upgrade before dispatch."""

    def test_provision_called_for_each_project(self):
        from worca.scripts.run_fleet import main
        with (
            patch("worca.scripts.run_fleet.provision_target") as mock_prov,
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
            patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"),
        ):
            mock_prov.return_value = (True, None)
            result = main(["--projects", "/repo/a", "/repo/b", "--prompt", "x"])
        assert mock_prov.call_count == 2
        assert result == 0

    def test_provision_uses_init_timeout_flag(self):
        from worca.scripts.run_fleet import main
        with (
            patch("worca.scripts.run_fleet.provision_target") as mock_prov,
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
            patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"),
        ):
            mock_prov.return_value = (True, None)
            main(["--projects", "/repo/a", "--prompt", "x", "--init-timeout", "30"])
        assert mock_prov.call_args[0][1] == 30

    def test_provision_uses_default_timeout_60(self):
        from worca.scripts.run_fleet import main
        with (
            patch("worca.scripts.run_fleet.provision_target") as mock_prov,
            patch("worca.scripts.run_fleet._load_global_settings", return_value={}),
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
            patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"),
        ):
            mock_prov.return_value = (True, None)
            main(["--projects", "/repo/a", "--prompt", "x"])
        assert mock_prov.call_args[0][1] == 60

    def test_setup_failed_does_not_halt_fleet(self):
        from worca.scripts.run_fleet import main
        with (
            patch("worca.scripts.run_fleet.provision_target") as mock_prov,
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
            patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"),
        ):
            mock_prov.side_effect = [
                (False, "init exceeded 60s — target may be unreachable"),
                (True, None),
            ]
            result = main(["--projects", "/repo/a", "/repo/b", "--prompt", "x"])
        assert result == 0
        assert mock_prov.call_count == 2

    def test_setup_failed_prints_to_stderr(self, capsys):
        from worca.scripts.run_fleet import main
        with (
            patch("worca.scripts.run_fleet.provision_target") as mock_prov,
            patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}),
            patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"),
        ):
            mock_prov.return_value = (False, "some init error")
            main(["--projects", "/repo/a", "--prompt", "x"])
        captured = capsys.readouterr()
        output = captured.err + captured.out
        assert "setup_failed" in output or "some init error" in output


# ---------------------------------------------------------------------------
# Phase 2b task 1 — Fleet manifest written by main() (§10)
# ---------------------------------------------------------------------------


class TestMainWritesFleetManifest:
    """main() writes an initial fleet manifest to ~/.worca/fleet-runs/<fleet_id>.json."""

    def test_manifest_written_when_projects_provided(self, tmp_path):
        from worca.scripts.run_fleet import main
        with (
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest"
            ) as mock_write,
        ):
            main(["--projects", str(tmp_path), "--prompt", "Migrate auth"])
        mock_write.assert_called_once()

    def test_manifest_contains_fleet_id(self, tmp_path):
        from worca.scripts.run_fleet import main
        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with (
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest",
                side_effect=capture,
            ),
        ):
            main(["--projects", str(tmp_path), "--prompt", "Migrate auth"])
        assert "fleet_id" in written
        assert written["fleet_id"].startswith("f_")

    def test_manifest_contains_fleet_id_short(self, tmp_path):
        from worca.scripts.run_fleet import main
        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with (
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest",
                side_effect=capture,
            ),
        ):
            main(["--projects", str(tmp_path), "--prompt", "Migrate auth"])
        assert "fleet_id_short" in written
        assert written["fleet_id"].endswith(written["fleet_id_short"])

    def test_manifest_status_is_running(self, tmp_path):
        from worca.scripts.run_fleet import main
        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with (
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest",
                side_effect=capture,
            ),
        ):
            main(["--projects", str(tmp_path), "--prompt", "Migrate auth"])
        assert written["status"] == "running"
        assert written["halt_reason"] is None

    def test_manifest_guide_uploaded_false_for_cli_paths(self, tmp_path):
        from worca.scripts.run_fleet import main
        guide_file = tmp_path / "spec.md"
        guide_file.write_text("# Guide")
        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with (
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest",
                side_effect=capture,
            ),
        ):
            main([
                "--projects", str(tmp_path),
                "--prompt", "Migrate auth",
                "--guide", str(guide_file),
            ])
        assert written["guide"]["uploaded"] is False
        assert len(written["guide"]["paths"]) == 1

    def test_manifest_plan_mode_explicit_when_plan_flag(self, tmp_path):
        from worca.scripts.run_fleet import main
        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with (
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest",
                side_effect=capture,
            ),
        ):
            main([
                "--projects", str(tmp_path),
                "--prompt", "x",
                "--plan", "docs/plans/W-040.md",
            ])
        assert written["plan"]["mode"] == "explicit"

    def test_manifest_plan_mode_plan_first_when_flag(self, tmp_path):
        from worca.scripts.run_fleet import main
        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with (
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest",
                side_effect=capture,
            ),
        ):
            main([
                "--projects", str(tmp_path),
                "--prompt", "x",
                "--plan-first",
            ])
        assert written["plan"]["mode"] == "plan-first"

    def test_manifest_base_branch_from_base_flag(self, tmp_path):
        from worca.scripts.run_fleet import main
        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with (
            patch("worca.scripts.run_fleet.validate_base_branch", return_value=[]),
            patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)),
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest",
                side_effect=capture,
            ),
        ):
            main([
                "--projects", str(tmp_path),
                "--prompt", "x",
                "--base", "dev",
            ])
        assert written["base_branch"] == "dev"

    def test_manifest_not_written_when_no_projects(self):
        from worca.scripts.run_fleet import main
        with (
            patch(
                "worca.orchestrator.fleet_manifest.write_fleet_manifest"
            ) as mock_write,
        ):
            main(["--resume", "f_202605120809_abc123"])
        mock_write.assert_not_called()
