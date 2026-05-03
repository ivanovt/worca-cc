"""Tests for worca.utils.git - Git and worktree operations."""

from unittest.mock import patch, MagicMock

from worca.utils.git import (
    create_branch,
    create_worktree,
    remove_worktree,
    current_branch,
    diff_stat,
    get_current_git_head,
    detect_default_branch,
    branch_exists,
)


# --- create_branch ---

def test_create_branch_success():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.git.subprocess.run", return_value=mock_result) as mock_run:
        result = create_branch("feat/new-feature")
    assert result is True
    args = mock_run.call_args[0][0]
    assert args == ["git", "checkout", "-b", "feat/new-feature"]


def test_create_branch_failure():
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        result = create_branch("feat/existing")
    assert result is False


# --- create_worktree ---

def test_create_worktree_success():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.git.subprocess.run", return_value=mock_result) as mock_run:
        result = create_worktree("/tmp/wt", "feat/wt-branch")
    assert result is True
    args = mock_run.call_args[0][0]
    assert args == ["git", "worktree", "add", "/tmp/wt", "-b", "feat/wt-branch"]


def test_create_worktree_failure():
    mock_result = MagicMock()
    mock_result.returncode = 128
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        result = create_worktree("/tmp/wt", "feat/bad")
    assert result is False


# --- remove_worktree ---

def test_remove_worktree_success():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.git.subprocess.run", return_value=mock_result) as mock_run:
        result = remove_worktree("/tmp/wt")
    assert result is True
    args = mock_run.call_args[0][0]
    assert args == ["git", "worktree", "remove", "/tmp/wt"]


def test_remove_worktree_failure():
    mock_result = MagicMock()
    mock_result.returncode = 1
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        result = remove_worktree("/tmp/nonexistent")
    assert result is False


# --- current_branch ---

def test_current_branch_returns_name():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "feat/my-branch\n"
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        result = current_branch()
    assert result == "feat/my-branch"


def test_current_branch_strips_whitespace():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "  main  \n"
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        result = current_branch()
    assert result == "main"


# --- diff_stat ---

def test_diff_stat_default_base():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = " src/app.py | 10 +++++++---\n 1 file changed\n"
    with patch("worca.utils.git.subprocess.run", return_value=mock_result) as mock_run:
        result = diff_stat()
    assert "src/app.py" in result
    args = mock_run.call_args[0][0]
    assert "main..HEAD" in args


def test_diff_stat_custom_base():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = " README.md | 2 +-\n"
    with patch("worca.utils.git.subprocess.run", return_value=mock_result) as mock_run:
        result = diff_stat(base="develop")
    assert "README.md" in result
    args = mock_run.call_args[0][0]
    assert "develop..HEAD" in args


def test_diff_stat_empty():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = ""
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        result = diff_stat()
    assert result == ""


# --- get_current_git_head ---

def test_get_current_git_head_returns_sha():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "abc1234def5678901234567890123456789012345\n"
    with patch("worca.utils.git.subprocess.run", return_value=mock_result) as mock_run:
        result = get_current_git_head()
    assert result == "abc1234def5678901234567890123456789012345"
    args = mock_run.call_args[0][0]
    assert args == ["git", "rev-parse", "HEAD"]


def test_get_current_git_head_strips_whitespace():
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "  deadbeefcafe1234  \n"
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        result = get_current_git_head()
    assert result == "deadbeefcafe1234"


def test_get_current_git_head_returns_empty_on_failure():
    mock_result = MagicMock()
    mock_result.returncode = 128
    mock_result.stdout = ""
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        result = get_current_git_head()
    assert result == ""


# --- detect_default_branch ---


def _git_responses(*responses):
    """Build a side_effect list of CompletedProcess-like mocks.

    Each `response` is (returncode, stdout). subprocess.run is called once
    per git invocation; the helper returns successive results in order.
    """
    out = []
    for code, text in responses:
        m = MagicMock()
        m.returncode = code
        m.stdout = text
        out.append(m)
    return out


def test_detect_default_branch_uses_origin_head():
    """Reads the symbolic-ref origin/HEAD and strips the refs/remotes/origin/ prefix."""
    responses = _git_responses((0, "refs/remotes/origin/master\n"))
    with patch("worca.utils.git.subprocess.run", side_effect=responses) as mock_run:
        result = detect_default_branch()
    assert result == "master"
    # First (and only) call probes origin/HEAD
    first_call = mock_run.call_args_list[0][0][0]
    assert first_call == ["git", "symbolic-ref", "refs/remotes/origin/HEAD"]


def test_detect_default_branch_handles_main_repo():
    responses = _git_responses((0, "refs/remotes/origin/main\n"))
    with patch("worca.utils.git.subprocess.run", side_effect=responses):
        result = detect_default_branch()
    assert result == "main"


def test_detect_default_branch_falls_back_to_current_branch():
    """When origin/HEAD is not configured, fall back to the current local branch."""
    responses = _git_responses(
        (1, ""),                # origin/HEAD probe fails (no upstream configured)
        (0, "develop\n"),       # rev-parse --abbrev-ref HEAD succeeds
    )
    with patch("worca.utils.git.subprocess.run", side_effect=responses):
        result = detect_default_branch()
    assert result == "develop"


def test_detect_default_branch_final_fallback_is_HEAD():
    """When both origin/HEAD and current branch detection fail, return literal HEAD."""
    responses = _git_responses(
        (1, ""),
        (1, ""),
    )
    with patch("worca.utils.git.subprocess.run", side_effect=responses):
        result = detect_default_branch()
    assert result == "HEAD"


def test_detect_default_branch_ignores_unrecognized_origin_head_format():
    """If symbolic-ref returns an unexpected ref shape, fall back."""
    responses = _git_responses(
        (0, "refs/heads/main\n"),  # local ref, not refs/remotes/origin/*
        (0, "master\n"),
    )
    with patch("worca.utils.git.subprocess.run", side_effect=responses):
        result = detect_default_branch()
    assert result == "master"


# --- branch_exists ---


def test_branch_exists_true_for_existing_ref():
    mock_result = MagicMock()
    mock_result.returncode = 0
    with patch("worca.utils.git.subprocess.run", return_value=mock_result) as mock_run:
        result = branch_exists("master")
    assert result is True
    args = mock_run.call_args[0][0]
    # Use rev-parse --verify --quiet for a cheap existence check
    assert args[0:3] == ["git", "rev-parse", "--verify"]
    assert "master" in args


def test_branch_exists_false_for_missing_ref():
    mock_result = MagicMock()
    mock_result.returncode = 128
    with patch("worca.utils.git.subprocess.run", return_value=mock_result):
        assert branch_exists("nonexistent") is False


def test_branch_exists_false_for_empty_input():
    """Empty branch name should not invoke git at all."""
    with patch("worca.utils.git.subprocess.run") as mock_run:
        assert branch_exists("") is False
        assert branch_exists(None) is False
        mock_run.assert_not_called()
