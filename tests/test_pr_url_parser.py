"""Table-driven tests for src/worca/utils/pr_url.py — parse_pr_url()."""
import pytest

from worca.utils.pr_url import parse_pr_url


# ---------------------------------------------------------------------------
# Table entries: (url, expected_provider, expected_host, expected_repo_path)
# ---------------------------------------------------------------------------
CASES = [
    # --- GitHub cloud ---
    (
        "https://github.com/owner/repo/pull/42",
        "github",
        "github.com",
        "owner/repo",
    ),
    (
        "https://github.com/my-org/my-repo/pull/1",
        "github",
        "github.com",
        "my-org/my-repo",
    ),
    # --- GitHub Enterprise (self-hosted) ---
    (
        "https://github.mycompany.com/owner/repo/pull/7",
        "github",
        "github.mycompany.com",
        "owner/repo",
    ),
    (
        "https://git.internal.corp/owner/repo/pull/99",
        "github",
        "git.internal.corp",
        "owner/repo",
    ),
    # --- GitLab cloud ---
    (
        "https://gitlab.com/group/project/-/merge_requests/5",
        "gitlab",
        "gitlab.com",
        "group/project",
    ),
    (
        "https://gitlab.com/top-group/sub-group/project/-/merge_requests/12",
        "gitlab",
        "gitlab.com",
        "top-group/sub-group/project",
    ),
    # --- GitLab self-hosted ---
    (
        "https://gitlab.mycompany.com/group/repo/-/merge_requests/3",
        "gitlab",
        "gitlab.mycompany.com",
        "group/repo",
    ),
    # --- Bitbucket Cloud ---
    (
        "https://bitbucket.org/owner/repo/pull-requests/10",
        "bitbucket",
        "bitbucket.org",
        "owner/repo",
    ),
    # --- Bitbucket Server / Data Center ---
    (
        "https://bitbucket.mycompany.com/projects/PROJ/repos/myrepo/pull-requests/4",
        "bitbucket",
        "bitbucket.mycompany.com",
        "PROJ/myrepo",
    ),
    (
        "https://stash.myorg.net/projects/KEY/repos/service/pull-requests/8",
        "bitbucket",
        "stash.myorg.net",
        "KEY/service",
    ),
    # --- Azure DevOps ---
    (
        "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/15",
        "azure_devops",
        "dev.azure.com",
        "myorg/myproject/myrepo",
    ),
    (
        "https://dev.azure.com/contoso/WebApp/_git/Frontend/pullrequest/200",
        "azure_devops",
        "dev.azure.com",
        "contoso/WebApp/Frontend",
    ),
    # --- Gitea ---
    (
        "https://gitea.io/owner/repo/pulls/6",
        "gitea",
        "gitea.io",
        "owner/repo",
    ),
    (
        "https://try.gitea.io/owner/repo/pulls/6",
        "gitea",
        "try.gitea.io",
        "owner/repo",
    ),
    (
        "https://gitea.mycompany.com/team/project/pulls/22",
        "gitea",
        "gitea.mycompany.com",
        "team/project",
    ),
    # --- "other" fallback ---
    (
        "https://unknown.host.com/owner/repo/pr/5",
        "other",
        "unknown.host.com",
        "",
    ),
    (
        "https://phabricator.example.com/D42",
        "other",
        "phabricator.example.com",
        "",
    ),
]


@pytest.mark.parametrize("url,provider,host,repo_path", CASES)
def test_parse_pr_url(url, provider, host, repo_path):
    result = parse_pr_url(url)
    assert result["provider"] == provider, f"provider mismatch for {url}"
    assert result["host"] == host, f"host mismatch for {url}"
    assert result["repo_path"] == repo_path, f"repo_path mismatch for {url}"


# ---------------------------------------------------------------------------
# Edge-case tests (individual, not parametrized)
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_url_with_query_string(self):
        url = "https://github.com/owner/repo/pull/42?token=secret&ref=main"
        result = parse_pr_url(url)
        assert result["provider"] == "github"
        assert result["host"] == "github.com"
        assert result["repo_path"] == "owner/repo"

    def test_url_with_fragment(self):
        url = "https://github.com/owner/repo/pull/42#issuecomment-123"
        result = parse_pr_url(url)
        assert result["provider"] == "github"
        assert result["repo_path"] == "owner/repo"

    def test_url_with_trailing_slash(self):
        url = "https://github.com/owner/repo/pull/42/"
        result = parse_pr_url(url)
        assert result["provider"] == "github"
        assert result["repo_path"] == "owner/repo"

    def test_empty_string_returns_other(self):
        result = parse_pr_url("")
        assert result["provider"] == "other"
        assert result["host"] == ""
        assert result["repo_path"] == ""

    def test_none_returns_other(self):
        result = parse_pr_url(None)
        assert result["provider"] == "other"
        assert result["host"] == ""
        assert result["repo_path"] == ""

    def test_non_url_string_returns_other(self):
        result = parse_pr_url("not-a-url-at-all")
        assert result["provider"] == "other"
        assert result["host"] == ""
        assert result["repo_path"] == ""

    def test_http_not_https_github(self):
        url = "http://github.com/owner/repo/pull/42"
        result = parse_pr_url(url)
        assert result["provider"] == "github"
        assert result["host"] == "github.com"

    def test_typo_in_path_returns_other_for_unknown_host(self):
        # Valid-looking URL but host is completely unknown and path doesn't match any pattern
        url = "https://notgit.randomservice.example/owner/repo/merge/42"
        result = parse_pr_url(url)
        assert result["provider"] == "other"

    def test_gitlab_missing_merge_requests_segment_returns_other(self):
        # gitlab.com host but path doesn't match /-/merge_requests/
        url = "https://gitlab.com/group/repo/issues/5"
        result = parse_pr_url(url)
        assert result["provider"] == "other"

    def test_returns_dict_with_all_keys(self):
        result = parse_pr_url("https://github.com/a/b/pull/1")
        assert set(result.keys()) == {"provider", "host", "repo_path", "number"}

    def test_pr_url_resolves_to_number(self):
        result = parse_pr_url("https://github.com/owner/repo/pull/42")
        assert result["number"] == 42

    def test_azure_devops_repo_path_includes_org_project_repo(self):
        url = "https://dev.azure.com/org/proj/_git/repo/pullrequest/1"
        result = parse_pr_url(url)
        assert result["repo_path"] == "org/proj/repo"

    def test_bitbucket_server_repo_path_is_project_key_slash_repo(self):
        url = "https://bitbucket.internal.net/projects/AB/repos/my-service/pull-requests/7"
        result = parse_pr_url(url)
        assert result["provider"] == "bitbucket"
        assert result["repo_path"] == "AB/my-service"
