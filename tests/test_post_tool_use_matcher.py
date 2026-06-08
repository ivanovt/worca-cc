"""The PostToolUse hook matcher in settings.json must cover every tool the
file-access recorder targets.

W-064 added the recorder (`_record_file_access` records Read/Write/Edit/
MultiEdit/NotebookEdit/Grep/Glob + Bash graph queries) and the Access Map UI,
but the PostToolUse matcher was left "Bash"-only (last touched at W-059). The
hook therefore never fired for the file/search tools, nothing was written to
`.worca/runs/<id>/access/`, and the Access Map always showed the empty state.
This test ties the matcher to the recorder's canonical tool set so the two
can't drift apart again.
"""
import json
import os

import worca
from worca.claude_hooks.post_tool_use import CRG_MATCHER_PATTERNS, FILE_ACCESS_TOOLS

SETTINGS_PATH = os.path.join(os.path.dirname(worca.__file__), "settings.json")


def _post_tool_use_matcher_tokens():
    """Union of '|'-split matcher tokens across every PostToolUse entry that
    runs post_tool_use.py."""
    with open(SETTINGS_PATH, encoding="utf-8") as f:
        settings = json.load(f)
    tokens = set()
    found = False
    for entry in settings.get("hooks", {}).get("PostToolUse", []):
        cmds = " ".join(h.get("command", "") for h in entry.get("hooks", []))
        if "post_tool_use.py" not in cmds:
            continue
        found = True
        for tok in entry.get("matcher", "").split("|"):
            tok = tok.strip()
            if tok:
                tokens.add(tok)
    return found, tokens


def test_post_tool_use_hook_is_registered():
    found, _ = _post_tool_use_matcher_tokens()
    assert found, "no PostToolUse entry in settings.json runs post_tool_use.py"


def test_post_tool_use_matcher_covers_file_access_tools():
    _, tokens = _post_tool_use_matcher_tokens()
    missing = [t for t in FILE_ACCESS_TOOLS if t not in tokens]
    assert not missing, (
        f"PostToolUse matcher does not cover recorded tools {missing}; the "
        f"file-access recorder never fires for them and the Access Map stays "
        f"empty. matcher tokens={sorted(tokens)}"
    )


def test_post_tool_use_matcher_keeps_bash():
    # Bash must stay: the same hook drives the test-gate and records graph queries.
    _, tokens = _post_tool_use_matcher_tokens()
    assert "Bash" in tokens, (
        f"PostToolUse matcher dropped Bash; the test-gate and graph-query "
        f"recording rely on it. tokens={sorted(tokens)}"
    )


def test_post_tool_use_matcher_covers_crg_mcp_tools():
    # CRG is queried over MCP (mcp__<server>__<tool>), not Bash. Without these
    # patterns the hook never fires for CRG tools, so CRG graph queries are
    # dropped from the access ledger even though the crg_invocations badge
    # counts them — the badge and the Graph-queries table then disagree.
    _, tokens = _post_tool_use_matcher_tokens()
    missing = [p for p in CRG_MATCHER_PATTERNS if p not in tokens]
    assert not missing, (
        f"PostToolUse matcher does not cover CRG MCP patterns {missing}; CRG "
        f"graph queries are never recorded. matcher tokens={sorted(tokens)}"
    )
