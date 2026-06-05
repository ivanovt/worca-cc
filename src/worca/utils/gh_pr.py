"""GitHub PR helpers — review thread ingestion.

fetch_review_feedback() runs a GraphQL query for unresolved, human-authored
review threads and returns them normalized to the §2 schema.
"""

import json
import os
import subprocess
import sys
from typing import Optional

_REPLY_MUTATION = """
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId,
    body: $body
  }) {
    comment { id }
  }
}
"""


def _github_disabled() -> bool:
    return os.environ.get("WORCA_NO_GITHUB", "") == "1"


_GRAPHQL_QUERY = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 50) {
            nodes {
              author { login }
              path
              line
              originalLine
              diffHunk
              body
              createdAt
            }
          }
        }
      }
    }
  }
}
"""


def fetch_review_feedback(
    nwo: str,
    pr_number: int,
    *,
    bot_login: Optional[str] = None,
) -> list[dict]:
    """Fetch unresolved human-authored review threads for a PR.

    Args:
        nwo: "owner/repo" string.
        pr_number: PR number.
        bot_login: GitHub login to exclude (worca's bot account). If None,
            no bot filtering is applied beyond what the caller sets.

    Returns:
        List of comment dicts matching the §2 schema:
        {thread_id, path, line, diff_hunk, author, body, kind, created_at}
    """
    owner, repo = nwo.split("/", 1)
    variables = json.dumps({"owner": owner, "repo": repo, "number": pr_number})

    try:
        result = subprocess.run(
            ["gh", "api", "graphql", "-f", f"query={_GRAPHQL_QUERY}", "--input", "-"],
            input=variables,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception as e:
        print(f"Warning: fetch_review_feedback failed: {e}", file=sys.stderr)
        return []

    if result.returncode != 0:
        print(
            f"Warning: fetch_review_feedback gh error: {result.stderr}",
            file=sys.stderr,
        )
        return []

    try:
        data = json.loads(result.stdout)
        threads = (
            data["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        )
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        print(f"Warning: fetch_review_feedback parse error: {e}", file=sys.stderr)
        return []

    comments = []
    for thread in threads:
        if thread.get("isResolved"):
            continue

        for node in thread.get("comments", {}).get("nodes", []):
            author_login = (node.get("author") or {}).get("login", "")

            if bot_login and author_login == bot_login:
                continue

            body = node.get("body", "")
            if not body or not body.strip():
                continue

            line = node.get("line") or node.get("originalLine")
            comments.append(
                {
                    "thread_id": thread["id"],
                    "path": node.get("path", ""),
                    "line": line,
                    "diff_hunk": node.get("diffHunk", ""),
                    "author": author_login,
                    "body": body,
                    "kind": "inline",
                    "created_at": node.get("createdAt", ""),
                }
            )

    return comments


def reply_to_thread(nwo: str, thread_id: str, body: str) -> bool:
    """Post a reply to a PR review thread.

    Never auto-resolves the thread (D3). Error-suppressed and WORCA_NO_GITHUB-gated.

    Returns True on success, False otherwise.
    """
    if _github_disabled():
        return False
    variables = json.dumps({"threadId": thread_id, "body": body})
    try:
        result = subprocess.run(
            ["gh", "api", "graphql", "-f", f"query={_REPLY_MUTATION}", "--input", "-"],
            input=variables,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception as e:
        print(f"Warning: reply_to_thread failed: {e}", file=sys.stderr)
        return False
    if result.returncode != 0:
        print(f"Warning: reply_to_thread gh error: {result.stderr}", file=sys.stderr)
        return False
    return True


def post_revision_summary(nwo: str, pr_number: int, summary: str) -> bool:
    """Post a top-level comment on a PR with the revision summary.

    Error-suppressed and WORCA_NO_GITHUB-gated.

    Returns True on success, False otherwise.
    """
    if _github_disabled():
        return False
    try:
        result = subprocess.run(
            [
                "gh", "api", "--method", "POST",
                f"/repos/{nwo}/issues/{pr_number}/comments",
                "-f", f"body={summary}",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception as e:
        print(f"Warning: post_revision_summary failed: {e}", file=sys.stderr)
        return False
    if result.returncode != 0:
        print(f"Warning: post_revision_summary gh error: {result.stderr}", file=sys.stderr)
        return False
    return True
