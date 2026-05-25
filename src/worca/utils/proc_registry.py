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
    with open(path, "w") as f:
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
            with open(os.path.join(procs_dir, name)) as f:
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
            with open(stat_path) as f:
                fields = f.read().split(")")[-1].split()
            # Field index 19 (0-based after the comm field closing paren)
            # is starttime in clock ticks since boot.
            starttime_ticks = int(fields[19])
            clk_tck = os.sysconf("SC_CLK_TCK")
            with open("/proc/uptime") as f:
                uptime = float(f.read().split()[0])
            boot_time = time.time() - uptime
            return boot_time + starttime_ticks / clk_tck
    except Exception:
        return None
