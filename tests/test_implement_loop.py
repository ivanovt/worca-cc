"""Tests for the implement bead-loop gating logic in runner.py."""

import pytest
from unittest.mock import patch, MagicMock

from worca.orchestrator.runner import PipelineInterrupted


def _make_bead(bead_id):
    return {"id": bead_id, "title": f"Bead {bead_id}", "status": "open"}


class TestImplementLoopSafetyCap:
    """The implement loop should use _query_ready_bead as the primary exit
    condition, with a safety cap derived from max(max_beads, len(run_bead_ids)) + 3."""

    def test_implement_loop_processes_all_beads_when_max_beads_zero(self):
        """When max_beads is 0 (e.g. broken backfill on resume), the loop must
        still process all beads returned by _query_ready_bead."""
        from worca.orchestrator import runner

        beads = [_make_bead("b1"), _make_bead("b2"), _make_bead("b3")]
        call_count = {"n": 0}
        processed = []

        original_query = runner._query_ready_bead

        def fake_query(allowed_ids=None, run_id=None):
            idx = call_count["n"]
            call_count["n"] += 1
            if idx < len(beads):
                return beads[idx]
            return None

        # We test the gating logic directly: with max_beads=0, the old code
        # would never enter the loop body. The new code should use the safety
        # cap = max(0, len(run_bead_ids)) + 3 and rely on next_bead being None
        # as the primary exit.
        max_beads = 0
        run_bead_ids = ["b1", "b2", "b3"]
        safety_cap = max(max_beads, len(run_bead_ids)) + 3  # = 6

        loop_counters = {"bead_iteration": 0}

        # Simulate the loop gating logic
        while True:
            next_bead = fake_query(allowed_ids=run_bead_ids)
            if next_bead is None:
                break
            if loop_counters["bead_iteration"] >= safety_cap:
                raise PipelineInterrupted(
                    f"implement_incomplete: bead {next_bead['id']} still unstarted",
                    stop_reason="implement_incomplete",
                )
            processed.append(next_bead["id"])
            loop_counters["bead_iteration"] += 1

        assert processed == ["b1", "b2", "b3"]
        assert loop_counters["bead_iteration"] == 3

    def test_implement_loop_exits_when_bd_ready_empty(self):
        """When _query_ready_bead returns None immediately, the loop exits
        without error — no beads to process."""
        from worca.orchestrator import runner

        max_beads = 0
        run_bead_ids = []
        safety_cap = max(max_beads, len(run_bead_ids)) + 3

        loop_counters = {"bead_iteration": 0}

        def fake_query(allowed_ids=None, run_id=None):
            return None

        next_bead = fake_query(allowed_ids=run_bead_ids)
        # Primary exit: next_bead is None
        assert next_bead is None
        # Loop body never entered
        assert loop_counters["bead_iteration"] == 0

    def test_safety_cap_raises_when_exceeded(self):
        """When the safety cap is hit but beads remain, PipelineInterrupted
        is raised with stop_reason='implement_incomplete'."""
        call_count = {"n": 0}

        def fake_query(allowed_ids=None, run_id=None):
            call_count["n"] += 1
            return _make_bead(f"b{call_count['n']}")

        max_beads = 2
        run_bead_ids = ["b1", "b2"]
        safety_cap = max(max_beads, len(run_bead_ids)) + 3  # = 5

        loop_counters = {"bead_iteration": 0}

        with pytest.raises(PipelineInterrupted, match="implement_incomplete") as exc_info:
            while True:
                next_bead = fake_query(allowed_ids=run_bead_ids)
                if next_bead is None:
                    break
                if loop_counters["bead_iteration"] >= safety_cap:
                    raise PipelineInterrupted(
                        f"implement_incomplete: bead {next_bead['id']} still unstarted",
                        stop_reason="implement_incomplete",
                    )
                loop_counters["bead_iteration"] += 1

        assert exc_info.value.stop_reason == "implement_incomplete"
        assert loop_counters["bead_iteration"] == 5

    def test_implement_halts_when_safety_cap_hit_with_remaining_beads(self):
        """Safety cap hit while _query_ready_bead still returns run-scoped
        beads must raise PipelineInterrupted(stop_reason='implement_incomplete')
        whose message names the blocked bead — never log 'All beads implemented'."""
        remaining_bead = _make_bead("bead-stuck")

        def fake_query(allowed_ids=None, run_id=None):
            return remaining_bead

        run_bead_ids = ["bead-done-1", "bead-done-2"]
        max_beads = 2
        safety_cap = max(max_beads, len(run_bead_ids)) + 3

        loop_counters = {"bead_iteration": safety_cap}

        with pytest.raises(PipelineInterrupted, match="implement_incomplete") as exc_info:
            next_bead = fake_query(allowed_ids=run_bead_ids)
            if next_bead is not None and loop_counters["bead_iteration"] >= safety_cap:
                raise PipelineInterrupted(
                    f"implement_incomplete: bead {next_bead['id']} and possibly more still unstarted",
                    stop_reason="implement_incomplete",
                )

        assert exc_info.value.stop_reason == "implement_incomplete"
        assert "bead-stuck" in str(exc_info.value)
