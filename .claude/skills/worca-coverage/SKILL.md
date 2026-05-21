---
name: worca-coverage
description: Run worca-cc Python coverage via `scripts/coverage.py` — supports `ci` one-shot, separate run/combine/report steps, baseline comparison, and the `--include-unit-tests` mode. Triggers on "coverage", "code coverage", "coverage report", "compare coverage", "worca-coverage", or any request to measure or compare Python coverage for this repo.
---

# worca-cc Coverage

Thin wrapper around `scripts/coverage.py`. CLAUDE.md documents the full flow — this skill makes it discoverable and picks the right invocation for the task.

## Step 0: No-args mode

If invoked with no arguments, print this usage:

```
/worca-coverage --ci                                    # one-shot: run + combine + JSON + XML + text
/worca-coverage --ci --include-unit-tests              # also wrap pytest with coverage.run (slower, complete)
/worca-coverage --run                                  # pytest under WORCA_COVERAGE=1 (fragments only)
/worca-coverage --combine                              # merge .coverage.* fragments
/worca-coverage --report [--format=text|json|html]     # report from combined data
/worca-coverage --compare --baseline=<before.json> --current=<after.json>
```

Default action when no flag is given: print this help and stop.

## CI / one-shot mode (`--ci`)

```bash
python scripts/coverage.py ci
```

This:
1. Erases stale `.coverage*` state
2. Runs `pytest` with `WORCA_COVERAGE=1` (activates subprocess-level coverage in `tests/integration/conftest.py`)
3. Combines `.coverage.*` fragments
4. Writes `coverage-out/coverage.json` (augmented schema: `summary`, `modules`, `omitted`, `raw`)
5. Writes `coverage-out/coverage.xml` (Cobertura)
6. Prints a text summary

**Exit code is the pytest exit code** — CI fails on real test regressions even when coverage upload succeeds.

## Full-coverage mode (`--ci --include-unit-tests`)

```bash
python scripts/coverage.py ci --include-unit-tests
```

Wraps the pytest invocation itself with `coverage run --parallel-mode` and targets all of `tests/` (instead of just `tests/integration/`). Required when you need accurate per-module numbers for modules only exercised by unit tests.

**Cost:** roughly doubles wall time. Use this for baseline runs, not iterative debugging.

## Step-by-step mode

Useful when iterating on a specific test file and you don't want to nuke fragments between runs:

```bash
# 1. Run with coverage active
WORCA_COVERAGE=1 pytest tests/test_<module>.py

# 2. Combine fragments
python scripts/coverage.py combine

# 3. Report
python scripts/coverage.py report --format=text
python scripts/coverage.py report --format=json --out=cov.json
python scripts/coverage.py report --format=html  # writes htmlcov/
```

## Compare mode

```bash
python scripts/coverage.py compare --baseline=before.json --current=after.json
```

Diffs two `coverage.json` files and prints per-module percentage-point deltas. Useful for per-phase tracking without enforcing a `--fail-under` gate.

Workflow:

```bash
# Before changes
python scripts/coverage.py ci
cp coverage-out/coverage.json before.json

# After changes
python scripts/coverage.py ci
python scripts/coverage.py compare --baseline=before.json --current=coverage-out/coverage.json
```

## Important gotchas

- **`WORCA_COVERAGE=1` is required** for integration tests. Without it, subprocess-level coverage is not activated and you get incomplete numbers.
- **`WORCA_COVERAGE=1` auto-disables `pytest-cov`** via the `pytest_load_initial_conftests` hook in `tests/conftest.py`. Without that, `pytest-cov`'s session_finish hook silently consumes the fragments before `coverage combine` can merge them.
- **Without `WORCA_COVERAGE=1`**, the standard `pytest --cov=worca` flow still works for unit-test coverage. Use the env var only when you need integration coverage.
- **Coverage threshold enforcement** stays out of scope until baselines stabilize. Do not propose `--fail-under` gates without explicit user direction.
