---
name: worca-dev-precommit
description: Run the worca-cc pre-commit gauntlet — ruff, biome, vitest, conditional playwright, npm pack file-allowlist check, and a docs-site build. Picks the right subset based on what the current branch changed vs base. Triggers on "precommit", "pre-commit check", "before commit", "verify before commit", "worca-dev-precommit", or any request to validate changes before committing in this repo.
---

# worca-cc Pre-Commit Gauntlet

Run the right checks for what was actually changed. CLAUDE.md describes these rules across several sections — this skill bundles them so nothing gets skipped.

## Step 1: Determine the diff

Detect the base branch and compute the changed file set:

```bash
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
BASE=${BASE:-master}
CHANGED=$(git diff --name-only "$BASE"...HEAD; git diff --name-only; git ls-files --others --exclude-standard)
echo "$CHANGED" | sort -u
```

Categorize:
- `PY_TOUCHED` — any path matching `src/worca/`, `tests/`, `scripts/`, or `pyproject.toml`
- `UI_TOUCHED` — any path under `worca-ui/`
- `UI_RUNTIME_TOUCHED` — any path under `worca-ui/app/` or `worca-ui/server/`
- `UI_NEW_FILES` — new files (untracked or added) under `worca-ui/server/` or `worca-ui/app/`
- `DOCS_TOUCHED` — any path under `docs-site/`

If nothing matches any category, print "no relevant changes — skipping precommit" and stop.

## Step 2: Python checks (if `PY_TOUCHED`)

```bash
ruff check .
pytest tests/
```

Report failures per-test with file:line. Do not bundle into "tests failed" — name each.

## Step 3: UI lint + vitest (if `UI_TOUCHED`)

```bash
cd worca-ui && npm run lint:fix && npx vitest run
```

Run from inside `worca-ui/` so config paths resolve. If `lint:fix` mutates files, stage them — they need to be in the commit.

## Step 4: Playwright (if `UI_RUNTIME_TOUCHED`)

```bash
cd worca-ui && npx playwright test --workers=1
```

**Must use `--workers=1`** — parallel workers cause flaky failures due to browser context contamination. If the chromium binary is missing, state that explicitly — do not silently skip.

If port collisions occur, fall back to per-file runs:

```bash
cd worca-ui && npx playwright test e2e/<spec>.spec.js --workers=1
```

## Step 5: npm package allowlist check (if `UI_NEW_FILES`)

For each new file under `worca-ui/server/` or `worca-ui/app/`:

```bash
cd worca-ui && npm pack --dry-run | grep <new-path>
```

If a new file does NOT appear in the output, the `files` glob in `worca-ui/package.json` is missing it. Extend the glob (e.g. `server/**/*.js` rather than `server/*.js`) and re-check. Missing files crash the published package silently — this check is non-negotiable.

## Step 6: Docs site build (if `DOCS_TOUCHED`)

```bash
cd docs-site && npm install && npm run build
```

Catches broken MDX, frontmatter, or `astro.config` errors before they reach the `docs-live` production deploy. If the build fails, STOP — do not commit.

## Step 7: Summary

Print a checklist showing which steps ran and the outcome:

```
[x] Python: ruff + pytest         OK
[x] UI lint + vitest              OK
[ ] Playwright                    skipped (no app/server changes)
[x] npm pack allowlist            OK (2 new files verified)
[x] docs-site build               OK
```

If any step failed, STOP and report — do not proceed to commit.
