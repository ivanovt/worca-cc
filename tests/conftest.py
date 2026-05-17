"""Global test fixtures.

Prevents test runs from polluting ~/.worca/projects.d/ with temporary project
entries that would then show up in the global worca-ui.
"""
import os

import pytest


_WORCA_HOME = os.path.expanduser("~/.worca")
_leak_baseline: dict | None = None


def _snapshot_worca_home() -> dict:
    """Return {relative_path: (size, mtime_ns)} for every file under ~/.worca/.

    Cheap stat-only scan — does not read file contents. Returns {} when the
    directory does not exist.
    """
    if not os.path.isdir(_WORCA_HOME):
        return {}
    snap: dict = {}
    for dirpath, _, filenames in os.walk(_WORCA_HOME):
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.stat(full)
            except FileNotFoundError:
                continue
            snap[os.path.relpath(full, _WORCA_HOME)] = (st.st_size, st.st_mtime_ns)
    return snap


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "allow_worca_writes: opt out of the ~/.worca/ leak detector for "
        "tests that intentionally exercise the real home directory",
    )


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
def _detect_worca_home_leaks(request):
    """Fail any test that writes into the real ~/.worca/ directory.

    Why: hardcoded module-load-time defaults like ``_FLEET_RUNS_DIR =
    os.path.expanduser("~/.worca/fleet-runs")`` (issue #162) silently
    leak temp-test state into the developer's real home directory,
    where it then surfaces as phantom fleets/workspaces in the UI.
    This guard catches *any* such leak — including future ones — by
    snapshotting ~/.worca/ around each test and asserting nothing was
    added or modified.

    Opt out for tests that intentionally write to the real home:

        @pytest.mark.allow_worca_writes
        def test_something(...): ...

    Set WORCA_DISABLE_LEAK_DETECTOR=1 to disable globally (escape
    hatch for emergencies — do not use in CI).
    """
    if os.environ.get("WORCA_DISABLE_LEAK_DETECTOR") == "1":
        yield
        return
    if request.node.get_closest_marker("allow_worca_writes"):
        yield
        return

    global _leak_baseline
    if _leak_baseline is None:
        _leak_baseline = _snapshot_worca_home()

    yield

    current = _snapshot_worca_home()
    added = set(current) - set(_leak_baseline)
    modified = {
        p for p in set(current) & set(_leak_baseline)
        if current[p] != _leak_baseline[p]
    }
    leaks = added | modified

    # Reset baseline so a single leak does not cascade across every
    # subsequent test in the session.
    _leak_baseline = current

    if leaks:
        listing = "\n".join(f"  - ~/.worca/{p}" for p in sorted(leaks))
        pytest.fail(
            f"Test '{request.node.nodeid}' wrote to the real ~/.worca/:\n"
            f"{listing}\n"
            "\n"
            "Fix the test to redirect writes to a tmp directory (e.g. set "
            "WORCA_HOME, pass base_dir=, or monkeypatch the module-level "
            "constant). If the write is intentional, add the "
            "@pytest.mark.allow_worca_writes marker."
        )


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
