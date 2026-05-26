# W-058: Windows support across all layers

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-05-26
**Depends on:** None (spun out of #217 / PR #224)

## Problem

Windows is now a declared **first-class support target for all worca layers** — worca-ui, the governance hooks, the Python library, and the autonomous pipeline — but today only the UI and hooks plausibly work there, and even the cross-platform Python layer is not validated on Windows:

- **No Windows CI exists.** Every job in `.github/workflows/test.yml` and `test-e2e.yml` runs on `ubuntu-latest`. macOS is also uncovered (dev-only).
- **The pipeline runtime control plane is POSIX-only.** Lifecycle (pause/stop/resume) is signal-based (`runner.py:648` installs `SIGTERM`/`SIGINT` handlers; `worca_lifecycle.py:146` sends `os.kill(pid, SIGTERM)`); reaping uses process groups (`os.getpgid`/`os.killpg`, guarded by `_HAS_PROC_GROUPS` in `proc_registry.py:20`); detached worktree/fleet runs rely on `start_new_session=True` (`runner.py:1479`, `run_worktree.py:321`). On Windows these degrade to a single-child `proc.terminate()` (`claude_cli.py:105-114`) — lifecycle, clean teardown, and true detachment do not work.
- **The unit suite carries Windows-portability debt** — ~262 hardcoded `/tmp/` literals across 31 test files (most inert, but a real subset does file I/O), plus modules that mock POSIX-only primitives. The exact failing set is unknown because GitHub truncates a Windows pytest step's log tail before the summary prints (observed in PR #224).

User-facing impact: worca cannot claim or verify Windows support for any layer today.

## Proposal

Stand up Windows as a supported platform in phases, **documenting limited functionality where a feature is inherently POSIX** rather than forcing native rewrites. Phase 0 adds Windows CI with a JUnit-XML artifact (so failures are actually readable). Phase 1 greens the genuinely cross-platform layers (Python lib/hooks + worca-ui vitest). Phase 2 ensures the POSIX pipeline runtime **degrades gracefully (no crashes) and is documented** (WSL2 is the supported path for running the pipeline on Windows). Phase 3 publishes a platform×capability matrix. Native Win32 analogs are explicitly deferred.

## Design

### 1. Platform support model

| Capability | Linux | macOS | Windows (target) |
|---|---|---|---|
| worca-ui (server + browser) | ✅ | ✅ | ✅ |
| Governance hooks + Python library | ✅ | ✅ | ✅ |
| Pipeline happy-path run | ✅ | ✅ | ✅ (validate) |
| Pause / stop / resume | ✅ | ✅ | ⚠️ documented limitation (use WSL2) |
| Orphan reaping / clean teardown | ✅ | ✅ | ⚠️ best-effort single-child; documented |
| Detached worktree / fleet / parallel | ✅ | ✅ | ⚠️ documented limitation (use WSL2) |

"Supported with documented limitations" is a first-class outcome here, not a gap.

### 2. CI scaffold + log-truncation fix (Phase 0)

- **Current state:** `test.yml` has `python-tests` (ubuntu matrix 3.10/3.12), `ui-unit-tests` (ubuntu). No Windows.
- **Obstacle:** a Windows pytest step emitting ~20 failures' tracebacks overflows GitHub's per-step log buffer — the stored log cuts off mid-progress, *before* pytest's summary, so failing test names are unrecoverable (observed PR #224, even with `--tb=no -rfE -q`).
- **Resolution:** Windows jobs write `--junitxml` and upload it via `actions/upload-artifact`; a tiny follow-up step (or local download) parses the XML for the failing set. Add a `windows` Python job (lib/hooks surface) and a `windows` worca-ui vitest job, both **non-blocking** (`continue-on-error` or not in required checks) until Phase 1 greens them.

### 3. Cross-platform layer remediation (Phase 1)

- **`/tmp` hardcoding:** replace real-I/O `/tmp/...` literals with `tmp_path` / `tempfile.gettempdir()`. The true failing set (≪262) is enumerated from the Phase 0 JUnit artifact, not guessed.
- **POSIX-only modules:** ensure `skipif(os.name != "posix")` on the modules that mock/exercise process-group primitives — `test_proc_registry.py`, `test_claude_cli.py`, `test_claude_cli_registry.py`, `test_mock_claude_watchdog.py` (most already have it) — and keep `tests/integration` excluded on Windows.
- **worca-ui vitest:** run the 248 `*.test.js` on Windows; fix any path-separator / port / build (`status-constants` codegen) issues.
- Flip both Windows jobs to **blocking** once green.

### 4. Pipeline runtime: graceful degradation audit (Phase 2)

For each POSIX path, guarantee **no crash / no `AttributeError`** on Windows and a clear degraded behavior:

| Mechanism | Location | Windows degraded behavior |
|---|---|---|
| `os.getpgid`/`os.killpg` reap | `proc_registry.py` (`_HAS_PROC_GROUPS`) | already no-op guarded; verify single-child `terminate()` fallback (`claude_cli.py:105-114`) |
| `SIGTERM`/`SIGINT` lifecycle | `runner.py:648`, `worca_lifecycle.py:146` | audit: `os.kill(pid, SIGTERM)` on Windows = `TerminateProcess` (hard kill, no graceful handler) — document |
| `start_new_session` detach | `runner.py:1479`, `run_worktree.py:321` | audit detachment semantics; document that fire-and-forget detach is not guaranteed |
| fleet / workspace | `run_fleet.py`, `run_workspace.py:56` | audit signal handlers; document |

No native Win32 implementation in this phase — degrade + document only.

### 5. Documentation (Phase 3)

`docs/platform-support.md`: the matrix above, the per-feature limitations, and "run the pipeline under WSL2 on Windows" guidance. Cross-link from `README` / `CLAUDE.md`.

## Implementation Plan

### Phase 0: CI scaffold + visibility
**Files:** `.github/workflows/test.yml`
**Tasks:** add non-blocking `windows` Python + vitest jobs; emit `--junitxml`; upload artifact; capture the true failure set.

### Phase 1: Green cross-platform layers
**Files:** the test files surfaced by Phase 0 (subset of the 31 with `/tmp`), the 4 POSIX-only modules (skip markers), `test.yml` (flip blocking).

### Phase 2: Runtime degradation audit + docs hooks
**Files:** `src/worca/utils/proc_registry.py`, `src/worca/utils/claude_cli.py`, `src/worca/orchestrator/runner.py`, `src/worca/utils/worca_lifecycle.py`, `src/worca/scripts/run_worktree.py`, `run_fleet.py`, `run_workspace.py` — audit + guards only.

### Phase 3: Platform-support docs
**Files:** `docs/platform-support.md` (new), `README.md`, `CLAUDE.md`.

### Files Changed Summary

| File | Change |
|------|--------|
| `.github/workflows/test.yml` | Add Windows Python + vitest jobs; JUnit artifact |
| `tests/*.py` (subset) | `/tmp` → `tmp_path`/`tempfile`; skip markers |
| `src/worca/utils/*.py`, `orchestrator/runner.py`, `scripts/*.py` | Degradation audit + guards (no native code) |
| `docs/platform-support.md` | New platform×capability matrix |

## Considerations

- **WSL2 is the supported pipeline path on Windows** — this is what makes "degrade + document" a complete story rather than a gap, and what keeps native analogs low-ROI for now.
- **Deferred (Non-goals below)** native Win32 analogs would require ctypes-or-pywin32 (a dependency decision), a `ProcessController` abstraction refactor, Windows integration-test capability, and 2× ongoing maintenance — out of scope until real demand.
- **Breaking changes:** none — additive CI + test-portability + docs; runtime changes are guards only.
- **Migration:** none.

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | existing suite on `windows-latest` | lib/hooks import + run; guards don't `AttributeError` |
| JS | vitest on `windows-latest` | worca-ui server + app cross-platform |

### Integration / E2E Tests
Windows integration/e2e remain **out of scope** (pipeline is POSIX; no Windows analogs yet). Linux/macOS integration unchanged.

### Existing Tests to Update
The `/tmp`-hardcoded subset enumerated from the Phase 0 JUnit artifact; POSIX-only modules get/keep skip markers.

## Files to Create/Modify

| File | Create/Modify | Purpose |
|------|---------------|---------|
| `.github/workflows/test.yml` | Modify | Windows jobs + JUnit artifact |
| `tests/*.py` (subset) | Modify | Windows portability (`/tmp`, skips) |
| `src/worca/utils/proc_registry.py`, `claude_cli.py`, `worca_lifecycle.py` | Modify | Degradation audit/guards |
| `src/worca/orchestrator/runner.py`, `scripts/run_worktree.py`, `run_fleet.py`, `run_workspace.py` | Modify | Degradation audit/guards |
| `docs/platform-support.md` | Create | Platform×capability matrix + limitations |

## Out of Scope

- **Native Win32 process-control analogs** — Job Objects (`KILL_ON_JOB_CLOSE`), `CTRL_BREAK_EVENT`/named-events for graceful stop, `DETACHED_PROCESS` for detach (via ctypes or pywin32).
- **A `ProcessController` platform abstraction** refactor of the spawn/kill/detach/lifecycle core.
- **Windows pipeline integration / e2e tests** — deferred until the runtime analogs above exist.
- Making the pipeline run *natively* (non-WSL) on Windows.
