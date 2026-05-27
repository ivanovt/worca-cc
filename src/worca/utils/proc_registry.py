"""Per-run process-group registry for orphan cleanup.

Tracks spawned subprocess groups as JSON files under ``<run_dir>/procs/``,
keyed by pgid. Provides helpers to list, verify (PID-reuse guard), and
kill all tracked groups with SIGTERM→SIGKILL escalation.
"""

import json
import os
import signal
import time

SIGTERM_TIMEOUT = 3.0
SIGKILL_TIMEOUT = 2.0

# Process-group signalling is POSIX-only. On platforms without os.getpgid /
# os.killpg (Windows), group tracking and killing degrade to no-ops and callers
# fall back to direct-child termination. Tracking is never recorded there, so
# the registry stays empty and kill_all_tracked has nothing to do.
_HAS_PROC_GROUPS = hasattr(os, "getpgid") and hasattr(os, "killpg")


def _validate_pid(value: object) -> int:
    pid = int(value)
    if pid <= 0:
        raise ValueError(f"Invalid PID: {pid}")
    return pid


def record_spawn(procs_dir: str, *, pgid: int, pid: int, stage: str, iteration: int) -> None:
    os.makedirs(procs_dir, exist_ok=True)
    entry = {
        "pgid": pgid,
        "pid": pid,
        "stage": stage,
        "iteration": iteration,
        "start_time": _get_process_create_time(pid) or time.time(),
    }
    path = os.path.join(procs_dir, f"{pgid}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entry, f)


def remove_spawn(procs_dir: str, *, pgid: int) -> None:
    path = os.path.join(procs_dir, f"{pgid}.json")
    try:
        os.unlink(path)
    except OSError:
        pass


def list_spawns(procs_dir: str) -> list[dict]:
    if not os.path.isdir(procs_dir):
        return []
    result = []
    for name in os.listdir(procs_dir):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(procs_dir, name), encoding="utf-8") as f:
                result.append(json.load(f))
        except (OSError, json.JSONDecodeError, ValueError):
            continue
    return result


def is_alive_and_ours(*, pgid: int, pid: int | None = None, start_time: float) -> bool:
    """Check if a tracked process group is still alive and matches the recorded start_time.

    Uses *pid* (the original child) for the start_time comparison, since that's
    what ``record_spawn`` records.  *pgid* is used only for the group-alive probe.
    With ``start_new_session=True`` they are equal, but accepting both keeps the
    guard correct if that invariant ever breaks.
    """
    if not _HAS_PROC_GROUPS:
        return False
    pgid = _validate_pid(pgid)
    check_pid = _validate_pid(pid if pid is not None else pgid)
    try:
        os.killpg(pgid, 0)
    except (ProcessLookupError, PermissionError, OSError):
        return False
    actual = _get_process_create_time(check_pid)
    if actual is None:
        return False
    return abs(actual - start_time) < 2.0


def kill_all_tracked(procs_dir: str) -> int:
    entries = list_spawns(procs_dir)
    killed = 0
    for entry in entries:
        pgid = entry["pgid"]
        pid = entry.get("pid", pgid)
        start_time = entry.get("start_time", 0.0)
        if is_alive_and_ours(pgid=pgid, pid=pid, start_time=start_time):
            _kill_group(pgid)
            killed += 1
        remove_spawn(procs_dir, pgid=pgid)
    return killed


def _kill_group(pgid: int) -> None:
    if not _HAS_PROC_GROUPS:
        return
    pgid = _validate_pid(pgid)
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, OSError):
        return
    deadline = time.monotonic() + SIGTERM_TIMEOUT
    while time.monotonic() < deadline:
        try:
            os.killpg(pgid, 0)
        except (ProcessLookupError, OSError):
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass


def _get_process_create_time(pid: int) -> float | None:
    try:
        pid = _validate_pid(pid)
        import platform
        if platform.system() == "Darwin":
            import subprocess
            env = {**os.environ, "LC_ALL": "C"}
            out = subprocess.check_output(
                ["ps", "-o", "lstart=", "-p", str(pid)],
                text=True, stderr=subprocess.DEVNULL, env=env,
            ).strip()
            if out:
                import datetime
                dt = datetime.datetime.strptime(out, "%c")
                return dt.timestamp()
        else:
            stat_path = f"/proc/{pid}/stat"
            with open(stat_path, encoding="utf-8") as f:
                fields = f.read().split(")")[-1].split()
            # Field index 19 (0-based after the comm field closing paren)
            # is starttime in clock ticks since boot.
            starttime_ticks = int(fields[19])
            clk_tck = os.sysconf("SC_CLK_TCK")
            # Anchor to the kernel's fixed boot epoch (/proc/stat 'btime') rather
            # than reconstructing it from time.time() - uptime. The reconstruction
            # jitters between calls (the two reads aren't simultaneous), so the
            # same process can yield create-times differing by >2s under load —
            # enough to fail the is_alive_and_ours PID-reuse tolerance and skip a
            # real orphan kill on resume. btime is a constant integer, so the
            # create-time is identical across every call and process.
            return _linux_boot_time() + starttime_ticks / clk_tck
    except Exception:
        return None


def _linux_boot_time() -> float:
    """System boot time (epoch seconds) from /proc/stat 'btime'.

    Falls back to ``time.time() - /proc/uptime`` only if btime is unavailable.
    btime is a fixed integer, so callers get a stable, jitter-free create-time.
    """
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("btime "):
                    return float(line.split()[1])
    except OSError:
        pass
    with open("/proc/uptime") as f:
        return time.time() - float(f.read().split()[0])
