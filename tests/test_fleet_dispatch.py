"""Tests for W-040 Phase 2b task 2: fleet dispatch loop + env scrubbing."""
from unittest.mock import patch

import pytest


class _FakePopen:
    """Test substitute for ``subprocess.Popen``.

    Each instance records itself in the class-level ``_active`` list at
    construction and is removed when ``poll()`` first returns its ``rc``.
    By varying ``polls_until_done`` per construction we can simulate
    long-running children for max-parallel assertions.
    """

    _active: list = []
    _peak: int = 0
    _total_constructed: int = 0
    _rcs: list = []  # iterator of return codes, popped per construction
    _polls_until_done: int = 1

    def __init__(self, *args, **kwargs):
        type(self)._total_constructed += 1
        if type(self)._rcs:
            self.rc = type(self)._rcs.pop(0)
        else:
            self.rc = 0
        self._remaining_polls = type(self)._polls_until_done
        type(self)._active.append(self)
        type(self)._peak = max(type(self)._peak, len(type(self)._active))

    def poll(self):
        self._remaining_polls -= 1
        if self._remaining_polls <= 0:
            if self in type(self)._active:
                type(self)._active.remove(self)
            return self.rc
        return None

    def communicate(self):
        # dispatch_fleet reads stdout to extract the child's run_id from
        # run_worktree.py output. Tests don't exercise the registration
        # path, so empty output is fine — `_parse_run_id_from_stdout`
        # returns None and the registration is skipped.
        return ("", "")

    @classmethod
    def reset(cls, *, rcs=None, polls_until_done=1):
        cls._active = []
        cls._peak = 0
        cls._total_constructed = 0
        cls._rcs = list(rcs) if rcs is not None else []
        cls._polls_until_done = polls_until_done


# ---------------------------------------------------------------------------
# Env scrubbing helpers
# ---------------------------------------------------------------------------


class TestBuildChildEnv:
    """build_child_env() must strip reserved keys from os.environ."""

    def test_strips_fleet_scrub_keys(self):
        from worca.scripts.run_fleet import _FLEET_SCRUB_KEYS, build_child_env

        base = {k: "x" for k in _FLEET_SCRUB_KEYS}
        base["SAFE_VAR"] = "keep"
        result = build_child_env(base)
        for key in _FLEET_SCRUB_KEYS:
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

    def test_keeps_path(self):
        """PATH must be inherited so children can find bd/claude/gh on disk."""
        from worca.scripts.run_fleet import build_child_env

        base = {"PATH": "/usr/bin:/bin", "HOME": "/root"}
        result = build_child_env(base)
        assert result["PATH"] == "/usr/bin:/bin"

    def test_fleet_scrub_list_matches_plan_section_5(self):
        """Per W-040 §5 the fleet scrub list is the explicit fleet-internal keys
        (WORCA_*, CLAUDECODE) — not the broader RESERVED_ENV_KEYS denylist that
        also includes PATH (which is meant only for the per-model env-settings
        denylist in worca.utils.env)."""
        from worca.scripts.run_fleet import _FLEET_SCRUB_KEYS

        assert "WORCA_AGENT" in _FLEET_SCRUB_KEYS
        assert "WORCA_RUN_ID" in _FLEET_SCRUB_KEYS
        assert "WORCA_PROJECT_ROOT" in _FLEET_SCRUB_KEYS
        assert "CLAUDECODE" in _FLEET_SCRUB_KEYS
        assert "PATH" not in _FLEET_SCRUB_KEYS

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

    def test_injects_worca_fleet_id_when_supplied(self):
        """fleet_id kwarg re-adds WORCA_FLEET_ID after the WORCA_* scrub."""
        from worca.scripts.run_fleet import build_child_env

        base = {"HOME": "/root", "WORCA_FLEET_ID": "stale-parent-value"}
        result = build_child_env(base, fleet_id="f_202601011200_a1b2c3d4")
        assert result["WORCA_FLEET_ID"] == "f_202601011200_a1b2c3d4"

    def test_no_fleet_id_injection_when_kwarg_absent(self):
        """Without fleet_id kwarg, WORCA_FLEET_ID stays stripped."""
        from worca.scripts.run_fleet import build_child_env

        base = {"HOME": "/root", "WORCA_FLEET_ID": "stale"}
        result = build_child_env(base)
        assert "WORCA_FLEET_ID" not in result

    def test_fleet_id_none_is_same_as_absent(self):
        from worca.scripts.run_fleet import build_child_env

        base = {"HOME": "/root", "WORCA_FLEET_ID": "stale"}
        result = build_child_env(base, fleet_id=None)
        assert "WORCA_FLEET_ID" not in result


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

        _FakePopen.reset(rcs=[child_returncode] * len(targets))

        with patch("worca.scripts.run_fleet.subprocess.Popen", _FakePopen) as mock_popen, \
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
            return result, mock_popen

    def test_dispatches_each_target(self):
        targets = [
            self._make_target("/repo/a"),
            self._make_target("/repo/b"),
        ]
        self._call(targets, "f_abc")
        assert _FakePopen._total_constructed == 2

    def test_dispatches_single_target(self):
        targets = [self._make_target("/repo/a")]
        self._call(targets, "f_abc")
        assert _FakePopen._total_constructed == 1

    def test_empty_targets_returns_immediately(self):
        self._call([], "f_abc")
        assert _FakePopen._total_constructed == 0

    def test_passes_cwd_as_project_dir(self):
        targets = [self._make_target("/repo/a")]
        _FakePopen.reset(rcs=[0])
        cwds = []

        class _Spy(_FakePopen):
            def __init__(self, *args, **kwargs):
                cwds.append(kwargs.get("cwd"))
                super().__init__(*args, **kwargs)

        from worca.scripts.run_fleet import dispatch_fleet
        with patch("worca.scripts.run_fleet.subprocess.Popen", _Spy), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}):
            dispatch_fleet(
                targets=targets, fleet_id="f", prompt="x", source=None, base=None,
                guide=[], plan=None, max_parallel=5, fleet_failure_threshold=0.30,
            )
        assert cwds == ["/repo/a"]

    def test_passes_scrubbed_env_to_subprocess(self):
        targets = [self._make_target("/repo/a")]
        _FakePopen.reset(rcs=[0])
        envs = []

        class _Spy(_FakePopen):
            def __init__(self, *args, **kwargs):
                envs.append(kwargs.get("env"))
                super().__init__(*args, **kwargs)

        scrubbed = {"HOME": "/root", "CUSTOM": "yes"}
        from worca.scripts.run_fleet import dispatch_fleet
        with patch("worca.scripts.run_fleet.subprocess.Popen", _Spy), \
             patch("worca.scripts.run_fleet.build_child_env", return_value=scrubbed):
            dispatch_fleet(
                targets=targets, fleet_id="f_abc", prompt="x", source=None, base=None,
                guide=[], plan=None, max_parallel=5, fleet_failure_threshold=0.30,
            )
        assert envs == [scrubbed]

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
        # 5 targets, max_parallel=1 → strictly sequential. First 3 fail →
        # terminal=3 >= min(3,5)=3, 3/3=1.0 >= 0.30 → fire. Children 4 and 5
        # must be marked halted without ever calling Popen.
        targets = [self._make_target(f"/repo/{i}") for i in range(5)]
        _FakePopen.reset(rcs=[1, 1, 1, 0, 0])
        from worca.scripts.run_fleet import dispatch_fleet

        with patch("worca.scripts.run_fleet.subprocess.Popen", _FakePopen), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}), \
             patch("worca.scripts.run_fleet.update_fleet_status"):
            result = dispatch_fleet(
                targets=targets, fleet_id="f_abc", prompt="x", source=None, base=None,
                guide=[], plan=None, max_parallel=1, fleet_failure_threshold=0.30,
            )
        assert _FakePopen._total_constructed < 5
        halted = [k for k, v in result.items() if v["status"] == "halted"]
        assert len(halted) >= 1

    def test_circuit_breaker_does_not_kill_in_flight(self):
        """Children already in flight when breaker fires must finish naturally."""
        targets = [self._make_target("/repo/a"), self._make_target("/repo/b")]
        # All fail — breaker would fire after first if not for in-flight children.
        # With max_parallel=2 both get spawned BEFORE the first finishes.
        # We need both to complete (neither killed). polls_until_done=2 makes
        # each child stay in-flight for one extra poll tick.
        _FakePopen.reset(rcs=[1, 1], polls_until_done=2)
        from worca.scripts.run_fleet import dispatch_fleet

        with patch("worca.scripts.run_fleet.subprocess.Popen", _FakePopen), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}), \
             patch("worca.scripts.run_fleet.update_fleet_status"):
            result = dispatch_fleet(
                targets=targets, fleet_id="f_abc", prompt="x", source=None, base=None,
                guide=[], plan=None, max_parallel=2, fleet_failure_threshold=0.10,
            )
        # Both spawned children must have a non-halted (final) status
        assert result["/repo/a"]["status"] == "failed"
        assert result["/repo/b"]["status"] == "failed"

    def test_no_threadpoolexecutor_import(self):
        """run_fleet.py must not use ThreadPoolExecutor (manual loop required)."""
        import importlib.util
        src = importlib.util.find_spec("worca.scripts.run_fleet").origin
        with open(src) as f:
            source = f.read()
        assert "ThreadPoolExecutor" not in source

    def test_max_parallel_limits_concurrent_children(self):
        """At most --max-parallel children run simultaneously."""
        # With 6 targets and max_parallel=2, peak concurrent Popen instances
        # must never exceed 2. _FakePopen tracks peak via _peak class var.
        targets = [self._make_target(f"/repo/{i}") for i in range(6)]
        _FakePopen.reset(rcs=[0] * 6, polls_until_done=2)
        from worca.scripts.run_fleet import dispatch_fleet

        with patch("worca.scripts.run_fleet.subprocess.Popen", _FakePopen), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}):
            dispatch_fleet(
                targets=targets, fleet_id="f_abc", prompt="x", source=None, base=None,
                guide=[], plan=None, max_parallel=2, fleet_failure_threshold=0.30,
            )
        assert _FakePopen._peak <= 2
        assert _FakePopen._peak == 2  # actually saturates with 6 targets

    def test_real_parallelism_uses_popen_not_run(self):
        """Sanity: dispatch_fleet must use subprocess.Popen (non-blocking)."""
        import importlib.util
        src = importlib.util.find_spec("worca.scripts.run_fleet").origin
        with open(src) as f:
            source = f.read()
        assert "subprocess.Popen(" in source, (
            "dispatch_fleet must spawn children via Popen for real parallelism"
        )

    def test_halted_targets_get_halted_status(self):
        """Targets not dispatched due to circuit breaker get status=halted."""
        targets = [
            self._make_target("/repo/a"),
            self._make_target("/repo/b"),
            self._make_target("/repo/c"),
            self._make_target("/repo/d"),
        ]
        _FakePopen.reset(rcs=[1, 1, 1, 1])
        from worca.scripts.run_fleet import dispatch_fleet

        with patch("worca.scripts.run_fleet.subprocess.Popen", _FakePopen), \
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

        with patch("worca.scripts.run_fleet.check_target_readiness", return_value=(True, None)), \
             patch("worca.scripts.run_fleet.dispatch_fleet") as mock_dispatch, \
             patch("worca.orchestrator.fleet_manifest.write_fleet_manifest"):
            mock_dispatch.return_value = {}
            main(["--projects", str(tmp_path), "--prompt", "x"])
        mock_dispatch.assert_called_once()

    def test_main_passes_max_parallel(self, tmp_path):
        from worca.scripts.run_fleet import main

        with patch("worca.scripts.run_fleet.check_target_readiness", return_value=(True, None)), \
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

        with patch("worca.scripts.run_fleet.check_target_readiness", return_value=(True, None)), \
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

    def test_main_aborts_when_any_target_is_not_ready(self, tmp_path):
        """Per the readiness-check contract, ANY unready target aborts
        the whole fleet — we do NOT silently auto-init or skip targets.
        Replaces the prior provision-then-skip-failures behaviour: that
        invited the orchestrator to silently mutate user repos. See
        run_fleet.main() readiness-check block.
        """
        from worca.scripts.run_fleet import main

        proj_a = tmp_path / "a"
        proj_b = tmp_path / "b"
        proj_a.mkdir()
        proj_b.mkdir()

        with patch("worca.scripts.run_fleet.check_target_readiness") as mock_prov, \
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

        # No dispatch happens when any target is unready — even the ready one.
        mock_dispatch.assert_not_called()
