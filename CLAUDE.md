# worca-cc

Autonomous software development pipeline combining orchestration with governance enforcement.

## Quick Start

```bash
# Install via /worca-install skill (recommended)
cd worca-cc && claude
# Then type: /worca-install /path/to/my-project

# Or manually copy .claude/ folder
cp -R .claude/ my-project/.claude/
cd my-project/worca-ui && npm install && npm run build && cd -

# Interactive mode
cd my-project && claude

# Autonomous mode
python .claude/scripts/run_pipeline.py --prompt "Add user auth"
```

## Architecture

10 stages: Preflight → Planner (Opus) → Plan Reviewer (Opus) → Coordinator (Opus) → Implementer(s) (Sonnet) → Tester (Sonnet) → Reviewer (Opus) → Guardian (Opus) → Learner (Opus)

Plan Review and Learn are disabled by default; enable via `worca.stages.plan_review.enabled` / `worca.stages.learn.enabled` in settings.json.

All governance enforced via Python hooks in `src/worca/claude_hooks/`.

## Project Structure

```
src/worca/               # Python package (pip-installable)
  orchestrator/          # Pipeline state machine, stages, prompt builder
  claude_hooks/          # Claude Code hook scripts (pre/post tool use, etc.)
  scripts/               # Pipeline entry points (run_pipeline.py, run_multi.py)
  agents/core/           # Agent .md templates (planner, coordinator, etc.)
  schemas/               # JSON schemas for structured agent output
  state/                 # Status JSON read/write, iteration tracking
  utils/                 # Claude CLI, beads, git, gh_issues helpers
  cli/                   # CLI entry points (worca init, worca run, etc.)
.claude/
  worca/                 # Runtime copy (created by `worca init .`, gitignored)
  agents/                # User-specific agent overrides
  settings.json          # Pipeline config under the "worca" key
tests/                   # Python tests (pytest)
docs/plans/              # Feature plans (W-NNN-slug.md)
worca-ui/                # Web UI (lit-html + Shoelace + esbuild, top-level npm package)
  app/                   # Source files (views/, utils/, styles.css, main.js)
  server/                # Express API server
```

## Developer Setup (dogfooding)

```bash
pip install -e ".[dev]"   # Editable install — import worca points to src/worca/
worca init .              # Creates .claude/worca/ runtime copy (gitignored)
cd worca-ui && npm install && npm run build && cd -
```

After editing `src/worca/`, run `worca init --upgrade` to refresh `.claude/worca/`.
Tests import from the package directly (`from worca.xxx import yyy`), so they use live source via the editable install.

## Configuration

Agent config in `.claude/settings.json` under the `worca` namespace. Key sections:
- `worca.stages` — enable/disable stages, override agents
- `worca.agents` — model and max_turns per agent
- `worca.models` — shorthand→full model ID mapping
- `worca.loops` — max iterations for test/review/planning retry loops
- `worca.circuit_breaker` — error classification and halt thresholds
- `worca.governance` — hook guards and dispatch rules

## Code Hosting

This project uses **GitHub** with the `gh` CLI. PR creation command:

```bash
gh pr create --title "..." --body "..."
```

The guardian agent uses this when creating PRs. Adapt this section for GitLab (`glab`), Bitbucket, or other hosting platforms.

## Development Approach

This project follows **TDD (Test-Driven Development)**:
1. Write a failing test first
2. Write minimal code to pass
3. Refactor

Implementer agents read this section to determine the testing methodology.

## Linting

```bash
ruff check .                                              # Python lint
cd worca-ui && npm run lint                       # UI lint (biome)
cd worca-ui && npm run lint:fix                   # Auto-fix UI lint issues
```

**CI enforces biome formatting strictly.** Always run `cd worca-ui && npm run lint` before committing any worca-ui changes (JS, server, app). Use `npm run lint:fix` to auto-fix formatting issues. Common biome rules: long ternaries must be split across lines, trailing commas required.

## Testing

```bash
pytest tests/                              # All Python tests
pytest tests/test_<module>.py              # Single module
npx vitest run worca-ui/server/    # UI server tests
cd worca-ui && npx playwright test --workers=1  # Browser e2e tests (must run serially)
```

Test naming: `tests/test_<module>.py` mirrors source module names. Pre-existing failures in unrelated tests should be ignored — only verify tests relevant to your changes.

**Playwright note:** Browser e2e tests must run with `--workers=1` (serial). Parallel workers cause flaky failures due to browser context contamination between isolated test servers.

## Governance

- Only the **guardian** agent may run `git commit` (enforced by pre_tool_use hook checking `WORCA_AGENT` env var)
- Source file writes are blocked until `MASTER_PLAN.md` exists (plan_check hook, only active when `WORCA_AGENT` is set)
- The post_tool_use hook has a test gate: 2 consecutive pytest failures block further tool calls
- Subagent dispatch is restricted per agent role (tracking hook)

## worca-ui Development

**Badge color language:** all `sl-badge` variants and status colors follow the guide in [`worca-ui/docs/badge-color-language.md`](./worca-ui/docs/badge-color-language.md). Read it before adding or modifying badges — blue means active, orange means caution, green means done.

After modifying any source files in `worca-ui/app/`, rebuild the bundle:

```bash
cd worca-ui && npm run build
```

This runs esbuild to produce `app/main.bundle.js`. Without rebuilding, changes won't take effect.

**Before committing any worca-ui changes**, always run lint and tests locally to catch failures before they reach CI:

```bash
cd worca-ui && npm run lint:fix && npx vitest run
```

Run both checks from inside `worca-ui/` so config paths resolve correctly. Do not commit if either fails — fix them first.

### Running the UI

```bash
pnpm worca:ui                        # Build + start in global mode (port 3400, default)
pnpm worca:ui:stop                   # Stop the global server
pnpm worca:ui:restart                # Rebuild + restart in global mode
PORT=3401 pnpm worca:ui              # Custom port via env var
pnpm worca:ui -- --port 3401         # Custom port via flag
pnpm worca:ui -- --project /path     # Single-project mode
pnpm worca:ui -- --help              # Show all commands and options
pnpm worca:ui -- --version           # Print version
```

The `--port` flag takes precedence over the `PORT` env var. `HOST` / `--host` works the same way (default `127.0.0.1`).

Global mode (the default) starts the UI without a fixed project root, serving all projects registered in `~/.worca/projects.d/`. Use `--project` to scope to a single project.

## Migrating

User-facing upgrade and cleanup steps live in [`MIGRATION.md`](./MIGRATION.md).

## Releasing

Two independent packages — release by pushing tags. **Do not use twine or npm publish manually; CI handles publishing.**

| Package | Version source | Tag format |
|---|---|---|
| `worca-cc` | `pyproject.toml` + `src/worca/__init__.py` (both must match) | `worca-cc-vX.Y.Z` |
| `@worca/ui` | `worca-ui/package.json` | `worca-ui-vX.Y.Z` |

Steps (same for both):

1. Bump version in the version source file(s)
2. Commit and push
3. Tag and push tag:
   ```bash
   git tag worca-cc-v0.6.0rc6    # or worca-ui-v0.1.0-rc.4
   git push origin <tag>
   ```
4. CI validates tag matches version, builds, tests, and publishes (PyPI via trusted publishing, npm via `NPM_TOKEN` secret)

Releases are independent — a UI fix doesn't require a Python release.

Update commands for users:
```bash
pip install --upgrade worca-cc==X.Y.Z
npm install -g @worca/ui@X.Y.Z
```

## Plans & Roadmap

- Feature tracking lives in **GitHub Issues**: https://github.com/SinishaDjukic/worca-cc/issues
- Labels: `area:cc` / `area:ui` for component, `P0`-`P4` for priority
- When a feature is completed, close the GitHub issue
- Bead-run linking uses labels (`run:{run_id}`), not `external_ref`

### GitHub Issue Structure

Issues must follow this structure so the pipeline can auto-detect plan files when started with `--source gh:issue:N`:

```markdown
## Problem

<What's wrong or missing — 2-5 sentences>

## Proposal

<What to build and how — bullet points or short paragraphs>

## Considerations

<Trade-offs, edge cases, dependencies — optional>

## Plan

- [docs/plans/W-NNN-short-description.md](https://github.com/SinishaDjukic/worca-cc/blob/master/docs/plans/W-NNN-short-description.md)
```

**Key rules:**
- Title format: `W-NNN: Short Description`
- Labels: one of `area:cc` / `area:ui` + one of `P0`-`P4`
- The `## Plan` section must contain a markdown link to `docs/plans/*.md` using an absolute blob URL (e.g. `https://github.com/SinishaDjukic/worca-cc/blob/main/docs/plans/W-NNN.md`) — the pipeline parses this link and skips the PLAN stage when the file exists
- If no plan link is present, the pipeline runs the Planner to generate one
- Plan files use the naming convention `W-NNN-short-description.md` in `docs/plans/`
- When asked to write a new plan, follow the structure and conventions in [`docs/plans/_TEMPLATE.md`](./docs/plans/_TEMPLATE.md)
