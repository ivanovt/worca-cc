"""Wrapper for the claude -p CLI with stream-json support.

Uses --output-format stream-json --verbose to get real-time NDJSON events
from the claude CLI. Each event is written to a log file for UI streaming.
The final 'result' event contains the structured output (same as --output-format json).
"""

import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
from typing import Optional, Callable

from worca.hooks.tracking import _load_dispatch_section
from worca.utils.env import get_env, filter_model_env

# Linux ARG_MAX is typically 2 MiB but total argv+envp must fit.
# Use a conservative 128 KiB threshold for the prompt argument.
_ARG_INLINE_LIMIT = 128 * 1024  # bytes

# Track the currently running subprocess so it can be terminated on signal.
_current_proc = None
_proc_lock = threading.Lock()

# Bounded wait when reaping the agent subprocess after a stream-side
# exception. Long enough for a signaled subprocess to finish dying, short
# enough to keep the failure path snappy.
_REAP_WAIT_TIMEOUT = 2.0


class AgentSubprocessError(RuntimeError):
    """Raised when the agent subprocess exits abnormally.

    Subclasses RuntimeError so existing `except RuntimeError` and `except
    Exception` callers in the runner continue to work. Exposes the raw
    subprocess returncode so callers can distinguish a real agent failure
    (positive exit code) from a signal-induced death (negative exit code,
    e.g. -SIGTERM = -15).
    """

    def __init__(self, message: str, returncode):
        super().__init__(message)
        self.returncode = returncode


def _reap_returncode(proc):
    """Best-effort reap of `proc` to obtain a definitive returncode.

    Used when an exception escapes the streaming loop before `proc.wait()`
    runs naturally — without this, `proc.returncode` may be `None` and the
    caller cannot tell whether the subprocess died from a signal or a real
    failure. Bounded by `_REAP_WAIT_TIMEOUT`; if the subprocess is wedged,
    we kill it so the caller is not blocked indefinitely.
    """
    try:
        proc.wait(timeout=_REAP_WAIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass
        try:
            proc.wait(timeout=_REAP_WAIT_TIMEOUT)
        except subprocess.TimeoutExpired:
            pass
    except Exception:
        pass
    return proc.returncode


def terminate_current():
    """Terminate the currently running claude subprocess, if any.

    Sends SIGTERM to the process group so child processes are also killed.
    """
    with _proc_lock:
        proc = _current_proc
    if proc is None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, OSError):
        pass


def _resolve_tool_disallows(agent_name: str, settings: dict | None = None) -> list[str]:
    """Build the --disallowedTools list from settings (W-054 §8).

    Loads worca.governance.dispatch.tools and returns the always_disallowed
    entries minus Skill (now governed by the skills hook). Named-tool entries
    in per_agent_allow are warned about and ignored — only '*' and [] are
    honored in v1.
    """
    cfg = _load_dispatch_section("tools", settings)
    disallows = list(cfg["always_disallowed"])
    entry = cfg["per_agent_allow"].get(
        agent_name, cfg["per_agent_allow"].get("_defaults", ["*"]),
    )
    has_wildcard = "*" in entry or len(entry) == 0
    if not has_wildcard:
        print(
            f"[worca] tools.per_agent_allow.{agent_name} contains named tools; "
            f"only '*' or [] are honored in v1 — falling back to wildcard",
            file=sys.stderr,
        )
    return [t for t in disallows if t != "Skill"]


def build_command(
    prompt: str,
    agent: str,
    output_format: str = "stream-json",
    json_schema: Optional[str] = None,
    model: Optional[str] = None,
    settings: Optional[dict] = None,
    **kwargs,
) -> tuple[list[str], Optional[str]]:
    """Build the claude CLI command list without executing.

    When the prompt exceeds 128 KiB it is written to a temporary file and
    the CLI argument becomes a short instruction to read that file.  This
    avoids ``[Errno 7] Argument list too long`` (E2BIG) errors.

    Args:
        prompt: The prompt to send to the agent.
        agent: Path to the agent .md file (e.g. ".claude/agents/core/planner.md").
        output_format: Output format ("text", "json", "stream-json").
        json_schema: Inline JSON schema string for structured output, or path
                     to a .json file (will be read and inlined).
        model: Model shorthand or full ID (e.g. "sonnet", "opus", "claude-sonnet-4-6").

    Returns:
        A (cmd, prompt_file) tuple. ``prompt_file`` is the path to a temp
        file containing the full prompt when offloaded, or None when the
        prompt is passed inline. The caller must delete the temp file after
        the subprocess finishes.
    """
    prompt_file = None
    if len(prompt.encode("utf-8", errors="replace")) > _ARG_INLINE_LIMIT:
        fd, prompt_file = tempfile.mkstemp(prefix="worca_prompt_", suffix=".md")
        with os.fdopen(fd, "w") as f:
            f.write(prompt)
        cli_prompt = (
            f"Read the file at {prompt_file} and follow ALL instructions in it. "
            f"That file IS your full prompt — process it exactly as written."
        )
    else:
        cli_prompt = prompt

    _claude_bin_override = os.environ.get("WORCA_CLAUDE_BIN")
    _claude_bin = shlex.split(_claude_bin_override or "claude")
    if _claude_bin_override:
        print(f"[worca] WORCA_CLAUDE_BIN override active: {_claude_bin_override}", file=sys.stderr)
    agent_name = os.path.splitext(os.path.basename(agent))[0]
    disallowed_tools = _resolve_tool_disallows(agent_name, settings)
    cmd = [
        *_claude_bin,
        "-p",
        cli_prompt,
        "--agent",
        agent,
        "--output-format",
        output_format,
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--disallowedTools", ",".join(disallowed_tools),
    ]
    if model:
        cmd.extend(["--model", model])
    if output_format == "stream-json":
        cmd.append("--verbose")
    if json_schema is not None:
        # If it looks like a file path, read its contents
        schema_str = json_schema
        if json_schema.endswith(".json"):
            try:
                with open(json_schema) as f:
                    schema_str = f.read().strip()
            except FileNotFoundError:
                pass  # Use the raw string as-is
        cmd.extend(["--json-schema", schema_str])
    return cmd, prompt_file


def _format_log_line(event: dict) -> Optional[str]:
    """Convert a stream-json event into a human-readable log line.

    Returns None for events that shouldn't be logged (system hooks, etc.).
    """
    etype = event.get("type", "")
    subtype = event.get("subtype", "")

    if etype == "system":
        if subtype == "init":
            model = event.get("model", "?")
            return f"[init] model={model}"
        # Skip hook events — noisy
        return None

    if etype == "assistant":
        msg = event.get("message", {})
        content_blocks = msg.get("content", [])
        parts = []
        for block in content_blocks:
            if block.get("type") == "text":
                text = block.get("text", "").strip()
                if text:
                    parts.append(text)
            elif block.get("type") == "tool_use":
                tool = block.get("name", "?")
                inp = block.get("input", {})
                # Summarize tool input
                if tool == "Read":
                    detail = inp.get("file_path", "")
                elif tool == "Write":
                    detail = inp.get("file_path", "")
                elif tool == "Edit":
                    detail = inp.get("file_path", "")
                elif tool == "Bash":
                    detail = inp.get("command", "")[:120]
                elif tool == "Grep":
                    detail = inp.get("pattern", "")
                elif tool == "Glob":
                    detail = inp.get("pattern", "")
                elif tool == "Agent":
                    detail = inp.get("description", "")
                else:
                    detail = ""
                parts.append(f"[tool:{tool}] {detail}")
            elif block.get("type") == "tool_result":
                # Tool results in assistant messages — skip detail
                pass
        if parts:
            return " | ".join(parts)
        return None

    if etype == "user":
        # User messages contain tool results
        content = event.get("content", [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tool_id = block.get("tool_use_id", "")[:8]
                    is_error = block.get("is_error", False)
                    status = "ERROR" if is_error else "ok"
                    return f"[result:{status}] {tool_id}"
        return None

    if etype == "result":
        cost = event.get("total_cost_usd", 0)
        turns = event.get("num_turns", 0)
        duration = event.get("duration_ms", 0)
        return f"[done] turns={turns} cost=${cost:.3f} duration={duration / 1000:.1f}s"

    return None


def process_stream(
    stdout,
    log_file=None,
    on_event: Optional[Callable[[dict], None]] = None,
) -> dict:
    """Read NDJSON events from stdout and return the result event.

    Args:
        stdout: File-like object yielding lines of NDJSON.
        log_file: Open file to write human-readable log lines to.
        on_event: Optional callback invoked for each parsed event.

    Returns the parsed result event dict, or raises RuntimeError if not found.
    The result event will have ``_resolved_model`` set from the system.init
    event if the result event does not already contain a ``model`` field.
    """
    result_event = None
    resolved_model = None
    sticky_structured_output = None

    for raw_line in stdout:
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # Not valid JSON — write raw to log
            if log_file:
                log_file.write(raw_line if isinstance(raw_line, str) else raw_line.decode())
                log_file.flush()
            continue

        if on_event:
            on_event(event)

        # Capture model from system.init event
        if event.get("type") == "system" and event.get("subtype") == "init":
            resolved_model = event.get("model")

        # Write human-readable summary to log
        if log_file:
            log_line = _format_log_line(event)
            if log_line:
                log_file.write(log_line + "\n")
                log_file.flush()

        if event.get("type") == "result":
            # Task-notification auto-resumes (e.g. long pytest run dispatched
            # as `run_in_background` Bash) emit extra `result` events with no
            # structured_output. Keep the last one we saw so the silent
            # resume can't clobber the real agent output (issue #163).
            so = event.get("structured_output")
            if so:
                sticky_structured_output = so
            result_event = event

    if result_event is None:
        raise RuntimeError("No result event found in stream-json output")

    if sticky_structured_output and not result_event.get("structured_output"):
        result_event["structured_output"] = sticky_structured_output

    # Attach resolved model to result event if not already present
    if resolved_model and "model" not in result_event:
        result_event["_resolved_model"] = resolved_model

    return result_event


def run_agent(
    prompt: str,
    agent: str,
    max_turns: int = 0,
    output_format: str = "stream-json",
    json_schema: Optional[str] = None,
    model: Optional[str] = None,
    model_env: Optional[dict] = None,
    log_path: Optional[str] = None,
    on_event: Optional[Callable[[dict], None]] = None,
    settings: Optional[dict] = None,
) -> dict:
    """Run a claude agent via the CLI and return parsed JSON output.

    Uses stream-json format to get real-time events. The final result event
    is returned (same structure as --output-format json).

    Note: max_turns is accepted for API compatibility but not passed to the CLI
    (claude -p does not support --max-turns). Use --max-budget-usd for cost control.

    Args:
        model: Model shorthand or full ID to pass via --model flag.
        log_path: If provided, write human-readable event summaries to this file.
        on_event: Optional callback invoked for each stream-json event.

    Raises RuntimeError on subprocess failure or missing result.
    """
    cmd, prompt_file = build_command(
        prompt,
        agent=agent,
        output_format=output_format,
        json_schema=json_schema,
        model=model,
        settings=settings,
    )

    global _current_proc

    # Extract agent name from path so hooks can enforce role-based restrictions
    agent_name = os.path.splitext(os.path.basename(agent))[0]

    safe_env, dropped = filter_model_env(model_env or {})
    if dropped:
        print(
            f"[worca] model env keys dropped (reserved): {sorted(dropped)}",
            file=sys.stderr,
        )

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=get_env(WORCA_AGENT=agent_name, **safe_env), start_new_session=True,
    )

    with _proc_lock:
        _current_proc = proc

    agent_pid_path = None
    if log_path:
        run_dir = os.path.dirname(log_path)
        agent_pid_path = os.path.join(run_dir, "agent.pid")
        try:
            os.makedirs(run_dir, exist_ok=True)
            with open(agent_pid_path, "w") as f:
                f.write(str(proc.pid))
        except OSError:
            agent_pid_path = None

    log_file = None
    result_event = None
    try:
        if log_path:
            os.makedirs(os.path.dirname(log_path), exist_ok=True)
            log_file = open(log_path, "w")

        # Tee stderr to console in background
        def _tee_stderr():
            for line in proc.stderr:
                sys.stderr.write(line)
                sys.stderr.flush()

        stderr_thread = threading.Thread(target=_tee_stderr, daemon=True)
        stderr_thread.start()

        try:
            # Process stdout stream events. May raise RuntimeError when the
            # subprocess dies before emitting a result event (signal kill,
            # crash, or a real agent failure that aborts mid-stream).
            result_event = process_stream(
                proc.stdout,
                log_file=log_file,
                on_event=on_event,
            )
            stderr_thread.join(timeout=5)
            proc.wait()
        except Exception as stream_exc:
            # The streaming layer cannot tell why the subprocess stopped
            # producing output. Reap it (with a bounded wait) so the
            # returncode is definitive, then route on the actual exit
            # signal: negative -> signal kill (interruption), otherwise
            # surface as AgentSubprocessError carrying the returncode.
            stderr_thread.join(timeout=5)
            rc = _reap_returncode(proc)
            if rc is not None and rc < 0:
                raise InterruptedError(
                    f"claude agent killed by signal {-rc}"
                ) from stream_exc
            raise AgentSubprocessError(
                f"claude agent stream failed: {stream_exc}",
                returncode=rc,
            ) from stream_exc

        if log_file:
            log_file.close()
            log_file = None

    finally:
        with _proc_lock:
            _current_proc = None
        if agent_pid_path:
            try:
                os.unlink(agent_pid_path)
            except OSError:
                pass
        if log_file:
            log_file.close()
        # Clean up the temporary prompt file if one was created
        if prompt_file:
            try:
                os.unlink(prompt_file)
            except OSError:
                pass

    if proc.returncode < 0:
        raise InterruptedError(f"claude agent killed by signal {-proc.returncode}")
    if proc.returncode != 0:
        error_msg = result_event.get("result", "") if result_event else ""
        raise AgentSubprocessError(
            f"claude agent failed (exit code {proc.returncode})"
            + (f": {error_msg[:500]}" if error_msg else ""),
            returncode=proc.returncode,
        )

    return result_event
