# W-054: Configurable per-agent tool / skill / subagent dispatch governance

**Status:** Draft
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-05-17
**Depends on:** W-038 (configurable subagent dispatch — establishes today's settings-driven dispatch shape)

> **Partially superseded (v2 dispatch normalization).** This plan places `general-purpose` on the subagents `always_disallowed` tier. That was later moved to `default_denied` (still off by default, but allowable per-agent) because `always_disallowed` is checked before `per_agent_allow`, leaving no opt-in path. The canonical reference is [`docs/governance.md`](../governance.md) § Subagents; the upgrade behavior is the v2 normalization in [`MIGRATION.md`](../../MIGRATION.md) (`0.40.x → 0.41.0`).

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

**Latent defect — `workspace_planner` missing from defaults.** The recently-landed
workspace-runs feature (`src/worca/scripts/run_workspace.py:473-492`) invokes
`workspace_planner.md` via `run_agent()`, which auto-sets `WORCA_AGENT=workspace_planner`
in the subprocess env (`claude_cli.py:331-342`). The `SubagentStart` hook then calls
`check_dispatch("workspace_planner", child)` → `rules.get("workspace_planner", set())`
returns the empty set → workspace_planner can dispatch **nothing**, not even `Explore`.
This is silent today because the agent does not currently attempt subagent dispatch, but
any future revision that wants `Explore` for cross-repo orientation would fail with a
confusing "Blocked: workspace_planner cannot dispatch Explore" message. W-054 fixes this
as a side effect of broadening the defaults (see §5.4).

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

The previous revision used an `all_known` parameter to expand wildcards against a full
inventory. This is infeasible at hook invocation time — a `PreToolUse` payload contains
only the current tool call, not a skill/subagent inventory. The revised algorithm uses
**deny-tier-only checks** when a wildcard is present, requiring no enumeration:

```python
def _matches_any(candidate: str, patterns: list[str]) -> bool:
    """Check if candidate matches any pattern in the list.

    Supports exact match and trailing-* prefix glob (e.g. 'worca-*').
    A bare '*' in the patterns list matches everything — but this should
    only appear in per_agent_allow entries, never in deny lists.
    """
    for pattern in patterns:
        if pattern == candidate:
            return True
        if pattern.endswith("*") and candidate.startswith(pattern[:-1]):
            return True
    return False


def check_allowed(section: str, agent: str, candidate: str,
                  *, settings_override=None) -> tuple:
    """Returns (allowed: bool, reason: str, via: 'wildcard'|'explicit'|None).

    No all_known set required — when '*' is in the entry, the check reduces
    to 'allow if not in always_disallowed AND (not in default_denied OR
    explicitly named in entry)'. The full enumeration is only needed for
    UI autocomplete endpoints, not for hook-time checks.
    """
    cfg = _load_dispatch_section(section, settings_override)

    # Tier 1 — hard deny wins everything
    if _matches_any(candidate, cfg["always_disallowed"]):
        return (False, "always_disallowed", None)

    # Resolve the agent's effective allow list (replace semantics)
    entry = cfg["per_agent_allow"].get(
        agent, cfg["per_agent_allow"].get("_defaults", [])
    )
    has_wildcard = "*" in entry
    explicit = {x for x in entry if x != "*"}

    if has_wildcard:
        # Wildcard means "allow anything not in deny tiers".
        # Explicitly-named extras bypass default_denied.
        if candidate in explicit:
            return (True, "ok", "explicit")
        if _matches_any(candidate, cfg["default_denied"]):
            return (False, "default_denied", None)
        return (True, "ok", "wildcard")
    else:
        if candidate in explicit:
            return (True, "ok", "explicit")
        return (False, "not_in_allow_list", None)
```

Key differences from the previous revision:
- **No `all_known` parameter.** Wildcard resolution is a deny-tier check, not a set
  expansion. This eliminates the impossible requirement to enumerate all skills/subagents
  at hook invocation time.
- **`_matches_any()` is fully specified** (see above). Supports exact match and
  trailing-`*` prefix glob. A bare `*` in a deny list would match everything — but this is
  a footgun that should never appear there; the Phase 1 unit tests assert this edge case.
- **`default_denied` gets its own return reason** (`"default_denied"` instead of
  `"not_in_allow_list"`) so telemetry can distinguish "blocked by policy" from "not
  configured".

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

### 4. Tools section — `--tools` allowlist, not `--disallowedTools` inversion

**Implementation revision** (from the draft's "only `*` / `[]`" stance). Claude Code's
CLI takes `--tools <list>` (allowlist) *in addition to* `--disallowedTools <list>`
(denylist). PR C dropped the inversion problem entirely by switching the per-agent
allow to drive `--tools`. The mapping is:

| `per_agent_allow` form | Claude CLI flag | Meaning |
|---|---|---|
| `["*"]` | `--tools default` | All built-ins allowed (minus `always_disallowed`) |
| `["Read", "Grep"]` | `--tools Agent,Grep,Read,Skill` | Restricted to named built-ins; `Skill` + `Agent` auto-included so worca hooks fire |
| `[]` | `--tools ""` | Lockdown — no built-in tool available |
| `["*", "Read"]` | `--tools default` | Mixed form collapses to wildcard (the explicit extra is already in `default`) |

Notes:

- `Skill` and `Agent` are meta-tools. When a named list is supplied, worca auto-includes
  them so the skill_use.py and subagent_start.py hooks still fire. Without that
  auto-inclusion, dispatch governance is silently disabled for the targeted agent.
- `--disallowedTools` is still emitted, but only with `always_disallowed` (minus `Skill`,
  which is delegated to the skills hook). The two flags compose: a named tool that appears
  in both `--tools` and `--disallowedTools` is still blocked.
- MCP tools (`mcp_*`) are not covered by `--tools` — the Claude CLI documents this flag
  as built-ins only. MCP governance flows through other channels.
- The empty-string `--tools ""` lockdown form is verified empirically by the `build_command`
  unit tests; the CLI accepts it as "no tools allowed".

`always_disallowed` defaults: `["EnterPlanMode", "EnterWorktree", "TodoWrite"]`. `Skill`
is intentionally absent — it is controlled via the skills section. The `_resolve_tool_args`
helper still filters `Skill` out defensively, so a project that re-adds it to
`always_disallowed` will not accidentally block the skills hook.

`default_denied`: empty by default. Reserved for future use (e.g. if Claude Code ships a
`Write` variant we want gated). Mixed-form opt-in semantics from the skills section are
not yet wired through for tools because no real use case demands it.

### 5. Subagents section

#### 5.1 `always_disallowed`

`["general-purpose"]` — same as today's `_SUBAGENT_DENYLIST`. Reason unchanged: a
general-purpose agent can fork unbounded invisible work the pipeline cannot observe.

#### 5.2 `default_denied`

Empty by default. Reserved for future use (e.g. a `*-publisher` family that should require
explicit opt-in).

#### 5.3 `per_agent_allow._defaults`

**Implemented value: `["*"]`** (revised from the draft's `["Explore"]`).

The original draft picked `["Explore"]` to preserve today's behavior. That rationale
was abandoned during implementation for two reasons:

1. **Consistency across sections.** Tools and skills both default to `["*"]`. Having
   subagents default to a single named agent made the three sections behave inconsistently
   — a "subagents are special" carve-out that the resolution algorithm already addresses
   via `always_disallowed: ["general-purpose"]`. The wildcard plus the hard-deny tier
   gives the same safety net (no unbounded `general-purpose` work) without the asymmetric
   default.
2. **Project-defined subagent visibility.** Projects increasingly ship their own subagents
   (the `feature-dev:*`, `claude-md-management:*`, and plugin-namespaced families). The
   `["Explore"]` default would force every project to enumerate each one before it became
   usable. The W-054 `default_denied` tier — currently empty — is the right escape hatch
   for "useful in some pipelines, dangerous in others" cases; the bare `_defaults`
   shouldn't carry that load.

The §1.2 workspace_planner-defect fix still holds: workspace_planner (and any future
unenumerated agent) falls through to `_defaults: ["*"]` and gets the same access as the
rest of the roster.

Subagent blast radius is still real — operators who want lockdown for a specific role
can use `"<role>": []` to ground them. The shift just moves the default from "opt-in"
to "opt-out," matching tools and skills.

#### 5.4 Agent roster — nine roles, not eight

The dispatch defaults must cover every agent role that runs under `WORCA_AGENT`. As of the
workspace-runs landing (commit `00b3c1b`), there are **nine** roles:

| Role | Where invoked | Notes |
|---|---|---|
| `planner` | per-pipeline | existing |
| `plan_reviewer` | per-pipeline | existing, gated off by default |
| `coordinator` | per-pipeline | existing |
| `implementer` | per-pipeline | existing |
| `tester` | per-pipeline | existing |
| `reviewer` | per-pipeline | existing |
| `guardian` | per-pipeline | existing |
| `learner` | per-pipeline | existing, gated off by default |
| `workspace_planner` | per-workspace | **new — missing from current `DEFAULT_SUBAGENT_DISPATCH`** |

`_defaults: ["*"]` (see §5.3 for the implementation revision) covers all nine roles
implicitly. The fix for the §1.2 defect is automatic: under the new resolution algorithm,
an agent not listed in `per_agent_allow` falls through to `_defaults`, so
workspace_planner gets the wildcard without any special-casing. The migration in §9
preserves user-supplied per-agent values verbatim — a project that has explicitly
enumerated all eight legacy agents will not automatically gain a workspace_planner entry,
but the fallback to `_defaults` still applies.

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
        "per_agent_allow":   { "_defaults": ["*"] }
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
```

`check_allowed()` and `_matches_any()` are implemented as specified in §2.1 above.

The existing `check_dispatch()` becomes a thin shim over `check_allowed("subagents", ...)`
for backward compatibility with the `SubagentStart` hook.

#### 7.2 New `src/worca/claude_hooks/skill_use.py` hook

Since skills will be allowed through the CLI flag (see §8), we need a hook that fires on
every skill invocation. The hook is registered as a `PreToolUse` hook with matcher `Skill`.

**Hook payload structure.** The `PreToolUse` hook receives JSON on stdin with `tool_name`
and `tool_input` fields (see `src/worca/claude_hooks/pre_tool_use.py:48-50` for the
existing pattern). When the tool is `Skill`, `tool_name` is `"Skill"` and the actual skill
name is nested inside `tool_input`. The exact field name inside `tool_input` is not yet
verified against the Claude Code hook API. Phase 2 implementation must:

1. **Discover the field path** by temporarily allowing `Skill` in a test pipeline run and
   logging the raw `data` dict from stdin, OR by checking Claude Code documentation for the
   `Skill` tool's input schema.
2. **Extract the skill name defensively** using a helper that checks the most likely paths:

```python
def _extract_skill_name(data: dict) -> str:
    """Extract the skill name from a PreToolUse hook payload for the Skill tool.

    The Skill tool's input schema is not formally documented. We check the
    most likely field paths and fall back to empty string (which will be
    rejected by check_allowed as not in any allow list).
    """
    tool_input = data.get("tool_input", {})
    # Most likely: tool_input has a 'skill_name' or 'name' field
    for field in ("skill_name", "name"):
        val = tool_input.get(field, "")
        if val:
            return val
    return ""
```

3. **Add a unit test** that asserts the extraction works against the discovered payload shape,
   so any future Claude Code API changes break loudly.

The hook body (after skill name extraction is resolved):

```python
def main():
    data = json.load(sys.stdin)
    parent = _role_from_worca_agent(os.environ.get("WORCA_AGENT", ""))
    skill = _extract_skill_name(data)

    allowed, reason, via = check_allowed("skills", parent, skill)
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

Note: the `_role_from_worca_agent()` helper is reused from `subagent_start.py` — extract
it to a shared location (e.g. `src/worca/hooks/agent_role.py` or inline in `tracking.py`)
so both hooks use the same normalization.

Wired in `.claude/settings.json` `hooks.PreToolUse` with matcher `Skill`.

#### 7.3 Telemetry — add `via` field

Both `pipeline.hook.dispatch_allowed` (existing) and `pipeline.hook.skill_allowed` (new)
gain a `via: "wildcard" | "explicit"` field. The UI reads this to render the
wildcard-allowed counter on the Run Detail Governance section.

### 8. `claude_cli.py` — drive `--tools` and `--disallowedTools` from settings

The implementation supersedes the draft "disallows-only" pseudocode. The current
`_resolve_tool_args` returns both halves so `build_command` can pass `--tools` *and*
`--disallowedTools` consistently:

```python
def build_command(prompt, agent, *, settings=None, ...):
    ...
    agent_name = os.path.splitext(os.path.basename(agent))[0]
    disallowed_tools, tools_arg = _resolve_tool_args(agent_name, settings)
    cmd = [
        *_claude_bin, "-p", cli_prompt, "--agent", agent,
        "--output-format", output_format,
        "--no-session-persistence", "--dangerously-skip-permissions",
        "--tools", tools_arg,
    ]
    if disallowed_tools:
        cmd.extend(["--disallowedTools", ",".join(disallowed_tools)])
    ...

def _resolve_tool_args(agent_name: str, settings: dict | None) -> tuple[list[str], str]:
    cfg = _load_dispatch_section("tools", settings)
    # Skill is always dropped from disallows — the skills hook governs it.
    disallows = [t for t in cfg["always_disallowed"] if t != "Skill"]

    # agent_name arrives as the resolved-prompt basename
    # (e.g. "implement-implementer-iter-3"); per_agent_allow is keyed by bare
    # role ("implementer"). Normalize via role_from_worca_agent.
    role = role_from_worca_agent(agent_name) or agent_name
    entry = cfg["per_agent_allow"].get(
        role, cfg["per_agent_allow"].get("_defaults", ["*"])
    )

    if "*" in entry:
        return disallows, "default"
    if len(entry) == 0:
        return disallows, ""  # lockdown — verified to work with the Claude CLI

    # Named list: auto-include Skill and Agent so worca's governance hooks fire.
    tools = {t for t in entry if t != "*"}
    tools.add("Skill")
    tools.add("Agent")
    return disallows, ",".join(sorted(tools))
```

Key points:

- `Skill` is dropped from the disallow list. Governance moves to the new PreToolUse hook
  (§7.2), so the model gains the capability but each invocation is checked.
- Per-agent lookup uses the bare role, so settings like
  `tools.per_agent_allow.implementer = ["Read", "Grep"]` actually match in production
  (regression covered by `test_resolve_tool_args_matches_per_agent_on_resolved_filename`).
- The empty per-agent list `[]` is honored as lockdown — `--tools ""` is the supported
  Claude CLI form.

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
    # Seed _defaults from the bundled defaults so the §1.2 workspace_planner
    # defect is fixed on upgrade (any agent not enumerated falls through to
    # _defaults rather than getting an empty set).
    per_agent.setdefault(
        "_defaults",
        list(_DISPATCH_DEFAULTS["subagents"]["per_agent_allow"]["_defaults"]),
    )
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

#### 10.0 Agent roster source of truth

The authoritative agent roster constant is `AGENT_NAMES` in
`worca-ui/app/views/settings.js:61-70` (the source file, **not** the minified `Xo` in
`main.bundle.js` which is a build artifact). It currently lists the legacy eight agents
(`planner, plan_reviewer, coordinator, implementer, tester, reviewer, guardian, learner`)
and does **not** include `workspace_planner`. Extend it to nine:

```js
export const AGENT_NAMES = [
  'planner',
  'plan_reviewer',
  'coordinator',
  'implementer',
  'tester',
  'reviewer',
  'guardian',
  'learner',
  'workspace_planner',
];
```

The per-agent rows in the dispatch-section editor are driven by this list, so adding
`workspace_planner` here makes it editable in the UI for all three sections automatically.
The denylist-sync test (`tests/test_denylist_sync.py`, §10.5) is extended to assert the
JS and Python agent rosters match too.

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
  agentRoles,              // AGENT_NAMES from settings.js — pipeline agent names
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

**Autocomplete endpoints.** Three new GET endpoints back the autocomplete pickers:

- `GET /api/tools` — static list from `worca-ui/server/known-tools.json` (mirrors
  `_KNOWN_TOOLS` constant in Python so the two stay in sync).
- `GET /api/skills` — shells out to `claude --list-skills --json` if available, else
  returns the static fallback list from `worca-ui/server/known-skills.json`.
- `GET /api/subagents` — already exists at `app.js` for the current dispatch UI; extended
  to honor the global mode `?project=<id>` filter.

**Settings save — JS migration module.** The UI server is JavaScript/Express; the settings
save endpoint (`POST /api/projects/:id/settings` in `project-routes.js:459-622`) uses pure
JS transformations (`global-keys.js`, `settings-merge.js`). Python code cannot be called
from this path without adding subprocess latency.

The migration logic is ported to a new JS module `worca-ui/server/dispatch-migration.js`,
following the same mutate-in-place pattern as `global-keys.js:extractAndStripGlobalKeys()`.
The JS module is authoritative for the save path; the Python module
(`src/worca/cli/init.py`) is authoritative for `worca init --upgrade`. Both implement the
same transformation, and `tests/test_denylist_sync.py` (§10.5) asserts they stay aligned
by running both against the same fixture inputs and comparing outputs.

```js
// worca-ui/server/dispatch-migration.js

import { DISPATCH_DEFAULTS } from './dispatch-defaults.js';

/**
 * Migrate legacy governance.subagent_dispatch → governance.dispatch.subagents
 * (W-054). Mutates `worcaConfig` in place. Returns list of change descriptions
 * (empty if no migration was needed).
 *
 * Follows the same mutate-in-place pattern as global-keys.js.
 */
export function migrateDispatchGovernance(worcaConfig) {
  const changes = [];
  const gov = worcaConfig.governance;
  if (!gov || typeof gov !== 'object') return changes;
  if (!('subagent_dispatch' in gov)) return changes;

  const old = gov.subagent_dispatch;
  delete gov.subagent_dispatch;

  if (!gov.dispatch) gov.dispatch = {};
  const dispatch = gov.dispatch;

  if (!dispatch.subagents) dispatch.subagents = {};
  const subagents = dispatch.subagents;

  if (!subagents.per_agent_allow) subagents.per_agent_allow = {};
  Object.assign(subagents.per_agent_allow, old);

  // Seed _defaults so workspace_planner (and future roles) get fallback
  if (!('_defaults' in subagents.per_agent_allow)) {
    subagents.per_agent_allow._defaults = [
      ...DISPATCH_DEFAULTS.subagents.per_agent_allow._defaults,
    ];
  }

  if (!subagents.always_disallowed) {
    subagents.always_disallowed = [...DISPATCH_DEFAULTS.subagents.always_disallowed];
  }
  if (!subagents.default_denied) {
    subagents.default_denied = [...DISPATCH_DEFAULTS.subagents.default_denied];
  }

  if (!dispatch.tools) dispatch.tools = structuredClone(DISPATCH_DEFAULTS.tools);
  if (!dispatch.skills) dispatch.skills = structuredClone(DISPATCH_DEFAULTS.skills);

  delete gov._dispatch_legacy;

  changes.push(
    'governance.subagent_dispatch -> governance.dispatch.subagents (W-054)',
  );
  return changes;
}
```

The shared defaults live in `worca-ui/server/dispatch-defaults.js` (a JSON-like JS export)
so both the migration module and `dispatch-tag-state.js` can import them. This replaces
the current `DEFAULT_GOVERNANCE.subagent_dispatch` in `settings.js`.

The settings save endpoint calls `migrateDispatchGovernance(base.worca)` right after
the existing `extractAndStripGlobalKeys(base)` call — same lifecycle position, same
mutate-in-place contract:

```js
// In project-routes.js, after line ~532:
const dispatchMigrated = migrateDispatchGovernance(base.worca);
```

The existing `dispatch` → `subagent_dispatch` migration block
(`project-routes.js:518-527`) is superseded by this new module and removed.

**Sync test integration.** `tests/test_denylist_sync.py` (§10.5) validates that the JS
and Python migration functions produce identical output for a set of fixture inputs
covering: legacy `subagent_dispatch` shape, already-migrated shape (idempotent), and
empty/missing governance.

#### 10.4 Run Detail — wildcard counter

`worca-ui/app/views/run-detail.js` already renders dispatch events. Extend it to count
events with `via: "wildcard"` and surface a small badge:

```
Dispatch activity: 12 explicit, 4 via wildcard
```

Clicking the counter expands to show the (parent_agent, child, via) tuples — same shape
as the existing dispatch activity list.

#### 10.5 Denylist sync — four sync pairs

Today's single sync (`dispatch-tag-state.js:9` ↔ `tracking.py:26`) becomes four pairs:

| Sync pair | JS file | Python file |
|---|---|---|
| tools denylists | `worca-ui/server/dispatch-defaults.js` | `src/worca/hooks/tracking.py` `_DISPATCH_DEFAULTS` |
| skills denylists | `worca-ui/server/dispatch-defaults.js` | `src/worca/hooks/tracking.py` `_DISPATCH_DEFAULTS` |
| subagents denylists | `worca-ui/server/dispatch-defaults.js` | `src/worca/hooks/tracking.py` `_DISPATCH_DEFAULTS` |
| migration behavior | `worca-ui/server/dispatch-migration.js` | `src/worca/cli/init.py` `_migrate_dispatch_governance()` |

A new lint test (`tests/test_denylist_sync.py`) reads both sides and asserts:
1. The three `always_disallowed` + `default_denied` arrays match between JS and Python
2. The `per_agent_allow._defaults` values match between JS and Python
3. The agent roster (`AGENT_NAMES` in `settings.js:61` ↔ `_DISPATCH_DEFAULTS` keys +
   nine-role set in `tracking.py`) match
4. Both migration functions (Python + JS) produce identical output for a shared set of
   fixture inputs (run via `node --input-type=module -e "..."` for the JS side)

Same pattern as today's W-038 implicit-comment sync, but enforced.

### 11. `_matches_any()` implementation specification

The glob matcher used in `always_disallowed` and `default_denied` is minimal and
deterministic:

```python
def _matches_any(candidate: str, patterns: list[str]) -> bool:
    """Check if candidate matches any pattern in the list.

    Supported pattern forms:
    - Exact match: 'hookify:hookify' matches only 'hookify:hookify'
    - Trailing-* prefix glob: 'worca-*' matches any string starting with 'worca-'
    - Bare '*': matches everything (should only be used in per_agent_allow, not deny lists)

    No other glob syntax (?, character classes, nested globs) is supported.
    """
    for pattern in patterns:
        if pattern == candidate:
            return True
        if pattern.endswith("*") and len(pattern) > 1 and candidate.startswith(pattern[:-1]):
            return True
    return False
```

Edge cases and their behavior:
- `_matches_any("worca-install", ["worca-*"])` → `True` (prefix glob)
- `_matches_any("worca", ["worca-*"])` → `False` (no dash after "worca")
- `_matches_any("hookify:hookify", ["hookify:hookify"])` → `True` (exact match)
- `_matches_any("hookify:list", ["hookify:hookify"])` → `False` (exact, no match)
- `_matches_any("anything", ["*"])` → `True` (bare wildcard)
- `_matches_any("", ["worca-*"])` → `False` (empty string doesn't match prefix)

**Why `len(pattern) > 1`:** prevents a bare `"*"` from being treated as a prefix glob
(prefix would be empty string, matching everything). A bare `"*"` is handled by the
exact-match branch returning `True` on `"*" == "*"` — but if `candidate != "*"`, the
function continues to the prefix check where `len("*") > 1` is `False`, so it falls
through correctly. The bare `"*"` semantics only matter in `per_agent_allow` entries,
not in deny lists.

A JS counterpart `matchesAny()` is implemented in `worca-ui/server/dispatch-defaults.js`
for the UI-side migration and validation. The sync test asserts both implementations
produce identical results for a shared set of test vectors.

## Implementation Plan

### Phase 1: Python — config loader + check_allowed

**Files:** `src/worca/hooks/tracking.py`, `tests/test_tracking.py`

1. Add `_DISPATCH_DEFAULTS` constant with the three section defaults — note `subagents._defaults`
   uses `["*"]` (see §5.3 for the revision rationale), which covers `workspace_planner`
   automatically via fallback (§5.4).
2. Add `_matches_any()` per §11 with the exact implementation specified.
3. Add `_load_dispatch_section()` and `check_allowed()` per §7.1 / §2.1. The `check_allowed()`
   signature is `(section, agent, candidate, *, settings_override=None)` — no `all_known`
   parameter.
4. Keep `check_dispatch()` as a shim over `check_allowed("subagents", ...)`.
5. Add unit tests covering:
   - wildcard expansion (deny-tier-only check, no `all_known`)
   - mixed form (`["*", "review"]` bypasses `default_denied` for `review`)
   - replace-not-union (per-agent entry does not inherit from `_defaults`)
   - `always_disallowed` short-circuit (wins over `*` and explicit)
   - `default_denied` not included in `*` (returns `"default_denied"` reason)
   - `_matches_any` glob match on `worca-*` prefix (and edge cases from §11)
   - missing section falls back to bundled defaults
   - `workspace_planner` resolves to `_defaults` when no per-agent entry exists (§1.2 regression)
   - `via` field returns `"wildcard"` or `"explicit"` correctly
   - bare `*` in a deny list matches everything (documented footgun, tested for awareness)
   - empty `WORCA_AGENT` allows all dispatches (interactive mode backward compat)

### Phase 2: Python — wire skills hook + telemetry

**Files:** `src/worca/claude_hooks/skill_use.py` (new), `src/worca/utils/claude_cli.py`,
`src/worca/claude_hooks/subagent_start.py`, `src/worca/hooks/agent_role.py` (new — shared
`_role_from_worca_agent` helper)

1. **Discover the Skill tool's `tool_input` schema.** Before writing `skill_use.py`,
   temporarily allow `Skill` in a local test run and log the raw stdin JSON to determine the
   exact field path for the skill name inside `tool_input`. Update
   `_extract_skill_name()` (§7.2) with the verified field path. If discovery is not possible
   pre-implementation, use the defensive multi-path extraction from §7.2 and add a unit test
   that will break loudly if the assumed fields are wrong.
2. Create `skill_use.py` per §7.2 — reads `tool_input` from the PreToolUse payload (not
   a top-level `skill_name` field), extracts the skill name via `_extract_skill_name()`,
   and delegates to `check_allowed("skills", ...)`.
3. Extract `_role_from_worca_agent()` from `subagent_start.py` into a shared
   `src/worca/hooks/agent_role.py` so both `skill_use.py` and `subagent_start.py` use
   the same normalization.
4. Update `claude_cli.py:143` to call `_resolve_tool_disallows()` per §8 — `Skill` no longer in
   the disallow list.
5. Extend `subagent_start.py:48` to include the `via` field in
   `pipeline.hook.dispatch_allowed`.
6. Register the new hook in `src/worca/settings.json` (the bundled defaults) under
   `hooks.PreToolUse` with `matcher: "Skill"`.
7. Add **unit tests** for the skill hook by invoking `skill_use.py:main()` directly with
   synthetic stdin payloads (mock the stdin JSON). This validates the hook logic without
   requiring full pipeline integration. Test cases:
   - Allowed skill (in `_defaults` wildcard) → exit 0, telemetry event with `via`
   - Blocked skill (in `always_disallowed`) → exit 2, blocked telemetry event
   - Blocked skill (in `default_denied`, not explicitly named) → exit 2
   - Allowed via mixed form (`["*", "review"]` with `review`) → exit 0, `via: "explicit"`
   - Empty `WORCA_AGENT` → exit 0 (interactive mode)

### Phase 3: Python — migration + init

**Files:** `src/worca/cli/init.py`, `tests/test_init_migration.py`

1. Implement `_migrate_dispatch_governance()` per §9, **including** the `per_agent_allow._defaults`
   seeding (the `per_agent.setdefault("_defaults", ...)` line). This is critical for the
   §1.2 workspace_planner defect fix on upgrade.
2. The migration logic stays in `src/worca/cli/init.py` (not extracted to a shared Python
   module — the UI save path uses the JS port in `dispatch-migration.js`, not Python).
3. Extend tests covering:
   - Existing `subagent_dispatch` is preserved under `dispatch.subagents.per_agent_allow`
   - `_defaults` is seeded from bundled defaults (regression test for §1.2 fix)
   - `_dispatch_legacy` is dropped
   - tools + skills sections land with defaults
   - Idempotent re-run produces no changes

### Phase 4: UI — settings editor + JS migration

**Files:** `worca-ui/app/views/settings.js`, `worca-ui/app/views/dispatch-tag-state.js`,
`worca-ui/app/views/dispatch-section.js` (new), `worca-ui/app/styles.css`,
`worca-ui/server/app.js`, `worca-ui/server/dispatch-defaults.js` (new),
`worca-ui/server/dispatch-migration.js` (new), `worca-ui/server/project-routes.js`,
`worca-ui/server/known-tools.json` (new), `worca-ui/server/known-skills.json` (new),
`worca-ui/package.json`

1. Add `workspace_planner` to the `AGENT_NAMES` constant in
   `worca-ui/app/views/settings.js:61-70` (the source file, not the build artifact).
2. Create `worca-ui/server/dispatch-defaults.js` exporting `DISPATCH_DEFAULTS` and
   `matchesAny()` — JS counterparts of the Python constants. This becomes the single JS
   source of truth for all three sections' defaults.
3. Create `worca-ui/server/dispatch-migration.js` per §10.3 — JS port of the Python
   migration logic.
4. Wire `migrateDispatchGovernance()` into `project-routes.js` settings save path, replacing
   the existing `dispatch` → `subagent_dispatch` migration block at lines 518-527.
5. Extract `dispatch-section.js` per §10.2.
6. Replace the single subagent_dispatch card in `settings.js` with three section cards.
7. Add `*` chip styling + mixed-form parsing in the tag input.
8. Add `GET /api/tools` and `GET /api/skills` endpoints; extend autocomplete in
   `dispatch-section.js`.
9. **Update `worca-ui/package.json` `files` field** to include the new server JSON files.
   The current allowlist has `server/**/*.js` for JS files but only explicit entries for
   JSON (`server/schemas/keys.json`, `server/reserved-env-keys.json`). Add:
   ```json
   "server/known-tools.json",
   "server/known-skills.json",
   "server/dispatch-defaults.js",
   "server/dispatch-migration.js"
   ```
   (The `.js` files are already covered by `server/**/*.js`, but explicit entries prevent
   future glob changes from silently dropping them. The `.json` files **must** be added
   explicitly — they are not covered by any existing glob.)
   Run `cd worca-ui && npm pack --dry-run | grep known-` to verify inclusion before
   committing.

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
3. Add `tests/test_denylist_sync.py` per §10.5 — four sync pairs covering denylists,
   defaults, agent roster, and migration behavior.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/hooks/tracking.py` | Generalize to three sections; add `_matches_any()`, `check_allowed()`; keep `check_dispatch()` as shim |
| `src/worca/hooks/agent_role.py` | New — shared `_role_from_worca_agent()` helper |
| `src/worca/claude_hooks/skill_use.py` | New PreToolUse hook for `Skill` |
| `src/worca/claude_hooks/subagent_start.py` | Emit `via` field in telemetry; import `_role_from_worca_agent` from shared module |
| `src/worca/utils/claude_cli.py` | Replace hardcoded disallow with settings-driven `_resolve_tool_disallows()` |
| `src/worca/cli/init.py` | Add `_migrate_dispatch_governance()` with `_defaults` seeding |
| `src/worca/settings.json` | Update bundled defaults to the new shape; register `skill_use.py` hook |
| `.claude/settings.json` | Migrate in place |
| `tests/test_tracking.py` | Wildcard, mixed form, replace semantics, default_denied, `_matches_any` tests |
| `tests/test_init_migration.py` | Migration coverage including `_defaults` seeding |
| `tests/test_denylist_sync.py` | New — assert JS and Python denylists, defaults, roster, and migration match |
| `worca-ui/app/views/settings.js` | Add `workspace_planner` to `AGENT_NAMES`; replace single dispatch card with three section cards |
| `worca-ui/app/views/dispatch-tag-state.js` | Extend to hold three section states; import from `dispatch-defaults.js` |
| `worca-ui/app/views/dispatch-section.js` | New — shared section renderer |
| `worca-ui/app/views/run-detail.js` | Wildcard counter |
| `worca-ui/app/styles.css` | `*` chip styling, default_denied chip styling |
| `worca-ui/server/app.js` | New `/api/tools` and `/api/skills` endpoints |
| `worca-ui/server/dispatch-defaults.js` | New — JS source of truth for dispatch defaults + `matchesAny()` |
| `worca-ui/server/dispatch-migration.js` | New — JS port of Python migration logic |
| `worca-ui/server/project-routes.js` | Wire `migrateDispatchGovernance()` into save path; remove legacy migration block |
| `worca-ui/server/known-tools.json` | New |
| `worca-ui/server/known-skills.json` | New |
| `worca-ui/package.json` | `files` allowlist: add `server/known-tools.json`, `server/known-skills.json` |
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
- **Agent role not enumerated in `per_agent_allow`.** Falls through to `_defaults` (§2.1).
  This fixes the §1.2 defect where `workspace_planner` silently couldn't dispatch anything;
  any future new agent role gets sensible behavior without a code change.
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
| `governance.subagent_dispatch` → `governance.dispatch.subagents.per_agent_allow` | Custom settings.json values need to move | Automatic migration on `worca init --upgrade` and on the next UI save (§9, §10.3) |
| `Skill` removed from hardcoded `--disallowedTools` | Skills become invokable from pipeline agents | New `skill_use.py` hook gates every invocation; denylist covers footguns |
| UI `subagent_dispatch` card replaced with three-section editor | Bookmarks/screenshots stale | One-time UI refresh; the new editor is a superset |
| `pipeline.hook.dispatch_allowed` event adds `via` field | Downstream event consumers see an extra field | Additive — existing consumers ignore unknown fields |

### Migration

`worca init --upgrade` (Python) and the UI save path (JS `dispatch-migration.js`) both
rewrite legacy keys. Idempotent — re-running on already-migrated settings is a no-op.
Legacy `governance._dispatch_legacy` is dropped during migration (it was already an artifact
of a previous migration). The two migration implementations (Python and JS) are kept in sync
by `tests/test_denylist_sync.py` which runs both against shared fixture inputs.

## Test Plan

### Unit tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_check_allowed_wildcard_allows_unknown` | `["*"]` allows a candidate not in any deny tier (no `all_known` needed) |
| Python | `test_check_allowed_mixed_form` | `["*", "review"]` includes default_denied "review" with `via: "explicit"` |
| Python | `test_check_allowed_replace_not_union` | Per-agent entry does not inherit from `_defaults` |
| Python | `test_check_allowed_always_disallowed_short_circuit` | Tier 1 wins over `*` and explicit |
| Python | `test_check_allowed_default_denied_not_in_wildcard` | `["*"]` excludes default_denied items; reason is `"default_denied"` |
| Python | `test_matches_any_glob_worca_prefix` | `worca-install` matches `worca-*`; `worca` does not |
| Python | `test_matches_any_exact_match` | `hookify:hookify` matches only itself |
| Python | `test_matches_any_bare_wildcard` | `*` matches everything; `len > 1` guard prevents prefix-glob path |
| Python | `test_matches_any_empty_candidate` | Empty string does not match `worca-*` |
| Python | `test_check_allowed_missing_section_uses_defaults` | Empty config returns bundled defaults |
| Python | `test_check_allowed_workspace_planner_falls_back_to_defaults` | Agent role not enumerated in `per_agent_allow` resolves via `_defaults` (regression test for §1.2 defect) |
| Python | `test_check_allowed_via_field` | Returns `wildcard` or `explicit` correctly |
| Python | `test_check_allowed_empty_agent_allows_all` | Empty `WORCA_AGENT` → interactive mode allows all |
| Python | `test_resolve_tool_disallows_drops_skill` | `Skill` never in returned disallow list |
| Python | `test_resolve_tool_disallows_named_entries_warn` | Named tool entries get warning + ignored |
| Python | `test_skill_hook_extract_skill_name` | `_extract_skill_name()` extracts from `tool_input` correctly |
| Python | `test_skill_hook_allows_via_settings` | Hook returns 0 when skill allowed; emits telemetry with `via` |
| Python | `test_skill_hook_blocks_always_disallowed` | Hook returns 2 for `always_disallowed` skill |
| Python | `test_skill_hook_blocks_default_denied` | Hook returns 2 for `default_denied` skill not in per_agent_allow |
| Python | `test_skill_hook_allows_mixed_form` | Hook returns 0 for `["*", "review"]` with `review`; `via: "explicit"` |
| Python | `test_migration_subagent_dispatch_to_dispatch_subagents` | W-038 shape → W-054 shape preserves per-agent values |
| Python | `test_migration_seeds_defaults` | `_defaults` is seeded from bundled defaults |
| Python | `test_migration_idempotent` | Re-running migration is a no-op |
| UI | `dispatch-section.test.js — wildcard chip renders distinctly` | `*` chip has the wildcard class |
| UI | `dispatch-section.test.js — mixed form parses` | Tag input accepts `["*", "review"]` |
| UI | `dispatch-section.test.js — always_disallowed chips locked` | Locked chips have struck-through class + no remove button |
| UI | `dispatch-section.test.js — default_denied chips editable` | Default-denied chips have warn color + editable |
| UI | `settings.test.js — three section cards render` | Tools, Skills, Subagents cards all present |
| UI | `settings.test.js — AGENT_NAMES includes workspace_planner` | Nine agents in the list |
| UI | `run-detail-dispatch.test.js — wildcard counter` | Counts events by `via` field correctly |
| UI | `dispatch-migration.test.js — JS migration matches Python` | Same fixture → same output |

### Unit tests for skill hook (replacing integration tests)

The skill hook is tested by invoking `skill_use.py:main()` directly with synthetic stdin
payloads, not through full pipeline integration. This is sufficient because:
- The hook logic (read stdin JSON → extract skill name → call `check_allowed` → emit
  telemetry → exit) is identical whether invoked from a real pipeline or from a test harness.
- The existing `mock_claude.py` does not support `Skill` tool calls and extending it is
  out of scope for W-054.
- `check_allowed()` is already tested exhaustively in Phase 1 unit tests.

| Scenario | Setup | Expected |
|---|---|---|
| Skill allowed via wildcard | stdin: `{"tool_name":"Skill","tool_input":{"skill_name":"my-lint"}}`, env: `WORCA_AGENT=implement-implementer-iter-1`, config: `_defaults: ["*"]` | exit 0, telemetry `via: "wildcard"` |
| Skill blocked by always_disallowed | stdin: skill `worca-install`, config: default | exit 2, reason `always_disallowed` |
| Skill blocked by default_denied | stdin: skill `review`, agent: `implementer`, config: default | exit 2, reason `default_denied` |
| Skill allowed via mixed form | stdin: skill `review`, agent: `reviewer`, config: `reviewer: ["*", "review"]` | exit 0, `via: "explicit"` |
| Interactive mode (no WORCA_AGENT) | stdin: any skill, env: no `WORCA_AGENT` | exit 0 |

### Integration tests

| Scenario | Expected |
|---|---|
| Pipeline run with `dispatch.tools.per_agent_allow.planner: []` | Planner only gets always_disallowed in its `--disallowedTools` |
| `worca init --upgrade` on a settings.json with old `subagent_dispatch` | New shape written, old key removed, per-agent values preserved, `_defaults` seeded |

Note: full-pipeline integration tests for the skill hook are deferred. The skill hook's
correctness is validated by Phase 1 `check_allowed()` unit tests + Phase 2 synthetic-stdin
hook tests. Adding mock_claude support for `Skill` tool calls is tracked separately.

### E2E tests (Playwright)

| Scenario | Expected |
|---|---|
| Settings page renders three section cards | Tools, Skills, Subagents sections visible |
| Adding `review` to reviewer's per-agent allow → save → reload | Value persists, shows mixed `["*", "review"]` |
| Run detail wildcard counter | Shows `N explicit, M via wildcard` for a run with mixed dispatch |

### Existing tests to update

- `tests/test_init_migration.py` — extend existing W-038 migration tests with W-054 migration
  assertions (new shape under `dispatch.subagents`, `_defaults` seeding).
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
- **Full pipeline integration tests for skill hook.** The mock_claude infrastructure does not
  support `Skill` tool calls. Extending it is separate work; W-054 validates the skill hook
  via unit tests with synthetic stdin payloads.

## Review Issue Resolution Log

### Issue 1 (critical): UI save path language boundary

**Problem:** Plan claimed the UI save path would call a Python migration module, but the
UI server is JavaScript/Express with no mechanism to call Python code.

**Resolution:** Migration logic is ported to a JS module `worca-ui/server/dispatch-migration.js`
following the same mutate-in-place pattern as the existing `global-keys.js`. The Python
migration stays in `init.py` for `worca init --upgrade`. A sync test
(`tests/test_denylist_sync.py`) asserts both implementations produce identical output for
shared fixture inputs. See §10.3.

### Issue 2 (critical): Skill hook payload field path

**Problem:** Plan assumed `data.get('skill_name', '')` at the top level, but PreToolUse
payloads provide `tool_name` and `tool_input` — the skill name is inside `tool_input`.

**Resolution:** §7.2 now specifies that the skill name is extracted from `tool_input`
(not the top-level payload) via a defensive `_extract_skill_name()` helper. Phase 2
implementation must verify the exact field path against a real Skill tool payload before
finalizing. The dropped `_enumerate_skills_from_hook_payload()` is no longer needed (see
Issue 3).

### Issue 3 (major): `all_known` parameter infeasible at hook time

**Problem:** `check_allowed()` required an `all_known` set for wildcard expansion, but no
mechanism exists to enumerate all skills/subagents at hook invocation time.

**Resolution:** `check_allowed()` no longer takes an `all_known` parameter. When `*` is in
the entry, the check reduces to "allow if not in `always_disallowed` AND (not in
`default_denied` OR explicitly named in entry)". The full enumeration is only needed for
UI autocomplete endpoints, where it's already available. See §2.1.

### Issue 4 (major): `Xo` in build artifact vs `AGENT_NAMES` in source

**Problem:** Plan referenced `Xo` in `main.bundle.js` (build artifact) instead of the source
constant `AGENT_NAMES` in `settings.js`.

**Resolution:** All references updated to `AGENT_NAMES` in `worca-ui/app/views/settings.js:61-70`.
Phase 4 Step 1 targets the source file. See §10.0.

### Issue 5 (major): `_matches_any()` unspecified

**Problem:** The glob matching function was referenced but never implemented in the plan.

**Resolution:** Full implementation specified in new §11, including the function body, edge
cases with expected behavior, the `len(pattern) > 1` guard rationale, and the JS counterpart
requirement. Unit tests for each edge case are listed in Phase 1.

### Issue 6 (major): Integration tests for skill hook infeasible

**Problem:** The mock_claude infrastructure doesn't support Skill tool calls, making the
listed integration tests impossible without extending the mock.

**Resolution:** Skill hook integration tests are replaced with unit tests that invoke
`skill_use.py:main()` directly with synthetic stdin payloads. This validates the same logic
without requiring mock_claude changes. The test table is in "Unit tests for skill hook"
section. Extending mock_claude for Skill support is explicitly out of scope.

### Issue 7 (major): `package.json` files allowlist missing new JSON files

**Problem:** `server/**/*.js` covers JS files but new `.json` files (`known-tools.json`,
`known-skills.json`) would be silently dropped from the published package.

**Resolution:** Phase 4 Step 9 explicitly adds the new JSON files to the `files` allowlist
and requires `npm pack --dry-run` verification before committing. See Phase 4.
