"""Shared helper for extracting agent roles from WORCA_AGENT env values."""


def role_from_worca_agent(raw: str) -> str:
    """Extract the bare agent role from a WORCA_AGENT env value.

    The env value is "{stage}-{agent}-iter-{N}" (e.g. "implement-implementer-iter-2").
    Returns the empty string for an empty input.
    """
    if not raw:
        return ""
    base = raw.rsplit("-iter-", 1)[0] if "-iter-" in raw else raw
    parts = base.split("-")
    return parts[-1] if parts else raw
