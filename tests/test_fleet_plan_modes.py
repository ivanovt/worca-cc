"""Tests for W-040-16/17: plan propagation and --plan-first for fleet children.

§6 of the W-040 plan:
  --plan <path> (explicit) — every child receives the same plan; Planner is
    skipped in every child. Propagated via run_worktree.py --plan.
  --plan-first [project] — designated reference project runs Planner first;
    plan copied to ~/.worca/fleet-runs/<fleet_id>/shared-plan.md; remaining
    N-1 children launch with that plan. Fleet halts if reference Planner fails.
"""
import os
import subprocess
from unittest.mock import MagicMock, patch



def _make_target(project_dir):
    return {"project_dir": project_dir, "status": "pending"}


def _dispatch_capture_cmds(targets, plan, guide=None):
    """Run dispatch_fleet and capture every child subprocess command.

    dispatch_fleet now uses subprocess.Popen (non-blocking) for real parallelism;
    the spy below mimics the Popen interface — records the cmd at __init__ and
    returns rc=0 on poll().
    """
    from worca.scripts.run_fleet import dispatch_fleet

    captured = []

    class _Spy:
        def __init__(self, cmd, *args, **kwargs):
            captured.append(list(cmd))

        def poll(self):
            return 0

    with patch("worca.scripts.run_fleet.subprocess.Popen", _Spy), \
         patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}):
        dispatch_fleet(
            targets=targets,
            fleet_id="f_test",
            prompt="Migrate auth",
            source=None,
            base=None,
            guide=guide or [],
            plan=plan,
            max_parallel=5,
            fleet_failure_threshold=0.30,
        )

    return captured


# ---------------------------------------------------------------------------
# test_plan_explicit: --plan <path> attaches same plan to every child
# ---------------------------------------------------------------------------


class TestPlanExplicit:
    """--plan <path> propagates the same plan to all fleet children."""

    def test_plan_included_in_every_child_cmd(self, tmp_path):
        """Every child command includes --plan with the given path."""
        plan_file = str(tmp_path / "plan.md")
        targets = [_make_target(f"/repo/{i}") for i in range(3)]
        cmds = _dispatch_capture_cmds(targets, plan=plan_file)
        assert len(cmds) == 3
        for cmd in cmds:
            assert "--plan" in cmd

    def test_all_children_receive_same_plan_path(self, tmp_path):
        """Every child gets exactly the same plan path — no divergence."""
        plan_file = str(tmp_path / "plan.md")
        targets = [_make_target(f"/repo/{i}") for i in range(4)]
        cmds = _dispatch_capture_cmds(targets, plan=plan_file)
        plan_values = []
        for cmd in cmds:
            if "--plan" in cmd:
                idx = cmd.index("--plan")
                plan_values.append(cmd[idx + 1])
        assert len(plan_values) == 4
        assert len(set(plan_values)) == 1, "all children must receive the same plan path"

    def test_plan_path_value_matches_provided_path(self, tmp_path):
        """The plan path in each child command equals the dispatched path."""
        plan_file = str(tmp_path / "shared-plan.md")
        targets = [_make_target("/repo/a"), _make_target("/repo/b")]
        cmds = _dispatch_capture_cmds(targets, plan=plan_file)
        for cmd in cmds:
            idx = cmd.index("--plan")
            assert cmd[idx + 1] == plan_file

    def test_no_plan_omits_flag_from_all_children(self):
        """When --plan is absent, no child receives a --plan flag."""
        targets = [_make_target(f"/repo/{i}") for i in range(3)]
        cmds = _dispatch_capture_cmds(targets, plan=None)
        assert len(cmds) == 3
        for cmd in cmds:
            assert "--plan" not in cmd

    def test_plan_path_passed_to_run_worktree(self, tmp_path):
        """Child command targets run_worktree.py, not run_pipeline.py directly."""
        plan_file = str(tmp_path / "plan.md")
        targets = [_make_target("/repo/a")]
        cmds = _dispatch_capture_cmds(targets, plan=plan_file)
        assert len(cmds) == 1
        cmd = cmds[0]
        assert any("run_worktree.py" in part for part in cmd)


# ---------------------------------------------------------------------------
# main() wiring: --plan resolved to absolute path before dispatch
# ---------------------------------------------------------------------------


class TestPlanExplicitMainWiring:
    """main() resolves --plan to an absolute path and passes it to dispatch_fleet."""

    def test_main_passes_plan_to_dispatch_fleet(self, tmp_path):
        """main() calls dispatch_fleet with the plan path when --plan is given."""
        from worca.scripts.run_fleet import main

        plan_file = str(tmp_path / "plan.md")

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch, \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            mock_dispatch.return_value = {}
            main(["--projects", str(tmp_path), "--prompt", "x", "--plan", plan_file])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs.get("plan") is not None

    def test_main_resolves_plan_to_absolute_path(self, tmp_path):
        """Relative --plan path is resolved to absolute before dispatch."""
        from worca.scripts.run_fleet import main

        plan_file = str(tmp_path / "plan.md")
        abs_plan = os.path.abspath(plan_file)

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch, \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            mock_dispatch.return_value = {}
            main(["--projects", str(tmp_path), "--prompt", "x", "--plan", plan_file])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs.get("plan") == abs_plan

    def test_main_passes_none_plan_when_absent(self, tmp_path):
        """When --plan is not given, dispatch_fleet receives plan=None."""
        from worca.scripts.run_fleet import main

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch, \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            mock_dispatch.return_value = {}
            main(["--projects", str(tmp_path), "--prompt", "x"])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs.get("plan") is None

    def test_manifest_plan_path_is_absolute(self, tmp_path):
        """Manifest records plan.path as an absolute path when --plan is given."""
        from worca.scripts.run_fleet import main

        plan_file = str(tmp_path / "plan.md")
        abs_plan = os.path.abspath(plan_file)
        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest", side_effect=capture), \
             patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}):
            main(["--projects", str(tmp_path), "--prompt", "x", "--plan", plan_file])

        assert written["plan"]["path"] == abs_plan

    def test_manifest_plan_path_none_when_no_plan(self, tmp_path):
        """Manifest records plan.path=None when --plan is not given."""
        from worca.scripts.run_fleet import main

        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest", side_effect=capture), \
             patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}):
            main(["--projects", str(tmp_path), "--prompt", "x"])

        assert written["plan"]["path"] is None

    def test_manifest_plan_mode_none_when_no_plan_flags(self, tmp_path):
        """Manifest records plan.mode='none' when neither --plan nor --plan-first is given."""
        from worca.scripts.run_fleet import main

        written = {}

        def capture(manifest, **kw):
            written.update(manifest)

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest", side_effect=capture), \
             patch("worca.scripts.run_fleet.dispatch_fleet", return_value={}):
            main(["--projects", str(tmp_path), "--prompt", "x"])

        assert written["plan"]["mode"] == "none"


# ---------------------------------------------------------------------------
# Single-child fleet with --plan (N=1 use case)
# ---------------------------------------------------------------------------


class TestPlanExplicitSingleTarget:
    """N=1 fleet with --plan still propagates the plan correctly."""

    def test_single_target_receives_plan(self, tmp_path):
        """A single-target fleet also gets the --plan flag."""
        plan_file = str(tmp_path / "plan.md")
        targets = [_make_target("/repo/a")]
        cmds = _dispatch_capture_cmds(targets, plan=plan_file)
        assert len(cmds) == 1
        assert "--plan" in cmds[0]
        idx = cmds[0].index("--plan")
        assert cmds[0][idx + 1] == plan_file

    def test_single_target_no_plan_omits_flag(self):
        """A single-target fleet without --plan omits the flag."""
        targets = [_make_target("/repo/a")]
        cmds = _dispatch_capture_cmds(targets, plan=None)
        assert len(cmds) == 1
        assert "--plan" not in cmds[0]


# ---------------------------------------------------------------------------
# W-040-17: _wait_for_plan() — polls for MASTER_PLAN.md with timeout
# ---------------------------------------------------------------------------


class TestWaitForPlan:
    """_wait_for_plan() polls for MASTER_PLAN.md in worktree root."""

    def test_returns_path_immediately_when_file_exists(self, tmp_path):
        """Returns the plan path immediately when MASTER_PLAN.md already exists."""
        from worca.scripts.run_fleet import _wait_for_plan

        plan = tmp_path / "MASTER_PLAN.md"
        plan.write_text("# Plan\n")

        result = _wait_for_plan(str(tmp_path), timeout=1, poll_interval=0.01)
        assert result == str(plan)

    def test_returns_none_on_timeout(self, tmp_path):
        """Returns None when MASTER_PLAN.md never appears within timeout."""
        from worca.scripts.run_fleet import _wait_for_plan

        result = _wait_for_plan(str(tmp_path), timeout=0.05, poll_interval=0.01)
        assert result is None

    def test_returns_none_for_nonexistent_directory(self, tmp_path):
        """Returns None when the worktree path does not exist."""
        from worca.scripts.run_fleet import _wait_for_plan

        result = _wait_for_plan(str(tmp_path / "nonexistent"), timeout=0.05, poll_interval=0.01)
        assert result is None


# ---------------------------------------------------------------------------
# W-040-17: run_plan_first() — dispatch reference child, copy plan to fleet dir
# ---------------------------------------------------------------------------


def _fake_run_worktree_success(worktree_path):
    """Build a fake subprocess.run side_effect that returns worktree_path on stdout."""
    def _fake(cmd, *args, **kwargs):
        return subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=f"run-001\n{worktree_path}\n",
            stderr="",
        )
    return _fake


class TestRunPlanFirst:
    """run_plan_first(): dispatch reference child (blocking), copy plan to fleet dir."""

    def test_returns_none_on_reference_child_failure(self, tmp_path):
        """Returns None when run_worktree.py exits non-zero."""
        from worca.scripts.run_fleet import run_plan_first

        with patch("worca.scripts.run_fleet.subprocess.run") as mock_run, \
             patch("worca.scripts.run_fleet.build_child_env", return_value={}):
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr="error"
            )
            result = run_plan_first(
                reference_project="/repo/ref",
                fleet_id="f_test",
                prompt="Do it",
                source=None,
                base=None,
                guide=[],
                fleet_runs_base=str(tmp_path),
            )
        assert result is None

    def test_returns_none_when_plan_times_out(self, tmp_path):
        """Returns None when _wait_for_plan returns None (plan never appears)."""
        from worca.scripts.run_fleet import run_plan_first

        with patch("worca.scripts.run_fleet.subprocess.run",
                   side_effect=_fake_run_worktree_success(str(tmp_path))), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={}), \
             patch("worca.scripts.run_fleet._wait_for_plan", return_value=None):
            result = run_plan_first(
                reference_project="/repo/ref",
                fleet_id="f_test",
                prompt="Do it",
                source=None,
                base=None,
                guide=[],
                fleet_runs_base=str(tmp_path),
            )
        assert result is None

    def test_copies_plan_to_fleet_dir(self, tmp_path):
        """On success, plan file is copied to <fleet_runs_base>/<fleet_id>/shared-plan.md."""
        from worca.scripts.run_fleet import run_plan_first

        plan_content = "# My Plan\n## Step 1\nDo the thing.\n"
        plan_file = tmp_path / "MASTER_PLAN.md"
        plan_file.write_text(plan_content)
        fleet_runs_base = str(tmp_path / "fleet-runs")

        with patch("worca.scripts.run_fleet.subprocess.run",
                   side_effect=_fake_run_worktree_success(str(tmp_path))), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={}), \
             patch("worca.scripts.run_fleet._wait_for_plan", return_value=str(plan_file)):
            run_plan_first(
                reference_project="/repo/ref",
                fleet_id="f_test_001",
                prompt="Do it",
                source=None,
                base=None,
                guide=[],
                fleet_runs_base=fleet_runs_base,
            )

        shared = os.path.join(fleet_runs_base, "f_test_001", "shared-plan.md")
        assert os.path.isfile(shared)
        assert open(shared).read() == plan_content

    def test_returns_shared_plan_path(self, tmp_path):
        """Returns the absolute path to the fleet-scoped shared-plan.md."""
        from worca.scripts.run_fleet import run_plan_first

        plan_file = tmp_path / "plan.md"
        plan_file.write_text("# Plan\n")
        fleet_runs_base = str(tmp_path / "fleet-runs")

        with patch("worca.scripts.run_fleet.subprocess.run",
                   side_effect=_fake_run_worktree_success(str(tmp_path))), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={}), \
             patch("worca.scripts.run_fleet._wait_for_plan", return_value=str(plan_file)):
            result = run_plan_first(
                reference_project="/repo/ref",
                fleet_id="f_test_001",
                prompt="Do it",
                source=None,
                base=None,
                guide=[],
                fleet_runs_base=fleet_runs_base,
            )

        expected = os.path.join(fleet_runs_base, "f_test_001", "shared-plan.md")
        assert result == expected

    def test_reference_child_cmd_has_no_plan_flag(self, tmp_path):
        """Reference child command does not include --plan (it generates the plan)."""
        from worca.scripts.run_fleet import run_plan_first

        plan_file = tmp_path / "MASTER_PLAN.md"
        plan_file.write_text("# Plan\n")
        captured_cmds = []

        def fake_run(cmd, *args, **kwargs):
            captured_cmds.append(list(cmd))
            return subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=f"run-001\n{tmp_path}\n",
                stderr="",
            )

        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=fake_run), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={}), \
             patch("worca.scripts.run_fleet._wait_for_plan", return_value=str(plan_file)):
            run_plan_first(
                reference_project="/repo/ref",
                fleet_id="f_test",
                prompt="Do it",
                source=None,
                base=None,
                guide=[],
                fleet_runs_base=str(tmp_path / "fleet-runs"),
            )

        assert len(captured_cmds) == 1
        assert "--plan" not in captured_cmds[0]

    def test_reference_child_runs_in_reference_dir(self, tmp_path):
        """subprocess.run is called with cwd=reference_project."""
        from worca.scripts.run_fleet import run_plan_first

        plan_file = tmp_path / "MASTER_PLAN.md"
        plan_file.write_text("# Plan\n")
        captured_kwds = []

        def fake_run(cmd, *args, **kwargs):
            captured_kwds.append(kwargs)
            return subprocess.CompletedProcess(
                args=[], returncode=0,
                stdout=f"run-001\n{tmp_path}\n",
                stderr="",
            )

        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=fake_run), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={}), \
             patch("worca.scripts.run_fleet._wait_for_plan", return_value=str(plan_file)):
            run_plan_first(
                reference_project="/repo/ref",
                fleet_id="f_test",
                prompt="Do it",
                source=None,
                base=None,
                guide=[],
                fleet_runs_base=str(tmp_path / "fleet-runs"),
            )

        assert captured_kwds[0].get("cwd") == "/repo/ref"


# ---------------------------------------------------------------------------
# W-040-17: --plan-first argument parsing
# ---------------------------------------------------------------------------


class TestPlanFirstArgParser:
    """--plan-first argument parsing supports optional project-name value."""

    def test_plan_first_without_value_is_truthy(self):
        """--plan-first (no project) results in a truthy args.plan_first."""
        from worca.scripts.run_fleet import create_parser

        parser = create_parser()
        args = parser.parse_args(["--projects", "/p1", "--prompt", "x", "--plan-first"])
        assert args.plan_first

    def test_plan_first_with_project_path(self):
        """--plan-first /path/to/project stores the path string."""
        from worca.scripts.run_fleet import create_parser

        parser = create_parser()
        args = parser.parse_args(
            ["--projects", "/p1", "--prompt", "x", "--plan-first", "/proj/ref"]
        )
        assert args.plan_first == "/proj/ref"

    def test_plan_first_absent_is_falsy(self):
        """When --plan-first is not supplied, args.plan_first is falsy."""
        from worca.scripts.run_fleet import create_parser

        parser = create_parser()
        args = parser.parse_args(["--projects", "/p1", "--prompt", "x"])
        assert not args.plan_first


# ---------------------------------------------------------------------------
# W-040-17: main() --plan-first wiring
# ---------------------------------------------------------------------------


def _main_plan_first(tmp_path, extra_argv=None, mock_run_plan_first=None, mock_dispatch=None):
    """Helper: call main() with --plan-first and standard mocks."""
    from worca.scripts.run_fleet import main

    p1 = str(tmp_path / "proj1")
    p2 = str(tmp_path / "proj2")
    p3 = str(tmp_path / "proj3")

    argv = ["--projects", p1, p2, p3, "--prompt", "my-task", "--plan-first"]
    if extra_argv:
        argv += extra_argv

    if mock_run_plan_first is None:
        mock_run_plan_first = MagicMock(return_value=str(tmp_path / "shared-plan.md"))
    if mock_dispatch is None:
        mock_dispatch = MagicMock(return_value={})

    with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
         patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"), \
         patch("worca.scripts.run_fleet.run_plan_first", mock_run_plan_first), \
         patch("worca.scripts.run_fleet.dispatch_fleet", mock_dispatch):
        exit_code = main(argv)

    return exit_code, mock_run_plan_first, mock_dispatch


class TestPlanFirstMainWiring:
    """main() --plan-first: reference project, halting, fan-out dispatch."""

    def test_default_reference_is_first_project(self, tmp_path):
        """When --plan-first has no value, first --projects entry is the reference."""
        _, mock_rpf, _ = _main_plan_first(tmp_path)

        call_kwargs = mock_rpf.call_args[1] if mock_rpf.call_args else {}
        assert call_kwargs.get("reference_project") == str(tmp_path / "proj1")

    def test_explicit_reference_project_used(self, tmp_path):
        """--plan-first <path> uses that path as the reference project."""
        p2 = str(tmp_path / "proj2")

        _, mock_rpf, _ = _main_plan_first(tmp_path, extra_argv=[p2])

        call_kwargs = mock_rpf.call_args[1] if mock_rpf.call_args else {}
        assert call_kwargs.get("reference_project") == p2

    def test_halts_fleet_if_reference_fails(self, tmp_path):
        """main() returns exit code 1 and marks fleet halted when run_plan_first fails."""
        from worca.scripts.run_fleet import main

        p1 = str(tmp_path)

        halt_calls = []

        def capture_halt(fleet_id, status, **kwargs):
            halt_calls.append({"status": status, "reason": kwargs.get("halt_reason")})

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"), \
             patch("worca.scripts.run_fleet.run_plan_first", return_value=None), \
             patch("worca.scripts.run_fleet.update_fleet_status", side_effect=capture_halt):
            exit_code = main(["--projects", p1, "--prompt", "x", "--plan-first"])

        assert exit_code == 1
        assert len(halt_calls) == 1
        assert halt_calls[0]["status"] == "halted"

    def test_dispatch_not_called_on_reference_failure(self, tmp_path):
        """dispatch_fleet is not called when run_plan_first returns None."""
        from worca.scripts.run_fleet import main

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"), \
             patch("worca.scripts.run_fleet.run_plan_first", return_value=None), \
             patch("worca.scripts.run_fleet.update_fleet_status"), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch:
            main(["--projects", str(tmp_path), "--prompt", "x", "--plan-first"])

        mock_dispatch.assert_not_called()

    def test_remaining_n_minus_1_dispatched_with_shared_plan(self, tmp_path):
        """N-1 remaining children are dispatched with plan=<shared_plan_path>."""
        shared_plan = str(tmp_path / "shared-plan.md")
        _, _, mock_dispatch = _main_plan_first(
            tmp_path,
            mock_run_plan_first=MagicMock(return_value=shared_plan),
        )

        kwargs = mock_dispatch.call_args[1]
        assert kwargs.get("plan") == shared_plan

    def test_reference_excluded_from_dispatch_targets(self, tmp_path):
        """Reference project (first in --projects) is not in dispatch targets."""
        p1 = str(tmp_path / "proj1")
        p2 = str(tmp_path / "proj2")
        p3 = str(tmp_path / "proj3")
        shared_plan = str(tmp_path / "shared-plan.md")

        _, _, mock_dispatch = _main_plan_first(
            tmp_path,
            mock_run_plan_first=MagicMock(return_value=shared_plan),
        )

        kwargs = mock_dispatch.call_args[1]
        target_dirs = [t["project_dir"] for t in kwargs.get("targets", [])]
        assert p1 not in target_dirs
        assert p2 in target_dirs
        assert p3 in target_dirs

    def test_two_projects_dispatches_one_after_plan_first(self, tmp_path):
        """With 2 projects and --plan-first, exactly 1 child is dispatched."""
        from worca.scripts.run_fleet import main

        p1 = str(tmp_path / "proj1")
        p2 = str(tmp_path / "proj2")
        shared_plan = str(tmp_path / "shared-plan.md")

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"), \
             patch("worca.scripts.run_fleet.run_plan_first", return_value=shared_plan), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch:
            mock_dispatch.return_value = {}
            main(["--projects", p1, p2, "--prompt", "x", "--plan-first"])

        kwargs = mock_dispatch.call_args[1]
        assert len(kwargs.get("targets", [])) == 1
        assert kwargs["targets"][0]["project_dir"] == p2

    def test_single_project_dispatches_empty_targets(self, tmp_path):
        """With 1 project and --plan-first, dispatch_fleet receives empty targets."""
        from worca.scripts.run_fleet import main

        p1 = str(tmp_path)
        shared_plan = str(tmp_path / "shared-plan.md")

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"), \
             patch("worca.scripts.run_fleet.run_plan_first", return_value=shared_plan), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch:
            mock_dispatch.return_value = {}
            main(["--projects", p1, "--prompt", "x", "--plan-first"])

        kwargs = mock_dispatch.call_args[1]
        assert kwargs.get("targets") == []

    def test_manifest_records_plan_first_mode(self, tmp_path):
        """Manifest records plan.mode='plan-first' when --plan-first is given."""
        from worca.scripts.run_fleet import main

        written = {}

        def capture_manifest(manifest, **kw):
            written.update(manifest)

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest",
                   side_effect=capture_manifest), \
             patch("worca.scripts.run_fleet.run_plan_first", return_value=None), \
             patch("worca.scripts.run_fleet.update_fleet_status"):
            main(["--projects", str(tmp_path), "--prompt", "x", "--plan-first"])

        assert written.get("plan", {}).get("mode") == "plan-first"

    def test_plan_and_plan_first_together_errors(self, tmp_path):
        """--plan and --plan-first together is an error (exit code 2)."""
        from worca.scripts.run_fleet import main

        plan_file = str(tmp_path / "plan.md")

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            exit_code = main(
                ["--projects", str(tmp_path), "--prompt", "x",
                 "--plan", plan_file, "--plan-first"]
            )

        assert exit_code == 2
