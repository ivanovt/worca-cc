"""Unit tests for the per-iteration graphify read-query counter predicate.

The runner counts read-only `graphify` queries per agent iteration to drive the
run-detail "Graphify" badge. The matching logic lives in
``_is_graphify_read_query`` (mutations are excluded — they're blocked by the
guard, not counted).
"""
import pytest

from worca.orchestrator.runner import _is_graphify_read_query


@pytest.mark.parametrize(
    "command",
    [
        'graphify query "where is checkout"',
        "graphify explain OrderService",
        'graphify path "A" "B"',
        "graphify affected src/x.py",
        "graphify diagnose",
        "cd /repo && graphify query \"x\"",  # hook cd-prefix is stripped
        'GRAPHIFY_OUT=/c graphify query "x"',  # env-prefix before the binary
    ],
)
def test_counts_read_verbs(command):
    assert _is_graphify_read_query(command) is True


@pytest.mark.parametrize(
    "command",
    [
        "graphify update .",  # mutation — blocked, not counted
        "graphify install",
        "graphify add https://x",
        "graphify hook",
        "grep -r graphify .",  # mentions graphify but doesn't invoke it
        "git log --oneline",
        'echo "graphify query"',  # quoted text, not an invocation
        "",
        "   ",
    ],
)
def test_excludes_non_read_queries(command):
    assert _is_graphify_read_query(command) is False


def test_query_text_mentioning_mutation_still_counts():
    # The verb is the token after `graphify`; later quoted tokens don't matter.
    assert _is_graphify_read_query('graphify query "how to update the install"') is True
