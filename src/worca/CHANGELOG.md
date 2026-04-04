# Changelog — worca-cc

## 0.6.0rcN (unreleased)

### Added
- pip-installable package (`pip install worca-cc`)
- `worca` CLI: `worca init`, `worca run`, `worca --version`
- PyPI trusted publishing via GitHub Actions
- GitHub Release creation with wheel/sdist artifacts

### Changed
- Repo restructured: pipeline code moved from `.claude/worca/` to `src/worca/`
- Agent templates moved from `.claude/agents/core/` to `src/worca/agents/core/`
- Hook scripts moved from `.claude/hooks/` to `src/worca/claude_hooks/`
- Agent overrides dir simplified from `.claude/agents/overrides/` to `.claude/agents/`
- `release.yml` merged into `release-pypi.yml`
- `upload-artifact`/`download-artifact` actions bumped from v4 to v5

## 0.5.0

Initial tagged release (pre-packaging).
