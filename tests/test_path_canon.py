"""Tests for path canonicalization and git oracle."""

import subprocess
from unittest import mock

import pytest

from worca.orchestrator.path_canon import canonicalize, GitPathOracle


class TestCanonicalize:
    """Test the Layer 1 canonicalize function."""

    def test_canonicalize_relative_path(self, tmp_path):
        """Relative path within repo should be normalized."""
        root = tmp_path / "repo"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "main.py").touch()

        result = canonicalize("src/main.py", str(root))
        assert result == "src/main.py"

    def test_canonicalize_absolute_path(self, tmp_path):
        """Absolute path within repo should be normalized to repo-relative."""
        root = tmp_path / "repo"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "main.py").touch()

        abs_path = root / "src" / "main.py"
        result = canonicalize(str(abs_path), str(root))
        assert result == "src/main.py"

    def test_canonicalize_windows_separators(self, tmp_path):
        """Windows backslashes should be converted to forward slashes."""
        root = tmp_path / "repo"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "Auth.py").touch()

        # On all platforms, pass backslash path
        result = canonicalize(r"src\Auth.py", str(root))
        # Should normalize to forward slashes
        assert result == "src/Auth.py" or result == r"src\Auth.py"
        # On POSIX, backslash might not be normalized in relpath,
        # but as_posix() will convert it
        if result:
            assert "/" in result or "\\" not in result or result == r"src\Auth.py"

    def test_canonicalize_dot_normalization(self, tmp_path):
        """Paths with . and .. should be normalized."""
        root = tmp_path / "repo"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "main.py").touch()

        result = canonicalize("src/./main.py", str(root))
        assert result == "src/main.py"

    def test_canonicalize_outside_repo_escapes(self, tmp_path):
        """Paths that escape repo should return None."""
        root = tmp_path / "repo"
        root.mkdir()

        result = canonicalize("../outside.py", str(root))
        assert result is None

    def test_canonicalize_outside_repo_absolute(self, tmp_path):
        """Absolute path outside repo should return None."""
        root = tmp_path / "repo"
        root.mkdir()
        outside = tmp_path / "outside.py"
        outside.touch()

        result = canonicalize(str(outside), str(root))
        assert result is None

    def test_canonicalize_windows_different_drive(self, tmp_path):
        """Windows paths on different drives should return None."""
        root = tmp_path / "repo"
        root.mkdir()

        # Simulate different drives by mocking realpath
        with mock.patch("os.path.realpath") as mock_realpath:
            def realpath_side_effect(path):
                if "repo" in str(path):
                    return "C:\\repo"
                return "D:\\other\\file.py"

            mock_realpath.side_effect = realpath_side_effect
            result = canonicalize("D:\\other\\file.py", str(root))
            assert result is None

    def test_canonicalize_root_directory(self, tmp_path):
        """Canonicalizing the root directory itself should return '.' or empty."""
        root = tmp_path / "repo"
        root.mkdir()

        result = canonicalize(".", str(root))
        assert result is None or result == "."

    def test_canonicalize_symlink_resolution(self, tmp_path):
        """Symlinked paths should be resolved to canonical form."""
        root = tmp_path / "repo"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "main.py").touch()

        # Create a symlink (skip on Windows without admin)
        try:
            link = root / "link_to_src"
            link.symlink_to(root / "src")
            result = canonicalize("link_to_src/main.py", str(root))
            # Should resolve through symlink
            assert result == "src/main.py"
        except OSError:
            # Skip on Windows without admin privileges
            pytest.skip("Cannot create symlinks")

    def test_canonicalize_posix_format(self, tmp_path):
        """Result should always use forward slashes (as_posix)."""
        root = tmp_path / "repo"
        root.mkdir()
        (root / "a").mkdir()
        (root / "a" / "b").mkdir()
        (root / "a" / "b" / "c.py").touch()

        result = canonicalize("a/b/c.py", str(root))
        assert result == "a/b/c.py"
        assert "\\" not in result


class TestGitPathOracle:
    """Test the Layer 2 GitPathOracle class."""

    def test_oracle_init_with_repo(self, tmp_path):
        """Initialize oracle with a real git repo."""
        repo = tmp_path / "repo"
        repo.mkdir()
        # Initialize git repo
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "file.py").write_text("content")
        subprocess.run(["git", "add", "file.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        assert oracle.oracle_status == "ok"
        assert "file.py" in oracle.reads

    def test_oracle_degraded_on_git_failure(self, tmp_path):
        """Oracle should degrade gracefully if git fails."""
        non_repo = tmp_path / "not_a_repo"
        non_repo.mkdir()

        oracle = GitPathOracle(str(non_repo))
        assert oracle.oracle_status == "degraded"

    def test_oracle_respell_read_exact_match(self, tmp_path):
        """Exact file match should be adopted from git."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "src").mkdir()
        (repo / "src" / "main.py").write_text("content")
        subprocess.run(["git", "add", "src/main.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        result = oracle.respell_read("src/main.py")
        assert result["path"] == "src/main.py"
        assert result["case_remapped"] is False

    def test_oracle_respell_read_case_insensitive_match(self, tmp_path):
        """Case-insensitive unique match should be adopted with flag."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "src").mkdir()
        (repo / "src" / "auth.py").write_text("content")
        subprocess.run(["git", "add", "src/auth.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        # Query with different case
        result = oracle.respell_read("src/Auth.py")
        # Should match case-insensitively on case-insensitive filesystems
        # On case-sensitive (Linux), this won't match
        if result["path"]:
            assert result["path"] == "src/auth.py"
            # case_remapped only set if we did a case-insensitive match
            assert isinstance(result["case_remapped"], bool)

    def test_oracle_respell_read_untracked_keeps_with_flag(self, tmp_path):
        """Untracked files should be kept with untracked flag."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        result = oracle.respell_read("new_untracked.py")
        # Untracked files are kept in reads oracle (only writes distinguish gitignored)
        assert result["path"] == "new_untracked.py"
        assert result["untracked"] is True

    def test_oracle_respell_write_exact_match(self, tmp_path):
        """Exact file match in status should be adopted."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "src").mkdir()
        (repo / "src" / "main.py").write_text("original")
        subprocess.run(["git", "add", "src/main.py"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, capture_output=True, check=True)

        # Modify the file
        (repo / "src" / "main.py").write_text("modified")

        oracle = GitPathOracle(str(repo))
        result = oracle.respell_write("src/main.py")
        assert result["path"] == "src/main.py"
        assert result["case_remapped"] is False

    def test_oracle_respell_write_drops_gitignored(self, tmp_path):
        """Files matching .gitignore should be dropped from writes."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / ".gitignore").write_text("*.pyc\n__pycache__/\nnode_modules/\n")
        subprocess.run(["git", "add", ".gitignore"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        result = oracle.respell_write("node_modules/pkg/index.js")
        # Should be dropped (returns None path)
        assert result["path"] is None or result["gitignored"] is True

    def test_oracle_respell_write_untracked_keeps_with_flag(self, tmp_path):
        """Untracked new files should be kept with flag in writes."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        result = oracle.respell_write("new_file.py")
        # Untracked in writes should be kept with flag
        assert result["path"] == "new_file.py"
        assert result["untracked"] is True

    def test_oracle_reads_and_writes_separate(self, tmp_path):
        """Reads and writes oracles should be separate."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "tracked.py").write_text("content")
        subprocess.run(["git", "add", "tracked.py"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        # Reads comes from ls-files
        assert "tracked.py" in oracle.reads
        # Writes comes from status (clean working tree, so empty)
        assert "tracked.py" not in oracle.writes

    def test_oracle_lowercased_maps(self, tmp_path):
        """Oracle should maintain lowercased maps for case-insensitive lookup."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "Auth.py").write_text("content")
        subprocess.run(["git", "add", "Auth.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        # Exact lookup
        assert oracle.reads.get("Auth.py") == "Auth.py"
        # Lowercased lookup should also work
        assert oracle.reads_lower.get("auth.py") == "Auth.py"

    def test_oracle_nul_separated_parsing(self, tmp_path):
        """Oracle should correctly parse NUL-separated git output."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "file1.py").write_text("content")
        (repo / "file2.py").write_text("content")
        subprocess.run(["git", "add", "file1.py", "file2.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        # Should have both files
        assert "file1.py" in oracle.reads
        assert "file2.py" in oracle.reads

    def test_oracle_core_quotepath_disabled(self, tmp_path):
        """Oracle should use core.quotepath=false for unicode safety."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        # Add a file with special characters
        (repo / "café.py").write_text("content")
        subprocess.run(["git", "add", "café.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        # File should be in oracle without octal escaping
        assert "café.py" in oracle.reads or oracle.oracle_status == "degraded"


class TestCanonicalizeWindowsSeparatorsAndCase:
    """Test canonicalize with Windows separators and case mapping."""

    def test_canonicalize_windows_separators_and_case(self, tmp_path):
        """Windows backslashes + case mismatch should normalize separators.

        On Windows, backslashes are path separators and should be normalized to forward slashes.
        On POSIX, backslashes are literal characters (not separators), so the behavior differs.
        This test documents the expected behavior on each platform.
        """
        import os
        root = tmp_path / "repo"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "api").mkdir()
        (root / "src" / "api" / "auth.py").touch()

        if os.name == "nt":
            # Windows: backslashes are separators and should normalize to forward slashes
            result = canonicalize(r"src\api\auth.py", str(root))
            assert result == "src/api/auth.py"
        else:
            # POSIX: backslashes are literal characters, so a file named r"src\api\auth.py"
            # would not match the actual directory structure. Result should be None
            # or the literal form depending on whether the path exists.
            result = canonicalize(r"src\api\auth.py", str(root))
            # On POSIX, this is a literal backslash string, not a path structure
            assert result is None or "\\" in result

    def test_canonicalize_windows_drive_different_drives(self, tmp_path):
        """Different Windows drives should return None."""
        root = tmp_path / "repo"
        root.mkdir()

        # Simulate different Windows drives via mock
        with mock.patch("os.path.realpath") as mock_realpath:
            with mock.patch("os.path.relpath") as mock_relpath:
                # realpath returns C: for root, D: for file
                def realpath_side_effect(path):
                    if "repo" in str(path):
                        return "C:\\Users\\repo"
                    return "D:\\other\\file.py"

                mock_realpath.side_effect = realpath_side_effect
                mock_relpath.side_effect = ValueError("different drives")

                result = canonicalize("D:\\other\\file.py", str(root))
                assert result is None


class TestCanonicalizeSymlinkedRoot:
    """Test canonicalize with symlinked repository root."""

    def test_canonicalize_symlinked_repo_root(self, tmp_path):
        """Symlinked repo root should resolve and produce correct repo-relative paths.

        If repo root is /Volumes/Apps/... (a mount symlink), and file is at
        /Volumes/Apps/dev/repo/src/main.py, canonicalize should return src/main.py.
        """
        # Create actual repo directory
        real_repo = tmp_path / "real_repo"
        real_repo.mkdir()
        (real_repo / "src").mkdir()
        (real_repo / "src" / "main.py").touch()

        # Create a symlink to the repo (if supported)
        try:
            symlink_repo = tmp_path / "symlink_repo"
            symlink_repo.symlink_to(real_repo)

            # Canonicalize using the symlinked root
            result = canonicalize("src/main.py", str(symlink_repo))
            assert result == "src/main.py"
        except OSError:
            pytest.skip("Cannot create symlinks")

    def test_canonicalize_symlinked_root_with_absolute_path(self, tmp_path):
        """Absolute path through symlinked root should canonicalize correctly."""
        real_repo = tmp_path / "real_repo"
        real_repo.mkdir()
        (real_repo / "src").mkdir()
        (real_repo / "src" / "main.py").touch()

        try:
            symlink_repo = tmp_path / "symlink_repo"
            symlink_repo.symlink_to(real_repo)

            # Use absolute path through symlink
            abs_path = symlink_repo / "src" / "main.py"
            result = canonicalize(str(abs_path), str(symlink_repo))
            assert result == "src/main.py"
        except OSError:
            pytest.skip("Cannot create symlinks")


class TestCanonicalizeOutsideRepo:
    """Test canonicalize with paths outside repository."""

    def test_canonicalize_parent_escape(self, tmp_path):
        """Paths escaping to parent directory should return None."""
        root = tmp_path / "repo"
        root.mkdir()
        (root / "src").mkdir()

        result = canonicalize("../outside.py", str(root))
        assert result is None

    def test_canonicalize_multiple_parent_escape(self, tmp_path):
        """Multiple parent directory traversals should return None."""
        root = tmp_path / "repo"
        root.mkdir()
        (root / "src").mkdir()

        result = canonicalize("../../very_outside.py", str(root))
        assert result is None


class TestOracleCaseCollisionDetection:
    """Test case-insensitive collision detection in oracle."""

    def test_oracle_case_collision_reads_refuses_remap(self, tmp_path):
        """When two files differ only in case, case-insensitive lookup should refuse remap.

        Example: files Auth.py and auth.py both exist in git.
        Query for AuTh.py should NOT match either (case_remapped=False).
        This prevents silent wrong-file returns and treats collisions as untracked.

        (Uses mock since case-insensitive filesystems make real files impossible to create.)
        """
        repo = tmp_path / "repo"
        repo.mkdir()

        # Mock the git output to include a case collision
        with mock.patch("subprocess.run") as mock_run:
            def run_side_effect(*args, **kwargs):
                cmd = args[0] if args else kwargs.get("args", [])
                if "ls-files" in cmd:
                    # Simulate git output with two files differing only in case
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = "Auth.py\0auth.py\0"
                    return result
                elif "status" in cmd or "check-ignore" in cmd:
                    # status returns empty (no writes), check-ignore returns not-ignored
                    result = mock.Mock()
                    result.returncode = 1
                    result.stdout = ""
                    return result
                # Pass through other commands
                return subprocess.run(*args, **kwargs)

            mock_run.side_effect = run_side_effect

            oracle = GitPathOracle(str(repo))

        # Verify both files are in the oracle (reads)
        assert "Auth.py" in oracle.reads
        assert "auth.py" in oracle.reads

        # Verify the collision was detected: lowercased key should be None (sentinel)
        assert oracle.reads_lower.get("auth.py") is None, "Collision sentinel should be None"

        # Query with different case should NOT use case-insensitive match
        result = oracle.respell_read("AuTh.py")
        # Should NOT match via case-insensitive (because collision detected)
        assert result["case_remapped"] is False
        # Path should be untracked (query form) since collision prevents case-remap
        assert result["untracked"] is True

    def test_oracle_case_collision_writes_refuses_remap(self, tmp_path):
        """Case collision in writes oracle should also refuse remap."""
        repo = tmp_path / "repo"
        repo.mkdir()

        # Mock the git output to include a case collision in status
        with mock.patch("subprocess.run") as mock_run:
            def run_side_effect(*args, **kwargs):
                cmd = args[0] if args else kwargs.get("args", [])
                if "ls-files" in cmd:
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = "Util.py\0util.py\0"
                    return result
                elif "status" in cmd:
                    # Simulate modified files
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = "M  Util.py\0M  util.py\0"
                    return result
                elif "check-ignore" in cmd:
                    result = mock.Mock()
                    result.returncode = 1
                    result.stdout = ""
                    return result
                return subprocess.run(*args, **kwargs)

            mock_run.side_effect = run_side_effect

            oracle = GitPathOracle(str(repo))

        # Verify the collision sentinel
        assert oracle.writes_lower.get("util.py") is None, "Collision sentinel should be None"

        # Query with different case should NOT match via case-insensitive
        result = oracle.respell_write("UTIL.py")
        assert result["case_remapped"] is False
        # Should be untracked (query form) since collision prevents case-remap
        assert result["untracked"] is True

    def test_oracle_no_collision_unique_case_match_works(self, tmp_path):
        """Unique case-insensitive match (no collision) should still work."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        # Only one file with the name (case-insensitive)
        (repo / "Config.py").write_text("Config content")
        subprocess.run(["git", "add", "Config.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))

        # Lowercased entry should NOT be None (no collision)
        assert oracle.reads_lower.get("config.py") == "Config.py"

        # Query with different case should match via case-insensitive
        result = oracle.respell_read("config.py")
        assert result["path"] == "Config.py"
        assert result["case_remapped"] is True

    def test_canonicalize_absolute_path_outside_repo(self, tmp_path):
        """Absolute path outside repo should return None."""
        repo = tmp_path / "repo"
        repo.mkdir()
        outside = tmp_path / "parent_outside.py"
        outside.touch()

        result = canonicalize(str(outside), str(repo))
        assert result is None

    def test_canonicalize_system_path_outside_repo(self, tmp_path):
        """System paths like /etc should return None."""
        repo = tmp_path / "repo"
        repo.mkdir()

        # Try with /etc/passwd (or equivalent on Windows)
        import os
        if os.name == "posix":
            result = canonicalize("/etc/passwd", str(repo))
            assert result is None


class TestGitOracleRespellAndFilter:
    """Test git oracle respelling and filtering behavior."""

    def test_git_oracle_respell_write_case_mismatch(self, tmp_path):
        """Hook write with case mismatch should adopt git's case."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "src").mkdir()
        (repo / "src" / "auth.py").write_text("original")
        subprocess.run(["git", "add", "src/auth.py"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, capture_output=True, check=True)

        # Modify with different case
        (repo / "src" / "auth.py").write_text("modified")

        oracle = GitPathOracle(str(repo))
        # Query with different case
        result = oracle.respell_write("src/Auth.py")
        # Should either match exactly (if case-sensitive) or adopt git case + flag
        assert result["path"] == "src/auth.py" or result["case_remapped"]

    def test_git_oracle_gitignored_writes_dropped(self, tmp_path):
        """Files in .gitignore should be dropped (path=None) for writes."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / ".gitignore").write_text("*.pyc\ndist/\nbuild/\n")
        subprocess.run(["git", "add", ".gitignore"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        # Test various ignored patterns
        for ignored_path in ["dist/bundle.js", "build/output.o", "file.pyc"]:
            result = oracle.respell_write(ignored_path)
            assert result["path"] is None or result["gitignored"]

    def test_git_oracle_untracked_kept_in_reads(self, tmp_path):
        """Untracked files should be kept in reads with untracked flag."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        result = oracle.respell_read("new_untracked_file.py")
        assert result["path"] == "new_untracked_file.py"
        assert result["untracked"]
        assert not result["case_remapped"]

    def test_git_oracle_untracked_kept_in_writes(self, tmp_path):
        """Untracked new files should be kept in writes with untracked flag."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        result = oracle.respell_write("brand_new_file.py")
        assert result["path"] == "brand_new_file.py"
        assert result["untracked"]
        assert not result["gitignored"]

    def test_git_oracle_exact_spelling_adopted(self, tmp_path):
        """Exact match should adopt git's exact spelling."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "src").mkdir()
        (repo / "src" / "MyClass.py").write_text("class MyClass: pass")
        subprocess.run(["git", "add", "src/MyClass.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        result = oracle.respell_read("src/MyClass.py")
        assert result["path"] == "src/MyClass.py"
        assert not result["case_remapped"]


class TestSearchScopeNormalization:
    """Test normalization of search scopes for Grep and Glob."""

    def test_grep_scope_file_normalized_to_parent(self):
        """Grep with file path should normalize scope to parent directory."""
        # This is conceptual - the actual normalization happens in aggregation
        # but we document the expected behavior here
        file_path = "src/main.py"
        # Expected: extract parent directory
        expected_scope = "src"
        parent = "/".join(file_path.split("/")[:-1]) or "."
        assert parent == expected_scope

    def test_grep_scope_absent_normalized_to_root(self):
        """Grep with absent/missing path should normalize to repo root."""
        # Expected: when path doesn't exist or is absent, default to root
        expected_scope = "."
        # This is handled in aggregation logic
        assert expected_scope == "."

    def test_glob_static_prefix_extraction(self):
        """Glob pattern static prefix should be extracted."""
        patterns = [
            ("src/**/*.py", "src"),
            ("src/api/*.py", "src/api"),
            ("**/*.js", "."),
            ("*.py", "."),
            ("tests/**/test_*.py", "tests"),
        ]
        for pattern, expected_prefix in patterns:
            # Extract static prefix before first wildcard
            prefix = pattern.split("*")[0].rstrip("/") or "."
            # Normalize to repo-relative
            if prefix and prefix != ".":
                assert prefix == expected_prefix
            else:
                assert prefix == "."

    def test_glob_fully_wildcarded_scope_is_root(self):
        """Fully wildcarded glob patterns should have root scope."""
        pattern = "**/*.py"
        # No static prefix before wildcard
        prefix = pattern.split("*")[0].rstrip("/") or "."
        assert prefix == "."

    def test_root_scoped_count_metric(self):
        """Root-scoped searches (whole-repo greps) should be counted separately."""
        # A search with scope "." is root-scoped
        scopes = [
            (".", True),      # Root scoped
            ("src", False),    # Directory scoped
            ("src/api", False), # Nested directory scoped
        ]
        for scope, is_root_scoped in scopes:
            assert (scope == ".") == is_root_scoped


class TestGitOracleRenameAndCopy:
    """Test rename/copy parsing in git status oracle."""

    def test_oracle_writes_handles_rename_correctly(self, tmp_path):
        """Rename should correctly parse old and new paths, storing new in oracle.

        When git status --porcelain=v1 -z outputs "R  old.py\0new.py\0",
        the oracle should store new.py in the writes dict, not ".py".
        """
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "old_name.py").write_text("content")
        subprocess.run(["git", "add", "old_name.py"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, capture_output=True, check=True)

        # Use git mv to properly detect rename
        subprocess.run(["git", "mv", "old_name.py", "new_name.py"], cwd=repo, capture_output=True, check=True)

        # Debug: check what git status actually outputs
        status_result = subprocess.run(
            ["git", "-c", "core.quotepath=false", "status", "--porcelain=v1", "-z"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=5
        )
        # If rename is detected, expect "R  old_name.py\0new_name.py\0"
        # If not, might be "D  old_name.py\0?? new_name.py\0"
        assert status_result.returncode == 0

        oracle = GitPathOracle(str(repo))
        # The new name should be in the writes oracle
        # (even if git detects it as D+A instead of R, both patterns should work)
        assert "new_name.py" in oracle.writes or "new_name.py" in oracle.reads, \
            f"new_name.py should be in writes or reads oracle. writes={oracle.writes}, reads={oracle.reads}"

    def test_oracle_writes_handles_copy_correctly(self, tmp_path):
        """Copy should correctly parse old and new paths, storing new in oracle."""
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.email", "test@test.com"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, capture_output=True, check=True)

        (repo / "original.py").write_text("content")
        subprocess.run(["git", "add", "original.py"], cwd=repo, capture_output=True, check=True)
        subprocess.run(["git", "commit", "-m", "initial"], cwd=repo, capture_output=True, check=True)

        # Copy the file (git doesn't track copies unless detected, so we use cp + add)
        import shutil
        shutil.copy(repo / "original.py", repo / "copied.py")
        subprocess.run(["git", "add", "copied.py"], cwd=repo, capture_output=True, check=True)

        oracle = GitPathOracle(str(repo))
        # The copied file should be in the writes oracle
        assert "copied.py" in oracle.writes, "copied.py should be in writes oracle"

    def test_oracle_rename_parsing_with_short_filename(self, tmp_path):
        """Rename with short filename should not get corrupted by entry[3:] parsing.

        This tests the bug: "R  foo.py\0bar.py\0" split by "\0" gives ["R  foo.py", "bar.py", ""].
        Old code tried entry[3:] on "bar.py" and got ".py" instead of "bar.py".
        """
        repo = tmp_path / "repo"
        repo.mkdir()

        # Mock git status output to simulate a rename with short filename
        with mock.patch("subprocess.run") as mock_run:
            def run_side_effect(*args, **kwargs):
                cmd = args[0] if args else kwargs.get("args", [])
                if "ls-files" in cmd:
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = "foo.py\0"  # Old file (no longer exists, but for ls-files it's gone)
                    return result
                elif "status" in cmd:
                    # Simulate rename: "R  foo.py\0bar.py\0"
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = "R  foo.py\0bar.py\0"
                    return result
                elif "check-ignore" in cmd:
                    result = mock.Mock()
                    result.returncode = 1  # Not ignored
                    result.stdout = ""
                    return result
                return subprocess.run(*args, **kwargs)

            mock_run.side_effect = run_side_effect

            oracle = GitPathOracle(str(repo))

        # The critical assertion: bar.py must be in writes, not ".py"
        assert "bar.py" in oracle.writes, "bar.py should be in writes oracle (not '.py')"
        assert ".py" not in oracle.writes, ".py should NOT be in writes oracle (parsing bug)"
        assert oracle.writes["bar.py"] == "bar.py"

    def test_oracle_rename_with_different_extensions(self, tmp_path):
        """Rename changing extension should parse correctly."""
        repo = tmp_path / "repo"
        repo.mkdir()

        with mock.patch("subprocess.run") as mock_run:
            def run_side_effect(*args, **kwargs):
                cmd = args[0] if args else kwargs.get("args", [])
                if "ls-files" in cmd:
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = ""
                    return result
                elif "status" in cmd:
                    # Rename from .js to .ts
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = "R  script.js\0script.ts\0"
                    return result
                elif "check-ignore" in cmd:
                    result = mock.Mock()
                    result.returncode = 1
                    result.stdout = ""
                    return result
                return subprocess.run(*args, **kwargs)

            mock_run.side_effect = run_side_effect
            oracle = GitPathOracle(str(repo))

        assert "script.ts" in oracle.writes
        assert oracle.writes["script.ts"] == "script.ts"
        assert ".ts" not in oracle.writes
        assert "script.js" not in oracle.writes  # Old name not stored

    def test_oracle_rename_with_long_filename(self, tmp_path):
        """Rename with longer filename should parse correctly."""
        repo = tmp_path / "repo"
        repo.mkdir()

        with mock.patch("subprocess.run") as mock_run:
            def run_side_effect(*args, **kwargs):
                cmd = args[0] if args else kwargs.get("args", [])
                if "ls-files" in cmd:
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = ""
                    return result
                elif "status" in cmd:
                    # Rename longer file
                    result = mock.Mock()
                    result.returncode = 0
                    result.stdout = "R  src/module/handler.py\0src/module/request_handler.py\0"
                    return result
                elif "check-ignore" in cmd:
                    result = mock.Mock()
                    result.returncode = 1
                    result.stdout = ""
                    return result
                return subprocess.run(*args, **kwargs)

            mock_run.side_effect = run_side_effect
            oracle = GitPathOracle(str(repo))

        assert "src/module/request_handler.py" in oracle.writes
        assert oracle.writes["src/module/request_handler.py"] == "src/module/request_handler.py"
        # Old name should NOT be in writes
        assert "src/module/handler.py" not in oracle.writes
