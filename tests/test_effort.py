"""Tests for worca.orchestrator.effort — effort resolution, model-aware ladders, escalation."""

import logging
from unittest.mock import patch


from worca.orchestrator.effort import (
    CANONICAL,
    EFFORT_LEVELS,
    MODEL_DEFAULT,
    MODEL_EFFORT_LADDERS,
    apply_escalation,
    clamp,
    collapse_down,
    model_ladder,
    resolve_effort,
    round_up,
)


# ---------------------------------------------------------------------------
# EFFORT_LEVELS and MODEL_EFFORT_LADDERS
# ---------------------------------------------------------------------------


class TestEffortLevels:
    def test_canonical_order(self):
        assert EFFORT_LEVELS == ("low", "medium", "high", "xhigh", "max")

    def test_canonical_is_effort_levels(self):
        assert CANONICAL is EFFORT_LEVELS

    def test_model_default_is_none(self):
        assert MODEL_DEFAULT is None


class TestModelEffortLadders:
    def test_opus_4_7_five_rung(self):
        assert MODEL_EFFORT_LADDERS["opus-4-7"] == ("low", "medium", "high", "xhigh", "max")

    def test_opus_4_6_four_rung(self):
        assert MODEL_EFFORT_LADDERS["opus-4-6"] == ("low", "medium", "high", "max")

    def test_sonnet_4_6_four_rung(self):
        assert MODEL_EFFORT_LADDERS["sonnet-4-6"] == ("low", "medium", "high", "max")

    def test_haiku_empty(self):
        ladder = model_ladder("claude-haiku-4-5-20251001")
        assert ladder == ()

    def test_sonnet_4_5_empty(self):
        ladder = model_ladder("claude-sonnet-4-5-20251014")
        assert ladder == ()


# ---------------------------------------------------------------------------
# model_ladder()
# ---------------------------------------------------------------------------


class TestModelLadder:
    def test_opus_4_7_full_id(self):
        assert model_ladder("claude-opus-4-7-20250506") == MODEL_EFFORT_LADDERS["opus-4-7"]

    def test_opus_4_6_full_id(self):
        assert model_ladder("claude-opus-4-6-20250501") == MODEL_EFFORT_LADDERS["opus-4-6"]

    def test_sonnet_4_6_full_id(self):
        assert model_ladder("claude-sonnet-4-6-20250514") == MODEL_EFFORT_LADDERS["sonnet-4-6"]

    def test_bare_family_name(self):
        assert model_ladder("claude-opus-4-7") == MODEL_EFFORT_LADDERS["opus-4-7"]

    def test_unknown_model_returns_canonical(self, caplog):
        with caplog.at_level(logging.WARNING):
            ladder = model_ladder("some-unknown-model-v99")
        assert ladder == CANONICAL
        assert any("unmapped" in r.message.lower() or "unknown" in r.message.lower() for r in caplog.records)

    def test_empty_ladder_for_unsupported(self):
        assert model_ladder("claude-haiku-4-5-20251001") == ()


# ---------------------------------------------------------------------------
# collapse_down()
# ---------------------------------------------------------------------------


class TestCollapseDown:
    def test_none_stays_none(self):
        assert collapse_down(None, CANONICAL) is None

    def test_level_on_ladder(self):
        assert collapse_down("high", CANONICAL) == "high"

    def test_xhigh_on_4_rung_collapses_to_high(self):
        ladder = MODEL_EFFORT_LADDERS["opus-4-6"]
        assert collapse_down("xhigh", ladder) == "high"

    def test_max_on_4_rung_stays_max(self):
        ladder = MODEL_EFFORT_LADDERS["opus-4-6"]
        assert collapse_down("max", ladder) == "max"

    def test_empty_ladder_returns_none(self):
        assert collapse_down("high", ()) is None

    def test_low_stays_on_any_ladder(self):
        for key in MODEL_EFFORT_LADDERS:
            ladder = MODEL_EFFORT_LADDERS[key]
            if ladder:
                assert collapse_down("low", ladder) == "low"


# ---------------------------------------------------------------------------
# round_up()
# ---------------------------------------------------------------------------


class TestRoundUp:
    def test_level_on_ladder(self):
        assert round_up("high", CANONICAL) == "high"

    def test_xhigh_on_4_rung_rounds_up_to_max(self):
        ladder = MODEL_EFFORT_LADDERS["opus-4-6"]
        assert round_up("xhigh", ladder) == "max"

    def test_none_stays_none(self):
        assert round_up(None, CANONICAL) is None

    def test_max_stays_max(self):
        assert round_up("max", MODEL_EFFORT_LADDERS["opus-4-6"]) == "max"

    def test_empty_ladder_returns_none(self):
        assert round_up("high", ()) is None


# ---------------------------------------------------------------------------
# apply_escalation()
# ---------------------------------------------------------------------------


class TestApplyEscalation:
    def test_initial_no_escalation(self):
        assert apply_escalation("high", "implementer", "initial", 1, CANONICAL) == "high"

    def test_next_bead_no_escalation(self):
        assert apply_escalation("high", "implementer", "next_bead", 1, CANONICAL) == "high"

    def test_test_failure_plus_one(self):
        assert apply_escalation("high", "implementer", "test_failure", 2, CANONICAL) == "xhigh"

    def test_review_changes_plus_two(self):
        assert apply_escalation("high", "implementer", "review_changes", 2, CANONICAL) == "max"

    def test_test_failure_stacks(self):
        # iter 3 means 2 escalation-eligible iterations: +1 + +1 = +2
        assert apply_escalation("medium", "implementer", "test_failure", 3, CANONICAL) == "xhigh"

    def test_review_changes_stacks(self):
        # iter 3: +2 + +2 = +4, saturates at max
        assert apply_escalation("low", "implementer", "review_changes", 3, CANONICAL) == "max"

    def test_planner_plan_review_revise_plus_one(self):
        assert apply_escalation("high", "planner", "plan_review_revise", 2, CANONICAL) == "xhigh"

    def test_planner_restart_planning_plus_one(self):
        assert apply_escalation("high", "planner", "restart_planning", 2, CANONICAL) == "xhigh"

    def test_planner_initial_no_escalation(self):
        assert apply_escalation("high", "planner", "initial", 1, CANONICAL) == "high"

    def test_coordinator_no_escalation_on_any_trigger(self):
        for trigger in ("initial", "test_failure", "review_changes"):
            assert apply_escalation("medium", "coordinator", trigger, 3, CANONICAL) == "medium"

    def test_tester_no_escalation(self):
        assert apply_escalation("high", "tester", "test_failure", 3, CANONICAL) == "high"

    def test_reviewer_no_escalation(self):
        assert apply_escalation("high", "reviewer", "review_changes", 3, CANONICAL) == "high"

    def test_guardian_no_escalation(self):
        assert apply_escalation("high", "guardian", "review_changes", 3, CANONICAL) == "high"

    def test_saturates_at_top(self):
        assert apply_escalation("xhigh", "implementer", "review_changes", 5, CANONICAL) == "max"

    def test_none_base_returns_none(self):
        assert apply_escalation(None, "implementer", "test_failure", 2, CANONICAL) is None

    def test_short_ladder_test_failure_jumps_to_max(self):
        ladder = MODEL_EFFORT_LADDERS["sonnet-4-6"]
        assert apply_escalation("high", "implementer", "test_failure", 2, ladder) == "max"

    def test_short_ladder_planner_escalation(self):
        ladder = MODEL_EFFORT_LADDERS["opus-4-6"]
        assert apply_escalation("high", "planner", "plan_review_revise", 2, ladder) == "max"


# ---------------------------------------------------------------------------
# clamp()
# ---------------------------------------------------------------------------


class TestClamp:
    def test_below_cap_unchanged(self):
        assert clamp("high", "xhigh") == ("high", None)

    def test_equal_to_cap_unchanged(self):
        assert clamp("xhigh", "xhigh") == ("xhigh", None)

    def test_above_cap_clamped(self):
        assert clamp("max", "xhigh") == ("xhigh", "max")

    def test_none_level_returns_none(self):
        assert clamp(None, "xhigh") == (None, None)

    def test_none_cap_no_clamping(self):
        assert clamp("max", None) == ("max", None)


# ---------------------------------------------------------------------------
# resolve_effort() — baseline (Opus 4.7 / full 5-rung ladder)
# ---------------------------------------------------------------------------


class TestResolveEffortBaseline:
    MODEL = "claude-opus-4-7-20250506"

    def test_omitted_disabled_returns_model_default(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="implementer", agent_effort=None,
            auto_mode="disabled", auto_cap="xhigh",
            trigger="initial", iter_num=1, bead=None, model=self.MODEL,
        )
        assert level is None
        assert source == "model_default"
        assert base is None

    def test_explicit_disabled_no_escalation(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="implementer", agent_effort="high",
            auto_mode="disabled", auto_cap="xhigh",
            trigger="test_failure", iter_num=3, bead=None, model=self.MODEL,
        )
        assert level == "high"
        assert source == "disabled"

    def test_reactive_explicit_escalates(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="implementer", agent_effort="high",
            auto_mode="reactive", auto_cap="max",
            trigger="test_failure", iter_num=2, bead=None, model=self.MODEL,
        )
        assert level == "xhigh"
        assert source == "reactive"
        assert base == "high"

    def test_reactive_omitted_starts_at_model_default(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="implementer", agent_effort=None,
            auto_mode="reactive", auto_cap="xhigh",
            trigger="initial", iter_num=1, bead=None, model=self.MODEL,
        )
        assert level is None
        assert source == "reactive"
        assert base is None

    def test_adaptive_reads_bead_label(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="initial", iter_num=1, bead="bead-123", model=self.MODEL,
            )
        assert level == "high"
        assert source == "adaptive:llm"
        assert bc["applied"] is True
        assert bc["skip_reason"] is None

    def test_adaptive_explicit_overrides_bead(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="medium"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort="xhigh",
                auto_mode="adaptive", auto_cap="max",
                trigger="initial", iter_num=1, bead="bead-123", model=self.MODEL,
            )
        assert level == "xhigh"
        assert source == "explicit"
        assert bc["applied"] is False
        assert bc["skip_reason"] == "explicit_override"

    def test_reactive_records_bead_skip_reason(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="medium"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="reactive", auto_cap="xhigh",
                trigger="initial", iter_num=1, bead="bead-123", model=self.MODEL,
            )
        assert bc["applied"] is False
        assert bc["skip_reason"] == "mode_reactive"

    def test_disabled_records_bead_skip_reason(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="medium"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="disabled", auto_cap="xhigh",
                trigger="initial", iter_num=1, bead="bead-123", model=self.MODEL,
            )
        assert bc["applied"] is False
        assert bc["skip_reason"] == "mode_disabled"

    def test_non_implementer_skip_reason(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="reviewer", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="initial", iter_num=1, bead="bead-123", model=self.MODEL,
            )
        assert bc["applied"] is False
        assert bc["skip_reason"] == "non_classified_agent"

    def test_review_changes_plus_two(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="medium"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="review_changes", iter_num=2, bead="bead-123", model=self.MODEL,
            )
        assert level == "xhigh"
        assert base == "medium"

    def test_planner_stacks_on_plan_review_revise(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="planner", agent_effort="medium",
            auto_mode="adaptive", auto_cap="max",
            trigger="plan_review_revise", iter_num=4, bead=None, model=self.MODEL,
        )
        assert level == "max"
        assert base == "medium"

    def test_planner_escalates_on_restart_planning(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="planner", agent_effort="high",
            auto_mode="adaptive", auto_cap="max",
            trigger="restart_planning", iter_num=2, bead=None, model=self.MODEL,
        )
        assert level == "xhigh"

    def test_auto_cap_clamps(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="implementer", agent_effort="high",
            auto_mode="reactive", auto_cap="xhigh",
            trigger="review_changes", iter_num=2, bead=None, model=self.MODEL,
        )
        assert level == "xhigh"

    def test_no_bead_no_bead_classified(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="planner", agent_effort="high",
            auto_mode="adaptive", auto_cap="max",
            trigger="initial", iter_num=1, bead=None, model=self.MODEL,
        )
        assert bc is None

    def test_bead_no_label_falls_back_to_model_default(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value=None):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="initial", iter_num=1, bead="bead-no-label", model=self.MODEL,
            )
        assert level is None
        assert source == "model_default"
        assert bc["level"] is None
        assert bc["applied"] is False


# ---------------------------------------------------------------------------
# resolve_effort() — model-aware (4-rung ladders)
# ---------------------------------------------------------------------------


class TestResolveEffortModelAware:
    def test_base_collapses_on_model_without_rung(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="planner", agent_effort="xhigh",
            auto_mode="disabled", auto_cap="xhigh",
            trigger="initial", iter_num=1, bead=None, model="claude-opus-4-6",
        )
        assert level == "high"
        assert requested == "xhigh"

    def test_escalation_on_short_ladder_jumps_to_max(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="test_failure", iter_num=2, bead="bead-1", model="claude-sonnet-4-6",
            )
        assert level == "max"

    def test_cap_rounds_up_on_short_ladder(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="xhigh",
                trigger="test_failure", iter_num=2, bead="bead-1", model="claude-sonnet-4-6",
            )
        assert level == "max"

    def test_cap_pinned_high_freezes_escalation(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="high",
                trigger="test_failure", iter_num=2, bead="bead-1", model="claude-sonnet-4-6",
            )
        assert level == "high"

    def test_unsupported_model_omits_env(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="implementer", agent_effort="high",
            auto_mode="adaptive", auto_cap="max",
            trigger="initial", iter_num=1, bead=None, model="claude-sonnet-4-5-20251014",
        )
        assert level is None

    def test_unknown_model_uses_canonical_with_warning(self, caplog):
        with caplog.at_level(logging.WARNING):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="planner", agent_effort="xhigh",
                auto_mode="disabled", auto_cap="max",
                trigger="initial", iter_num=1, bead=None, model="totally-unknown-model",
            )
        assert level == "xhigh"
        assert any("unmapped" in r.message.lower() or "unknown" in r.message.lower() for r in caplog.records)


# ---------------------------------------------------------------------------
# resolve_effort() — escalation stacking
# ---------------------------------------------------------------------------


class TestResolveEffortEscalation:
    MODEL = "claude-opus-4-7-20250506"

    def test_test_failure_then_review_changes_stacks(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="low"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="review_changes", iter_num=3, bead="bead-1", model=self.MODEL,
            )
        assert level == "max"
        assert base == "low"

    def test_planner_three_plan_review_revise_bounces(self):
        level, requested, source, base, bc, _ = resolve_effort(
            agent="planner", agent_effort="medium",
            auto_mode="adaptive", auto_cap="max",
            trigger="plan_review_revise", iter_num=4, bead=None, model=self.MODEL,
        )
        assert level == "max"

    def test_implementer_multiple_test_failures(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="low"):
            level, requested, source, base, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="test_failure", iter_num=4, bead="bead-1", model=self.MODEL,
            )
        assert level == "xhigh"


# ---------------------------------------------------------------------------
# resolve_effort() — bead_classified detail
# ---------------------------------------------------------------------------


class TestResolveEffortBeadClassified:
    MODEL = "claude-opus-4-7-20250506"

    def test_adaptive_applied_has_no_skip_reason(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            _, _, _, _, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="initial", iter_num=1, bead="b-1", model=self.MODEL,
            )
        assert bc["applied"] is True
        assert bc["skip_reason"] is None
        assert bc["level"] == "high"

    def test_explicit_override_populates_skip_reason(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="low"):
            _, _, _, _, bc, _ = resolve_effort(
                agent="implementer", agent_effort="max",
                auto_mode="adaptive", auto_cap="max",
                trigger="initial", iter_num=1, bead="b-1", model=self.MODEL,
            )
        assert bc["level"] == "low"
        assert bc["applied"] is False
        assert bc["skip_reason"] == "explicit_override"

    def test_mode_disabled_skip_reason(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            _, _, _, _, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="disabled", auto_cap="max",
                trigger="initial", iter_num=1, bead="b-1", model=self.MODEL,
            )
        assert bc["skip_reason"] == "mode_disabled"

    def test_mode_reactive_skip_reason(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            _, _, _, _, bc, _ = resolve_effort(
                agent="implementer", agent_effort=None,
                auto_mode="reactive", auto_cap="max",
                trigger="initial", iter_num=1, bead="b-1", model=self.MODEL,
            )
        assert bc["skip_reason"] == "mode_reactive"

    def test_non_classified_agent_skip_reason(self):
        with patch("worca.orchestrator.effort.bd_get_effort_label", return_value="high"):
            _, _, _, _, bc, _ = resolve_effort(
                agent="tester", agent_effort=None,
                auto_mode="adaptive", auto_cap="max",
                trigger="initial", iter_num=1, bead="b-1", model=self.MODEL,
            )
        assert bc["skip_reason"] == "non_classified_agent"

    def test_bead_none_gives_bead_classified_none(self):
        _, _, _, _, bc, _ = resolve_effort(
            agent="planner", agent_effort="high",
            auto_mode="adaptive", auto_cap="max",
            trigger="initial", iter_num=1, bead=None, model=self.MODEL,
        )
        assert bc is None


# ---------------------------------------------------------------------------
# resolve_effort() — capped_from return value
# ---------------------------------------------------------------------------


class TestResolveEffortCappedFrom:
    MODEL = "claude-opus-4-7-20250506"

    def test_no_cap_returns_none(self):
        _, _, _, _, _, capped = resolve_effort(
            agent="implementer", agent_effort="high",
            auto_mode="reactive", auto_cap="max",
            trigger="initial", iter_num=1, bead=None, model=self.MODEL,
        )
        assert capped is None

    def test_cap_fires_returns_original(self):
        _, _, _, _, _, capped = resolve_effort(
            agent="implementer", agent_effort="high",
            auto_mode="reactive", auto_cap="high",
            trigger="test_failure", iter_num=2, bead=None, model=self.MODEL,
        )
        assert capped == "xhigh"

    def test_cap_not_fired_when_level_below(self):
        _, _, _, _, _, capped = resolve_effort(
            agent="implementer", agent_effort="low",
            auto_mode="reactive", auto_cap="xhigh",
            trigger="initial", iter_num=1, bead=None, model=self.MODEL,
        )
        assert capped is None

    def test_disabled_mode_no_cap(self):
        _, _, _, _, _, capped = resolve_effort(
            agent="implementer", agent_effort="high",
            auto_mode="disabled", auto_cap="high",
            trigger="test_failure", iter_num=3, bead=None, model=self.MODEL,
        )
        assert capped is None
