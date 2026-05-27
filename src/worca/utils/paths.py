"""Lazy resolvers for ~/.worca/ subdirectories.

Why these helpers exist: many call sites used to capture
``os.path.expanduser("~/.worca/...")`` into a module-level constant at
import time. That makes the path impossible to override from a test
(or from a different ``WORCA_HOME``) after the module is imported —
which leaked temp-test state into the developer's real home directory
(issue #162).

Every helper here re-reads the environment on each call. Each
resolver accepts an optional ``override`` arg so legacy module-level
constants set to non-None (typically by ``unittest.mock.patch``) win
over the env-var lookup. This preserves backwards compatibility with
the dozens of tests that patch the per-module constants directly.

Resolution order:

    1. ``override`` arg (e.g. a module-level constant set by tests)
    2. ``$WORCA_HOME/<subdir>``
    3. ``~/.worca/<subdir>``
"""

import os


def worca_home() -> str:
    """Return the worca state directory.

    Honors ``$WORCA_HOME`` if set, else falls back to ``~/.worca``.
    Resolved on every call so tests can set the env var after import.
    """
    override = os.environ.get("WORCA_HOME")
    if override:
        return os.path.expanduser(override)
    # os.path.join (not "~/.worca") so the separator is OS-native: on Windows
    # expanduser("~/.worca") keeps the literal "/" → "C:\\Users\\x/.worca",
    # which leaks mixed separators into every derived dir (fleet-runs, cache…).
    return os.path.join(os.path.expanduser("~"), ".worca")


def worca_cache_dir() -> str:
    """Return the worca cache directory.

    Honors ``$WORCA_CACHE`` if set, else falls back to ``<worca_home>/cache``.
    Resolved on every call so tests can set the env var after import. Holds
    derived/regenerable artifacts (e.g. the Graphify per-commit knowledge-graph
    snapshots), distinct from durable state under ``worca_home()``.
    """
    override = os.environ.get("WORCA_CACHE")
    if override:
        return os.path.expanduser(override)
    return os.path.join(worca_home(), "cache")


def fleet_runs_dir(override: str | None = None) -> str:
    """Return the fleet-runs directory.

    Pass ``override`` to honor a module-level constant set by tests
    (via ``mock.patch``). Otherwise resolves to ``<worca_home>/fleet-runs``.
    """
    if override:
        return override
    return os.path.join(worca_home(), "fleet-runs")


def workspace_runs_dir(override: str | None = None) -> str:
    """Return the workspace-runs directory.

    Pass ``override`` to honor a module-level constant set by tests
    (via ``mock.patch``). Otherwise resolves to ``<worca_home>/workspace-runs``.
    """
    if override:
        return override
    return os.path.join(worca_home(), "workspace-runs")
