"""Tests for gh_pr.py — fetch_review_feedback(), reply_to_thread(), post_revision_summary()."""

import json
from unittest.mock import MagicMock, patch


from worca.utils.gh_pr import fetch_review_feedback, reply_to_thread, post_revision_summary


GRAPHQL_RESPONSE = {
    "data": {
        "repository": {
            "pullRequest": {
                "reviewThreads": {
                    "nodes": [
                        {
                            "id": "PRRT_aaa",
                            "isResolved": False,
                            "isOutdated": False,
                            "comments": {
                                "nodes": [
                                    {
                                        "author": {"login": "alice"},
                                        "path": "src/foo.py",
                                        "line": 42,
                                        "originalLine": 42,
                                        "diffHunk": "@@ -40,6 +40,8 @@",
                                        "body": "this leaks a file handle",
                                        "createdAt": "2026-06-03T12:00:00Z",
                                    }
                                ]
                            },
                        },
                        {
                            "id": "PRRT_bbb",
                            "isResolved": True,
                            "isOutdated": False,
                            "comments": {
                                "nodes": [
                                    {
                                        "author": {"login": "alice"},
                                        "path": "src/bar.py",
                                        "line": 10,
                                        "originalLine": 10,
                                        "diffHunk": "@@ -8,4 +8,6 @@",
                                        "body": "already resolved",
                                        "createdAt": "2026-06-03T10:00:00Z",
                                    }
                                ]
                            },
                        },
                        {
                            "id": "PRRT_ccc",
                            "isResolved": False,
                            "isOutdated": False,
                            "comments": {
                                "nodes": [
                                    {
                                        "author": {"login": "worca-bot"},
                                        "path": "src/baz.py",
                                        "line": 5,
                                        "originalLine": 5,
                                        "diffHunk": "@@ -3,4 +3,6 @@",
                                        "body": "bot comment should be excluded",
                                        "createdAt": "2026-06-03T11:00:00Z",
                                    }
                                ]
                            },
                        },
                    ]
                }
            }
        }
    }
}


def _make_gh_result(payload: dict) -> MagicMock:
    result = MagicMock()
    result.returncode = 0
    result.stdout = json.dumps(payload)
    result.stderr = ""
    return result


def test_fetch_review_feedback_filters_resolved():
    """Only unresolved threads are returned."""
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = _make_gh_result(GRAPHQL_RESPONSE)
        comments = fetch_review_feedback("owner/repo", 1, bot_login="worca-bot")

    thread_ids = {c["thread_id"] for c in comments}
    # PRRT_bbb is resolved → excluded
    assert "PRRT_bbb" not in thread_ids
    # PRRT_aaa is unresolved human → included
    assert "PRRT_aaa" in thread_ids


def test_fetch_review_feedback_excludes_bot():
    """Bot-authored threads are excluded even when unresolved."""
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = _make_gh_result(GRAPHQL_RESPONSE)
        comments = fetch_review_feedback("owner/repo", 1, bot_login="worca-bot")

    thread_ids = {c["thread_id"] for c in comments}
    # PRRT_ccc is unresolved but bot-authored → excluded
    assert "PRRT_ccc" not in thread_ids


def test_fetch_review_feedback_schema():
    """Returned items match the §2 schema."""
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = _make_gh_result(GRAPHQL_RESPONSE)
        comments = fetch_review_feedback("owner/repo", 1, bot_login="worca-bot")

    assert len(comments) == 1
    c = comments[0]
    assert c["thread_id"] == "PRRT_aaa"
    assert c["path"] == "src/foo.py"
    assert c["line"] == 42
    assert c["diff_hunk"] == "@@ -40,6 +40,8 @@"
    assert c["author"] == "alice"
    assert c["body"] == "this leaks a file handle"
    assert c["kind"] == "inline"
    assert c["created_at"] == "2026-06-03T12:00:00Z"


def test_fetch_review_feedback_drops_empty_body():
    """Threads with empty/whitespace bodies are excluded."""
    response = {
        "data": {
            "repository": {
                "pullRequest": {
                    "reviewThreads": {
                        "nodes": [
                            {
                                "id": "PRRT_empty",
                                "isResolved": False,
                                "isOutdated": False,
                                "comments": {
                                    "nodes": [
                                        {
                                            "author": {"login": "alice"},
                                            "path": "src/x.py",
                                            "line": 1,
                                            "originalLine": 1,
                                            "diffHunk": "@@ -1 @@",
                                            "body": "   ",
                                            "createdAt": "2026-06-03T12:00:00Z",
                                        }
                                    ]
                                },
                            }
                        ]
                    }
                }
            }
        }
    }
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = _make_gh_result(response)
        comments = fetch_review_feedback("owner/repo", 1, bot_login="worca-bot")

    assert comments == []


def test_fetch_review_feedback_gh_error_returns_empty(capsys):
    """When the gh CLI fails, returns [] with a stderr warning."""
    result = MagicMock()
    result.returncode = 1
    result.stdout = ""
    result.stderr = "authentication error"
    with patch("subprocess.run", return_value=result):
        comments = fetch_review_feedback("owner/repo", 1, bot_login="worca-bot")

    assert comments == []
    captured = capsys.readouterr()
    assert "Warning" in captured.err


# ---------------------------------------------------------------------------
# reply_to_thread()
# ---------------------------------------------------------------------------


def test_reply_to_thread_no_github_gated(monkeypatch):
    """WORCA_NO_GITHUB=1 → no subprocess call, returns False."""
    monkeypatch.setenv("WORCA_NO_GITHUB", "1")
    with patch("subprocess.run") as mock_run:
        result = reply_to_thread("owner/repo", "PRRT_aaa", "Fixed in commit abc")
    assert result is False
    mock_run.assert_not_called()


def test_reply_to_thread_success(monkeypatch):
    """Successful reply posts a GraphQL mutation and returns True."""
    monkeypatch.delenv("WORCA_NO_GITHUB", raising=False)
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = json.dumps({"data": {"addPullRequestReviewThreadReply": {"comment": {"id": "PRC_1"}}}})
    mock_result.stderr = ""
    with patch("subprocess.run", return_value=mock_result) as mock_run:
        result = reply_to_thread("owner/repo", "PRRT_aaa", "Fixed in commit abc")

    assert result is True
    mock_run.assert_called_once()
    call_args = mock_run.call_args
    cmd = call_args[0][0]
    assert cmd[0] == "gh"
    assert "graphql" in cmd


def test_reply_to_thread_gh_error_suppressed(monkeypatch, capsys):
    """gh CLI error → returns False with a stderr warning."""
    monkeypatch.delenv("WORCA_NO_GITHUB", raising=False)
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stdout = ""
    mock_result.stderr = "not found"
    with patch("subprocess.run", return_value=mock_result):
        result = reply_to_thread("owner/repo", "PRRT_aaa", "Fixed in commit abc")

    assert result is False
    captured = capsys.readouterr()
    assert "Warning" in captured.err


def test_reply_to_thread_exception_suppressed(monkeypatch, capsys):
    """Exception during subprocess → returns False with a stderr warning."""
    monkeypatch.delenv("WORCA_NO_GITHUB", raising=False)
    with patch("subprocess.run", side_effect=OSError("gh not found")):
        result = reply_to_thread("owner/repo", "PRRT_aaa", "Fixed")

    assert result is False
    captured = capsys.readouterr()
    assert "Warning" in captured.err


def test_reply_to_thread_passes_thread_id_and_body(monkeypatch):
    """Thread ID and body are included in the subprocess call input."""
    monkeypatch.delenv("WORCA_NO_GITHUB", raising=False)
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "{}"
    mock_result.stderr = ""
    with patch("subprocess.run", return_value=mock_result) as mock_run:
        reply_to_thread("owner/repo", "PRRT_xyz", "Addressed in sha123")

    call_kwargs = mock_run.call_args[1]
    stdin_input = call_kwargs.get("input", "")
    variables = json.loads(stdin_input)
    assert variables["threadId"] == "PRRT_xyz"
    assert variables["body"] == "Addressed in sha123"


# ---------------------------------------------------------------------------
# post_revision_summary()
# ---------------------------------------------------------------------------


def test_post_revision_summary_no_github_gated(monkeypatch):
    """WORCA_NO_GITHUB=1 → no subprocess call, returns False."""
    monkeypatch.setenv("WORCA_NO_GITHUB", "1")
    with patch("subprocess.run") as mock_run:
        result = post_revision_summary("owner/repo", 42, "Addressed 3 items, commit abc")
    assert result is False
    mock_run.assert_not_called()


def test_post_revision_summary_success(monkeypatch):
    """Successful summary post returns True."""
    monkeypatch.delenv("WORCA_NO_GITHUB", raising=False)
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = json.dumps({"id": 1})
    mock_result.stderr = ""
    with patch("subprocess.run", return_value=mock_result) as mock_run:
        result = post_revision_summary("owner/repo", 42, "Addressed 3 items, commit abc")

    assert result is True
    mock_run.assert_called_once()
    call_args = mock_run.call_args[0][0]
    assert "gh" in call_args
    assert "/repos/owner/repo/issues/42/comments" in " ".join(call_args)


def test_post_revision_summary_gh_error_suppressed(monkeypatch, capsys):
    """gh CLI error → returns False with a stderr warning."""
    monkeypatch.delenv("WORCA_NO_GITHUB", raising=False)
    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stdout = ""
    mock_result.stderr = "forbidden"
    with patch("subprocess.run", return_value=mock_result):
        result = post_revision_summary("owner/repo", 42, "Addressed 3 items")

    assert result is False
    captured = capsys.readouterr()
    assert "Warning" in captured.err


def test_post_revision_summary_exception_suppressed(monkeypatch, capsys):
    """Exception during subprocess → returns False with a stderr warning."""
    monkeypatch.delenv("WORCA_NO_GITHUB", raising=False)
    with patch("subprocess.run", side_effect=OSError("gh not found")):
        result = post_revision_summary("owner/repo", 42, "Addressed 3 items")

    assert result is False
    captured = capsys.readouterr()
    assert "Warning" in captured.err
