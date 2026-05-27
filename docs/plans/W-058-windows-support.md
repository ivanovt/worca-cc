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

Stand up Windows as a supported platform in phases, **documenting limited functionality where a feature is inherently POSIX** rather than forcing native rewrites. Phase 0 adds Windows + macOS CI with JUnit-XML artifacts (so failures are actually readable). Phase 1 greens the genuinely cross-platform layers. Phase 2 ensures graceful degradation on the POSIX pipeline runtime. Phase 3 publishes a platform×capability matrix. Native Win32 analogs are explicitly deferred.

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

### 2. CI scaffold + log-truncation fix (Phase 0) — THIS RUN

- **Current state:** `test.yml` has `python-tests` (ubuntu matrix 3.10/3.12), `ui-unit-tests` (ubuntu). No Windows or macOS jobs.
- **Obstacle:** a Windows pytest step emitting ~20 failures' tracebacks overflows GitHub's per-step log buffer — the stored log cuts off mid-progress, *before* pytest's summary, so failing test names are unrecoverable (observed PR #224, even with `--tb=no -rfE -q`).
- **Resolution:** new jobs write `--junitxml` and upload it via `actions/upload-artifact`; a local download parses the XML for the failing set. Add **four new top-level jobs** — Windows Python, Windows vitest, macOS Python, macOS vitest — all **non-blocking** (not listed in branch-protection required checks; failures show a red-X but do not block merges). Do **not** use `continue-on-error: true` — that masks failures and defeats the visibility goal.
- **npm cache portability:** the existing `python-tests` job caches `~/.npm` (line 38). On Windows the npm global cache lives at `~/AppData/npm-cache`. New jobs use `npm config get cache` to resolve the platform-appropriate path via a preceding step output, then feed that path to `actions/cache@v4`.

#### Concrete job structure

Four **new top-level jobs** (not matrix additions to the existing ubuntu jobs — the existing `python-tests` ubuntu job has a 3.10+3.12 matrix and the existing `ui-unit-tests` job has ubuntu-specific caching; both must stay unchanged).

**`python-tests-windows` / `python-tests-macos`** (Python lib/hooks surface):
- `runs-on:` `windows-latest` / `macos-latest`
- Python 3.12 only (Windows/macOS portability bugs are OS-level, not Python-minor-version-specific; add 3.10 only if a version-specific divergence later appears)
- Node.js 22 setup (needed for `claude` and `bd` CLI install via `npm install -g`)
- npm global cache: resolve path via `npm config get cache` step output, feed to `actions/cache@v4`
- Install `claude` + `bd` CLIs, `pip install -e ".[dev]"`
- Run: `pytest tests/ --junitxml=test-results/pytest-results.xml`
- Upload `test-results/` via `actions/upload-artifact@v4` with name `pytest-results-{os}` (runs even on test failure via `if: always()`)

**`ui-unit-tests-windows` / `ui-unit-tests-macos`** (worca-ui vitest):
- `runs-on:` `windows-latest` / `macos-latest`
- Node.js 22 with `cache: 'npm'` and `cache-dependency-path: worca-ui/package-lock.json`
- Python 3.12 setup (needed for `status-constants.js` codegen — the build step invokes `python` to generate it from `src/worca/state/status.py`)
- `pip install -e .` (editable install for codegen)
- `npm ci` + `npm run build` in `worca-ui/`
- Run: `npx vitest run --reporter=junit --outputFile=test-results/vitest-results.xml` in `worca-ui/`
- Upload `test-results/` via `actions/upload-artifact@v4` with name `vitest-results-{os}` (runs even on test failure via `if: always()`)

**Artifact naming convention:** `pytest-results-windows`, `pytest-results-macos`, `vitest-results-windows`, `vitest-results-macos` — distinguishes OS and job type for downstream parsing.

### 3–5. Future phases (not in scope for this run)

Phases 1–3 are planned but **will not be implemented in this pipeline run**. They are retained here for roadmap context only.

- **Phase 1 — Green cross-platform layers:** fix the real `/tmp` subset (enumerated from Phase 0 JUnit artifacts, not guessed), add `skipif(os.name != "posix")` on POSIX-only test modules, green worca-ui vitest on Windows/macOS, flip jobs to blocking.
- **Phase 2 — Pipeline runtime degradation audit:** ensure no crash / no `AttributeError` on Windows for POSIX paths (`proc_registry.py`, `runner.py`, `worca_lifecycle.py`, `run_worktree.py`, `run_fleet.py`, `run_workspace.py`); document limitations.
- **Phase 3 — Platform-support docs:** `docs/platform-support.md` matrix, README/CLAUDE.md cross-links.

## Implementation Plan

> **Scope gate:** this run implements **Phase 0 only**. The sole file touched is `.github/workflows/test.yml`. Do not modify test files, `src/worca/` runtime code, or create documentation files.

### Phase 0: CI scaffold + visibility

**Files:** `.github/workflows/test.yml` (only file modified)

**Tasks:**

1. **Add `python-tests-windows` job** — new top-level job, `runs-on: windows-latest`, Python 3.12, Node.js 22, npm cache via `npm config get cache`, install CLIs + dev deps, `pytest tests/ --junitxml=test-results/pytest-results.xml`, upload artifact `pytest-results-windows`.

2. **Add `python-tests-macos` job** — identical structure to `python-tests-windows` but `runs-on: macos-latest`, artifact name `pytest-results-macos`.

3. **Add `ui-unit-tests-windows` job** — new top-level job, `runs-on: windows-latest`, Node.js 22 (with npm cache), Python 3.12 (for codegen), `pip install -e .`, `npm ci` + `npm run build`, `npx vitest run --reporter=junit --outputFile=test-results/vitest-results.xml`, upload artifact `vitest-results-windows`.

4. **Add `ui-unit-tests-macos` job** — identical structure to `ui-unit-tests-windows` but `runs-on: macos-latest`, artifact name `vitest-results-macos`.

5. **Non-blocking mechanism** — the four new jobs are simply not added to branch-protection required checks. They run on every push/PR, show red-X on failure (full visibility), but do not block merges. Do **not** use `continue-on-error: true`.

6. **JUnit-XML artifacts** — each job uploads its XML results via `actions/upload-artifact@v4` with `if: always()` so artifacts are available even when tests fail. This defeats GitHub's step-log truncation — the full failure set is recoverable from the downloaded XML.

`test-e2e.yml` stays Ubuntu-only (Windows/macOS e2e is out of scope for all phases).

**Done when:** all four new jobs appear in CI, run to completion (pass or fail), and their JUnit-XML artifacts are downloadable. The existing `python-tests` and `ui-unit-tests` ubuntu jobs are unchanged.

### Files Changed Summary

| File | Change |
|------|--------|
| `.github/workflows/test.yml` | Add 4 new jobs: `python-tests-windows`, `python-tests-macos`, `ui-unit-tests-windows`, `ui-unit-tests-macos` with JUnit-XML artifact upload |

## Considerations

- **WSL2 is the supported pipeline path on Windows** — this is what makes "degrade + document" a complete story rather than a gap, and what keeps native analogs low-ROI for now.
- **Deferred (Non-goals below)** native Win32 analogs would require ctypes-or-pywin32 (a dependency decision), a `ProcessController` abstraction refactor, Windows integration-test capability, and 2× ongoing maintenance — out of scope until real demand.
- **Breaking changes:** none — additive CI only in Phase 0.
- **Migration:** none.

## Test Plan

### Phase 0 validation
| Check | Validates |
|-------|-----------|
| `python-tests-windows` job runs | Python lib/hooks can import + pytest runs on Windows |
| `python-tests-macos` job runs | Python lib/hooks can import + pytest runs on macOS |
| `ui-unit-tests-windows` job runs | worca-ui build + vitest on Windows |
| `ui-unit-tests-macos` job runs | worca-ui build + vitest on macOS |
| JUnit-XML artifacts downloadable | Log-truncation workaround; full failure set recoverable |
| Existing ubuntu jobs unchanged | No regression in current CI |
| New jobs do not block merges | Not in branch-protection required checks |

### Integration / E2E Tests
Windows/macOS integration/e2e remain **out of scope** (pipeline is POSIX; no Windows analogs yet). Linux integration and `test-e2e.yml` unchanged.

## Files to Create/Modify

| File | Create/Modify | Purpose |
|------|---------------|---------|
| `.github/workflows/test.yml` | Modify | Add 4 non-blocking Windows/macOS jobs with JUnit-XML artifact upload |

## Out of Scope

- **Phases 1–3** — test-file portability, runtime degradation guards, platform-support docs (future pipeline runs).
- **Native Win32 process-control analogs** — Job Objects (`KILL_ON_JOB_CLOSE`), `CTRL_BREAK_EVENT`/named-events for graceful stop, `DETACHED_PROCESS` for detach (via ctypes or pywin32).
- **A `ProcessController` platform abstraction** refactor of the spawn/kill/detach/lifecycle core.
- **Windows pipeline integration / e2e tests** — deferred until the runtime analogs above exist.
- Making the pipeline run *natively* (non-WSL) on Windows.
- **`test-e2e.yml`** — stays Ubuntu-only.
- **`continue-on-error: true`** — explicitly rejected; masks failures.
