# Contributing to worca-cc

Thank you for your interest in contributing to worca-cc!

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

# UI server tests
npx vitest run worca-ui/server/

# Browser e2e tests (must run serially)
cd worca-ui && npx playwright test --workers=1
```

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

# 3. Run a pipeline to verify
python .claude/scripts/run_pipeline.py --prompt "your test task"
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
