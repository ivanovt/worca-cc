"""Effort resolution for pipeline agents.

Resolves per-agent effort levels using model-aware ladders, escalation on
loopbacks, and auto_cap clamping. See docs/plans/W-052-adaptive-effort-levels.md
for the full specification.
"""

import logging
import re
from typing import Optional

from worca.utils.beads import bd_get_effort_label

logger = logging.getLogger(__name__)

EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
CANONICAL = EFFORT_LEVELS

MODEL_DEFAULT = None

MODEL_EFFORT_LADDERS: dict[str, tuple[str, ...]] = {
    "opus-4-7": ("low", "medium", "high", "xhigh", "max"),
    "opus-4-6": ("low", "medium", "high", "max"),
    "sonnet-4-6": ("low", "medium", "high", "max"),
}

_UNSUPPORTED_FAMILIES = frozenset({
    "opus-4-5", "sonnet-4-5", "haiku-4-5", "haiku",
})

_FAMILY_RE = re.compile(
    r"claude-(?P<family>(?:opus|sonnet|haiku)-\d+-\d+)"
)


def _extract_family(model_id: str) -> Optional[str]:
    m = _FAMILY_RE.match(model_id)
    if not m:
        return None
    return m.group("family")


def model_ladder(model_id: str) -> tuple[str, ...]:
    family = _extract_family(model_id)
    if family and family in MODEL_EFFORT_LADDERS:
        return MODEL_EFFORT_LADDERS[family]
    if family:
        for prefix in _UNSUPPORTED_FAMILIES:
            if family.startswith(prefix):
                return ()
    if model_id in MODEL_EFFORT_LADDERS:
        return MODEL_EFFORT_LADDERS[model_id]
    logger.warning("Unmapped/unknown model %r — using canonical 5-rung ladder; escalation may be inexact", model_id)
    return CANONICAL


def collapse_down(level: Optional[str], ladder: tuple[str, ...]) -> Optional[str]:
    if level is None:
        return None
    if not ladder:
        return None
    if level in ladder:
        return level
    idx = CANONICAL.index(level) if level in CANONICAL else -1
    for i in range(idx - 1, -1, -1):
        if CANONICAL[i] in ladder:
            return CANONICAL[i]
    return None


def round_up(level: Optional[str], ladder: tuple[str, ...]) -> Optional[str]:
    if level is None:
        return None
    if not ladder:
        return None
    if level in ladder:
        return level
    idx = CANONICAL.index(level) if level in CANONICAL else -1
    for i in range(idx + 1, len(CANONICAL)):
        if CANONICAL[i] in ladder:
            return CANONICAL[i]
    return ladder[-1] if ladder else None


_ESCALATION_DELTAS: dict[str, dict[str, int]] = {
    "implementer": {
        "test_failure": 1,
        "review_changes": 2,
    },
    "planner": {
        "plan_review_revise": 1,
        "restart_planning": 1,
    },
}


def apply_escalation(
    base: Optional[str],
    agent: str,
    trigger: str,
    iter_num: int,
    ladder: tuple[str, ...],
) -> Optional[str]:
    if base is None:
        return None
    if not ladder:
        return None

    delta_per_loop = _ESCALATION_DELTAS.get(agent, {}).get(trigger, 0)
    if delta_per_loop == 0:
        return base

    loops = max(iter_num - 1, 0)
    total_delta = delta_per_loop * loops

    if base not in ladder:
        base = collapse_down(base, ladder)
        if base is None:
            return None

    idx = ladder.index(base)
    new_idx = min(idx + total_delta, len(ladder) - 1)
    return ladder[new_idx]


def clamp(
    level: Optional[str], cap: Optional[str]
) -> tuple[Optional[str], Optional[str]]:
    if level is None or cap is None:
        return (level, None)
    level_idx = CANONICAL.index(level) if level in CANONICAL else -1
    cap_idx = CANONICAL.index(cap) if cap in CANONICAL else -1
    if level_idx <= cap_idx or level_idx < 0 or cap_idx < 0:
        return (level, None)
    return (cap, level)


def resolve_effort(
    *,
    agent: str,
    agent_effort: Optional[str],
    auto_mode: str,
    auto_cap: Optional[str],
    trigger: str,
    iter_num: int,
    bead: Optional[str],
    model: str,
) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[dict], Optional[str]]:
    """Resolve the effort level for a stage invocation.

    Returns (level, requested, source, base, bead_classified, capped_from).
    """
    bead_label = bd_get_effort_label(bead) if bead else None
    bead_classified = None
    if bead is not None:
        bead_classified = {
            "level": bead_label,
            "applied": False,
            "skip_reason": None,
        }

    if agent_effort is not None:
        base = agent_effort
        source_base = "explicit"
        if bead_classified is not None:
            bead_classified["skip_reason"] = "explicit_override"
    elif auto_mode == "adaptive" and agent == "implementer" and bead_label:
        base = bead_label
        source_base = "adaptive:llm"
        bead_classified["applied"] = True
    else:
        base = MODEL_DEFAULT
        source_base = "model_default"
        if bead_classified is not None:
            if auto_mode == "disabled":
                bead_classified["skip_reason"] = "mode_disabled"
            elif auto_mode == "reactive":
                bead_classified["skip_reason"] = "mode_reactive"
            elif agent != "implementer":
                bead_classified["skip_reason"] = "non_classified_agent"

    ladder = model_ladder(model)

    if auto_mode == "disabled":
        level = collapse_down(base, ladder)
        source = "disabled" if source_base == "explicit" else source_base
        return (level, base, source, base, bead_classified, None)

    requested = apply_escalation(base, agent, trigger, iter_num, CANONICAL)
    collapsed_base = collapse_down(base, ladder)
    level = apply_escalation(collapsed_base, agent, trigger, iter_num, ladder)
    cap_on_ladder = round_up(auto_cap, ladder)
    level, capped_from = clamp(level, cap_on_ladder)

    if auto_mode == "reactive":
        source = "reactive"
    elif source_base == "adaptive:llm":
        source = "adaptive:llm"
    else:
        source = source_base

    return (level, requested, source, base, bead_classified, capped_from)
