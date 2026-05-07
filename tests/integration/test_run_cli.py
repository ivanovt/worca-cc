"""Integration tests for pipeline_env.run_cli helper (W-050 coverage improvement).

Validates that run_cli:
- spawns ``python -m worca.cli.main <name> <args>`` via _wrap_with_coverage
- captures stdout and stderr
- returns the subprocess exit code faithfully
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.timeout(120)


def test_run_cli_cleanup_dry_run_returns_zero_and_captures_stdout(pipeline_env):
    """``run_cli('cleanup', '--dry-run')`` exits 0 and stdout is captured.

    With no completed worktrees present the dry-run listing is empty, but the
    command must succeed and the caller must be able to read stdout — verifying
    the subprocess wiring (cwd, coverage wrapping, capture_output=True).
    """
    result = pipeline_env.run_cli("cleanup", "--dry-run")
    assert result.returncode == 0, (
        f"expected rc=0, got {result.returncode}\n"
        f"stdout: {result.stdout[:500]}\n"
        f"stderr: {result.stderr[:500]}"
    )
    # stdout is a string (capture_output=True, text=True); may be empty but must exist
    assert isinstance(result.stdout, str)


def test_run_cli_captures_stderr_from_failing_command(pipeline_env):
    """``run_cli`` with an unrecognised flag returns nonzero and populates stderr.

    argparse writes its usage/error messages to stderr when it rejects a flag,
    so this exercises the stderr-capture path without needing a real failure.
    """
    result = pipeline_env.run_cli("cleanup", "--no-such-flag-xyz")
    assert result.returncode != 0, (
        "expected nonzero exit from invalid flag, got 0"
    )
    assert result.stderr, (
        f"expected stderr output from argparse, got empty string\n"
        f"stdout: {result.stdout[:300]}"
    )


def test_run_cli_result_has_stdout_and_stderr_attributes(pipeline_env):
    """The returned CompletedProcess always exposes .stdout and .stderr as strings."""
    result = pipeline_env.run_cli("cleanup", "--dry-run")
    assert hasattr(result, "stdout")
    assert hasattr(result, "stderr")
    assert isinstance(result.stdout, str)
    assert isinstance(result.stderr, str)
