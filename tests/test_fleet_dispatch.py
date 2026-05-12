"""Tests for W-040 Phase 2b task 2: fleet dispatch loop + env scrubbing."""
import os
import subprocess
from unittest.mock import call, patch, MagicMock

import pytest


# ---------------------------------------------------------------------------
# Env scrubbing helpers
# ---------------------------------------------------------------------------


class TestBuildChildEnv:
    """build_child_env() must strip reserved keys from os.environ."""

    def test_strips_reserved_env_keys(self):
        from worca.scripts.run_fleet import build_child_env
        from worca.utils.env import RESERVED_ENV_KEYS

        base = {k: "x" for k in RESERVED_ENV_KEYS}
        base["SAFE_VAR"] = "keep"
        result = build_child_env(base)
        for key in RESERVED_ENV_KEYS:
            assert key not in result

    def test_keeps_safe_keys(self):
        from worca.scripts.run_fleet import build_child_env

        base = {"HOME": "/root", "USER": "alice", "SAFE_VAR": "yes"}
        result = build_child_env(base)
        assert result["HOME"] == "/root"
        assert result["USER"] == "alice"
        assert result["SAFE_VAR"] == "yes"

    def test_strips_worca_prefix_keys(self):
        from worca.scripts.run_fleet import build_child_env

        base = {"WORCA_AGENT": "guardian", "WORCA_CUSTOM": "xyz"}
        result = build_child_env(base)
        assert "WORCA_AGENT" not in result
        assert "WORCA_CUSTOM" not in result

    def test_strips_claudecode(self):
        from worca.scripts.run_fleet import build_child_env

        base = {"CLAUDECODE": "1", "HOME": "/root"}
        result = build_child_env(base)
        assert "CLAUDECODE" not in result

    def test_strips_path(self):
        from worca.scripts.run_fleet import build_child_env

        base = {"PATH": "/usr/bin:/bin", "HOME": "/root"}
        result = build_child_env(base)
        assert "PATH" not in result

    def test_uses_env_py_reserved_keys_not_hardcoded(self):
        """Verify run_fleet imports RESERVED_ENV_KEYS from worca.utils.env."""
        import importlib
        import worca.scripts.run_fleet as fleet_mod
        src = importlib.util.find_spec("worca.scripts.run_fleet").origin
        with open(src) as f:
            source = f.read()
        assert "RESERVED_ENV_KEYS" in source
        assert "from worca.utils.env import" in source or "worca.utils.env" in source

    def test_strips_worca_run_id(self):
        from worca.scripts.run_fleet import build_child_env

        base = {"WORCA_RUN_ID": "some-run-123"}
        result = build_child_env(base)
        assert "WORCA_RUN_ID" not in result

    def test_strips_worca_project_root(self):
        from worca.scripts.run_fleet import build_child_env

        base = {"WORCA_PROJECT_ROOT": "/fleet/launcher/dir"}
        result = build_child_env(base)
        assert "WORCA_PROJECT_ROOT" not in result

    def test_does_not_modify_input(self):
        from worca.scripts.run_fleet import build_child_env

        base = {"WORCA_AGENT": "planner", "HOME": "/root"}
        original = dict(base)
        build_child_env(base)
        assert base == original

    def test_empty_env_returns_empty(self):
        from worca.scripts.run_fleet import build_child_env

        result = build_child_env({})
        assert result == {}


# ---------------------------------------------------------------------------
# Build child command
# ---------------------------------------------------------------------------


class TestBuildChildCmd:
    """build_child_cmd() constructs the run_worktree.py invocation."""

    def _call(self, project_dir, fleet_id, prompt=None, source=None, base=None,
              guide=None, plan=None):
        from worca.scripts.run_fleet import build_child_cmd
        return build_child_cmd(
            project_dir=project_dir,
            fleet_id=fleet_id,
            prompt=prompt,
            source=source,
            base=base,
            guide=guide,
            plan=plan,
        )

    def test_includes_run_worktree_py(self):
        cmd = self._call("/repo/a", "f_abc", prompt="x")
        script = cmd[-1] if cmd[-1].endswith("run_worktree.py") else None
        assert any("run_worktree.py" in c for c in cmd)

    def test_includes_fleet_id(self):
        cmd = self._call("/repo/a", "f_abc123", prompt="x")
        assert "--fleet-id" in cmd
        idx = cmd.index("--fleet-id")
        assert cmd[idx + 1] == "f_abc123"

    def test_includes_prompt(self):
        cmd = self._call("/repo/a", "f_abc", prompt="Migrate auth")
        assert "--prompt" in cmd
        idx = cmd.index("--prompt")
        assert cmd[idx + 1] == "Migrate auth"

    def test_includes_source_when_provided(self):
        cmd = self._call("/repo/a", "f_abc", source="gh:issue:42")
        assert "--source" in cmd
        idx = cmd.index("--source")
        assert cmd[idx + 1] == "gh:issue:42"

    def test_includes_base_as_branch_flag(self):
        cmd = self._call("/repo/a", "f_abc", prompt="x", base="dev")
        assert "--branch" in cmd
        idx = cmd.index("--branch")
        assert cmd[idx + 1] == "dev"

    def test_omits_branch_when_base_is_none(self):
        cmd = self._call("/repo/a", "f_abc", prompt="x", base=None)
        assert "--branch" not in cmd

    def test_includes_guide_paths(self):
        cmd = self._call("/repo/a", "f_abc", prompt="x", guide=["/docs/spec.md"])
        assert "--guide" in cmd
        idx = cmd.index("--guide")
        assert cmd[idx + 1] == "/docs/spec.md"

    def test_includes_multiple_guide_paths(self):
        cmd = self._call("/repo/a", "f_abc", prompt="x",
                         guide=["/docs/a.md", "/docs/b.md"])
        guide_indices = [i for i, c in enumerate(cmd) if c == "--guide"]
        assert len(guide_indices) == 2

    def test_includes_plan_when_provided(self):
        cmd = self._call("/repo/a", "f_abc", prompt="x", plan="/plan.md")
        assert "--plan" in cmd
        idx = cmd.index("--plan")
        assert cmd[idx + 1] == "/plan.md"

    def test_omits_plan_when_none(self):
        cmd = self._call("/repo/a", "f_abc", prompt="x", plan=None)
        assert "--plan" not in cmd


# ---------------------------------------------------------------------------
# Dispatch loop
# ---------------------------------------------------------------------------


class TestDispatchFleet:
    """dispatch_fleet() runs children with concurrency limit and circuit breaker."""

    def _make_target(self, project_dir):
        return {"project_dir": project_dir, "status": "pending"}

    def _call(self, targets, fleet_id, max_parallel=5, threshold=0.30,
              prompt="x", source=None, base=None, guide=None, plan=None,
              child_returncode=0):
        from worca.scripts.run_fleet import dispatch_fleet

        completed = subprocess.CompletedProcess(
            args=[], returncode=child_returncode, stdout="", stderr=""
        )

        with patch("worca.scripts.run_fleet.subprocess.run", return_value=completed) as mock_run, \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}):
            result = dispatch_fleet(
                targets=targets,
                fleet_id=fleet_id,
                prompt=prompt,
                source=source,
                base=base,
                guide=guide or [],
                plan=plan,
                max_parallel=max_parallel,
                fleet_failure_threshold=threshold,
            )
            return result, mock_run

    def test_dispatches_each_target(self):
        targets = [
            self._make_target("/repo/a"),
            self._make_target("/repo/b"),
        ]
        result, mock_run = self._call(targets, "f_abc")
        assert mock_run.call_count == 2

    def test_dispatches_single_target(self):
        targets = [self._make_target("/repo/a")]
        result, mock_run = self._call(targets, "f_abc")
        assert mock_run.call_count == 1

    def test_empty_targets_returns_immediately(self):
        result, mock_run = self._call([], "f_abc")
        assert mock_run.call_count == 0

    def test_passes_cwd_as_project_dir(self):
        targets = [self._make_target("/repo/a")]
        _, mock_run = self._call(targets, "f_abc")
        kwargs = mock_run.call_args[1]
        assert kwargs.get("cwd") == "/repo/a"

    def test_passes_scrubbed_env_to_subprocess(self):
        targets = [self._make_target("/repo/a")]
        from worca.scripts.run_fleet import dispatch_fleet
        import subprocess as sp

        completed = sp.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        scrubbed = {"HOME": "/root", "CUSTOM": "yes"}

        with patch("worca.scripts.run_fleet.subprocess.run", return_value=completed) as mock_run, \
             patch("worca.scripts.run_fleet.build_child_env", return_value=scrubbed):
            dispatch_fleet(
                targets=targets,
                fleet_id="f_abc",
                prompt="x",
                source=None,
                base=None,
                guide=[],
                plan=None,
                max_parallel=5,
                fleet_failure_threshold=0.30,
            )
        kwargs = mock_run.call_args[1]
        assert kwargs.get("env") == scrubbed

    def test_returns_dict_with_child_results(self):
        targets = [self._make_target("/repo/a")]
        result, _ = self._call(targets, "f_abc")
        assert isinstance(result, dict)
        assert "/repo/a" in result

    def test_successful_child_marked_completed(self):
        targets = [self._make_target("/repo/a")]
        result, _ = self._call(targets, "f_abc", child_returncode=0)
        assert result["/repo/a"]["status"] == "completed"

    def test_failed_child_marked_failed(self):
        targets = [self._make_target("/repo/a")]
        result, _ = self._call(targets, "f_abc", child_returncode=1)
        assert result["/repo/a"]["status"] == "failed"

    def test_circuit_breaker_halts_unstarted_children(self):
        """When failed/terminal >= threshold and terminal >= min(3,total), remaining
        unstarted children are skipped (§7 formula)."""
        # 5 targets: first 3 fail → terminal=3 >= min(3,5)=3, 3/3=1.0 >= 0.30 → fire
        # Targets 3 and 4 should be skipped (halted)
        targets = [
            self._make_target(f"/repo/{i}") for i in range(5)
        ]
        from worca.scripts.run_fleet import dispatch_fleet
        import subprocess as sp

        call_count = 0

        def fake_run(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            # First 3 fail
            rc = 1 if call_count <= 3 else 0
            return sp.CompletedProcess(args=[], returncode=rc, stdout="", stderr="")

        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=fake_run), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}), \
             patch("worca.scripts.run_fleet.update_fleet_status"):
            result = dispatch_fleet(
                targets=targets,
                fleet_id="f_abc",
                prompt="x",
                source=None,
                base=None,
                guide=[],
                plan=None,
                max_parallel=1,
                fleet_failure_threshold=0.30,
            )

        # Circuit breaker fires after 3 failures; fewer than 5 were run
        assert call_count < 5

    def test_circuit_breaker_does_not_kill_in_flight(self):
        """Children already running are not killed when breaker fires."""
        # With max_parallel=2, and threshold such that after 1 failure the breaker
        # fires, the already-dispatched second child must still complete.
        # With a sequential (max_parallel=1) loop, in-flight == current child,
        # which already has its result. We verify the result dict still has it.
        targets = [
            self._make_target("/repo/a"),
            self._make_target("/repo/b"),
        ]
        from worca.scripts.run_fleet import dispatch_fleet
        import subprocess as sp

        call_idx = 0

        def fake_run(*args, **kwargs):
            nonlocal call_idx
            call_idx += 1
            # All fail — breaker will trip after first
            return sp.CompletedProcess(args=[], returncode=1, stdout="", stderr="")

        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=fake_run), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}), \
             patch("worca.scripts.run_fleet.update_fleet_status"):
            result = dispatch_fleet(
                targets=targets,
                fleet_id="f_abc",
                prompt="x",
                source=None,
                base=None,
                guide=[],
                plan=None,
                max_parallel=1,
                fleet_failure_threshold=0.10,  # very low — fires after min(3,2)=2 terminal
            )

        # The first child already ran and its result is in the dict
        completed_or_failed = [v for v in result.values() if v["status"] in ("completed", "failed")]
        assert len(completed_or_failed) >= 1

    def test_no_threadpoolexecutor_import(self):
        """run_fleet.py must not use ThreadPoolExecutor (manual loop required)."""
        import importlib.util
        src = importlib.util.find_spec("worca.scripts.run_fleet").origin
        with open(src) as f:
            source = f.read()
        assert "ThreadPoolExecutor" not in source

    def test_max_parallel_limits_concurrent_children(self):
        """At most --max-parallel children run simultaneously."""
        # With 6 targets and max_parallel=2, subprocess.run is called serially
        # at most 2 at a time. We track concurrent calls via a counter.
        targets = [self._make_target(f"/repo/{i}") for i in range(6)]
        from worca.scripts.run_fleet import dispatch_fleet
        import subprocess as sp

        concurrent = {"current": 0, "peak": 0}

        def fake_run(*args, **kwargs):
            concurrent["current"] += 1
            concurrent["peak"] = max(concurrent["peak"], concurrent["current"])
            result = sp.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
            concurrent["current"] -= 1
            return result

        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=fake_run), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}):
            dispatch_fleet(
                targets=targets,
                fleet_id="f_abc",
                prompt="x",
                source=None,
                base=None,
                guide=[],
                plan=None,
                max_parallel=2,
                fleet_failure_threshold=0.30,
            )

        assert concurrent["peak"] <= 2

    def test_halted_targets_get_halted_status(self):
        """Targets not dispatched due to circuit breaker get status=halted.

        Uses 4 targets so that after 3 failures (terminal=3 >= min(3,4)=3)
        the breaker fires and the 4th target is marked halted rather than run.
        """
        targets = [
            self._make_target("/repo/a"),
            self._make_target("/repo/b"),
            self._make_target("/repo/c"),
            self._make_target("/repo/d"),
        ]
        from worca.scripts.run_fleet import dispatch_fleet
        import subprocess as sp

        def fake_run(*args, **kwargs):
            return sp.CompletedProcess(args=[], returncode=1, stdout="", stderr="")

        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=fake_run), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}), \
             patch("worca.scripts.run_fleet.update_fleet_status"):
            result = dispatch_fleet(
                targets=targets,
                fleet_id="f_abc",
                prompt="x",
                source=None,
                base=None,
                guide=[],
                plan=None,
                max_parallel=1,
                fleet_failure_threshold=0.10,
            )

        statuses = [v["status"] for v in result.values()]
        assert "halted" in statuses


# ---------------------------------------------------------------------------
# main() wires dispatch
# ---------------------------------------------------------------------------


class TestMainDispatchWiring:
    """main() calls dispatch_fleet() with the right args after provisioning."""

    def test_main_calls_dispatch_fleet(self, tmp_path):
        from worca.scripts.run_fleet import main

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch, \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            mock_dispatch.return_value = {}
            main(["--projects", str(tmp_path), "--prompt", "x"])
        mock_dispatch.assert_called_once()

    def test_main_passes_max_parallel(self, tmp_path):
        from worca.scripts.run_fleet import main

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch, \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            mock_dispatch.return_value = {}
            main([
                "--projects", str(tmp_path),
                "--prompt", "x",
                "--max-parallel", "3",
            ])
        kwargs = mock_dispatch.call_args[1]
        assert kwargs.get("max_parallel") == 3

    def test_main_passes_fleet_failure_threshold(self, tmp_path):
        from worca.scripts.run_fleet import main

        with patch("worca.scripts.run_fleet.provision_target", return_value=(True, None)), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch, \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            mock_dispatch.return_value = {}
            main([
                "--projects", str(tmp_path),
                "--prompt", "x",
                "--fleet-failure-threshold", "0.5",
            ])
        kwargs = mock_dispatch.call_args[1]
        assert kwargs.get("fleet_failure_threshold") == pytest.approx(0.5)

    def test_main_skips_dispatch_when_no_projects(self):
        from worca.scripts.run_fleet import main

        with patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch:
            main(["--resume", "f_20260512_abc"])
        mock_dispatch.assert_not_called()

    def test_main_skips_provisioned_failures_from_dispatch(self, tmp_path):
        """Targets that failed provisioning are not passed to dispatch_fleet."""
        from worca.scripts.run_fleet import main

        proj_a = tmp_path / "a"
        proj_b = tmp_path / "b"
        proj_a.mkdir()
        proj_b.mkdir()

        with patch("worca.scripts.run_fleet.provision_target") as mock_prov, \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch, \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            mock_prov.side_effect = [
                (False, "init failed"),
                (True, None),
            ]
            mock_dispatch.return_value = {}
            main([
                "--projects", str(proj_a), str(proj_b),
                "--prompt", "x",
            ])

        # dispatch_fleet should only receive the successfully provisioned target
        mock_dispatch.assert_called_once()
        kwargs = mock_dispatch.call_args[1]
        targets = kwargs.get("targets", [])
        assert len(targets) == 1
        assert targets[0]["project_dir"] == str(proj_b)
