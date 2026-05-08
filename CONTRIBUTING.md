# Contributing to worca-cc

Thank you for your interest in contributing to worca-cc!

## Quick Start (Dogfooding Flow)

The fastest path to contributing is to let worca itself drive development on its own repo. The flow below takes you from a clean clone to a PR that was planned, implemented, and tested by the pipeline.

### 1. One-time setup

1. Clone the repo: `git clone https://github.com/SinishaDjukic/worca-cc.git`
2. Install both packages so you have the CLI and dashboard available globally:
   ```bash
   pip install worca-cc
   npm install -g @worca/ui
   ```
3. Start the dashboard: `worca-ui` (defaults to http://127.0.0.1:3400)
4. In the dashboard, open **Settings → Projects**, add your local `worca-cc` clone as a project, and confirm the install/update prompt when asked.

That's it — worca is now running *on* the worca repo, ready to plan and implement changes against itself.

> Prefer working from source (editable install, live reloads, pre-commit hooks)? See [Development Setup](#development-setup) below.

### 2. Propose a feature or bugfix

1. Open Claude Code inside the worca-cc repo: `cd worca-cc && claude`
2. Discuss the change with Claude directly. Cover:
   - Implications for both `worca-cc` (Python pipeline) and `worca-ui` (dashboard)
   - Testing and validation strategy
   - Backward compatibility
3. Ask Claude to draft a detailed plan into `docs/plans/W-NNN-<slug>.md`. Tell it to use the **next available W number** (check existing files in `docs/plans/`).
4. Have Claude commit and push the plan, then open a GitHub issue that links to it. The issue must follow the structure in [CLAUDE.md](./CLAUDE.md#github-issue-structure) — the pipeline parses the `## Plan` link to skip its own Planner stage.

### 3. Implement via the pipeline

1. In worca-ui, select the worca-cc project and click **New Pipeline**.
2. Choose **Start from GitHub issue** and paste the issue URL.
3. Pick a pipeline template — the default works for generic work, but **Feature Development** or **Bugfix** give tighter, role-specific prompts. Leave **Create a new branch** enabled.

The pipeline will plan (or reuse your plan), implement, test, and open a PR.

### 4. Validate the result

Once the PR is up, verify it two ways:

1. **Sanity check with a fresh Claude session.** Start a clean `claude` session anywhere and ask it to analyze the PR URL — an independent read catches issues the pipeline's own agents may have rationalized away.
2. **Apply the PR locally.** Clone worca-cc into a second folder and run:
   ```bash
   /worca-sync-pr /path/to/second-clone <pr_number>
   ```
   This checks out the PR in the target dir, installs that PR's worca version into it, and starts a project-scoped worca-ui on **port 3401** — so you can exercise the change without disturbing your main dashboard on 3400.

If it looks good, merge. If not, comment on the PR or reopen the issue with feedback.

---

## Development Setup

```bash
# Clone the repository
git clone https://github.com/SinishaDjukic/worca-cc.git
cd worca-cc

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dev dependencies (editable install)
pip install -e ".[dev]"
worca init .              # creates .claude/worca/ runtime copy

# Install git hooks and build the UI
npm install               # installs husky (pre-commit hooks)
cd worca-ui && npm install && npm run build && cd -
```

**Note:** `worca init --upgrade` overwrites `.claude/settings.json` with the latest package defaults. Put any machine-specific overrides in `settings.local.json` (which is gitignored and deep-merges on top). Use `worca init --check` for a dry-run that shows what would change without modifying anything.

The pre-commit hook runs automatically on every `git commit` and checks:
- **ruff** — Python linting
- **biome** — JavaScript linting and formatting (worca-ui)
- **esbuild** — UI bundle build

After modifying any source files in `worca-ui/app/`, rebuild the bundle:

```bash
cd worca-ui && npm run build
```

This runs esbuild to produce `app/main.bundle.js`, which the server loads by default. Without rebuilding, changes to the source files won't take effect.

### Running the dashboard (dev mode)

```bash
pnpm worca:ui                             # Build + start in global mode
pnpm worca:ui:restart                     # Build + restart
pnpm worca:ui:stop                        # Stop
```

## Project Structure

```
src/worca/               # Python package (pip-installable)
  orchestrator/          # Pipeline state machine, stages, prompt builder
  claude_hooks/          # Claude Code hook scripts
  scripts/               # Pipeline entry points (run_pipeline.py, run_multi.py)
  agents/core/           # Agent .md templates
  schemas/               # JSON schemas for structured agent output
  state/                 # Status JSON read/write, iteration tracking
  utils/                 # Claude CLI, beads, git, gh_issues helpers
  cli/                   # CLI entry points (worca init, worca run, etc.)
tests/                   # Python tests (pytest)
worca-ui/                # Dashboard (@worca/ui npm package)
  app/                   # Lit-HTML frontend
  server/                # Express + WebSocket server
docs/                    # Feature plans, screenshots
```

## Linting

```bash
# Python lint
ruff check .

# UI lint (JavaScript)
cd worca-ui && npm run lint

# Auto-fix lint issues
cd worca-ui && npm run lint:fix
```

## Running Tests

```bash
# Python tests
pytest tests/

# Pipeline integration tests (full pipeline against a mock Claude CLI)
pytest tests/integration/

# UI server tests
npx vitest run worca-ui/server/

# Browser e2e tests (must run serially)
cd worca-ui && npx playwright test --workers=1
```

`tests/integration/` (W-044) runs the full pipeline state machine against a mock Claude CLI at `tests/mock_claude/mock_claude.py` — no API calls, no real LLM cost. Each test spins up a temp git repo + worca runtime, so the suite is slower (~30-60s end to end). Requires the editable install (`pip install -e ".[dev]"`); signal-handling tests are skipped on Windows.

For coverage, use the centralized runner described in [CLAUDE.md](./CLAUDE.md#testing) — `python scripts/coverage.py ci` produces both terminal text and `coverage-out/coverage.json` for downstream tooling. Add `--include-unit-tests` when you need accurate per-module numbers for code exercised only by unit tests.

## Claude Code Skills

worca-cc ships with slash-command skills that automate common contributor workflows. Run these inside a Claude Code session (`claude` in your terminal).

### Development & Testing

| Skill | What it does |
|---|---|
| `/worca-install <path>` | First-time install of the pipeline into a target project. Copies runtime files, merges settings, installs skills, and registers the project in worca-ui. |
| `/worca-sync [path]` | Update an existing project with the latest pipeline files from your local worca-cc clone. Re-runs `worca init --upgrade`, syncs skills, and ensures project registration. Path is optional if `worca.source_repo` is already set. |
| `/worca-sync-commit <target> <ref>` | Check out a specific commit or branch in a target worca-cc clone, rebuild worca-ui, upgrade the Python runtime, and start a project-scoped UI. Useful for reviewing pipeline output at a particular point in history. Add `--clean` to discard uncommitted changes first. |
| `/worca-sync-pr <target> <pr>` | Same as above but checks out a GitHub PR by number or URL. Great for reviewing pipeline-generated PRs in an isolated clone. |
| `/worca-agent-override [agent] [instruction]` | Create or update per-project agent prompt overrides without modifying core templates. Supports append and replace modes with governance protection. |

**Typical dev-test cycle with skills:**

```bash
# 1. Make changes in worca-cc
cd ~/dev/worca-cc
# ... edit src/worca/, worca-ui/app/, etc.

# 2. Sync to your test project (inside a claude session)
cd ~/dev/my-test-project && claude
/worca-sync

# 3. Or review a PR's pipeline output in a separate clone
cd ~/dev/worca-cc && claude
/worca-sync-pr ~/dev/worca-cc-review 43

# 4. Or jump to a specific commit to compare behavior
/worca-sync-commit ~/dev/worca-cc-review abc1234
```

### Issue Triage

| Skill | What it does |
|---|---|
| `/worca-analyze <issue>` | End-to-end issue triage: analyze a GitHub issue, surface open design decisions with a recommended option for each, optionally append a `## Decisions` section to the issue body, recommend the most appropriate pipeline template, and optionally launch a worktree-based pipeline. |

Pass either a bare issue number (uses the current repo) or a full URL:

```bash
/worca-analyze 127
/worca-analyze https://github.com/SinishaDjukic/worca-cc/issues/127
```

What it does in order:

1. **Analyze** the issue body (and any files it references) into a structured report — TL;DR, scope, risk, open questions — anchored with `path:line` references.
2. **Decide** — for each open question, present 2-3 options with one marked **Recommended** and short rationale; you answer in one shot.
3. **Update the issue** — drafts a `## Decisions` section, shows the diff, and only writes via `gh issue edit` after explicit "yes". Never touches the `## Plan` section.
4. **Pick a template** — resolves user > project > built-in templates via `worca templates list --json` and recommends one (or surfaces top-2 for ambiguous cases) with a one-line config delta.
5. **Launch** — always worktree-based and detached, only after explicit confirmation. The skill prints the run ID and worktree path so you can tail it.

Analyses are cached at `.worca/analyses/issue-<N>.md` keyed by a SHA-256 of the issue body — re-running on an unchanged issue reuses the cached analysis but still re-prompts for decisions and template selection.

This complements the worca-ui "New Pipeline" flow described in [step 3 of the dogfooding flow](#3-implement-via-the-pipeline) — use the UI for click-driven setup, use `/worca-analyze` when you want a CLI-driven triage pass that also captures design decisions back into the issue.

### Releasing

| Skill | What it does |
|---|---|
| `/worca-rc` | Bump RC versions for both packages, commit, tag, and push. Versions are auto-detected — no arguments needed. CI handles publishing. |
| `/worca-release --version:micro` | Create a stable release (patch bump) for all packages. Strips any RC suffix, bumps, commits, tags, and pushes. |
| `/worca-release --version:minor` | Same but with a minor version bump. |
| `/worca-release --version:micro --package:worca-cc` | Release only the Python package. Use `--package:worca-ui` for npm only. |

Run `/worca-release` with no arguments to see current versions and recent tags.

## Code Style

- Python: enforced by [Ruff](https://docs.astral.sh/ruff/) (`ruff check .`)
- Line length: 100 characters
- Target: Python 3.8+

## Testing Changes in Projects

When developing worca-cc, you'll want to test your local changes in real projects without publishing a release.

### Setting the Worca Local Repo

Open the worca-ui dashboard (`http://127.0.0.1:3400`), go to **Settings > Preferences**, and set **Worca Local Repo** to the path of your locally cloned `worca-cc` repository (e.g. `~/dev/worca-cc`). This tells `worca init --upgrade` to copy pipeline files from your local clone instead of the installed package.

The Settings > Versions panel will also show the local repo path alongside installed/latest versions, so you can confirm it's configured.

### Syncing changes to a test project

After making changes in your local worca-cc repo, use the `/worca-sync` skill inside the target project to push your updates:

```
/worca-sync
```

This will:
1. Resolve the source repo from the project's `settings.json` (set during `/worca-install` or via the UI preference)
2. Run `worca init --upgrade` to sync `.claude/worca/`, merge settings, and update `.gitignore`
3. Copy shared skills (`worca-sync`, `worca-agent-override`) to the project
4. Register the project in worca-ui's multi-project selector if needed

You can also pass an explicit path: `/worca-sync ~/dev/worca-cc`

### Typical dev-test cycle

```bash
# 1. Make changes in worca-cc
cd ~/dev/worca-cc
# ... edit src/worca/, worca-ui/app/, etc.

# 2. Sync to your test project
cd ~/dev/my-test-project
claude                    # then type: /worca-sync

# 3. Run a pipeline to verify — preferred: worca-ui
#    Open http://127.0.0.1:3400, select the project, click "New Pipeline",
#    and start from a GitHub issue or prompt. This is the same path real
#    contributors use and exercises the full UI → server → orchestrator flow.
#
#    CLI fallback (headless/CI):
#    python .claude/scripts/run_pipeline.py --prompt "your test task"
```

## Cutting Release Candidates

Use the `/worca-rc` skill to bump RC versions for both packages, commit, tag, and push in one step:

```
/worca-rc
```

This will:
1. Read current versions from `pyproject.toml`, `src/worca/__init__.py`, and `worca-ui/package.json`
2. Increment the RC number (e.g. `0.6.0rc6` → `0.6.0rc7`, `0.1.0-rc.4` → `0.1.0-rc.5`)
3. Update all version files, commit, create both tags, and push

No arguments needed — versions are auto-detected. CI workflows handle publishing to PyPI and npm when the tags land.

## Creating Stable Releases

Use the `/worca-release` skill to bump to a stable version, commit, tag, and push:

```
/worca-release --version:micro              # bump patch for all packages
/worca-release --version:minor              # bump minor for all packages
/worca-release --version:micro --package:worca-cc   # Python only
/worca-release --version:minor --package:worca-ui   # npm only
```

This strips any RC suffix, applies the bump, updates all version files, commits, tags, and pushes. CI handles publishing to PyPI and npm.

Run `/worca-release` with no arguments to see current versions and recent tags.

## Releasing (Manual)

Two independent packages with independent version numbers and release cadences. Prefer using `/worca-release` above — these manual steps are for reference.

### Python pipeline (`worca-cc` on PyPI)

| Item | Value |
|---|---|
| Version source | `pyproject.toml` + `src/worca/__init__.py` |
| Tag format | `worca-cc-vX.Y.Z` |
| CI workflow | `.github/workflows/release-pypi.yml` |

Steps:

1. Bump version in **both** `pyproject.toml` and `src/worca/__init__.py`
2. Commit: `git commit -m "chore: bump worca-cc to X.Y.Z"`
3. Tag and push:
   ```bash
   git tag worca-cc-vX.Y.Z
   git push origin main && git push origin worca-cc-vX.Y.Z
   ```
4. CI validates tag matches pyproject.toml, builds wheel+sdist, publishes to PyPI (trusted publishing), creates GitHub Release with artifacts + checksums

### Dashboard (`@worca/ui` on npm)

| Item | Value |
|---|---|
| Version source | `worca-ui/package.json` |
| Tag format | `worca-ui-vX.Y.Z` |
| CI workflow | `.github/workflows/release-npm.yml` |

Steps:

1. Bump version in `worca-ui/package.json`
2. Commit: `git commit -m "chore: bump @worca/ui to X.Y.Z"`
3. Tag and push:
   ```bash
   git tag worca-ui-vX.Y.Z
   git push origin main && git push origin worca-ui-vX.Y.Z
   ```
4. CI validates tag matches package.json, builds, runs tests, publishes to npm

### Version table

| Package | Version source | Tag format |
|---|---|---|
| `worca-cc` | `pyproject.toml` + `src/worca/__init__.py` | `worca-cc-vX.Y.Z` |
| `@worca/ui` | `worca-ui/package.json` | `worca-ui-vX.Y.Z` |

Releases are independent — a UI fix doesn't require a Python release.

### Release artifacts

**worca-cc:** wheel (.whl), sdist (.tar.gz), checksums-sha256.txt — published to PyPI, attached to GitHub Release

**@worca/ui:** published to npm registry

### Verifying a PyPI download

```bash
pip download worca-cc --no-deps
sha256sum worca_cc-*.whl
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
