"""PR URL parser — maps a PR/MR URL to {provider, host, repo_path}."""
from __future__ import annotations

import re
from urllib.parse import urlparse


def parse_pr_url(url: str | None) -> dict[str, str]:
    """Return ``{provider, host, repo_path}`` for *url*.

    Never raises. Defaults to ``provider="other"`` for unrecognised URLs.
    """
    empty = {"provider": "other", "host": "", "repo_path": ""}

    if not url:
        return empty

    try:
        parsed = urlparse(url)
    except Exception:
        return empty

    host = parsed.hostname or ""
    if not host:
        return empty

    path = parsed.path.rstrip("/")

    # --- Azure DevOps ---
    # https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{n}
    if host == "dev.azure.com":
        m = re.match(r"^/([^/]+)/([^/]+)/_git/([^/]+)/pullrequest/\d+", path)
        if m:
            repo_path = f"{m.group(1)}/{m.group(2)}/{m.group(3)}"
            return {"provider": "azure_devops", "host": host, "repo_path": repo_path}
        return {"provider": "azure_devops", "host": host, "repo_path": ""}

    # --- GitLab (cloud + self-hosted) ---
    # https://{host}/{group...}/{repo}/-/merge_requests/{n}
    if host == "gitlab.com" or "gitlab" in host:
        m = re.match(r"^/(.+)/-/merge_requests/\d+", path)
        if m:
            return {"provider": "gitlab", "host": host, "repo_path": m.group(1)}
        return {"provider": "other", "host": host, "repo_path": ""}

    # --- Bitbucket Cloud ---
    # https://bitbucket.org/{owner}/{repo}/pull-requests/{n}
    if host == "bitbucket.org":
        m = re.match(r"^/([^/]+)/([^/]+)/pull-requests/\d+", path)
        if m:
            return {"provider": "bitbucket", "host": host, "repo_path": f"{m.group(1)}/{m.group(2)}"}
        return {"provider": "other", "host": host, "repo_path": ""}

    # --- Bitbucket Server / Data Center ---
    # https://{host}/projects/{KEY}/repos/{repo}/pull-requests/{n}
    m = re.match(r"^/projects/([^/]+)/repos/([^/]+)/pull-requests/\d+", path)
    if m:
        return {"provider": "bitbucket", "host": host, "repo_path": f"{m.group(1)}/{m.group(2)}"}

    # --- Gitea (cloud + self-hosted) ---
    # https://{host}/{owner}/{repo}/pulls/{n}
    # Gitea cloud domains: gitea.io, try.gitea.io; self-hosted often has "gitea" in the host
    if host in ("gitea.io", "try.gitea.io") or "gitea" in host:
        m = re.match(r"^/([^/]+)/([^/]+)/pulls/\d+", path)
        if m:
            return {"provider": "gitea", "host": host, "repo_path": f"{m.group(1)}/{m.group(2)}"}
        return {"provider": "other", "host": host, "repo_path": ""}

    # --- GitHub Cloud + Enterprise ---
    # https://{host}/{owner}/{repo}/pull/{n}
    # Covers github.com and any Enterprise GitHub host (e.g. github.mycompany.com, git.internal.corp)
    m = re.match(r"^/([^/]+)/([^/]+)/pull/(\d+)", path)
    if m:
        return {
            "provider": "github",
            "host": host,
            "repo_path": f"{m.group(1)}/{m.group(2)}",
            "number": int(m.group(3)),
        }

    return {"provider": "other", "host": host, "repo_path": ""}
