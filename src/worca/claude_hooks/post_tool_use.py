# /// script
# requires-python = ">=3.8"
# ///
"""PostToolUse hook: runs test_gate and links bd create to pipeline runs."""
import json
import re
import shlex
import subprocess
import sys
import os
from datetime import datetime
from pathlib import Path

# graphify read subcommands (the queryable surface). Mutating subcommands
# (update/install/add/...) are blocked by the pre_tool_use guard and are never
# recorded as queries.
_GRAPHIFY_READ_OPS = ("query", "explain", "path", "affected", "diagnose")

# CRG is reached via an MCP server keyed "code-review-graph"; Claude Code names
# its tools mcp__<server>__<tool>.
_CRG_TOOL_PREFIXES = ("mcp__code-review-graph__", "mcp__code_review_graph__")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

try:
    from worca.hooks.test_gate import check_test_gate, _state as _test_gate_state
except ImportError:
    sys.exit(0)

try:
    from worca.events.hook_emitter import emit_from_hook
except ImportError:
    emit_from_hook = None

try:
    from worca.utils.settings import load_settings
except ImportError:
    load_settings = None


def _is_file_access_enabled():
    """Check if file access recording is enabled via settings."""
    if not load_settings:
        return True  # Default to enabled if we can't load settings
    project_root = os.environ.get("WORCA_PROJECT_ROOT", ".")
    try:
        settings_path = os.path.join(project_root, ".claude", "settings.json")
        settings = load_settings(settings_path)
        return (
            settings.get("worca", {})
            .get("telemetry", {})
            .get("file_access", {})
            .get("enabled", True)
        )
    except Exception:
        return True  # Default to enabled if we can't load settings


def _get_access_dir():
    """Get the access directory for the current run."""
    run_id = os.environ.get("WORCA_RUN_ID")
    if not run_id:
        return None
    project_root = os.environ.get("WORCA_PROJECT_ROOT", ".")
    return os.path.join(project_root, ".worca", "runs", run_id, "access")


def _count_grep_results(output):
    """Count the number of matching lines in grep output."""
    if not output:
        return 0
    lines = output.strip().split("\n")
    return len([line for line in lines if line.strip()])


def _parse_graphify_command(command):
    """Extract a graphify read query from a Bash command, or None.

    Handles compound commands (e.g. a ``cd <root> && graphify query "…"``
    prefix) by scanning tokens for the graphify invocation. Only the read
    subcommands are recorded; the query is the positional args with flags
    (and their values for ``--graph``-style flags) stripped.
    """
    if not command or "graphify" not in command:
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    for i, tok in enumerate(tokens):
        if tok.rsplit("/", 1)[-1] != "graphify":
            continue
        rest = tokens[i + 1:]
        op = None
        args = []
        skip_next = False
        for t in rest:
            if skip_next:
                skip_next = False
                continue
            if t.startswith("-"):
                # value-taking flags: skip the following token too
                if t in ("--graph", "-g", "--out", "--output", "--format"):
                    skip_next = True
                continue
            if op is None:
                op = t
                continue
            args.append(t)
        if op in _GRAPHIFY_READ_OPS:
            return {"engine": "graphify", "op": op, "query": " ".join(args).strip()[:200]}
        # graphify invoked, but not a read subcommand — don't record.
        return None
    return None


def _graph_query_from_tool(tool_name, tool_input):
    """Return a {engine, op, query} dict if this tool call is a graph query.

    Only the fields both engines reliably expose are captured: the engine, the
    op (graphify subcommand / CRG MCP tool name), and the verbatim query/args.
    """
    for prefix in _CRG_TOOL_PREFIXES:
        if tool_name.startswith(prefix):
            op = tool_name[len(prefix):]
            try:
                query = json.dumps(tool_input or {}, separators=(",", ":"), sort_keys=True)
            except (TypeError, ValueError):
                query = str(tool_input)
            return {"engine": "crg", "op": op, "query": query[:200]}
    if tool_name == "Bash":
        return _parse_graphify_command((tool_input or {}).get("command", ""))
    return None


# File/search tools whose PostToolUse this hook records into
# .worca/runs/<id>/access/. This set MUST be a subset of the PostToolUse
# matcher in src/worca/settings.json (plus "Bash" for graph queries + the
# test-gate) — otherwise the hook never fires for these tools and nothing is
# recorded. test_post_tool_use_matcher.py asserts that wiring.
FILE_ACCESS_TOOLS = ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob")

# PostToolUse matcher fragments (regex alternatives) for the CRG MCP tools, so
# Claude Code fires this hook for CRG graph queries. CRG is reached over MCP —
# tools are named mcp__<server>__<tool> — and the matcher selects which tool
# calls reach a hook. Without these alternatives in the matcher, the CRG branch
# of _graph_query_from_tool is dead: CRG queries never land in the access ledger
# even though the runner's crg_invocations badge counts them (the badge reads
# the agent tool-use stream, this hook reads the matcher-gated callbacks — two
# different channels that must agree). Derived from _CRG_TOOL_PREFIXES so the
# matcher and the recorder stay in lockstep. test_post_tool_use_matcher.py
# asserts the shipped matcher carries these.
CRG_MATCHER_PATTERNS = tuple(f"{prefix}.*" for prefix in _CRG_TOOL_PREFIXES)


def _record_file_access(tool_name, tool_input, tool_response):
    """Record file access for reads, writes, searches, and graph queries."""
    # Check if file access recording is enabled
    if not _is_file_access_enabled():
        return

    graph_query = _graph_query_from_tool(tool_name, tool_input)

    # Only record specific tools (plus graphify/CRG graph queries).
    if tool_name not in FILE_ACCESS_TOOLS and graph_query is None:
        return

    run_id = os.environ.get("WORCA_RUN_ID")
    stage = os.environ.get("WORCA_STAGE")
    iteration = os.environ.get("WORCA_ITERATION")
    bead_id = os.environ.get("WORCA_BEAD_ID")

    # Skip if required env vars are missing
    if not (run_id and stage and iteration):
        return

    access_dir = _get_access_dir()
    if not access_dir:
        return

    # Create the access directory if it doesn't exist
    try:
        Path(access_dir).mkdir(parents=True, exist_ok=True)
    except Exception:
        return

    # Build the filename
    if bead_id:
        filename = f"{stage}-{iteration}-{bead_id}.jsonl"
    else:
        filename = f"{stage}-{iteration}.jsonl"

    filepath = os.path.join(access_dir, filename)

    # Build the record based on tool type
    ts = datetime.utcnow().isoformat() + "Z"
    record = {"ts": ts, "tool": tool_name}

    if graph_query is not None:
        record["op"] = "graph_query"
        record["engine"] = graph_query["engine"]
        record["graph_op"] = graph_query["op"]
        record["query"] = graph_query["query"]

    elif tool_name in ("Read",):
        record["op"] = "read"
        record["path"] = tool_input.get("file_path", "")

    elif tool_name in ("Write", "Edit"):
        record["op"] = "write"
        record["path"] = tool_input.get("file_path", "")

    elif tool_name == "MultiEdit":
        record["op"] = "write"
        record["path"] = tool_input.get("file_path", "")

    elif tool_name == "NotebookEdit":
        record["op"] = "write"
        record["path"] = tool_input.get("notebook_path", "")

    elif tool_name in ("Grep", "Glob"):
        record["op"] = "search"
        record["pattern"] = tool_input.get("pattern", "")
        # For Grep, use path; for Glob, use path
        record["scope"] = tool_input.get("path", "")

        # Capture filter dimensions (glob/type for Grep, glob for Glob)
        filter_obj = {}
        if tool_name == "Grep":
            if "glob" in tool_input:
                filter_obj["glob"] = tool_input["glob"]
            if "type" in tool_input:
                filter_obj["type"] = tool_input["type"]
        elif tool_name == "Glob":
            if "glob" in tool_input:
                filter_obj["glob"] = tool_input["glob"]
        if filter_obj:
            record["filter"] = filter_obj

        # Extract result count from response
        if tool_name in ("Grep", "Glob"):
            output = tool_response.get("output", "")
            record["result_count"] = _count_grep_results(output)

    # Append the record to the JSONL file
    try:
        with open(filepath, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(record, separators=(",", ":")) + "\n")
    except Exception:
        pass

    # Emit a live event for graph queries so the run-detail graphify/CRG badges
    # can count them during the run, mirroring the dispatch_{allowed,blocked}
    # live-event pattern. The completion-time count (graphify_invocations /
    # crg_invocations, tallied by the runner from the tool-use stream) remains
    # authoritative; the UI server uses these events only to populate a live
    # count for the still-running iteration.
    if graph_query is not None and emit_from_hook:
        try:
            emit_from_hook("pipeline.hook.graph_query", {
                "engine": graph_query["engine"],
                "op": graph_query["op"],
                "agent": os.environ.get("WORCA_AGENT"),
            })
        except Exception:
            pass


def _link_bd_create_to_run(tool_name, tool_input, tool_response):
    """After a successful bd create, add a run label to link it to the current run.

    When WORCA_RUN_ID is set (pipeline is running), any successful `bd create`
    output is parsed for the issue ID, then `bd label add` tags it with
    ``run:<run_id>`` so multiple beads can share the same run reference.
    Also emits a bead.created event via hook_emitter for each created bead.
    """
    if tool_name != "Bash":
        return
    run_id = os.environ.get("WORCA_RUN_ID")
    if not run_id:
        return
    command = tool_input.get("command", "")
    if "bd create" not in command:
        return
    stdout = tool_response.get("stdout", "")
    exit_code = tool_response.get("exit_code", 1)
    if exit_code != 0:
        return
    # Match all created issue IDs (may be multiple in chained commands)
    for match in re.finditer(r"Created issue:\s+(\S+)", stdout):
        issue_id = match.group(1)
        subprocess.run(
            ["bd", "label", "add", issue_id, f"run:{run_id}"],
            capture_output=True, text=True
        )
        try:
            from worca.events.hook_emitter import emit_from_hook
            emit_from_hook("pipeline.bead.created", {"bead_id": issue_id, "run_label": f"run:{run_id}"})
        except Exception:
            pass


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    tool_response = data.get("tool_response", {})

    # Record file access (reads, writes, searches)
    _record_file_access(tool_name, tool_input, tool_response)

    # Link bd create issues to the current pipeline run
    _link_bd_create_to_run(tool_name, tool_input, tool_response)

    # Test gate check
    exit_code = tool_response.get("exit_code", data.get("exit_code", 0))
    code, reason = check_test_gate(tool_name, tool_input, exit_code)
    if code != 0:
        if emit_from_hook:
            emit_from_hook("pipeline.hook.test_gate", {
                "agent": os.environ.get("WORCA_AGENT", ""),
                "strike": _test_gate_state["strikes"],
                "action": "block",
            })
        print(reason, file=sys.stderr)
    elif reason:
        print(reason, file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
