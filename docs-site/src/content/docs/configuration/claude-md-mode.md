---
title: CLAUDE.md load mode
description: Control which CLAUDE.md files Claude Code loads for every agent in a run — per run, per template, and at the CLI.
sidebar:
  order: 6
---

By default Claude Code merges every `CLAUDE.md` file it finds while walking up from the project root — user home, org-policy paths, and each ancestor directory. For ambient interactive use that's fine. For **hermetic**, **template-defined**, or **multi-project** runs it can silently change agent behaviour across machines, because different contributors have different ancestor hierarchies.

`worca.claude_md_mode` is a per-run, per-template control that pins what gets loaded.

## The four modes

| Value | What loads | When to use |
|---|---|---|
| **`all`** *(default)* | Standard Claude Code behaviour — every ancestor `CLAUDE.md`, user-home, org-policy paths. | Normal interactive runs where the ambient hierarchy is intentional. |
| **`project`** | Project-root `CLAUDE.md` only. | Hermetic workspace and fleet runs — every contributor gets identical agent behaviour regardless of their directory layout. |
| **`project+local`** | Project-root `CLAUDE.md` + `CLAUDE.local.md`. | Same as `project`, but keeps per-developer overrides in `CLAUDE.local.md`. |
| **`none`** | Nothing. Auto-memory writes (`~/.claude/memory/`) are also disabled as a side effect. | Maximum isolation — CI clean-room runs where any user-specific guidance would be non-deterministic. |

## Setting the mode

The launcher's **Advanced options** group has a **CLAUDE.md Mode** dropdown next to **Max Beads**. The default option reflects the template-or-project resolved value; picking an explicit option overrides for that run only.

![The launcher's CLAUDE.md Mode dropdown open: Template Default: all (selected), Explicit: all, Explicit: project, Explicit: project+local, Explicit: none.](/screenshots/claude-md-mode/01-new-run-dropdown.png)

A template can pin a mode in its **Pipeline** tab, in the section between **Approval Gates** and **Loops**:

![The Pipeline Templates editor's CLAUDE.md Load Mode section: a single Mode dropdown with the "Not set (inherit project)" passthrough as the default, plus the explanatory paragraph above it.](/screenshots/claude-md-mode/02-template-editor-section.png)

Leaving the template field at **Not set** means the project's `worca.claude_md_mode` (or the `all` default) applies. Setting it to an explicit value means the template pins it for every run it owns — useful for a `hermetic-ci` template that needs to be reproducible across every CI runner.

Project-wide, you can pin a default in `.claude/settings.json`:

```jsonc
{
  "worca": {
    "claude_md_mode": "project"
  }
}
```

Or per-run on the CLI:

```bash
python .claude/scripts/run_pipeline.py  --prompt "..." --claude-md-mode project
python .claude/scripts/run_worktree.py  --prompt "..." --claude-md-mode project
python .claude/scripts/run_fleet.py     --projects ... --claude-md-mode project
python .claude/scripts/run_workspace.py <parent>     --claude-md-mode project
```

## Precedence

```
--claude-md-mode <mode>          ← CLI flag (highest)
  ↓ (if not set)
template config.claude_md_mode   ← template editor → Pipeline tab → CLAUDE.md Load Mode
  ↓ (if template doesn't set it)
worca.claude_md_mode             ← project settings.json
  ↓ (if not set)
"all"                            ← built-in default
```

`claude_md_mode` is a **cross-template** project setting — unlike `worca.agents` or `worca.stages`, it is **not** stripped from the merge base when a template is active. A `worca.claude_md_mode: "project"` value in your project settings continues to apply under every built-in template that doesn't explicitly override it.

## Three constraints to know

**1. Blocklist-only.** Claude Code only exposes `claudeMdExcludes` (a deny-list). For `project` and `project+local`, worca walks the ancestor chain at run start and emits one pattern per ancestor directory plus user-home and org-policy paths. This covers the common cases but can only block paths that exist at launch time — dynamic mounts or symlinks resolved later are not covered.

**2. `none` mode disables auto-memory as a side effect.** Claude Code's `autoMemoryEnabled: false` overlay disables the automatic memory subsystem. It does **not** by itself disable CLAUDE.md auto-discovery — those are separate concerns. To block CLAUDE.md as well, `none` mode also writes a broad `claudeMdExcludes` blocklist. If you want to suppress CLAUDE.md loading but keep auto-memory writes, use `project` instead of `none`.

**3. Managed/org CLAUDE.md immunity.** The org-policy paths (`/etc/claude-code/CLAUDE.md`, `/Library/Application Support/ClaudeCode/CLAUDE.md`, `C:/ProgramData/ClaudeCode/CLAUDE.md`) are included in the blocklist for forward compatibility, but the managed/org CLAUDE.md is loaded by Claude Code at a lower layer that `claudeMdExcludes` does not currently cover. Treat managed CLAUDE.md as always-on by design.

## Observability

The resolved mode lands in `status.json` (`claude_md_mode` field, omitted when `"all"`) and emits as the `pipeline.claude_md.mode_resolved` event (Tier 2 — webhook and chat-notification only).

The overlay JSON for non-`all` modes is written to `<run_dir>/claude_md_overlay.json` and passed to every agent subprocess via `--settings <path>`.

## See also

- [Settings overview](/configuration/settings-overview/) — `worca.claude_md_mode` placement in `settings.json`.
- [Configuration precedence](/configuration/precedence/) — why `claude_md_mode` is cross-template, not template-owned.
- [Launching a run](/running-pipelines/launching-a-run/) — the CLAUDE.md Mode dropdown in context.
