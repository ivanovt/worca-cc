# Platform Support

worca targets **Linux, macOS, and Windows**. The cross-platform layers — the
Python library, the governance hooks, and worca-ui (server + browser) — are
first-class on all three and validated in CI (Windows, macOS, and Ubuntu jobs).

The **autonomous pipeline control plane** (pause/stop/resume, orphan reaping,
detached worktree/fleet/workspace runs) is POSIX-native. On Windows it
**degrades gracefully — it never crashes and never does anything destructive —
but some lifecycle features are best-effort or unavailable**. To run the
pipeline itself on Windows with full fidelity, use **WSL2** (a Linux
environment), which is the supported path.

> "Supported with documented limitations" is a deliberate outcome here, not a
> gap. Native Win32 process-control analogs (Job Objects, `CTRL_BREAK_EVENT`,
> `DETACHED_PROCESS`) are intentionally out of scope until there's demand —
> WSL2 covers the full-fidelity case.

## Capability matrix

| Capability | Linux | macOS | Windows (native) | Windows (WSL2) |
|---|:---:|:---:|:---:|:---:|
| worca-ui (server + browser) | ✅ | ✅ | ✅ | ✅ |
| Governance hooks + Python library | ✅ | ✅ | ✅ | ✅ |
| Unit + UI test suites | ✅ | ✅ | ✅ | ✅ |
| Pipeline happy-path run | ✅ | ✅ | ⚠️ best-effort | ✅ |
| Pause / stop / resume | ✅ | ✅ | ⚠️ hard-kill only | ✅ |
| Orphan reaping / clean teardown | ✅ | ✅ | ⚠️ best-effort single-child | ✅ |
| Detached worktree / fleet / workspace | ✅ | ✅ | ⚠️ not guaranteed | ✅ |
| Pipeline integration / e2e tests | ✅ | ✅ | ❌ (out of scope) | ✅ |

## Windows degradation details

These are the specific POSIX mechanisms the control plane relies on and how
they behave on native Windows. All paths are guarded so they **degrade without
crashing**.

| Mechanism | POSIX behavior | Native-Windows behavior |
|---|---|---|
| **Liveness probe** (`is the pipeline still running?`) | `os.kill(pid, 0)` — non-destructive | Routed through `worca.utils.proc.pid_is_alive()`, which uses a non-destructive `OpenProcess`/`WaitForSingleObject` ctypes check. **Never** calls `os.kill(pid, 0)` on Windows — there it maps to `TerminateProcess` and would *kill* the probed process. |
| **Lifecycle signals** (pause/stop) | `SIGTERM`/`SIGINT` → graceful handler flushes state | `os.kill(pid, SIGTERM)` maps to `TerminateProcess` — an immediate **hard kill**; the graceful in-process handler does not run, so state may not be flushed. |
| **Process-group reaping** | `os.killpg`/`os.getpgid` reap the whole tree | Process groups are unavailable (`_HAS_PROC_GROUPS` is false); teardown falls back to **best-effort single-child** `terminate()`. Grandchildren may be orphaned. |
| **Detached runs** | `start_new_session=True` detaches the child | `start_new_session` is a POSIX-only kwarg, **silently ignored** by `subprocess` on Windows; fire-and-forget detachment is not guaranteed. |
| **Signal-handler install** | `signal.signal(SIGTERM/SIGINT, …)` on the main thread | Installed inside `try/except (ValueError, OSError)`; if unavailable (non-main-thread/embedded), it's skipped rather than crashing. |

## Recommendation

- **worca-ui, hooks, and library development** — work natively on Windows.
- **Running the autonomous pipeline** (`worca run`, `run_worktree.py`, fleet,
  workspace) — use **WSL2** for full lifecycle fidelity. Native Windows runs
  will start and produce output, but pause/stop/resume and clean teardown are
  best-effort.

## See also

- [`docs/plans/W-058-windows-support.md`](./plans/W-058-windows-support.md) — the design and phased rollout.
