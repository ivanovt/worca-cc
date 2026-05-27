"""Advisory graphify nudge for the PreToolUse hook.

Non-blocking: when an agent is about to run a broad code search (grep/rg/find/…)
and a knowledge graph is ready, suggest a scoped `graphify query` instead —
mirroring graphify's own allow + additionalContext approach, but worca-owned.

Gating (all must hold):
  - the tool is Bash and the command is a search (current Claude Code routes
    Grep/Glob through Bash, so we match the command string, same as graphify);
  - a graph is ready: ``GRAPHIFY_OUT`` is set (the runner only sets it when the
    per-commit snapshot is ``ready``) and ``$GRAPHIFY_OUT/graph.json`` exists;
  - ``worca.graphify.nudge`` is not ``off``;
  - the throttle mode allows it this time.

``worca.graphify.nudge`` — ``off | every | stage | run`` (default ``every``):
  every  nudge on every matching search
  stage  nudge once per agent iteration (keyed by WORCA_AGENT)
  run    nudge once per pipeline run
Throttle state is kept as marker files under ``WORCA_RUN_DIR/.graphify_nudge/``.
"""
import os
import re

# Same searcher set graphify matches. Bounded by word boundaries so e.g. a path
# containing "find" doesn't trip it.
_SEARCH_RE = re.compile(r"\b(grep|rg|ripgrep|find|fd|fdfind|ack|ag)\b")
_NUDGE_MODES = ("off", "every", "stage", "run")

_NUDGE_TEXT = (
    "A code knowledge graph is preloaded for this repo. For codebase "
    'questions, prefer a scoped `graphify query "<question>"` (a semantic '
    "subgraph, usually far smaller than a raw search) over broad grep/find — "
    'and `graphify explain "<symbol>"` or `graphify path "<A>" "<B>"` for '
    "relationships."
)


def _extract_actual_command(command: str) -> str:
    """Strip the ``cd <root> &&`` prefix the pre_tool_use hook prepends."""
    if "&&" in command:
        return command.split("&&", 1)[1].strip()
    return command.strip()


def _nudge_mode() -> str:
    """Read ``worca.graphify.nudge`` (default ``every``)."""
    try:
        from worca.utils.settings import load_settings

        mode = (
            load_settings(".claude/settings.json")
            .get("worca", {})
            .get("graphify", {})
            .get("nudge", "every")
        )
        return mode if mode in _NUDGE_MODES else "every"
    except Exception:
        return "every"


def _graph_ready() -> bool:
    """True when the runner has injected a ready graph via GRAPHIFY_OUT."""
    out = os.environ.get("GRAPHIFY_OUT")
    return bool(out and os.path.isfile(os.path.join(out, "graph.json")))


def _is_search_command(command: str) -> bool:
    actual = _extract_actual_command(command)
    if "graphify" in actual:  # don't nudge a graphify invocation itself
        return False
    return bool(_SEARCH_RE.search(actual))


def _throttle_ok(mode: str) -> bool:
    """For stage/run modes, allow once per key then suppress. Marks on allow."""
    if mode == "every":
        return True
    run_dir = os.environ.get("WORCA_RUN_DIR")
    if not run_dir:
        return True  # nowhere to track → behave like 'every'
    raw_key = "run" if mode == "run" else (os.environ.get("WORCA_AGENT") or "stage")
    key = re.sub(r"[^A-Za-z0-9_.-]", "_", raw_key)
    marker_dir = os.path.join(run_dir, ".graphify_nudge")
    marker = os.path.join(marker_dir, key)
    try:
        if os.path.exists(marker):
            return False
        os.makedirs(marker_dir, exist_ok=True)
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write("1")
    except OSError:
        return True  # can't track → don't suppress
    return True


def graphify_nudge_context(tool_name: str, tool_input: dict) -> "str | None":
    """Return advisory additionalContext to nudge a graph query, or None.

    Non-blocking — the caller emits this as ``additionalContext`` on an
    otherwise-allowed PreToolUse decision. Cheap checks run before the settings
    read so the common (non-search / no-graph) path stays fast.
    """
    if tool_name != "Bash":
        return None
    command = tool_input.get("command", "")
    if not command or not _is_search_command(command):
        return None
    if not _graph_ready():
        return None
    mode = _nudge_mode()
    if mode == "off":
        return None
    if not _throttle_ok(mode):
        return None
    return _NUDGE_TEXT
