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
      reviews(first: 50) {
        nodes {
          author { login }
          body
          state
          submittedAt
        }
      }
    }
  }
}
"""

# Review states whose summary body counts as actionable feedback. APPROVED and
# DISMISSED/PENDING reviews are skipped — only change requests and plain review
# comments carry feedback to address.
_FEEDBACK_REVIEW_STATES = {"CHANGES_REQUESTED", "COMMENTED"}


def current_repo_nwo(cwd: Optional[str] = None) -> str:
    """Return the current repository's "owner/repo", or "" on any error.

    Resolves via ``gh repo view`` so it follows GitHub's default-repo logic —
    the base repo of a PR, which is where a PR and its review threads live even
    for cross-repo (fork) PRs.  This is deliberately NOT derived from a PR's
    ``headRepository`` (the fork), which would be the wrong repo to query.
    """
    try:
        result = subprocess.run(
            ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
            capture_output=True,
            text=True,
            timeout=15,
            cwd=cwd,
        )
    except Exception as e:
        print(f"Warning: current_repo_nwo failed: {e}", file=sys.stderr)
        return ""
    if result.returncode != 0:
        print(f"Warning: current_repo_nwo gh error: {result.stderr}", file=sys.stderr)
        return ""
    return result.stdout.strip()


def resolve_bot_login() -> Optional[str]:
    """Resolve the login worca posts comments as (the authenticated gh token).

    Excluding this login from ingestion is the L1 self-comment-loop guard:
    worca's own summary/thread-reply comments must never be re-ingested as
    feedback to address.  Returns None on any error (no filtering applied).
    """
    try:
        result = subprocess.run(
            ["gh", "api", "user", "--jq", ".login"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception as e:
        print(f"Warning: resolve_bot_login failed: {e}", file=sys.stderr)
        return None
    if result.returncode != 0:
        print(f"Warning: resolve_bot_login gh error: {result.stderr}", file=sys.stderr)
        return None
    login = result.stdout.strip()
    return login or None


def fetch_review_feedback(
    nwo: str,
    pr_number: int,
    *,
    bot_login: Optional[str] = None,
) -> list[dict]:
    """Fetch unresolved human-authored review feedback for a PR.

    Ingests two sources: unresolved inline review-thread comments and
    change-requesting / commenting review summary bodies.

    Args:
        nwo: "owner/repo" string — must be the *base* repo (where the PR lives),
            not a fork's head repo. Use current_repo_nwo() to resolve it.
        pr_number: PR number.
        bot_login: GitHub login to exclude (worca's bot account, L1). If None,
            no bot filtering is applied.

    Returns:
        List of comment dicts matching the §2 schema:
        {thread_id, path, line, diff_hunk, author, body, kind, created_at}.
        ``kind`` is "inline" for thread comments and "review_summary" for
        review bodies (which have no thread_id / file anchor).
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
        pull_request = data["data"]["repository"]["pullRequest"]
        threads = pull_request["reviewThreads"]["nodes"]
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

    # PR-level feedback: review summary bodies (the message left when a reviewer
    # submits "Request changes" / "Comment"). These carry no file anchor or
    # thread_id, so they appear as PR-level items and are never thread-replied.
    for review in (pull_request.get("reviews") or {}).get("nodes", []):
        if review.get("state") not in _FEEDBACK_REVIEW_STATES:
            continue
        author_login = (review.get("author") or {}).get("login", "")
        if bot_login and author_login == bot_login:
            continue
        body = review.get("body", "")
        if not body or not body.strip():
            continue
        comments.append(
            {
                "thread_id": "",
                "path": "",
                "line": None,
                "diff_hunk": "",
                "author": author_login,
                "body": body,
                "kind": "review_summary",
                "created_at": review.get("submittedAt", ""),
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
