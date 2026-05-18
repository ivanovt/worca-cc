# Dispatch Governance

Worca controls which tools, skills, and subagents each pipeline agent can invoke. All three dimensions share a consistent three-tier resolution model configured under `worca.governance.dispatch` in `.claude/settings.json`.

## Three-tier model

Each section (`tools`, `skills`, `subagents`) has three tiers:

| Tier | Key | Overridable | Purpose |
|------|-----|-------------|---------|
| 1 | `always_disallowed` | No | Hard deny — worca-internal footguns that no agent should ever invoke. Cannot be bypassed from settings. |
| 2 | `default_denied` | Yes, via explicit opt-in | Blocked unless the agent explicitly names them in `per_agent_allow`. The `"*"` wildcard does **not** include them. |
| 3 | `per_agent_allow` | N/A | Per-agent allow list with `_defaults` fallback. Controls what each agent role can use. |

## Resolution algorithm

Given a `(section, agent, candidate)` triple:

1. If `candidate` matches any pattern in `always_disallowed` → **deny** (reason: `always_disallowed`).
2. Look up `per_agent_allow[agent]`; if absent, fall back to `per_agent_allow._defaults`.
3. If the allow list contains `"*"` (wildcard):
   - If `candidate` is also named explicitly in the list → **allow** (via: `explicit`).
   - If `candidate` matches any pattern in `default_denied` → **deny** (reason: `default_denied`).
   - Otherwise → **allow** (via: `wildcard`).
4. If the allow list does not contain `"*"`:
   - If `candidate` is named explicitly → **allow** (via: `explicit`).
   - Otherwise → **deny** (reason: `not_in_allow_list`).

When `WORCA_AGENT` is empty (interactive mode), all dispatches are allowed — hooks do not gate interactive sessions.

## Per-section defaults and rationale

### Tools

```jsonc
{
  "always_disallowed": ["EnterPlanMode", "EnterWorktree", "TodoWrite"],
  "default_denied": [],
  "per_agent_allow": { "_defaults": ["*"] }
}
```

**Default: wide open (`["*"]`).** Per-tool blast radius is small, and Bash is already hook-guarded by `pre_tool_use.py`. The `always_disallowed` entries prevent agents from entering plan mode, spawning worktrees, or writing todos — actions that would break pipeline flow.

The tools section only honors `"*"` and `[]` (lockdown) — named-tool allowlists are not supported in v1 because `--disallowedTools` takes an enumeration and inverting against an unstable tool universe (built-ins + MCP) is brittle.

### Skills

```jsonc
{
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
}
```

**Default: wide open (`["*"]`).** Developers usually have custom skills (lint wrappers, code-review skills, doc-management skills); blocking them all would defeat the purpose of enabling the Skill tool. Footguns are covered by the denylist tiers.

**Tier 1 (`always_disallowed`) rationale:**

| Pattern | Reason |
|---------|--------|
| `loop`, `schedule` | Pipeline-recursion — an agent spawning its own loop would fork unbounded work |
| `worca-*` | Pipeline-spawning — `worca-install`, `worca-rc`, `worca-release`, etc. should never run inside a pipeline |
| `update-config` | Governance self-modification — agents must not change their own config mid-run |
| `hookify:hookify`, `hookify:configure`, `hookify:list`, `hookify:writing-rules` | Hook self-modification — agents must not install or reconfigure hooks |
| `init` | CLAUDE.md overwrite — the init skill would clobber project instructions |

**Tier 2 (`default_denied`) rationale:**

| Skill | Reason |
|-------|--------|
| `review`, `security-review` | Duplicate reviewer-stage work; opt-in for second-opinion runs |
| `feature-dev:feature-dev` | Would launch nested feature development inside an already-developing pipeline |
| `claude-md-management:revise-claude-md`, `claude-md-management:claude-md-improver` | Modify CLAUDE.md mid-pipeline; useful only for the learner stage |

### Subagents

```jsonc
{
  "always_disallowed": ["general-purpose"],
  "default_denied": [],
  "per_agent_allow": {
    "_defaults": ["Explore"],
    "implementer": ["Explore", "feature-dev:code-reviewer"]
  }
}
```

**Default: narrow (`["Explore"]`).** Subagents can fork unbounded invisible work — each subagent spawns a full Claude session with its own tool access. Broader access is opt-in.

## Asymmetric defaults

The three sections intentionally use different default postures:

| Section | `_defaults` | Rationale |
|---------|-------------|-----------|
| tools | `["*"]` | Per-tool blast radius is small; Bash already hook-guarded |
| skills | `["*"]` | Custom skills are the primary use case for enabling Skill; denylist covers footguns |
| subagents | `["Explore"]` | Subagents fork unbounded invisible work — opt-in to broader access |

This is not inconsistency — it reflects blast radius. A tool call is one operation. A skill invocation runs a bounded script. A subagent spawns a full agent session.

## Wildcard semantics

- `"*"` in `per_agent_allow` (either `_defaults` or a per-agent entry) means "allow any item not in `always_disallowed` or `default_denied`".
- `"*"` is honored in both `_defaults` and per-agent entries.
- Per-agent entries **replace** `_defaults` — there is no union. This matches the existing `tracking.py` subagent dispatch behavior.

## Mixed form syntax

The mixed form `["*", "extra"]` means "wildcard plus these specific opted-in items." Named items in a mixed-form list that also appear in `default_denied` are treated as explicit opt-ins — they bypass the `default_denied` gate.

Example: allowing the `review` skill (which is `default_denied`) for the reviewer agent:

```jsonc
"per_agent_allow": {
  "_defaults": ["*"],
  "reviewer": ["*", "review"]
}
```

Here, `"*"` allows everything except `always_disallowed` and `default_denied`. The explicit `"review"` entry opts in to that specific `default_denied` skill. Telemetry reports `via: "explicit"` for `review` and `via: "wildcard"` for other allowed items.

## Empty `[]` lockdown

An empty per-agent allow list means "nothing allowed for this agent" — this is an explicit lockdown, not a fallback to `_defaults`.

```jsonc
"per_agent_allow": {
  "_defaults": ["*"],
  "coordinator": []
}
```

The coordinator can invoke no skills/subagents/tools (depending on the section), while all other agents get the wildcard default.

## `always_disallowed` and `default_denied` overlap

If the same name appears in both tiers, `always_disallowed` wins — it short-circuits first in the resolution algorithm. The item cannot be opted in via `per_agent_allow` regardless of the `default_denied` entry.

## Pattern matching

Both `always_disallowed` and `default_denied` support:

- **Exact match:** `"EnterPlanMode"` matches only `EnterPlanMode`
- **Trailing-`*` glob:** `"worca-*"` matches `worca-install`, `worca-release`, etc.
- **Bare `"*"`:** matches everything (typically only useful in `per_agent_allow`)

`per_agent_allow` entries only use exact names and the bare `"*"` wildcard.

## Observability

Dispatch decisions emit telemetry events:

- `pipeline.hook.dispatch_allowed` (subagents and skills) with `via: "wildcard" | "explicit"` indicating how the decision was made.
- The Run Detail Governance section in the UI surfaces a counter: "Dispatch activity: N explicit, M via wildcard" — useful for detecting drift when a project flips defaults to `*`.

## Enforcement points

| Section | Hook script | Mechanism |
|---------|-------------|-----------|
| tools | `claude_cli.py` | `--disallowedTools` flag on agent subprocess |
| skills | `skill_use.py` | PreToolUse hook on the `Skill` tool |
| subagents | `subagent_start.py` | SubagentStart hook |

## Configuration examples

### Allow the reviewer to use the `review` skill

```jsonc
"skills": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "reviewer": ["*", "review"]
  }
}
```

### Lock down all subagent dispatch for the coordinator

```jsonc
"subagents": {
  "per_agent_allow": {
    "_defaults": ["Explore"],
    "coordinator": []
  }
}
```

### Give the implementer access to code-reviewer subagent

```jsonc
"subagents": {
  "per_agent_allow": {
    "_defaults": ["Explore"],
    "implementer": ["Explore", "feature-dev:code-reviewer"]
  }
}
```

### Disable all tools for an agent (lockdown)

```jsonc
"tools": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "learner": []
  }
}
```
