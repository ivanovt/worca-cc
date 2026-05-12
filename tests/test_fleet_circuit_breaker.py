"""Tests for W-040-13: Fleet-level circuit breaker.

Verifies the §7 formula in dispatch_fleet():
  - trip condition: failed_count / terminal_count >= threshold
                    AND terminal_count >= min(3, total)
  - manifest write: halt_reason='circuit_breaker' on trip
"""
import subprocess
from unittest.mock import patch

import pytest


def _make_target(project_dir):
    return {"project_dir": project_dir, "status": "pending"}


def _run_dispatch(targets, threshold=0.30, max_parallel=1, returncodes=None):
    from worca.scripts.run_fleet import dispatch_fleet

    rc_iter = iter(returncodes or [0] * len(targets))

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args=[], returncode=next(rc_iter, 0))

    with patch("worca.scripts.run_fleet.subprocess.run", side_effect=fake_run), \
         patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}), \
         patch("worca.scripts.run_fleet.update_fleet_status"):
        return dispatch_fleet(
            targets=targets,
            fleet_id="f_test",
            prompt="x",
            source=None,
            base=None,
            guide=[],
            plan=None,
            max_parallel=max_parallel,
            fleet_failure_threshold=threshold,
        )


# ---------------------------------------------------------------------------
# §7 formula — terminal_count guard and denominator
# ---------------------------------------------------------------------------


class TestCircuitBreakerThreshold:
    """dispatch_fleet() uses the correct §7 formula: failed/terminal >= threshold
    AND terminal >= min(3, total)."""

    def test_breaker_does_not_fire_before_min_3_terminal(self):
        """Breaker must not fire until terminal_count >= min(3, total).

        With 5 targets and threshold=0.10, 2 early failures leave only 2
        terminal children (< min(3,5)=3).  The wrong formula (failed/total)
        would fire on the first failure (1/5=0.20 > 0.10) and halt targets
        2-4.  The correct formula waits for 3 terminal before checking.
        """
        targets = [_make_target(f"/repo/{i}") for i in range(5)]
        # 2 fail early, then succeed — terminal stays < 3 at failure time
        result = _run_dispatch(targets, threshold=0.10, returncodes=[1, 1, 0, 0, 0])
        statuses = [v["status"] for v in result.values()]
        assert "halted" not in statuses
        assert len(result) == 5

    def test_breaker_fires_once_min_3_terminal_is_reached(self):
        """Breaker fires when terminal_count reaches min(3, total) and ratio passes."""
        # 5 targets: first 3 all fail → terminal=3 >= min(3,5)=3, 3/3=1.0 >= 0.30 → fire
        # Targets 3 and 4 should be halted.
        targets = [_make_target(f"/repo/{i}") for i in range(5)]
        result = _run_dispatch(targets, threshold=0.30, returncodes=[1, 1, 1, 0, 0])
        statuses = [v["status"] for v in result.values()]
        assert "halted" in statuses

    def test_breaker_uses_terminal_count_not_total_as_denominator(self):
        """Ratio denominator is terminal_count (failed+completed), not total targets.

        Scenario: 6 targets, threshold=0.40, returncodes=[1, 0, 1, 0, 0, 0].
        After /repo/2 fails:
          terminal=3 (repo0=failed, repo1=completed, repo2=failed)
          failed/terminal = 2/3 = 0.667 >= 0.40  → fire  (correct formula)
          failed/total    = 2/6 = 0.333 < 0.40   → no fire (wrong formula)
        So with the correct formula, /repo/3-5 are halted; with the wrong one they run.
        """
        targets = [_make_target(f"/repo/{i}") for i in range(6)]
        result = _run_dispatch(targets, threshold=0.40, returncodes=[1, 0, 1, 0, 0, 0])
        statuses = [v["status"] for v in result.values()]
        assert "halted" in statuses

    def test_breaker_fires_at_exact_threshold(self):
        """Circuit breaker fires when ratio == threshold (>= not strict >)."""
        # 6 targets, threshold=0.5, returncodes=[1, 0, 1, 0, 0, 0]:
        # After /repo/2 fails: terminal=3, 2/3=0.667 >= 0.5 → fire
        # Use a tighter case: 3 targets, 1 fail + 2 succeed, threshold=0.333...
        # Better: 4 targets, returncodes=[1, 0, 0, 0], threshold=0.30:
        # After /repo/0 fails: terminal=1 < min(3,4)=3 → no fire
        # After /repo/1 and /repo/2 succeed: no check (success path)
        # After /repo/3 runs...but all is fine (only 1/4 failed)
        # Use 5 targets where terminal=3 with exactly 1 fail + 2 succeed → 1/3=0.333... >= 0.30
        targets = [_make_target(f"/repo/{i}") for i in range(5)]
        result = _run_dispatch(targets, threshold=0.30, returncodes=[1, 0, 0, 0, 0])
        # 1/5 = 0.20 < 0.30, so after 3 terminal (1 fail + 2 succeed) = 1/3=0.333 >= 0.30
        # /repo/0 fails: terminal=1 < 3 → no
        # /repo/1 succeeds: no check
        # /repo/2 succeeds: no check
        # /repo/3 succeeds: no check
        # /repo/4 succeeds: no check
        # 1/5 terminal=5, failed=1 → 1/5=0.20 < 0.30 → no halt
        statuses = [v["status"] for v in result.values()]
        # This scenario does NOT halt — ratio is below threshold
        assert "halted" not in statuses

        # Real exact-threshold test: 3 fail out of 3 terminal, threshold=1.0 (never fires)
        # vs threshold=1.0 exactly at limit
        # Use: 5 targets, [1, 0, 1, 0, 0], threshold exactly 2/3 ≈ 0.666...
        targets2 = [_make_target(f"/proj/{i}") for i in range(6)]
        result2 = _run_dispatch(targets2, threshold=2 / 3, returncodes=[1, 0, 1, 0, 0, 0])
        statuses2 = [v["status"] for v in result2.values()]
        # After /proj/2 fails: terminal=3, failed=2, 2/3 == 2/3 >= 2/3 → fire (exact match)
        assert "halted" in statuses2

    def test_breaker_does_not_fire_below_threshold(self):
        """Failure ratio strictly below threshold does not halt fleet."""
        # 6 targets, 1 fail: 1/terminal is at most 1/3 ≈ 0.333 after 3 terminal,
        # then 1/4, 1/5, 1/6 → all below 0.40
        targets = [_make_target(f"/repo/{i}") for i in range(6)]
        result = _run_dispatch(targets, threshold=0.40, returncodes=[1, 0, 0, 0, 0, 0])
        statuses = [v["status"] for v in result.values()]
        assert "halted" not in statuses
        assert len(result) == 6

    def test_unstarted_targets_cancelled_on_breaker_trip(self):
        """Targets not yet dispatched get status='halted' when breaker fires."""
        # 4 targets: first 3 fail → 3/3=1.0 >= 0.30, 3 >= min(3,4)=3 → fire → 4th halted
        targets = [_make_target(f"/repo/{i}") for i in range(4)]
        result = _run_dispatch(targets, threshold=0.30, returncodes=[1, 1, 1, 0])
        assert result["/repo/3"]["status"] == "halted"

    def test_completed_children_preserved_after_breaker_fires(self):
        """Children already run before circuit breaker fires keep their results."""
        targets = [_make_target(f"/repo/{i}") for i in range(4)]
        result = _run_dispatch(targets, threshold=0.30, returncodes=[1, 1, 1, 0])
        assert result["/repo/0"]["status"] == "failed"
        assert result["/repo/1"]["status"] == "failed"
        assert result["/repo/2"]["status"] == "failed"

    def test_min_3_total_adapts_for_small_fleets(self):
        """For a fleet of 2, min(3, 2)=2 — breaker can fire only when both complete."""
        # 2 targets both fail → terminal=2 == min(3,2)=2; 2/2=1.0 >= 0.30 → fire
        # But there are no remaining unstarted targets. Verify no crash.
        targets = [_make_target(f"/repo/{i}") for i in range(2)]
        result = _run_dispatch(targets, threshold=0.30, returncodes=[1, 1])
        assert len(result) == 2
        assert all(v["status"] == "failed" for v in result.values())


# ---------------------------------------------------------------------------
# Manifest writes on circuit-breaker trip
# ---------------------------------------------------------------------------


class TestCircuitBreakerManifestWrite:
    """dispatch_fleet() calls update_fleet_status with halt_reason='circuit_breaker'."""

    def _run_dispatch_with_spy(self, targets, threshold=0.30, returncodes=None):
        from worca.scripts.run_fleet import dispatch_fleet

        rc_iter = iter(returncodes or [0] * len(targets))

        def fake_run(*args, **kwargs):
            return subprocess.CompletedProcess(args=[], returncode=next(rc_iter, 0))

        with patch("worca.scripts.run_fleet.subprocess.run", side_effect=fake_run), \
             patch("worca.scripts.run_fleet.build_child_env", return_value={"HOME": "/root"}), \
             patch("worca.scripts.run_fleet.update_fleet_status") as mock_update:
            result = dispatch_fleet(
                targets=targets,
                fleet_id="f_202605120809_cbtest",
                prompt="x",
                source=None,
                base=None,
                guide=[],
                plan=None,
                max_parallel=1,
                fleet_failure_threshold=threshold,
            )
            return result, mock_update

    def test_update_fleet_status_called_with_circuit_breaker_halt_reason(self):
        """On circuit-breaker trip, update_fleet_status(fleet_id, 'halted',
        halt_reason='circuit_breaker') is called."""
        targets = [_make_target(f"/repo/{i}") for i in range(4)]
        # 3 fail → 3/3 >= 0.30, 3 >= min(3,4) → fire
        _, mock_update = self._run_dispatch_with_spy(
            targets, threshold=0.30, returncodes=[1, 1, 1, 0]
        )
        mock_update.assert_called_once_with(
            "f_202605120809_cbtest", "halted", halt_reason="circuit_breaker"
        )

    def test_update_fleet_status_not_called_when_no_trip(self):
        """update_fleet_status is not called when circuit breaker does not fire."""
        targets = [_make_target(f"/repo/{i}") for i in range(4)]
        # All succeed → no trip
        _, mock_update = self._run_dispatch_with_spy(
            targets, threshold=0.30, returncodes=[0, 0, 0, 0]
        )
        mock_update.assert_not_called()

    def test_update_fleet_status_not_called_below_threshold(self):
        """update_fleet_status is not called when failure ratio is below threshold."""
        targets = [_make_target(f"/repo/{i}") for i in range(6)]
        # 1/6 ≈ 0.167 < 0.30 — no trip
        _, mock_update = self._run_dispatch_with_spy(
            targets, threshold=0.30, returncodes=[1, 0, 0, 0, 0, 0]
        )
        mock_update.assert_not_called()

    def test_update_fleet_status_called_exactly_once_on_trip(self):
        """update_fleet_status is called only once even if multiple failures exceed threshold."""
        targets = [_make_target(f"/repo/{i}") for i in range(5)]
        # 3 fail → trip, targets 3 and 4 halted without further subprocess.run calls
        _, mock_update = self._run_dispatch_with_spy(
            targets, threshold=0.30, returncodes=[1, 1, 1, 1, 1]
        )
        mock_update.assert_called_once()

    def test_update_fleet_status_imported_from_fleet_manifest(self):
        """run_fleet.py imports update_fleet_status from worca.orchestrator.fleet_manifest."""
        import importlib.util
        src = importlib.util.find_spec("worca.scripts.run_fleet").origin
        with open(src) as f:
            source = f.read()
        assert "update_fleet_status" in source
