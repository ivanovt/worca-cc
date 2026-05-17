# W-054: Configurable per-agent tool / skill / subagent dispatch governance

**Status:** Draft
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-05-17
**Depends on:** W-038 (configurable subagent dispatch — establishes today's settings-driven dispatch shape)

## Problem

Worca's dispatch governance is split across two enforcement layers that are wired up
inconsistently:

1. **Tool blacklist is hardcoded.** `src/worca/utils/claude_cli.py:143` passes a fixed
   `--disallowedTools "Skill,EnterPlanMode,EnterWorktree,TodoWrite"` argument to every agent
   subprocess. There is no settings.json knob — projects cannot enable a single skill or relax
   a single tool without editing the package. The hardcoded `Skill` block in particular makes
   every project-specific skill (lint wrappers, code-review skills, doc-management skills,
   the `frontend-design`/`claude-api`/`simplify` family shipped by Anthropic plugins)
   unreachable from a pipeline.
2. **Subagent dispatch is configurable but shape-limited.** `worca.governance.subagent_dispatch`
   in `.claude/settings.json:277` forces enumerating `Explore` across all eight agent roles,
   has no `_defaults` fallback, and quietly ignores everything other than per-agent allow lists.
   The hard denylist (`general-purpose`, `src/worca/hooks/tracking.py:26`) lives next to the
   defaults but uses a different mechanism.
3. **Skills have no governance layer at all.** Because the `Skill` tool is wholesale blocked at
   the CLI flag, there is no per-agent allow/deny model for skills. Once we unblock `Skill`,
   the pipeline gains a brand-new dispatch dimension with no controls.

User-facing impact: developers cannot share project-specific Claude Code skills or
subagents with their pipeline. The result is that worca pipelines burn tokens reimplementing
work that a single `Skill` invocation could shortcut, and developers either fork worca to
remove the disallow flag or accept the missing capability silently.

## Proposal

Unify the three dimensions under one `worca.governance.dispatch.{tools, skills, subagents}`
config block with a consistent three-tier model:

- `always_disallowed` — non-overridable hard deny (worca-internal footguns).
- `default_denied` — blocked unless an agent explicitly names them in `per_agent_allow`;
  the `"*"` wildcard does **not** include them.
- `per_agent_allow` — per-agent allow list with `_defaults` fallback. Supports `"*"` (all
  available minus the two deny tiers) and named entries, including a mixed `["*", "extra"]`
  form that means "wildcard plus these specific opted-in items."

The wildcard makes the common case ("let my agents use any subagent I have configured")
one line of config. The `default_denied` tier solves the "useful in some pipelines, dangerous
in others" cases (e.g. `review`, `feature-dev:feature-dev`) without removing them from the
project entirely. Telemetry surfaces which dispatches went through via `*` so drift is
visible.

## Design

### 1. Current state

#### 1.1 Hardcoded tool blacklist (`src/worca/utils/claude_cli.py:133-144`)

```python
cmd = [
    *_claude_bin,
    "-p",
    cli_prompt,
    "--agent",
    agent,
    "--output-format",
    output_format,
    "--no-session-persistence",
    "--dangerously-skip-permissions",
    "--disallowedTools", "Skill,EnterPlanMode,EnterWorktree,TodoWrite",
]
```

The list is a string literal in `build_command()`. Every agent subprocess gets the same
disallow set. No settings.json passes through.

#### 1.2 Subagent dispatch (`src/worca/hooks/tracking.py:12-21`, `:113-130`)

```python
DEFAULT_SUBAGENT_DISPATCH = {
    "planner":      {"Explore"},
    "coordinator":  set(),
    "implementer":  {"Explore"},
    "tester":       {"Explore"},
    "guardian":     {"Explore"},
    "reviewer":     {"Explore"},
    "plan_reviewer":{"Explore"},
    "learner":      {"Explore"},
}

_SUBAGENT_DENYLIST = frozenset({"general-purpose"})
```

`check_dispatch()` returns allow only when `child_agent in rules[parent_agent]`. The denylist
short-circuits with a fixed reason string. Settings override via
`worca.governance.subagent_dispatch.<agent> = [...]` *replaces* the per-agent allow set
(`tracking.py:76`).

#### 1.3 No skill governance layer

The `Skill` tool is blanket-disallowed at the CLI level, so there is no settings key, no
hook, no UI surface for skills. The `subagent_start.py` hook fires on `Agent(...)` calls,
not on `Skill(...)` calls.

#### 1.4 UI surface (`worca-ui/app/views/settings.js:151-180`, `:1141-1200`,
`worca-ui/app/views/dispatch-tag-state.js`)

`DEFAULT_GOVERNANCE.subagent_dispatch` mirrors the Python defaults. The settings page
renders one tag input per agent role and writes back through
`POST /api/projects/:id/settings`. `SUBAGENT_DENYLIST = new Set(['general-purpose'])`
mirrors the Python frozenset with a comment requiring manual sync. There is no UI for
tool or skill governance.

### 2. Three-tier resolution model

Each of `tools`, `skills`, and `subagents` has the same JSON shape:

```jsonc
{
  "always_disallowed": [...],   // tier 1 — hard deny, non-overridable
  "default_denied":    [...],   // tier 2 — blocked unless named explicitly
  "per_agent_allow": {          // tier 3 — per-agent allow list
    "_defaults": [...],         //          fallback for agents not explicitly listed
    "<agent>":   [...]          //          replaces _defaults for this agent
  }
}
```

#### 2.1 Resolution algorithm

For a given (agent, candidate) pair the hook computes:

```
def is_allowed(section, agent, candidate, all_known):
    # Tier 1 — hard deny wins everything
    if matches_any(candidate, section.always_disallowed):
        return (False, "always_disallowed")

    # Resolve the agent's effective allow list (replace semantics)
    entry = section.per_agent_allow.get(agent, section.per_agent_allow.get("_defaults", []))

    if "*" in entry:
        # Wildcard expands to "everything known" minus the two deny tiers,
        # then adds any explicitly-named extras from the same entry.
        allowed = (all_known - set(section.always_disallowed)
                              - set(section.default_denied))
        allowed |= {x for x in entry if x != "*"}
    else:
        allowed = set(entry)

    if candidate in allowed:
        via = "wildcard" if "*" in entry and candidate not in entry else "explicit"
        return (True, via)
    return (False, "not_in_allow_list")
```

#### 2.2 Mixed `["*", "extra"]` syntax

The mixed form is the escape hatch for default_denied items. Example: reviewer agent wants
the wildcard set *plus* the default-denied `review` skill:

```jsonc
"skills": {
  "default_denied": ["review", "security-review"],
  "per_agent_allow": {
    "_defaults": ["*"],
    "reviewer":  ["*", "review", "security-review"]
  }
}
```

Without the mixed form, the reviewer would have to enumerate every skill it wants — the
exact pain point W-054 exists to fix.

#### 2.3 Why replace, not union, for per-agent vs `_defaults`

Matches today's `tracking.py:76` behavior (zero behavior change for currently-configured
projects) and keeps the resolution algorithm predictable. A union would mean adding any
per-agent entry silently inherits the defaults too — projects that want lockdown for one
specific agent would have to fight the merge. Replace is the safer default.

### 3. Skill section

#### 3.1 `always_disallowed` (non-overridable)

These skills are pipeline-internal footguns and must never run in a pipeline subprocess,
regardless of project config:

| Category | Skills |
|---|---|
| Pipeline-recursion | `loop`, `schedule` |
| Pipeline-spawning | `worca-*` glob — `worca-install`, `worca-rc`, `worca-release`, `worca-sync`, `worca-sync-pr`, `worca-sync-commit`, `worca-analyze`, `worca-agent-override` |
| Governance self-modification | `update-config`, `hookify:hookify`, `hookify:configure`, `hookify:list`, `hookify:writing-rules` |
| Project-memory overwrite | `init` |

The denylist supports exact names *and* a simple glob — only `worca-*`-style prefix globs
are honored in v1 (no `?` or character classes; new patterns require a code change). This
keeps the JSON readable as new worca skills land.

#### 3.2 `default_denied` (configurable, off by default)

Skills that conflict with pipeline stages or duplicate work already done by an agent.
Projects can opt in per-agent if they want, but `["*"]` alone does not include them.

| Skill | Reason it's not in `*` |
|---|---|
| `review` | Duplicates reviewer-stage work; useful only when project deliberately wants a second-opinion review during implement. |
| `security-review` | Duplicates reviewer-stage security check; opt-in for security-sensitive guardian runs. |
| `feature-dev:feature-dev` | Would launch nested feature development inside an already-feature-developing pipeline. |
| `claude-md-management:revise-claude-md` | Modifies CLAUDE.md mid-pipeline; useful for learner stage only. |
| `claude-md-management:claude-md-improver` | Same — large multi-file modifications to project memory. |

A project that wants reviewer + guardian to use `review` and `security-review` writes:

```jsonc
"skills": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "reviewer":  ["*", "review"],
    "guardian":  ["*", "review", "security-review"]
  }
}
```

#### 3.3 `per_agent_allow._defaults`

Default is `["*"]` — developers usually have project-specific skills and the denylist
already covers the dangerous cases. The wildcard covers project-defined skills automatically
as they're added.

### 4. Tools section — narrower wildcard contract

Tools differ from skills/subagents in one critical way: Claude Code's CLI takes
`--disallowedTools <list>`, an enumeration. To honor a *named* allowlist we would have to
compute the complement against a moving universe (built-ins + every MCP tool registered at
runtime). That inversion is brittle.

For v1, the tools section honors only two values:

- `"*"` (or its sugar form `["*"]`) — pass `--disallowedTools <always_disallowed>` only.
- `[]` — same as `*` for the per-agent allow purpose; no extra disallows beyond tier 1.

Named-tool entries are accepted in the JSON but emit a startup warning and are ignored.
The mixed `["*", "extra"]` form has no meaning for tools (there is no `default_denied`
for tools) and is normalized to `["*"]`. Documenting this asymmetry up front is cleaner
than pretending the inversion problem is solvable.

`always_disallowed` defaults: `["EnterPlanMode", "EnterWorktree", "TodoWrite"]`. Note
`Skill` is *removed* — it is now controlled via the skills section.

`default_denied`: empty by default. Reserved for future use (e.g. if Claude Code ships a
`Write` variant we want gated).

### 5. Subagents section

#### 5.1 `always_disallowed`

`["general-purpose"]` — same as today's `_SUBAGENT_DENYLIST`. Reason unchanged: a
general-purpose agent can fork unbounded invisible work the pipeline cannot observe.

#### 5.2 `default_denied`

Empty by default. Reserved for future use (e.g. a `*-publisher` family that should require
explicit opt-in).

#### 5.3 `per_agent_allow._defaults`

`["Explore"]` — preserves today's behavior. Subagents have asymmetric blast radius vs.
tools (one subagent dispatch can do an arbitrary amount of work in a child context), so
opt-in to broader access stays the rule. Developers who want all subagents available write
`"_defaults": ["*"]` explicitly.

### 6. Settings.json end-to-end shape

After migration, a fresh `.claude/settings.json` has:

```jsonc
"worca": {
  "governance": {
    "guards": { /* unchanged */ },
    "test_gate_strikes": 2,
    "dispatch": {
      "tools": {
        "always_disallowed": ["EnterPlanMode", "EnterWorktree", "TodoWrite"],
        "default_denied":    [],
        "per_agent_allow":   { "_defaults": ["*"] }
      },
      "skills": {
        "always_disallowed": [
          "loop", "schedule",
          "worca-*",
          "update-config",
          "hookify:hookify", "hookify:configure", "hookify:list", "hookify:writing-rules",
          "init"
        ],
        "default_denied": [
          "review", "security-review",
          "feature-dev:feature-dev",
          "claude-md-management:revise-claude-md",
          "claude-md-management:claude-md-improver"
        ],
        "per_agent_allow": { "_defaults": ["*"] }
      },
      "subagents": {
        "always_disallowed": ["general-purpose"],
        "default_denied":    [],
        "per_agent_allow":   { "_defaults": ["Explore"] }
      }
    }
  }
}
```

### 7. Hook implementation

#### 7.1 `src/worca/hooks/tracking.py` — generalize to support all three sections

Replace the section-specific constants with a shared loader:

```python
def _load_dispatch_section(section: str, settings_override=None) -> dict:
    """Load worca.governance.dispatch.{tools,skills,subagents}.

    Returns the normalized section dict with all three tiers populated.
    """
    raw = (
        (settings_override or _load_settings())
        .get("worca", {})
        .get("governance", {})
        .get("dispatch", {})
        .get(section, {})
    )
    defaults = _DISPATCH_DEFAULTS[section]
    return {
        "always_disallowed": list(raw.get("always_disallowed", defaults["always_disallowed"])),
        "default_denied":    list(raw.get("default_denied",    defaults["default_denied"])),
        "per_agent_allow":   {**defaults["per_agent_allow"], **raw.get("per_agent_allow", {})},
    }


def check_allowed(section: str, agent: str, candidate: str, all_known: set) -> tuple:
    """Returns (allowed: bool, reason: str, via: 'wildcard'|'explicit'|None)."""
    cfg = _load_dispatch_section(section)
    if _matches_any(candidate, cfg["always_disallowed"]):
        return (False, "always_disallowed", None)
    entry = cfg["per_agent_allow"].get(agent, cfg["per_agent_allow"].get("_defaults", []))
    has_wildcard = "*" in entry
    explicit = {x for x in entry if x != "*"}
    if has_wildcard:
        allowed = (all_known - set(cfg["always_disallowed"]) - set(cfg["default_denied"])) | explicit
    else:
        allowed = explicit
    if candidate in allowed:
        via = "explicit" if candidate in explicit else "wildcard"
        return (True, "ok", via)
    return (False, "not_in_allow_list", None)
```

The existing `check_dispatch()` becomes a thin shim over `check_allowed("subagents", ...)`
for backward compatibility with the `SubagentStart` hook.

#### 7.2 New `src/worca/claude_hooks/skill_use.py` hook

Since skills will be allowed through the CLI flag (see §8), we need a hook that fires on
every skill invocation. This is the same shape as `subagent_start.py`:

```python
def main():
    data = json.load(sys.stdin)
    parent = os.environ.get("WORCA_AGENT", "")
    skill = data.get("skill_name", "")
    all_known = _enumerate_skills_from_hook_payload(data)
    allowed, reason, via = check_allowed("skills", parent, skill, all_known)
    if allowed:
        emit_from_hook("pipeline.hook.skill_allowed", {
            "parent_agent": parent, "skill": skill, "via": via,
        })
        sys.exit(0)
    emit_from_hook("pipeline.hook.skill_blocked", {
        "parent_agent": parent, "skill": skill, "reason": reason,
    })
    print(reason, file=sys.stderr)
    sys.exit(2)
```

Wired in `.claude/settings.json` `hooks.PreToolUse` with matcher `Skill`.

#### 7.3 Telemetry — add `via` field

Both `pipeline.hook.dispatch_allowed` (existing) and `pipeline.hook.skill_allowed` (new)
gain a `via: "wildcard" | "explicit"` field. The UI reads this to render the
wildcard-allowed counter on the Run Detail Governance section.

### 8. `claude_cli.py` — drive disallows from settings

Replace the hardcoded string with a settings lookup, called once per agent:

```python
def build_command(prompt, agent, *, settings=None, ...):
    ...
    agent_name = os.path.splitext(os.path.basename(agent))[0]
    disallowed_tools = _resolve_tool_disallows(agent_name, settings)
    cmd = [
        *_claude_bin, "-p", cli_prompt, "--agent", agent,
        "--output-format", output_format,
        "--no-session-persistence", "--dangerously-skip-permissions",
        "--disallowedTools", ",".join(disallowed_tools),
    ]
    ...

def _resolve_tool_disallows(agent_name: str, settings: dict | None) -> list[str]:
    cfg = _load_dispatch_section("tools", settings)
    # Tier 1 always applies
    disallows = list(cfg["always_disallowed"])
    entry = cfg["per_agent_allow"].get(
        agent_name, cfg["per_agent_allow"].get("_defaults", ["*"])
    )
    # Tools section only honors "*" / [] for per-agent — anything else gets stripped + warned
    has_wildcard = "*" in entry or len(entry) == 0
    if not has_wildcard:
        print(
            f"[worca] tools.per_agent_allow.{agent_name} contains named tools; "
            f"only '*' or [] are honored in v1 — falling back to wildcard",
            file=sys.stderr,
        )
    # Skill stays out of the disallow list — it now goes through the skills hook
    return [t for t in disallows if t != "Skill"]
```

Note: `Skill` is dropped from the disallow list entirely. Governance moves to the new
PreToolUse hook (§7.2), so the model gains the capability but each invocation is checked.

### 9. Migration on `worca init --upgrade`

`src/worca/cli/init.py` already migrates `governance.dispatch → governance.subagent_dispatch`
(`:204`). We extend it to migrate the new shape:

```python
def _migrate_dispatch_governance(governance_cfg: dict, changes: list[str]) -> None:
    """Migrate flat subagent_dispatch -> nested dispatch.subagents (W-054)."""
    if "subagent_dispatch" not in governance_cfg:
        return
    old = governance_cfg.pop("subagent_dispatch")
    dispatch = governance_cfg.setdefault("dispatch", {})
    subagents = dispatch.setdefault("subagents", {})
    # Preserve user's per-agent values verbatim under per_agent_allow
    per_agent = subagents.setdefault("per_agent_allow", {})
    per_agent.update(old)
    # Fill in the always_disallowed / default_denied defaults if missing
    subagents.setdefault("always_disallowed", _DISPATCH_DEFAULTS["subagents"]["always_disallowed"])
    subagents.setdefault("default_denied",    _DISPATCH_DEFAULTS["subagents"]["default_denied"])
    # Add tools + skills sections with defaults
    dispatch.setdefault("tools",  copy.deepcopy(_DISPATCH_DEFAULTS["tools"]))
    dispatch.setdefault("skills", copy.deepcopy(_DISPATCH_DEFAULTS["skills"]))
    # Drop legacy keys
    governance_cfg.pop("_dispatch_legacy", None)
    changes.append(
        "  governance.subagent_dispatch -> governance.dispatch.subagents "
        "(W-054 — tools and skills sections added with defaults)"
    )
```

Old shapes that still pass through cleanly:

| Old key | New location |
|---|---|
| `governance.dispatch` (W-038 legacy) | dropped if W-038 migration ran; else migrated to `governance.dispatch.subagents.per_agent_allow` |
| `governance.subagent_dispatch` | `governance.dispatch.subagents.per_agent_allow` |
| `governance._dispatch_legacy` | dropped (stale artifact) |

### 10. UI changes (worca-ui)

#### 10.1 Settings page — full editor for all three sections

Today `worca-ui/app/views/settings.js:1141-1200` renders one card per agent with a tag input
for `subagent_dispatch`. We replace that with three cards (Tools / Skills / Subagents), each
containing:

```
+--------------------------------------------------------------+
| Tools                                                        |
+--------------------------------------------------------------+
| Always disallowed (non-overridable)                          |
| [EnterPlanMode] [EnterWorktree] [TodoWrite]   (struck-through, locked) |
|                                                              |
| Default denied (blocked unless explicitly named)             |
| (empty for tools)                                            |
|                                                              |
| Per-agent allow                                              |
|   _defaults: [*]                                             |
|   planner:   [*]    [edit]                                   |
|   ...                                                        |
+--------------------------------------------------------------+
```

The `*` chip renders distinctly — filled background, "any" label, hover tooltip explaining
the expansion rule. Named chips render with the current Shoelace tag style.

#### 10.2 New shared component `app/views/dispatch-section.js`

Extracts the rendering of one `dispatch.{tools|skills|subagents}` section. Inputs:

```js
dispatchSectionView({
  section,                 // 'tools' | 'skills' | 'subagents'
  config,                  // {always_disallowed, default_denied, per_agent_allow}
  knownItems,              // for autocomplete (fetched from /api/tools, /api/skills, /api/subagents)
  agentRoles,              // Xo from main.bundle.js — pipeline agent names
  defaults,                // DEFAULT_GOVERNANCE.dispatch[section] for reset behavior
  onChange,                // (newConfig) => void
})
```

Rendering responsibilities:
- struck-through `always_disallowed` chips (locked)
- editable `default_denied` chip list (warn-color background to distinguish)
- per-agent allow editor, one row per agent + `_defaults` row at top
- `*` chip rendering + mixed-form support in the tag input

`dispatch-tag-state.js` extends to hold three independent tag states (`toolsState`,
`skillsState`, `subagentsState`).

#### 10.3 Backend — `worca-ui/server/`

Three new GET endpoints back the autocomplete pickers:

- `GET /api/tools` — static list from `worca-ui/server/known-tools.json` (mirrors
  `_KNOWN_TOOLS` constant in Python so the two stay in sync).
- `GET /api/skills` — shells out to `claude --list-skills --json` if available, else
  returns the static fallback list from `worca-ui/server/known-skills.json`.
- `GET /api/subagents` — already exists at `app.js` for the current dispatch UI; extended
  to honor the global mode `?project=<id>` filter.

Saving writes through the existing `POST /api/projects/:id/settings` endpoint, which
deep-merges and triggers the same on-save migration as `worca init --upgrade` (§9). The
migration function moves into `src/worca/orchestrator/settings_migration.py` so both
entry points share one implementation.

#### 10.4 Run Detail — wildcard counter

`worca-ui/app/views/run-detail.js` already renders dispatch events. Extend it to count
events with `via: "wildcard"` and surface a small badge:

```
Dispatch activity: 12 explicit, 4 via wildcard
```

Clicking the counter expands to show the (parent_agent, child, via) tuples — same shape
as the existing dispatch activity list.

#### 10.5 Denylist sync — three pairs

Today's single sync (`dispatch-tag-state.js:9` ↔ `tracking.py:26`) becomes three pairs:

| Section | JS file | Python file |
|---|---|---|
| tools | `worca-ui/server/known-tools.json` | `src/worca/hooks/tracking.py` constant |
| skills | `worca-ui/server/known-skills.json` | `src/worca/hooks/tracking.py` constant |
| subagents | `worca-ui/app/views/dispatch-tag-state.js` (existing) | `src/worca/hooks/tracking.py` (existing) |

A new lint test (`tests/test_denylist_sync.py`) reads both sides and asserts they match.
Same pattern as today's W-038 implicit-comment sync, but enforced.

## Implementation Plan

### Phase 1: Python — config loader + check_allowed

**Files:** `src/worca/hooks/tracking.py`, `tests/test_tracking.py`

1. Add `_DISPATCH_DEFAULTS` constant with the three section defaults.
2. Add `_load_dispatch_section()` and `check_allowed()` per §7.1.
3. Keep `check_dispatch()` as a shim over `check_allowed("subagents", ...)`.
4. Add unit tests covering: wildcard expansion, mixed form, replace-not-union, always_disallowed
   short-circuit, default_denied not included in `*`, missing section falls back to defaults,
   glob match on `worca-*`.

### Phase 2: Python — wire skills hook + telemetry

**Files:** `src/worca/claude_hooks/skill_use.py` (new), `src/worca/utils/claude_cli.py`,
`src/worca/claude_hooks/subagent_start.py`, `src/worca/utils/dispatch_events.py` (new helper)

1. Create `skill_use.py` per §7.2.
2. Update `claude_cli.py:143` to call `_resolve_tool_disallows()` per §8 — `Skill` no longer in
   the disallow list.
3. Extend `subagent_start.py:48` to include the `via` field in
   `pipeline.hook.dispatch_allowed`.
4. Register the new hook in `src/worca/settings.json` (the bundled defaults) under
   `hooks.PreToolUse` with `matcher: "Skill"`.

### Phase 3: Python — migration + init

**Files:** `src/worca/cli/init.py`, `src/worca/orchestrator/settings_migration.py` (new),
`tests/test_init_migration.py`

1. Move the migration body into `settings_migration.py` so both `worca init --upgrade` and the
   UI save-path can reuse it.
2. Implement `_migrate_dispatch_governance()` per §9.
3. Extend tests covering: existing `subagent_dispatch` is preserved under
   `dispatch.subagents.per_agent_allow`, `_dispatch_legacy` is dropped, tools+skills sections
   land with defaults, idempotent re-run.

### Phase 4: UI — settings editor

**Files:** `worca-ui/app/views/settings.js`, `worca-ui/app/views/dispatch-tag-state.js`,
`worca-ui/app/views/dispatch-section.js` (new), `worca-ui/app/styles.css`,
`worca-ui/server/app.js`, `worca-ui/server/known-tools.json` (new),
`worca-ui/server/known-skills.json` (new)

1. Extract `dispatch-section.js` per §10.2.
2. Replace the single subagent_dispatch card in `settings.js` with three section cards.
3. Add `*` chip styling + mixed-form parsing in the tag input.
4. Add `GET /api/tools` and `GET /api/skills` endpoints; extend autocomplete in
   `dispatch-section.js`.
5. Save path: send the full `governance.dispatch` block; the server runs the same migration
   helper from Phase 3 before writing.

### Phase 5: UI — run detail wildcard counter

**Files:** `worca-ui/app/views/run-detail.js`,
`worca-ui/app/views/run-detail-dispatch.test.js`

1. Count events by `via` field.
2. Render counter badge.
3. Add tests for both the counter render and the expanded list.

### Phase 6: Documentation + sync test

**Files:** `CLAUDE.md`, `MIGRATION.md`, `docs/governance.md` (new),
`tests/test_denylist_sync.py` (new)

1. Document the new config shape in `CLAUDE.md` (replaces the existing brief mention of
   `worca.governance.subagent_dispatch`).
2. Add upgrade steps to `MIGRATION.md`.
3. Add `tests/test_denylist_sync.py` per §10.5.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/hooks/tracking.py` | Generalize to three sections; add `check_allowed()`; keep `check_dispatch()` as shim |
| `src/worca/claude_hooks/skill_use.py` | New PreToolUse hook for `Skill` |
| `src/worca/claude_hooks/subagent_start.py` | Emit `via` field in telemetry |
| `src/worca/utils/claude_cli.py` | Replace hardcoded disallow with settings-driven `_resolve_tool_disallows()` |
| `src/worca/utils/dispatch_events.py` | New helper for the shared `via` field |
| `src/worca/cli/init.py` | Use shared migration helper |
| `src/worca/orchestrator/settings_migration.py` | New — migration logic shared between CLI and UI |
| `src/worca/settings.json` | Update bundled defaults to the new shape; register `skill_use.py` hook |
| `.claude/settings.json` | Migrate in place |
| `tests/test_tracking.py` | Wildcard, mixed form, replace semantics, default_denied tests |
| `tests/test_init_migration.py` | Migration coverage |
| `tests/test_denylist_sync.py` | New — assert JS and Python denylists match |
| `worca-ui/app/views/settings.js` | Replace single dispatch card with three section cards |
| `worca-ui/app/views/dispatch-tag-state.js` | Extend to hold three section states |
| `worca-ui/app/views/dispatch-section.js` | New — shared section renderer |
| `worca-ui/app/views/run-detail.js` | Wildcard counter |
| `worca-ui/app/styles.css` | `*` chip styling, default_denied chip styling |
| `worca-ui/server/app.js` | New `/api/tools` and `/api/skills` endpoints |
| `worca-ui/server/known-tools.json` | New |
| `worca-ui/server/known-skills.json` | New |
| `worca-ui/package.json` | `files` allowlist update for new server/app paths |
| `CLAUDE.md` | Document new governance shape |
| `MIGRATION.md` | Upgrade steps |
| `docs/governance.md` | New — full reference for the three-tier model |

## Considerations

### Edge cases

- **Plugin-namespaced skills (`hookify:hookify`).** Names are matched verbatim; the glob form
  only honors `*` as a trailing wildcard so `hookify:*` would also work if we want to broaden
  later.
- **Unknown agent name.** If `WORCA_AGENT` is empty (interactive mode), all dispatches are
  allowed — matches today's `check_dispatch()` behavior. Hook tests assert this.
- **Settings file missing.** `_load_settings()` returns `{}` and the section falls back to
  bundled defaults. No crash.
- **Empty `per_agent_allow` entry `[]`.** Means "lockdown for this agent" — explicit, no
  surprise. Documented in `docs/governance.md`.
- **`always_disallowed` overlap with `default_denied`.** If the same name appears in both,
  `always_disallowed` wins (short-circuits first in the resolution algorithm).

### Governance / blast radius

- **Skills gain a new failure mode.** Before W-054, the Skill tool was off and no skill could
  run. After W-054, a misconfigured `default_denied` could let an agent invoke a destructive
  skill the project author didn't intend. The denylist + telemetry counter mitigate but do not
  eliminate this. The trade-off is intentional — current state forces forking worca to share
  any skill.
- **The mixed `["*", "extra"]` form is the new escape hatch.** Operators should learn it.
  Doc page calls it out with examples for the common cases (reviewer wants `review`, guardian
  wants `security-review`).

### Breaking changes

| Change | Impact | Mitigation |
|---|---|---|
| `governance.subagent_dispatch` → `governance.dispatch.subagents.per_agent_allow` | Custom settings.json values need to move | Automatic migration on `worca init --upgrade` and on the next UI save (§9) |
| `Skill` removed from hardcoded `--disallowedTools` | Skills become invokable from pipeline agents | New `skill_use.py` hook gates every invocation; denylist covers footguns |
| UI `subagent_dispatch` card replaced with three-section editor | Bookmarks/screenshots stale | One-time UI refresh; the new editor is a superset |
| `pipeline.hook.dispatch_allowed` event adds `via` field | Downstream event consumers see an extra field | Additive — existing consumers ignore unknown fields |

### Migration

`worca init --upgrade` (or first UI save) rewrites legacy keys. Idempotent — re-running on
already-migrated settings is a no-op. Legacy `governance._dispatch_legacy` is dropped during
migration (it was already an artifact of a previous migration).

## Test Plan

### Unit tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_check_allowed_wildcard_expansion` | `["*"]` expands to all_known minus deny tiers |
| Python | `test_check_allowed_mixed_form` | `["*", "review"]` includes default_denied "review" |
| Python | `test_check_allowed_replace_not_union` | Per-agent entry does not inherit from `_defaults` |
| Python | `test_check_allowed_always_disallowed_short_circuit` | Tier 1 wins over `*` and explicit |
| Python | `test_check_allowed_default_denied_not_in_wildcard` | `["*"]` excludes default_denied items |
| Python | `test_check_allowed_glob_worca_prefix` | `worca-install` matches `worca-*` |
| Python | `test_check_allowed_missing_section_uses_defaults` | Empty config returns bundled defaults |
| Python | `test_check_allowed_via_field` | Returns `wildcard` or `explicit` correctly |
| Python | `test_resolve_tool_disallows_drops_skill` | `Skill` never in returned disallow list |
| Python | `test_resolve_tool_disallows_named_entries_warn` | Named tool entries get warning + ignored |
| Python | `test_skill_use_hook_allows_via_settings` | Hook returns 0 when skill is allowed |
| Python | `test_skill_use_hook_blocks_denylisted` | Hook returns 2 with reason for denylisted skill |
| Python | `test_migration_subagent_dispatch_to_dispatch_subagents` | W-038 shape → W-054 shape preserves per-agent values |
| Python | `test_migration_idempotent` | Re-running migration is a no-op |
| UI | `dispatch-section.test.js — wildcard chip renders distinctly` | `*` chip has the wildcard class |
| UI | `dispatch-section.test.js — mixed form parses` | Tag input accepts `["*", "review"]` |
| UI | `dispatch-section.test.js — always_disallowed chips locked` | Locked chips have struck-through class + no remove button |
| UI | `dispatch-section.test.js — default_denied chips editable` | Default-denied chips have warn color + editable |
| UI | `settings.test.js — three section cards render` | Tools, Skills, Subagents cards all present |
| UI | `run-detail-dispatch.test.js — wildcard counter` | Counts events by `via` field correctly |

### Integration tests

| Scenario | Expected |
|---|---|
| Pipeline run with `dispatch.skills.per_agent_allow._defaults: ["*"]` and a project skill | Skill invocation succeeds; telemetry shows `via: "wildcard"` |
| Pipeline run with skill in `default_denied` and not in agent's per_agent_allow | Hook blocks with reason `not_in_allow_list` |
| Pipeline run with skill in `always_disallowed` (e.g. `worca-install`) | Hook blocks even when agent has `["*"]` |
| Pipeline run with `dispatch.tools.per_agent_allow.planner: []` | Planner only gets always_disallowed in its `--disallowedTools` |
| `worca init --upgrade` on a settings.json with old `subagent_dispatch` | New shape written, old key removed, per-agent values preserved |

### E2E tests (Playwright)

| Scenario | Expected |
|---|---|
| Settings page renders three section cards | Tools, Skills, Subagents sections visible |
| Adding `review` to reviewer's per-agent allow → save → reload | Value persists, shows mixed `["*", "review"]` |
| Run detail wildcard counter | Shows `N explicit, M via wildcard` for a run with mixed dispatch |

### Existing tests to update

- `tests/test_init_migration.py` — extend existing W-038 migration tests with W-054 migration
  assertions (new shape under `dispatch.subagents`).
- `worca-ui/app/views/run-detail-dispatch.test.js` — existing dispatch_allowed assertions
  need the new `via` field in mocked event payloads.
- `worca-ui/app/views/settings.test.js` — replace the single-card subagent_dispatch
  assertions with three-card assertions.
- `src/worca/utils/test_claude_cli.py:70-76` — current test asserts the hardcoded disallow
  string. Replace with assertions over `_resolve_tool_disallows()` returns.

## Files to Create / Modify

See "Files Changed Summary" in Implementation Plan.

## Out of Scope

- **Named-tool allowlists in the tools section.** v1 honors only `"*"` / `[]` per §4. Adding
  named entries requires solving the complement-against-moving-universe problem, which is its
  own design exercise. Defer to a future W-NNN.
- **Glob patterns beyond trailing `*`.** No `?`, no character classes, no nested globs. The
  `worca-*` family is the only case we have today.
- **Per-skill argument validation.** The hook checks skill *name* only — what arguments the
  agent passes to the skill is not inspected.
- **Removing the `general-purpose` subagent denylist.** Stays permanent — see §5.1 reasoning.
- **Sharing dispatch config across projects (org-level governance).** Each project still
  reads its own `.claude/settings.json`. Cross-project governance is a separate plan.
- **Multi-harness governance translation** (W-036). The `--disallowedTools` flag is
  Claude-Code-specific; future harnesses with different governance shapes need their own
  translation layer. W-054 does not block that work, but does not implement it either.
