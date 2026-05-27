"""Cross-platform PID liveness probe.

On POSIX, ``os.kill(pid, 0)`` is a non-destructive liveness check.
On Windows, ``os.kill(pid, sig)`` calls ``TerminateProcess`` for any signal
that isn't ``CTRL_C_EVENT`` / ``CTRL_BREAK_EVENT`` — so ``os.kill(pid, 0)``
**kills the target process**.  This module provides ``pid_is_alive(pid)`` as
the single safe entry point: POSIX uses the traditional ``os.kill`` probe;
Windows uses ``ctypes`` with ``OpenProcess(SYNCHRONIZE)`` +
``WaitForSingleObject`` — stdlib-only, no pywin32.

Best-effort: a ``True`` return means the PID existed *at probe time*; the
process may exit immediately after.  A ``False`` return means the PID did not
exist or could not be probed.
"""

from __future__ import annotations

import os

# Windows constants (kept at module level so the ctypes path is self-contained).
_SYNCHRONIZE = 0x00100000
_WAIT_OBJECT_0 = 0x00000000
_WAIT_TIMEOUT = 0x00000102


def pid_is_alive(pid: int) -> bool:
    """Return True if *pid* refers to a running process.

    Raises ``PermissionError`` on POSIX when the process exists but is owned
    by another user (same semantics as ``os.kill(pid, 0)``).

    Never calls ``os.kill`` on Windows — delegates to ``_win_pid_is_alive``.
    """
    if pid <= 0:
        return False

    if os.name == "nt":
        return _win_pid_is_alive(pid)

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        raise
    except OSError:
        return False
    return True


def _win_pid_is_alive(pid: int) -> bool:
    """Windows liveness probe via kernel32 (ctypes, stdlib-only).

    Opens the process with SYNCHRONIZE access (non-destructive), then polls
    ``WaitForSingleObject`` with a zero timeout.  ``WAIT_TIMEOUT`` means the
    process is still running; ``WAIT_OBJECT_0`` means it has exited.  Returns
    False when ``OpenProcess`` fails (invalid/dead PID or access denied).
    """
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-error]
    handle = kernel32.OpenProcess(_SYNCHRONIZE, False, pid)
    if not handle:
        return False
    try:
        result = kernel32.WaitForSingleObject(handle, 0)
        return result == _WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)
