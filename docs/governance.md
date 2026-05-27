# Dispatch Governance

Worca controls which tools, skills, and subagents each pipeline agent can invoke. All three dimensions share a consistent three-tier resolution model configured under `worca.governance.dispatch` in `.claude/settings.json`.

## Three-tier model

Each section (`tools`, `skills`, `subagents`) has three tiers:

| Tier | Key | Overridable | Purpose |
|------|-----|-------------|---------|
| 1 | `always_disallowed` | Yes, by editing settings.json | Hard deny — worca-internal footguns no agent should invoke. The `_DISPATCH_DEFAULTS` constants in `tracking.py` populate this on `worca init`/`--upgrade`, but the resulting value in `settings.json` can be edited or cleared per project. Edit sparingly. |
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

**Named-tool allowlists are supported (PR C).** `per_agent_allow` honors three forms:

| Form | CLI translation | Meaning |
|------|-----------------|---------|
| `["*"]` (default) | `--tools default` | All built-in tools allowed (minus `always_disallowed`) |
| `["Read", "Grep"]` | `--tools Agent,Grep,Read,Skill` | Only the named built-ins are allowed; **`Skill` and `Agent` are auto-included** so worca's skill / subagent governance hooks still fire |
| `[]` (or missing key) | inherits `_defaults` | Falls through — clearing chips in the UI does not silently brick an agent |
| `["none"]` | `--tools ""` | Explicit lockdown — no built-in tool can be used |

**Two constraints worth knowing:**

1. **MCP tools (`mcp_*`) are not covered by `--tools`.** Per the Claude CLI help text, `--tools` only restricts the *built-in* set. MCP governance flows through separate channels (the MCP server's own auth, the harness's MCP allow/deny configuration). A named tool allowlist does not block MCP calls.
2. **`Skill` and `Agent` are meta-tools.** They invoke skills and subagents, and the worca hooks (`skill_use.py` and `subagent_start.py`) gate those calls. If you author a named allowlist without `Skill` or `Agent`, the agent can't dispatch — but the hooks would never fire if those meta-tools were truly excluded from `--tools`. The implementation auto-adds them to any named list to keep both governance paths alive.

### Skills

```jsonc
{
  "always_disallowed": [
    "batch", "fewer-permission-prompts",
    "loop", "schedule",
    "worca-*",
    "update-config",
    "hookify:hookify", "hookify:configure", "hookify:list", "hookify:writing-rules",
    "init"
  ],
  "default_denied": [
    "claude-api", "debug",
    "review", "security-review", "simplify",
    "feature-dev:feature-dev",
    "claude-md-management:revise-claude-md",
    "claude-md-management:claude-md-improver"
  ],
  "per_agent_allow": {
    "_defaults": ["*"],
    "implementer": ["*", "simplify", "claude-api"],
    "tester": ["*", "debug"],
    "reviewer": ["*", "review", "security-review"],
    "learner": [
      "*",
      "claude-md-management:revise-claude-md",
      "claude-md-management:claude-md-improver"
    ]
  }
}
```

**Default: wide open (`["*"]`).** Developers usually have custom skills (lint wrappers, code-review skills, doc-management skills); blocking them all would defeat the purpose of enabling the Skill tool. Footguns are covered by the denylist tiers.

**Tier 1 (`always_disallowed`) rationale:**

| Pattern | Reason |
|---------|--------|
| `batch` | Pipeline-spawning — the bundled `/batch` skill decomposes work into 5–30 background subagent worktrees and opens PRs, which would recursively launch parallel pipelines inside a pipeline |
| `fewer-permission-prompts` | Governance self-modification — modifies the project's `.claude/settings.json` allowlist, bypassing the worca governance boundary |
| `loop`, `schedule` | Pipeline-recursion — an agent spawning its own loop would fork unbounded work |
| `worca-*` | Pipeline-spawning — `worca-install`, `worca-rc`, `worca-release`, etc. should never run inside a pipeline |
| `update-config` | Governance self-modification — agents must not change their own config mid-run |
| `hookify:hookify`, `hookify:configure`, `hookify:list`, `hookify:writing-rules` | Hook self-modification — agents must not install or reconfigure hooks |
| `init` | CLAUDE.md overwrite — the init skill would clobber project instructions |

**Tier 2 (`default_denied`) rationale:**

| Skill | Reason | Default opt-ins |
|-------|--------|-----------------|
| `claude-api` | Claude API reference + model-ID migration; useful when implementing API features but noisy elsewhere | `implementer` |
| `debug` | Enables debug logging mid-session; high-signal for the tester but distracts other agents | `tester` |
| `review`, `security-review` | Duplicate reviewer-stage work; opt-in for second-opinion runs | `reviewer` |
| `simplify` | Spawns 3 parallel review-style agents — fine for the implementer's self-review loop, too heavy for other stages | `implementer` |
| `feature-dev:feature-dev` | Would launch nested feature development inside an already-developing pipeline | (none) |
| `claude-md-management:revise-claude-md`, `claude-md-management:claude-md-improver` | Modify CLAUDE.md mid-pipeline; useful only for the learner stage | `learner` |

### Subagents

```jsonc
{
  "always_disallowed": [],
  "default_denied": ["general-purpose"],
  "per_agent_allow": { "_defaults": ["*"] }
}
```

**Default: wide open (`["*"]`).** All built-in subagents (`Explore`, `Plan`, `claude-code-guide`, `statusline-setup`) plus user/plugin subagents resolve via wildcard. The `general-purpose` subagent is in `default_denied` because it spawns an unconstrained Claude session with full tool access — so it stays **off by default** (the `"*"` wildcard excludes `default_denied`), but a project can re-allow it for a specific agent by naming it in `per_agent_allow` (e.g. `"implementer": ["*", "general-purpose"]`).

> **Why `default_denied`, not `always_disallowed`?** It used to be on `always_disallowed`, which the resolver checks *before* `per_agent_allow` — so there was no way to opt in even by naming it explicitly. Moving it to `default_denied` keeps the footgun guarded by default while making the opt-in path actually work. Upgrading projects self-heal via the v2 dispatch normalization (stamped on `governance.dispatch_migration_version`); the UI editor no longer hard-blocks typing `general-purpose` into an allow list.

Projects that need tighter control add specific subagents to `default_denied` and opt in per agent. The plain wildcard default reflects an operational reality: hand-curating allowlists for an evolving set of project/plugin subagents creates more drift than safety. To genuinely forbid a subagent everywhere (no per-agent opt-in possible), add it to `always_disallowed`.

## Asymmetric defaults

All three sections now default to `["*"]` (PR B for subagents). The deny tiers carry the protection:

| Section | `_defaults` | Tier-1 denials |
|---------|-------------|----------------|
| tools | `["*"]` | `EnterPlanMode`, `EnterWorktree`, `TodoWrite` (always_disallowed) |
| skills | `["*"]` | `batch`, `fewer-permission-prompts`, `loop`, `schedule`, `worca-*`, `update-config`, `hookify:*`, `init` (always_disallowed) |
| subagents | `["*"]` | `general-purpose` (default_denied — off by default, allowable per-agent) |

The skills section additionally uses `default_denied` to gate per-agent opt-ins (`simplify`, `debug`, `claude-api`, `review`, etc.). The subagents section uses `default_denied` for `general-purpose` (same pattern: normally off; an agent can opt in). `always_disallowed` is empty by default for subagents — projects add to it only to forbid a subagent with no opt-in path.

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

## Empty `[]` falls through; `["none"]` is lockdown

An empty per-agent allow list **falls through to `_defaults`**. Clearing the chip list in the UI must not silently brick an agent — that was a real footgun.

To express full lockdown, use the singleton `["none"]` (the `LOCKDOWN_SENTINEL`):

```jsonc
"per_agent_allow": {
  "_defaults": ["*"],
  "coordinator": ["none"]    // lockdown — no skill/subagent/tool allowed
}
```

The coordinator can invoke nothing in that section, while all other agents get the wildcard default. Any combination other than the exact singleton (`["none", "Read"]`, etc.) treats `"none"` as a literal name that won't match anything real — the sentinel only fires for the exact one-element list.

## `always_disallowed` and `default_denied` overlap

If the same name appears in both tiers within the resolved config, `always_disallowed` wins — it short-circuits first in the resolution algorithm. The item cannot be opted in via `per_agent_allow` regardless of the `default_denied` entry. (Removing the name from `always_disallowed` in `settings.json` would demote it to `default_denied`-only, which is the intended escape hatch when a project genuinely needs to override a default footgun.)

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
| tools | `claude_cli.py` | `--tools <list>` + `--disallowedTools <list>` flags on agent subprocess |
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
    "coordinator": ["none"]   // singleton sentinel — explicit lockdown
  }
}
```

### Tighten subagents from the default wildcard

The default is `["*"]` (PR B). To go back to a narrow Explore-only posture for the coordinator while leaving every other agent on the wildcard default:

```jsonc
"subagents": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "coordinator": ["Explore"]
  }
}
```

### Block a specific subagent from the wildcard default

Add it to `default_denied`. The wildcard does not include `default_denied` entries:

```jsonc
"subagents": {
  "default_denied": ["claude-code-guide"],
  "per_agent_allow": {
    "_defaults": ["*"]
  }
}
```

### Re-allow `general-purpose` for one agent

`general-purpose` ships in `default_denied`, so it is blocked under the wildcard. Name it explicitly in a per-agent entry to opt that agent in (the mixed form `["*", …]` keeps the wildcard for everything else):

```jsonc
"subagents": {
  "default_denied": ["general-purpose"],
  "per_agent_allow": {
    "_defaults": ["*"],
    "implementer": ["*", "general-purpose"]
  }
}
```

### Disable all tools for an agent (lockdown)

```jsonc
"tools": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "learner": ["none"]
  }
}
```

The learner subprocess is invoked with `--tools ""` — no built-in tool is available. The `Skill` and `Agent` PreToolUse hooks still fire, but they can't ultimately succeed because the underlying tools they invoke are themselves locked down.

### Restrict an agent to a named tool subset

```jsonc
"tools": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "reviewer": ["Read", "Grep"]
  }
}
```

The reviewer subprocess is invoked with `--tools Agent,Grep,Read,Skill` (with `Skill`/`Agent` auto-included). The reviewer can read and grep but cannot Edit, Write, or run Bash. Worca's skill/subagent governance still applies to the meta-tools.
