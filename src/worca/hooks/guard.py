"""PreToolUse safety gates for worca governance.

Reads JSON from stdin with tool_name and tool_input.
Exit code 0 = allow, exit code 2 = block (print reason to stderr).
"""
import json
import re
import shlex
import sys
import os

from worca.hooks.agent_role import role_from_worca_agent as _role_from_worca_agent


def _extract_actual_command(command: str) -> str:
    """Extract the actual command, stripping any cd prefix added by hooks.

    The pre_tool_use hook prepends 'cd /project/root && ' to every Bash
    command when WORCA_PROJECT_ROOT is set.  Detection functions need to
    inspect the real command, not the cd wrapper.
    """
    if "&&" in command:
        return command.split("&&", 1)[1].strip()
    return command.strip()


_SAFE_COMMAND_PREFIXES = ("bd ", "bd\t")


# The format of WORCA_AGENT is "{stage}-{agent}-iter-{N}" (set by
# utils/claude_cli.py from the resolved prompt filename). All role-based
# checks must extract the agent component with `_role_from_worca_agent()`
# — comparing the raw env var against a bare agent name silently fails.
# Implementation lives in worca.hooks.agent_role and is shared with the
# skill_use and subagent_start hooks; imported above.


def _is_env_evasion(command: str) -> bool:
    """Detect attempts to unset or override WORCA_AGENT (governance bypass).

    Catches patterns like:
      unset WORCA_AGENT
      export WORCA_AGENT=...
      WORCA_AGENT= <cmd>
      env -u WORCA_AGENT <cmd>
      env WORCA_AGENT=<whatever> <cmd>

    Searches the full raw command (NOT the cd-stripped form) — evasions
    typically appear on the left of `&&`, which the cd-strip would discard.
    """
    if _is_safe_command(command):
        return False
    patterns = (
        r"\bunset\b[^\n]*\bWORCA_AGENT\b",
        r"\bexport\b[^\n]*\bWORCA_AGENT\b",
        r"\bWORCA_AGENT\s*=",
        r"\benv\b[^\n]*(-u\s+WORCA_AGENT|WORCA_AGENT\s*=)",
    )
    for p in patterns:
        if re.search(p, command):
            return True
    return False


def _is_safe_command(command: str) -> bool:
    """Check if command is a safe CLI tool that should bypass all detection.

    Safe commands are tools like bd (beads issue tracker) whose arguments
    contain natural language that must not be pattern-matched as shell
    operations.
    """
    actual = _extract_actual_command(command)
    return any(actual.startswith(p) for p in _SAFE_COMMAND_PREFIXES)


def _is_rm_rf(command: str) -> bool:
    """Check if a command contains rm with both -r and -f flags."""
    if _is_safe_command(command):
        return False
    # Tokenize roughly to find rm invocations
    # Match patterns: rm -rf, rm -fr, rm -r -f, rm -f -r, etc.
    # We look for "rm" followed by flags that include both r and f
    tokens = command.split()
    if "rm" not in tokens:
        return False

    rm_index = tokens.index("rm")
    flags_after_rm = []
    for token in tokens[rm_index + 1:]:
        if token.startswith("-"):
            flags_after_rm.append(token)
        else:
            break

    # Collect all individual flag characters
    all_flags = set()
    for flag_token in flags_after_rm:
        if flag_token.startswith("--"):
            # Long flags like --recursive, --force
            long_flag = flag_token[2:]
            if long_flag == "recursive":
                all_flags.add("r")
            elif long_flag == "force":
                all_flags.add("f")
        else:
            # Short flags like -rf, -r, -f
            for ch in flag_token[1:]:
                all_flags.add(ch)

    return "r" in all_flags and "f" in all_flags


def _is_force_push(command: str) -> bool:
    """Check if command is a git push with --force or -f."""
    if _is_safe_command(command):
        return False
    tokens = command.split()
    if "git" not in tokens:
        return False
    git_idx = tokens.index("git")
    remaining = tokens[git_idx + 1:]
    if not remaining or remaining[0] != "push":
        return False
    push_args = remaining[1:]
    for arg in push_args:
        if arg == "--force" or arg.startswith("--force-"):
            return True
        if arg.startswith("-") and not arg.startswith("--"):
            if "f" in arg[1:]:
                return True
    return False


def _is_git_commit(command: str) -> bool:
    """Check if command contains git commit."""
    if _is_safe_command(command):
        return False
    return "git commit" in command


def _is_test_command(command: str) -> bool:
    """Check if command runs tests."""
    if _is_safe_command(command):
        return False
    test_patterns = [
        "pytest", "python -m pytest", "npm test", "npm run test",
        "yarn test", "cargo test", "go test",
    ]
    cmd_lower = command.lower()
    return any(p in cmd_lower for p in test_patterns)


def _is_file_write_via_bash(command: str) -> bool:
    """Detect Bash commands that write files, bypassing Write/Edit tools.

    Catches patterns like: cat > file, echo > file, tee file,
    python3 -c "open(f,'w')", heredocs writing files, sed -i, etc.
    """
    if _is_safe_command(command):
        return False

    # Shell redirection: > or >> to a file
    # Match: cat > file, echo > file, printf > file, etc.
    if re.search(r'(?<!\|)\s*>\s*[^\s|&;]', command):
        return True

    # Heredoc writes: << 'EOF' or <<EOF combined with > or cat >
    if re.search(r'<<\s*[\'"]?\w+[\'"]?', command) and ">" in command:
        return True

    # tee command (writes to files)
    if re.search(r'\btee\b', command):
        return True

    # sed -i (in-place edit)
    if re.search(r'\bsed\b.*\s-i', command):
        return True

    # python/python3 with file write patterns
    if re.search(r'\bpython[3]?\b', command):
        if re.search(r'open\s*\(.*["\']w["\']', command) or \
           re.search(r'\.write\s*\(', command) or \
           re.search(r'\.writelines\s*\(', command) or \
           re.search(r'pathlib.*write_', command):
            return True

    # cp or mv (can overwrite files)
    if re.search(r'\b(cp|mv)\b', command):
        return True

    # dd command
    if re.search(r'\bdd\b.*\bof=', command):
        return True

    return False


# graphify subcommands that mutate state (build the graph, install hooks,
# rewrite the consumer's config). The worca pipeline owns graph builds — it
# runs `graphify update` itself at preflight as a detached subprocess that
# never passes through this hook. Agents get the cached graph via the
# GRAPHIFY_OUT env var and are restricted to read-only queries.
_GRAPHIFY_MUTATION_VERBS = frozenset({
    "update", "install", "uninstall", "add", "hook",
    "merge-driver", "watch", "clone",
})


def _is_graphify_mutation(command: str) -> bool:
    """Detect a mutating `graphify <verb>` invocation.

    Read subcommands (query/explain/path/affected/diagnose) are allowed; only
    the mutating verbs above are matched. Inspects the cd-stripped command so
    the hook's ``cd <root> &&`` prefix doesn't hide the real invocation, and
    matches on the first token after a ``graphify`` executable so a query whose
    text mentions "update" (a later, quoted token) is not falsely flagged.
    """
    if _is_safe_command(command):
        return False
    actual = _extract_actual_command(command)
    try:
        tokens = shlex.split(actual)
    except ValueError:
        return False
    for i, tok in enumerate(tokens):
        if os.path.basename(tok) == "graphify" and i + 1 < len(tokens):
            return tokens[i + 1] in _GRAPHIFY_MUTATION_VERBS
    return False


def _graphify_mutation_guard_enabled() -> bool:
    """Whether the read-only graphify guard is active (default True).

    Reads ``worca.governance.guards.block_graphify_mutation`` from the project
    settings (resolved relative to the hook's cwd, which the pre_tool_use hook
    pins to the project root). Defaults to True — and stays True on any read
    error — so the guard is on unless a project explicitly opts out.
    """
    try:
        from worca.utils.settings import load_settings
        guards = (
            load_settings(".claude/settings.json")
            .get("worca", {})
            .get("governance", {})
            .get("guards", {})
        )
        return guards.get("block_graphify_mutation", True)
    except Exception:
        return True


def check_guard(tool_name: str, tool_input: dict) -> tuple:
    """Check if tool use should be blocked.

    Returns (exit_code, reason) where exit_code 0 = allow, 2 = block.
    """
    command = tool_input.get("command", "")
    file_path = tool_input.get("file_path", "")

    # Block rm -rf
    if tool_name == "Bash" and _is_rm_rf(command):
        return (2, "Blocked: rm with recursive+force flags is not allowed.")

    # Block .env access via Write/Edit
    if tool_name in ("Write", "Edit"):
        basename = os.path.basename(file_path)
        if basename == ".env":
            return (2, "Blocked: writing to .env files is not allowed. Use .env.sample or .env.example instead.")

    # Block force push
    if tool_name == "Bash" and _is_force_push(command):
        return (2, "Blocked: git push --force is not allowed.")

    # Block mutating graphify subcommands (build/install/hook/etc.). Agents may
    # only run read-only queries (query/explain/path/affected/diagnose); the
    # worca pipeline owns graph builds. Role-independent, like the guards above.
    if (tool_name == "Bash"
            and _is_graphify_mutation(command)
            and _graphify_mutation_guard_enabled()):
        return (2, "Blocked: agents may only run read-only graphify queries "
                   "(query/explain/path/affected/diagnose). graphify "
                   "update/install/add and other mutations are reserved for "
                   "the worca pipeline.")

    # Block WORCA_AGENT evasion attempts (unset / env -u / override).
    # Runs BEFORE role checks so the agent cannot first erase its identity
    # and then perform a restricted action.
    if tool_name == "Bash" and _is_env_evasion(command):
        return (2, "Blocked: WORCA_AGENT may not be unset, exported, or overridden — "
                   "this is a governance bypass attempt and is logged.")

    # Block commits when not Guardian
    raw_agent = os.environ.get("WORCA_AGENT")
    role = _role_from_worca_agent(raw_agent) if raw_agent else None
    if tool_name == "Bash" and _is_git_commit(command):
        if role is not None and role != "guardian":
            return (2, "Blocked: only the guardian agent may commit. Current agent: {}.".format(raw_agent))

    # Role-based restrictions (only enforced when WORCA_AGENT is set)
    if role:
        # Planner may only write the plan file
        if tool_name in ("Write", "Edit") and role == "planner":
            plan_file = os.environ.get("WORCA_PLAN_FILE")
            if plan_file:
                allowed = os.path.abspath(plan_file)
                target = os.path.abspath(file_path)
                if target != allowed:
                    return (2, "Blocked: planner agent may only write {}, not {}.".format(plan_file, file_path))
            else:
                basename = os.path.basename(file_path)
                if basename != "MASTER_PLAN.md" and not re.match(r'^plan-\d{3}\.md$', basename):
                    return (2, "Blocked: planner agent may only write MASTER_PLAN.md or plan-NNN.md, not {}.".format(basename))

        # Read-only agents: coordinator, tester, plan_reviewer, and reviewer
        # may not write files
        read_only_agents = ("coordinator", "tester", "plan_reviewer", "reviewer")
        if role in read_only_agents:
            if tool_name in ("Write", "Edit"):
                return (2, "Blocked: {} agent is read-only — may not write files.".format(role))
            if tool_name == "Bash" and _is_file_write_via_bash(command):
                return (2, "Blocked: {} agent is read-only — file writes via Bash are not allowed.".format(role))

        # Planner, Coordinator, PlanReviewer, and Reviewer may not run tests.
        # Reviewer was observed running pytest/vitest to verify claims
        # (2026-04-12 W-039 run) — reviewer must stay read-only.
        if tool_name == "Bash" and role in ("planner", "coordinator", "plan_reviewer", "reviewer"):
            if _is_test_command(command):
                return (2, "Blocked: {} agent may not run tests.".format(role))

        # Guardian (PR stage): may not modify source or test files.
        # Its job is PR creation + commit, not code fixes. If tests or review
        # fail at PR time, route back — do not patch inline.
        if role == "guardian" and tool_name in ("Write", "Edit"):
            # Allow docs/markdown only (PR bodies, release notes, etc.).
            ext = os.path.splitext(file_path)[1].lower()
            if ext not in (".md", ".markdown", ".txt", ""):
                return (2, "Blocked: guardian agent may not modify source/test files — "
                           "got {}. Route back to implementer/tester if a fix is needed.".format(file_path))

    # Allow everything else
    return (0, "")


def main():
    data = json.load(sys.stdin)
    tool_name = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})
    code, reason = check_guard(tool_name, tool_input)
    if code != 0:
        print(reason, file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
