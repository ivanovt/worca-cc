# CLAUDE.md Load Mode (`claude_md_mode`)

By default Claude Code merges every `CLAUDE.md` it finds when walking up from the project root — user home, org-policy paths, and each ancestor directory. For ambient consumer projects this is fine. For hermetic, template-defined, or multi-project runs it can silently change agent behaviour across machines.

`claude_md_mode` gives you a per-run, per-template control over which files are loaded.

## Modes

| Value | Behaviour | Overlay written |
|-------|-----------|-----------------|
| `all` (default) | Standard Claude Code loading — no change | No overlay, no `--settings` flag |
| `project` | Project-root `CLAUDE.md` only | `claudeMdExcludes` list blocking home + org-policy + all ancestor paths; also excludes `CLAUDE.local.md` |
| `project+local` | Project-root `CLAUDE.md` + `CLAUDE.local.md` | Same blocklist, but `CLAUDE.local.md` is kept |
| `none` | No CLAUDE.md loading; auto-memory disabled | `{"autoMemoryEnabled": false, "claudeMdExcludes": ["**/CLAUDE.md", "**/CLAUDE.local.md", <home>, <org-policy paths>]}` |

## Precedence chain

```
--claude-md-mode <mode>          ← CLI flag (highest)
  ↓ (if not set)
template config.claude_md_mode   ← template explicitly sets it (deep-merge overlay wins)
  ↓ (if template doesn't set it)
worca.claude_md_mode             ← project settings.json (flows through even under a template)
  ↓ (if not set)
"all"                            ← built-in default (no overlay)
```

`claude_md_mode` is a **cross-template** project setting — unlike `worca.agents` or `worca.stages`, it is not stripped when a template is active. The project-level `worca.claude_md_mode` always applies as the base unless a template explicitly overrides it in its `config` block. This means `worca.claude_md_mode: "project"` in `settings.json` works correctly for hermetic runs regardless of which built-in template is used. Custom templates that need to pin a specific mode (e.g. `"none"` for no CLAUDE.md loading) can still do so via their `config` — the deep-merge overlay wins for scalars. See [configuration-precedence.md](./configuration-precedence.md) for the full template-owned-key model.

## Three constraints to know

**1. Blocklist-only.** `claudeMdExcludes` is a deny-list passed to Claude Code. For `project` and `project+local`, worca emits one pattern per ancestor directory (walked at run start) plus user-home and org-policy paths. This covers the common cases, but it can only block paths it knows about at launch time. Dynamic mounts or symlinks resolved after launch are not covered.

**2. `none` mode disables auto-memory as a side effect.** Claude Code's `autoMemoryEnabled: false` overlay disables the automatic memory subsystem (`~/.claude/memory/`). It does **not** by itself disable CLAUDE.md auto-discovery — those are separate concerns in Claude Code (per `claude --help` for `--bare`). To block CLAUDE.md as well, `none` mode also writes a broad `claudeMdExcludes` blocklist (`**/CLAUDE.md`, `**/CLAUDE.local.md`, plus the same enumerated user-home and org-policy paths used by `project`). If you want to suppress CLAUDE.md loading but keep auto-memory writes enabled, use `project` instead of `none`.

**3. Managed/org CLAUDE.md immunity.** The org-policy paths (`/etc/claude-code/CLAUDE.md`, `/Library/Application Support/ClaudeCode/CLAUDE.md`, `C:/ProgramData/ClaudeCode/CLAUDE.md`) are included in the blocklist for forward-compatibility, but the managed/org CLAUDE.md is loaded by Claude Code at a lower layer that `claudeMdExcludes` does not currently cover. Those patterns are emitted anyway so the behaviour is correct once the underlying Claude Code issue is resolved.

## Configuring it

**Per-run (CLI):**

```bash
python .claude/scripts/run_pipeline.py --prompt "..." --claude-md-mode project
python .claude/scripts/run_worktree.py --prompt "..." --claude-md-mode project
python .claude/scripts/run_fleet.py   --projects ... --claude-md-mode project
python .claude/scripts/run_workspace.py <parent-dir> --claude-md-mode project
```

**Project default (`settings.json`):**

```json
{
  "worca": {
    "claude_md_mode": "project"
  }
}
```

**Template config:**

```json
{
  "id": "hermetic-ci",
  "config": {
    "claude_md_mode": "project"
  }
}
```

**UI:** the New Run form has a CLAUDE.md Mode dropdown next to Max Beads. The default option shows the template-or-project resolved value. Selecting an explicit value overrides for that run only.

## When to use each mode

### `project` — hermetic workspace and fleet runs

The canonical use case. A workspace run coordinates N projects under `~/monorepo/`. Without mode control, every child pipeline inherits `~/monorepo/CLAUDE.md` (the parent directory), which can silently change agent behaviour across contributor machines.

```bash
# All workspace child pipelines see only their project-root CLAUDE.md
python .claude/scripts/run_workspace.py ~/monorepo --prompt "..." --claude-md-mode project
```

Fleet runs across heterogeneous machines benefit similarly: a developer running the fleet on a machine without the monorepo ancestor CLAUDE.md gets identical agent behaviour to CI.

### `project+local` — allow per-developer overrides in CLAUDE.local.md

Same as `project` but `CLAUDE.local.md` is kept. Useful when developers use `CLAUDE.local.md` for personal preferences (editor style, verbosity) that should persist even in hermetic mode.

### `none` — maximum isolation

Strips all CLAUDE.md and disables auto-memory. Appropriate for CI clean-room runs where any user-specific guidance would be non-deterministic. Note the auto-memory side effect (constraint #2).

### `all` — default, no change

Standard Claude Code behaviour. Use this (or omit the flag) for normal interactive runs where the ambient CLAUDE.md hierarchy is intentional.

## Observability

The resolved mode is recorded in `status.json` (`claude_md_mode` field, omitted when `"all"`) and emitted as the `pipeline.claude_md.mode_resolved` event (Tier 2, webhook/notification only). The run-detail UI shows a badge when mode is non-default.

The overlay JSON is written to `<run_dir>/claude_md_overlay.json` and passed to every agent subprocess via `--settings <path>`.
