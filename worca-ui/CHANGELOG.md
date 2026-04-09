# Changelog — @worca/ui

## 0.4.0

### Added
- Pipeline template selection on new-run page with styled dropdown (group headers, descriptions, indentation)

### Fixed
- Template dropdown contrast on selected row; show description below
- Prevent running badge from disappearing after pipeline start
- Scope parallel pipeline check to current project
- Move `pipeline.pid` to per-run directories for concurrent pipeline support

## 0.3.0

### Added
- Rich hover tooltips on all bead views — Kanban, dependency graph, and list (#74)
- Structured tooltip layout with copy button and interactive content
- `sl-tooltip` overlays for dependency graph nodes

### Fixed
- Add Paused section to dashboard
- Use `pipeline_status` instead of PID file for multi-active run detection

## 0.2.0

### Added
- W-035: Per-stage cost badges, web searches summary card, and cache breakdown tooltips

### Changed
- Remove `DEFAULT_PRICING` from UI; use worca-cc as single source of truth for pricing
- Rewrite costs API to read `token_usage` from `status.json`

### Fixed
- Convert beads-reader from sync to async to unblock event loop
- Improve pricing tab layout — field alignment, widths, and Server Tools table
- Report globally installed `@worca/ui` version in settings

## 0.1.1

### Added
- Force-cancel for stale pipeline runs
- Version info section in Settings → Preferences
- `--version` and `--help` flags for `worca-ui` CLI
- Move `source_repo` to global preferences; default to global mode

### Fixed
- Replace `better-sqlite3` with `bd` CLI in beads-reader
- Browser notifications not firing
- Prevent redirect on cold load of direct run URLs in multi-project mode

## 0.1.0-rc.3

### Added
- npm package published as `@worca/ui`
- CI release via `release-npm.yml` on `worca-ui-v*` tags
- `prepublishOnly` script (build + test)

### Changed
- Moved from `.claude/worca-ui/` to top-level `worca-ui/`
- Renamed package from internal to `@worca/ui`

## 0.1.0-rc.2

Manual npm publish for end-to-end validation.

## 0.1.0-rc.1

Initial npm publish (manual, `--tag next`).
