# Changelog — worca-cc

## 0.9.0

### Added
- Pipeline template selection on new-run page and display in run views
- Template agent prompt overrides wired through to overlay resolver

### Fixed
- Respect `milestones.plan_approval=false` to auto-approve plans
- Block parallel pipelines on same project; remove `_archive_run`
- Move `pipeline.pid` to per-run directories for concurrent pipeline support
- Use sonnet for quick-fix coordinator; remove budget overrides from all templates

## 0.8.0

### Added
- Pipeline templates system (W-016) — named configurations that define stage flow, agent selection, and governance rules per work type; built-in templates: `feature`, `bugfix`, `quick-fix`, `incident-analysis`, `refactor`

## 0.7.0

### Added
- W-035: Complete usage object logging with model-specific pricing (Opus 4.6, Sonnet 4.6, Haiku 4.5), web search/fetch cost tracking, and cache tier breakdown

### Changed
- Remove `DEFAULT_PRICING` from UI; use worca-cc `settings.json` as single source of truth for pricing

### Fixed
- Add beads fingerprint upgrade to `worca init`; fix missing await in `list-beads-issues`

## 0.6.1

### Fixed
- Stabilization release from 0.6.0rc series (packaging and CI fixes)

## 0.6.0

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
