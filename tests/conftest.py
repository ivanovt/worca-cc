"""Global test fixtures.

Prevents test runs from polluting ~/.worca/projects.d/ with temporary project
entries that would then show up in the global worca-ui.
"""
import os

import pytest


def pytest_load_initial_conftests(early_config, parser, args):
    """Disable pytest-cov when WORCA_COVERAGE=1.

    pytest-cov registers a ``pytest_unconfigure`` hook that calls
    ``coverage combine`` + erase at session end. With WORCA_COVERAGE=1,
    tests/integration/conftest.py:_wrap_with_coverage already wraps each
    pipeline subprocess with ``coverage run --parallel-mode`` — pytest-cov's
    end-of-session combine silently consumes those fragments before our
    explicit ``coverage combine`` ever runs.

    Disabling pytest-cov via ``-p no:cov`` here (rather than relying on
    every developer to remember the flag) keeps the W-050 subprocess-level
    instrumentation in charge whenever WORCA_COVERAGE=1 is set.

    Why ``pytest_load_initial_conftests`` and not ``addopts`` in
    pyproject.toml: this hook is conditional. Without WORCA_COVERAGE=1
    pytest-cov stays available for normal ``pytest --cov`` use.
    """
    if os.environ.get("WORCA_COVERAGE") == "1":
        if not any(a == "no:cov" or a.endswith("no:cov") for a in args):
            args[:0] = ["-p", "no:cov"]


@pytest.fixture(autouse=True)
def _isolate_project_registry(monkeypatch, tmp_path):
    """Redirect auto_register_project to a throwaway directory so test projects
    never leak into the real ~/.worca/projects.d/."""
    fake_prefs = tmp_path / "fake_worca_prefs"
    fake_prefs.mkdir()

    import worca.utils.project_registry as reg

    _original = reg.auto_register_project

    def _isolated(project_root, prefs_dir=str(fake_prefs)):
        return _original(project_root, prefs_dir=prefs_dir)

    monkeypatch.setattr(reg, "auto_register_project", _isolated)
