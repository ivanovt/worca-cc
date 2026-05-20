"""Shared helper for extracting agent roles from WORCA_AGENT env values.

Single source of truth used by ``guard.py``, ``subagent_start.py``,
``skill_use.py``, and ``claude_cli.py``. Bare agent names also pass through
unchanged so callers that already have a normalized role can pass it in.
"""


def role_from_worca_agent(raw: str) -> str:
    """Extract the bare agent role from a WORCA_AGENT env value.

    The env value is the basename (sans extension) of the resolved prompt
    file: ``{stage}-{agent}-iter-{N}``. Stage values and agent names never
    contain ``-iter-`` so the right split is unambiguous. Returns the empty
    string for empty input.

    Examples:
        role_from_worca_agent("test-tester-iter-5")        -> "tester"
        role_from_worca_agent("pr-guardian-iter-1")        -> "guardian"
        role_from_worca_agent("plan_review-plan_reviewer-iter-2") -> "plan_reviewer"
        role_from_worca_agent("guardian")                  -> "guardian"  # bare
    """
    if not raw:
        return ""
    base = raw.rsplit("-iter-", 1)[0] if "-iter-" in raw else raw
    parts = base.split("-")
    return parts[-1] if parts else raw
