# W-052: Adaptive Effort Levels for Pipeline Agents

**Status:** Draft (decisions locked 2026-05-12; execution defaults locked 2026-05-15)
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-05-12
**Depends on:** None

## Locked Defaults (2026-05-15)

Four execution defaults are now binding (mirror of the `## Decisions` section on issue #160):

- **Shipping strategy** — single PR landing all 7 phases atomically. No phase-split. Heavier diff but no half-shipped state and atomic rollback.
- **Default `auto_mode` (fresh installs)** — `adaptive`. Coordinator emits `worca-effort:*` labels on first run; the implementer consumes them. Documented in MIGRATION.md as a behavior change for upgraders.
- **Default `auto_cap`** — `xhigh`. Lets escalation reach Opus 4.7's model-default ceiling; `max` is reachable only via explicit operator opt-in.
- **Per-agent defaults in shipped `src/worca/settings.json`** — bake `planner: xhigh`, `coordinator: medium`, `guardian: high`. Leave `implementer`, `tester`, `reviewer` unset so the adaptive path drives base from the coordinator's per-bead label (or model default under `disabled`/`reactive`).

## Problem

Claude Code exposes a discrete reasoning-effort scale (`low`, `medium`, `high`, `xhigh`, `max`) via the `--effort` flag, `CLAUDE_CODE_EFFORT_LEVEL` env var, and per-agent frontmatter (see [Claude Code model-config docs](https://code.claude.com/docs/en/model-config#adjust-effort-level)). On Opus 4.7 the default is `xhigh`; on Opus 4.6 and Sonnet 4.6 it is `high`. Effort directly controls how much adaptive reasoning the model spends per step, and is the primary lever for trading token spend against capability — distinct from `--model` (model identity) and `--max-turns` (turn budget).

worca-cc does not surface this lever anywhere today:

1. The CLI wrapper in `src/worca/utils/claude_cli.py:133-146` builds the `claude -p` command with `--model`, `--output-format`, `--no-session-persistence`, and `--dangerously-skip-permissions`, but never `--effort` and never `CLAUDE_CODE_EFFORT_LEVEL`. Every agent invocation falls through to the Claude Code default for its model.
2. Per-agent config in `worca.agents.<agent>` (`src/worca/orchestrator/stages.py:78-110`) reads only `model` and `max_turns`. There is no `effort` field.
3. The iteration trigger (`initial`, `test_failure`, `review_changes`) is already in scope at `runner.py:1839-1864` when stage config is resolved, but it is unused for effort — `max_turns` simply gets a uniform `msize` multiplier (`runner.py:1873`).
4. Status records (`src/worca/state/status.py:75-110`) capture `agent`, `model`, `trigger`, and `started_at` per iteration. There is no `effort` field, so the UI cannot show or debug which effort level a stage ran with, and the learner cannot correlate effort against outcomes.

User-facing impact: pipeline operators cannot calibrate intelligence-vs-cost per stage or per iteration. A planner that bounces three times through plan_review keeps running at the same default effort; an implementer that fails tests twice cannot escalate; a coordinator that does mostly mechanical bead splitting cannot be dialed *down* to save tokens. There is no path between "all agents at model default" and "edit the runner."

## Proposal

Add a per-agent `effort` field to `worca.agents.<agent>` accepting `low | medium | high | xhigh | max`. Values pass through via `CLAUDE_CODE_EFFORT_LEVEL` on the per-stage env dict (reusing the existing `worca.models.*.env` merge path). Omitted means "use Claude Code's model default."

A new `worca.effort` block governs **how** the per-agent value is consumed and whether the runtime adapts:

- `auto_mode`: `disabled` | `reactive` | `adaptive` (default).
- `auto_cap`: ceiling for runtime-resolved levels (default `xhigh`).

The three modes encode two orthogonal axes — **starting point** (template-author's intent vs LLM judgment per bead) and **escalation** (do loopbacks bump effort):

| Mode | Starting point | Escalation on loopbacks |
|---|---|---|
| `disabled` | per-agent `effort` value (if set) else model default | NO |
| `reactive` | per-agent `effort` value (if set) else model default | YES |
| `adaptive` | per-agent `effort` value if explicitly set (wins), else coordinator-set bead label | YES |

**The coordinator owns per-bead effort classification.** During its normal `bd create` pass (Opus, full plan + scope in context), it attaches `--labels worca-effort:<level>` and writes a reasoning note via `bd update --notes`. No separate classifier agent. The coordinator emits labels **regardless of `auto_mode`** — under `reactive` / `disabled` the labels are informational and used for forensic comparison ("would `adaptive` have run this differently?").

Implementer loopback escalation: `test_failure` +1 rung, `review_changes` +2 rungs, stacked across iterations. Planner: +1 per `plan_review_changes` bounce. Resolved effort + the coordinator's verdict + a `skip_reason` (when divergent) are persisted per-iteration in `status.json` and surfaced in the UI as tight badges/chips.

## Design

### 1. Schema — per-agent `effort` field

**Current state:** `src/worca/orchestrator/stages.py:100-110`

```python
agent_config = worca.get("agents", {}).get(agent_name, {})
...
raw_model = agent_config.get("model", "sonnet")
model_id, model_env = _resolve_model(raw_model, model_map)
return {
    "agent": agent_name,
    "model": model_id,
    "model_env": model_env,
    "max_turns": agent_config.get("max_turns", 30),
    "schema": STAGE_SCHEMA_MAP.get(stage, f"{stage.value}.json"),
}
```

**Resolution:** add `effort` to the returned dict, sourced from `agent_config.get("effort")`. `None` means "omitted — use model default" (under `disabled`/`reactive`) or "fall back to coordinator-set bead label" (under `adaptive` for the implementer). Resolution into a concrete level happens in the runner (see §3).

The per-agent `effort` field accepts only literal rungs: `low | medium | high | xhigh | max`. There is **no `auto` value** — the mode field (`worca.effort.auto_mode`) decides whether explicit values, model defaults, or per-bead LLM judgment are used as the starting point. This collapses the plan's earlier "explicit values never escalate; only `auto` escalates" complexity into a single rule: mode controls escalation, the per-agent field is just the starting point (and acts as an override under `adaptive`).

**This is the shipped `src/worca/settings.json` default** (per *Locked Defaults*). Existing keys (`model`, `max_turns`) are unchanged — only the four new entries shown below are added on top of the current block:

```jsonc
// src/worca/settings.json (shipped default, committed)
"worca": {
  "effort": {
    "auto_mode": "adaptive",        // disabled | reactive | adaptive  ← LOCKED
    "auto_cap":  "xhigh"            // low | medium | high | xhigh | max  ← LOCKED
  },
  "agents": {
    "planner":     { "model": "opus",   "max_turns": 100, "effort": "xhigh"  },  // LOCKED — heavy reasoning
    "coordinator": { "model": "opus",   "max_turns": 300, "effort": "medium" },  // LOCKED — mechanical decomposition
    "implementer": { "model": "sonnet", "max_turns": 300                     },  // LOCKED unset — adaptive path drives base
    "tester":      { "model": "sonnet", "max_turns": 100                     },  // LOCKED unset — model default
    "reviewer":    { "model": "opus",   "max_turns": 50                      },  // LOCKED unset — model default
    "guardian":    { "model": "opus",   "max_turns": 50,  "effort": "high"   }   // LOCKED — high vigilance
  }
}
```

**No new agent entries.** The coordinator handles effort labeling itself; no `effort_classifier` agent is needed.

**Validation:** at pipeline start, log an info line reporting effective `auto_mode` + `auto_cap`. No error conditions — invalid `effort` values fall back to model default with a stderr warning.

### 2. Data model — bead labels and notes

The coordinator persists its effort verdict on the bead itself so the cache survives across resumes, worktrees, and re-runs of the same plan:

- **Label**: `worca-effort:<level>` (e.g. `worca-effort:high`). Namespaced to mirror the existing `run:{run_id}` convention (CLAUDE.md "Plans & Roadmap"). One value per bead.
- **Notes**: coordinator reasoning appended via `bd update <id> --notes "Effort: <level> — <reasoning>"`. Visible in `bd show` and the UI bead detail panel.

**User precedence**: if a `worca-effort:*` label already exists on a bead the coordinator is creating or updating, the coordinator must preserve the existing value (do not overwrite). A user who wants to re-classify deletes the label manually.

**Mode-independent emission**: the coordinator emits labels and notes under all `auto_mode` settings (decision §4 below). Under `reactive` / `disabled` the label is informational and used for forensic comparison — it does **not** drive the implementer's starting point.

### 3. Resolution algorithm

The runner resolves effort once per stage invocation, after `get_stage_config()` and before `claude_cli` is called. Inputs: agent config's `effort` value, `auto_mode`, `auto_cap`, current trigger, current iteration number, and (for implementer only) the assigned bead.

```python
def resolve_effort(agent, agent_effort, auto_mode, auto_cap, trigger, iter_num, bead):
    """
    Returns (level, source, base, bead_classified) where:
      level            -- value sent to CLAUDE_CODE_EFFORT_LEVEL (or None to omit)
      source           -- one of: explicit, model_default,
                          adaptive:llm, reactive, disabled
      base             -- starting point before escalation
      bead_classified  -- {level, applied, skip_reason} or None for non-bead stages
    """
    # --- Determine bead-classified record (always populated when bead exists) ---
    bead_label = read_bead_effort_label(bead) if bead else None
    bead_classified = None
    if bead is not None:
        bead_classified = {
            "level": bead_label,
            "applied": False,
            "skip_reason": None,  # filled in below
        }

    # --- Determine starting point ---
    if agent_effort is not None:
        base = agent_effort
        source_base = "explicit"
        if bead_classified is not None:
            bead_classified["skip_reason"] = "explicit_override"
    elif auto_mode == "adaptive" and agent == "implementer" and bead_label:
        base = bead_label
        source_base = "adaptive:llm"
        bead_classified["applied"] = True
    else:
        base = MODEL_DEFAULT
        source_base = "model_default"
        if bead_classified is not None:
            if auto_mode == "disabled":
                bead_classified["skip_reason"] = "mode_disabled"
            elif auto_mode == "reactive":
                bead_classified["skip_reason"] = "mode_reactive"
            elif agent != "implementer":
                bead_classified["skip_reason"] = "non_classified_agent"

    # --- Apply escalation (only under reactive / adaptive) ---
    if auto_mode == "disabled":
        return (base, "disabled" if base else None, base, bead_classified)

    escalated = apply_escalation(base, agent, trigger, iter_num)
    final = clamp(escalated, auto_cap)
    source = source_base if source_base == "adaptive:llm" else auto_mode
    return (final, source, base, bead_classified)
```

The `(level, source, base, bead_classified)` tuple is persisted in `status.json` (see §6) and emitted as a log line.

**Escalation rules** (`apply_escalation`):

| Agent | Trigger | Delta |
|---|---|---|
| implementer | `initial` / `next_bead` | +0 |
| implementer | `test_failure` | +1 per loop (stacks across iters) |
| implementer | `review_changes` | +2 per loop (stacks across iters) |
| planner | `initial` | +0 |
| planner | `plan_review_changes` | +1 per re-run (stacks within run) |
| coordinator / tester / reviewer / guardian | any | +0 (no escalation; non-implementer-non-planner agents do not escalate on loopback) |

Only the agent re-running on a loopback escalates. Tester does not escalate when re-run after an implementer fix; only the implementer does. Reviewer does not escalate when re-run after another loop; only the originating agent does.

`clamp(level, cap)` rounds the level *down* to the cap if it exceeds it, and records `capped_from` in the iteration record.

**Note on disabled mode and per-agent values:** under `disabled`, an explicit per-agent `effort` is still applied as the env var (no escalation). The plan's earlier "explicit = never escalate" semantic now lives at the mode level — set `auto_mode: disabled` to pin every agent to its template value (or model default) and freeze escalation.

### 4. Coordinator-owned effort labeling

The coordinator (`src/worca/agents/core/coordinator.md`, Opus, `max_turns=300`) already reasons about every bead's scope as part of its decomposition pass. It owns effort classification — attaching `--labels worca-effort:<level>` during each `bd create` and writing a reasoning note via `bd update --notes`. No separate `effort_classifier` agent.

**Rubric** (added to `coordinator.md`):

| Level | When to pick |
|---|---|
| `low` | Typo fixes, comment-only changes, single-line config tweaks, doc updates with no code impact. |
| `medium` | Localized changes in a single file, mechanical refactors, well-scoped feature toggles. |
| `high` | Cross-file changes, new abstractions, non-trivial logic, anything touching pipeline state or governance hooks. |
| `xhigh` | Schema/migration work, concurrency, security-sensitive paths, multi-stage refactors with subtle invariants. |
| `max` | Never pick autonomously — reserved for explicit human or template signal. |

**Coordinator prompt addition** (concatenated to `coordinator.md` after the "Process" section):

```markdown
## Effort Labeling

For each Beads task you create, attach a `worca-effort:<level>` label reflecting
the task's complexity per the rubric below. Use the `--labels` flag on `bd create`:

  bd create --title="..." --type=task \
            --labels "run:{{run_id}},worca-effort:medium"

Immediately after creation, write a concise reasoning note (1-2 sentences):

  bd update <bead-id> --notes "Effort: medium — localized refactor in single file"

This is required regardless of pipeline `auto_mode` — labels under `reactive`/
`disabled` are informational and used for forensic comparison.

Never pick `max`. That rung is reserved for explicit human or template signal.
If an existing bead already has a `worca-effort:*` label, preserve it (do not
overwrite).
```

**Coordinator schema (`src/worca/schemas/coordinate.json`):** unchanged. Effort labels flow through the existing `bd create` shell-call path; no new structured output field needed.

**Coordinator template instructions** must also remind the agent to: (a) consider bead title + description + dependency count + plan section sliced from the linked plan file, (b) preserve any pre-existing `worca-effort:*` label.

**Failure modes:**
- **Missing label after coordinator finishes:** the runner detects unlabeled beads (`bd list --json` filter for `run:<id>` without `worca-effort:*`) and logs a warning. Resolution algorithm in §3 already handles this — base falls back to model default with `bead_classified.level = null`.
- **Invalid label value:** rejected by `resolve_effort()` (treated as null), warning logged. Pipeline does not halt.
- **No `classifier_failure` stop reason needed** — coordinator labeling is best-effort; the runtime never blocks on it.

**Beads created mid-run** (e.g. coordinator splits a bead during a loop): the coordinator is also the agent doing the splitting, so labels are attached at creation time by the same prompt logic. No lazy-classification path on IMPLEMENT entry.

### 5. Implementation seam — `CLAUDE_CODE_EFFORT_LEVEL`

Resolved effort is injected via the existing per-stage env-dict merge in `src/worca/utils/claude_cli.py`, not via a new CLI flag. This reuses the path already exercised by `worca.models.*.env` (see CLAUDE.md "Model Profiles") and inherits its reserved-key denylist via `src/worca/utils/env.py`.

**Reserved-key check:** `CLAUDE_CODE_EFFORT_LEVEL` is not in the worca denylist (`WORCA_*`, `PATH`, `CLAUDECODE`) so it is allowed through. Add an explicit test asserting this.

**Current state:** `src/worca/utils/claude_cli.py:133-146`

```python
cmd = [
    *_claude_bin,
    "-p",
    cli_prompt,
    "--agent",
    agent,
    ...
]
if model:
    cmd.extend(["--model", model])
```

**Resolution:** the env dict is already plumbed via `model_env` returned by `get_stage_config()`. The runner merges resolved effort into that dict before calling `run_agent()`:

```python
# runner.py — at the stage-invocation site
effort_level, effort_source = resolve_effort(
    agent=stage_config["agent"],
    agent_effort=stage_config["effort"],
    auto_mode=effort_settings["auto_mode"],
    auto_cap=effort_settings["auto_cap"],
    trigger=trigger,
    iter_num=iter_num,
    bead=assigned_bead,
)
env_overrides = dict(stage_config.get("model_env") or {})
if effort_level is not None:
    env_overrides["CLAUDE_CODE_EFFORT_LEVEL"] = effort_level
```

`run_agent()` already accepts and forwards `model_env`; this becomes a no-op there.

### 6. Observability — status.json and pipeline logs

**Iteration record extension** (`src/worca/state/status.py:75-110` `start_iteration`):

```jsonc
{
  "number": 2,
  "status": "in_progress",
  "started_at": "2026-05-12T10:14:33Z",
  "agent": "implementer",
  "model": "claude-sonnet-4-6",
  "trigger": "test_failure",
  "effort": {
    "level":  "xhigh",                // sent to CLAUDE_CODE_EFFORT_LEVEL (null = omitted)
    "source": "adaptive",             // explicit | model_default | adaptive:llm | reactive | disabled
    "base":   "high",                 // starting point before escalation
    "escalations": ["test_failure"],
    "capped_from": null,              // or "max" if clamp fired
    "bead_classified": {              // null for non-bead stages (planner, etc.)
      "level":  "high",               // coordinator's verdict for the assigned bead
      "applied": true,                // was this level used as the base?
      "skip_reason": null             // null when applied; else mode_reactive | mode_disabled | explicit_override | non_classified_agent
    }
  }
}
```

`bead_classified` is the forensic block — it answers "what did the coordinator think, and why was/wasn't that what the iteration ran at?" `skip_reason` enum: `"mode_reactive" | "mode_disabled" | "explicit_override" | "non_classified_agent" | null`. When `applied = true`, `skip_reason = null`.

**Pipeline log format** (terse `key=value` style, divergence-aware):

| Scenario | Log line |
|---|---|
| `adaptive`, bead label used | `IMPLEMENT iter 1: effort=high source=adaptive bead=high` |
| `adaptive`, explicit per-agent override | `IMPLEMENT iter 1: effort=xhigh source=explicit bead=medium(overridden)` |
| `reactive`, bead label informational | `IMPLEMENT iter 1: effort=high source=reactive bead=medium(ignored)` |
| `disabled`, bead label informational | `IMPLEMENT iter 1: effort=high source=disabled bead=medium(ignored)` |
| Loopback escalation | `IMPLEMENT iter 2: effort=xhigh source=adaptive bead=high +test_failure` |
| Cap fired | `IMPLEMENT iter 3: effort=xhigh source=adaptive bead=high +test_failure +test_failure capped` |
| Non-bead stage (e.g. planner) | `PLAN iter 1: effort=xhigh source=explicit` |
| Model default fallback | `TEST iter 1: effort=- source=model_default` |

Emitted from the existing stage-start log in `runner.py:1887-1889`.

### 7. UI surfaces

All effort surfaces use **tight indicators** — short badges and chips, no prose. Reasoning text (from the coordinator's `bd update --notes`) is **not** rendered in tooltips; it appears only in `bd show` and the bead-detail panel's notes section.

#### 7.1 Per-iteration badge (`worca-ui/app/views/run-detail.js`)

Iteration metadata row gets a two-chip display: the effective effort + the source qualifier, plus a `bead=` chip when the iteration ran with a bead and the bead's classified level disagrees.

```
Effort: [xhigh] [explicit]   Bead: [medium] [overridden]
Effort: [high]  [adaptive]   Bead: [high]
Effort: [xhigh] [+test_failure]
Effort: [high]  [reactive]   Bead: [medium] [ignored]
Effort: [-]     [model default]
```

Badge-variant mapping per `worca-ui/docs/badge-color-language.md`:

| Resolved level | Variant |
|---|---|
| `low` | `neutral` |
| `medium` | `neutral` |
| `high` | `primary` |
| `xhigh` | `warning` |
| `max` | `danger` |
| `(model default)` | `neutral` |

Source/qualifier chips (`[explicit]`, `[adaptive]`, `[reactive]`, `[disabled]`, `[model default]`, `[+test_failure]`, `[+review_changes]`, `[capped]`) use `neutral` variant. Divergence chips (`[overridden]`, `[ignored]`) use `warning`.

**Tooltip** (concise — single short line, no prose):
- `source = explicit` → `template value`
- `source = model_default` → `Claude Code default for this model`
- `source = adaptive` → `coordinator label: <level>`
- `source = reactive` / `disabled` + `bead.applied=false` → `coordinator labeled <level>; not applied under <mode>`
- `capped_from != null` → append ` · capped from <level>`
- Escalation present → append ` · escalated +<delta> from <base>`

#### 7.2 Run-header chip

Small chip in the run header: `Effort: adaptive · cap xhigh` (or `reactive` / `disabled`). Click-through reveals the per-agent table from the Settings panel scoped to this run.

#### 7.3 Bead detail panel — **read-only**

- Render the `worca-effort:*` label as a badge alongside other bead labels, with the §7.1 color scale.
- Render `[ignored: <mode>]` chip next to the badge when the active run's `auto_mode` is `reactive` or `disabled` (the label is informational under those modes).
- Surface the coordinator's reasoning note in a dedicated notes section.
- **No inline editor.** Mid-run effort overrides are not supported in the UI (decision §4 of the analysis). Operators who want to override edit settings.json per-agent or use a different `auto_mode`.

Per-iteration mini-table on bead detail (shows how each iteration actually ran):

```
iter 1  [xhigh] [explicit]
iter 2  [max]   [+test_failure] [capped]
iter 3  [high]  [adaptive]
```

#### 7.4 Settings panel (`worca-ui/app/views/settings.js`)

New "Effort" section, sibling to "Models" and "Secrets":

```
┌── Effort ────────────────────────────────────────────────┐
│ Auto mode    [adaptive ▾]                                 │
│              disabled | reactive | adaptive               │
│                                                           │
│ Auto cap     [xhigh ▾]                                    │
│              low | medium | high | xhigh | max            │
│                                                           │
│ Per-agent overrides:                                      │
│ ┌─────────────┬──────────┬─────────────────────────────┐ │
│ │ Agent       │ Effort   │ Notes                       │ │
│ ├─────────────┼──────────┼─────────────────────────────┤ │
│ │ planner     │ [xhigh▾] │                             │ │
│ │ coordinator │ [medium▾]│                             │ │
│ │ implementer │ [(def)▾] │ adaptive: coordinator label │ │
│ │ tester      │ [(def)▾] │ inherits Claude Code default│ │
│ │ reviewer    │ [(def)▾] │ adaptive: coordinator label │ │
│ │ guardian    │ [high ▾] │                             │ │
│ └─────────────┴──────────┴─────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

- Per-agent dropdown values: `(unset)`, `low`, `medium`, `high`, `xhigh`, `max`. **No `auto` value** — leave unset to get the mode-dependent fallback.
- Selecting `max` triggers a confirmation modal: `"max effort is the highest-cost rung. Confirm setting <agent> to max?"` with `Cancel` / `Set to max` buttons. Required for both per-agent settings and `auto_cap`.
- Writes to `settings.json` (non-secret).
- Project settings deep-merge over global; inherited global values render as placeholder text ("inheriting `adaptive` from global") following the existing models-panel inheritance pattern.

#### 7.5 Pipeline template editor

When the template-editor UI lands (out of scope for this plan), the same widget reused at template scope.

### 8. Compatibility and breaking changes

- **No breaking changes to existing configs.** Omitted `effort` field continues to mean "use Claude Code model default" — current behavior preserved exactly.
- **Older models** (Sonnet 4.5, Opus 4.5, etc.) silently fall back to their highest supported rung — this is Claude Code behavior, not worca behavior. Documented in MIGRATION.md, not errored.
- **Subagent frontmatter `effort:`** is documented by Claude Code as overriding session effort for skills/subagents (`/en/sub-agents#supported-frontmatter-fields`). worca agent templates are loaded as Claude Code subagents, so a template-level frontmatter `effort:` would clobber the env var. Resolution: do **not** set frontmatter `effort:` in any worca template; env-var path is the single source of truth.

## Implementation Plan

**Shipping strategy (locked):** all 7 phases land in a **single PR**. Python core, coordinator changes, logging, three UI views, settings panel, and docs are reviewed and merged atomically. No phase split — the feature is not partially useful, and a half-shipped state where the runtime emits `effort: {...}` blocks but the UI has no chips just confuses operators. Atomic rollback if anything regresses.

The phases below structure the *order of work within the PR*, not separate PRs.

### Phase 1: Schema and resolution core (Python)

**Files:** `src/worca/orchestrator/stages.py`, `src/worca/orchestrator/effort.py` (new), `src/worca/orchestrator/runner.py`, `src/worca/utils/settings.py`, `src/worca/settings.json`.

**Tasks:**
1. Add `worca.effort` block to `src/worca/settings.json` with the locked defaults: `auto_mode: "adaptive"`, `auto_cap: "xhigh"`.
2. Add `effort` field to default agent entries in `settings.json` per the locked per-agent defaults: `planner: "xhigh"`, `coordinator: "medium"`, `guardian: "high"`. Implementer/tester/reviewer remain unset so the adaptive path drives base from the coordinator's per-bead label (or model default under `disabled`/`reactive`).
3. Create `src/worca/orchestrator/effort.py` with `resolve_effort()`, `apply_escalation()`, `clamp()`, `read_bead_effort_label()`, and the `EFFORT_LEVELS` ordered tuple.
4. Extend `get_stage_config()` in `stages.py:78-110` to include `effort: agent_config.get("effort")` in the returned dict.
5. In `runner.py` at the stage-invocation site (~`runner.py:1839-1864`), call `resolve_effort()` with `trigger`, `iter_num`, and the assigned bead (None for non-implementer), and merge the result into `env_overrides` before `run_agent()`.
6. Persist `effort` block (including `bead_classified` sub-block) in `start_iteration()` (`status.py:75-110`) as a new optional kwarg.

### Phase 2: Coordinator-owned effort labeling

**Files:** `src/worca/agents/core/coordinator.md`, `src/worca/utils/beads.py` (read helper only — no new write path).

**Tasks:**
1. Append the "Effort Labeling" section (rubric + `bd create --labels` + `bd update --notes` instructions) to `coordinator.md` per §4.
2. Add `bd_get_effort_label(bead_id) -> Optional[str]` helper in `utils/beads.py` — parses `worca-effort:*` from the bead's label list. Used by `resolve_effort()`.
3. Add a runner-side warning emitter: after COORDINATE completes, scan `prompt_builder.get_context("beads_ids")` and log a warning for any bead missing a `worca-effort:*` label. No halt, no retry — best-effort.
4. Verify existing `bd_label_add()` (`utils/beads.py:181`) is suitable for any runtime label preservation (e.g. when an external tool seeds labels). No new write path needed for the coordinator — it uses `bd create --labels` directly.

**No new agent, no schema, no post-coordinate classification loop, no `classifier_failure` stop reason, no lazy classification on IMPLEMENT entry.**

### Phase 3: Logging and status integration

**Files:** `src/worca/orchestrator/runner.py`, `src/worca/state/status.py`, `src/worca/orchestrator/events.py` (if applicable).

**Tasks:**
1. Format-and-emit the effort log line at `runner.py:1887-1889`.
2. Extend the `STAGE_STARTED` event payload with `effort: {...}` so the UI receives it via SSE.
3. Update `stage_started_payload()` to accept and forward the effort dict.

### Phase 4: UI — per-iteration badges and tooltips

**Files:** `worca-ui/app/views/run-detail.js`, `worca-ui/app/styles.css`.

**Tasks:**
1. Add an `Effort:` row to the iteration metadata renderer with the two-chip layout per §7.1 (level + source qualifier).
2. Render a separate `Bead:` row when the iteration ran with a bead — show the coordinator's classified level + a divergence chip (`[overridden]` / `[ignored]`) when `bead_classified.applied = false`.
3. Map levels to Shoelace variants per §7.1.
4. Wire short-line tooltips per §7.1 — no prose, just `template value` / `coordinator label: <level>` / `escalated +N from <base>` etc.

### Phase 5: UI — run-header chip and bead detail (read-only)

**Files:** `worca-ui/app/views/run-detail.js`, `worca-ui/app/views/beads-panel.js`.

**Tasks:**
1. Add the `Effort: <mode> · cap <cap>` chip to the run-header strip.
2. Render `worca-effort:*` label as a badge in bead detail (read-only — no editor).
3. Render `[ignored: <mode>]` chip next to the label when the active run's mode is `reactive`/`disabled`.
4. Surface coordinator reasoning note in a dedicated notes section (not in tooltips).
5. Add the per-iteration mini-table showing how each iteration actually ran (§7.3).

### Phase 6: UI — settings panel

**Files:** `worca-ui/app/views/settings.js`, `worca-ui/server/settings-routes.js` (or equivalent), `worca-ui/app/styles.css`.

**Tasks:**
1. Add "Effort" section to settings.js, between Models and Secrets.
2. Implement `auto_mode` dropdown, `auto_cap` dropdown, per-agent table.
3. Per-agent dropdown values: `(unset)`, `low`, `medium`, `high`, `xhigh`, `max`. **No `auto` value.**
4. Wire writes to `settings.json` via existing settings PUT endpoint.
5. Implement inheritance placeholder rendering using the models-panel pattern.
6. Add confirmation modal triggered when selecting `max` (for per-agent fields and `auto_cap`).

### Phase 7: Documentation

**Files:** `CLAUDE.md`, `MIGRATION.md`, `docs/effort.md` (new).

**Tasks:**
1. Add a "Effort Levels" section to CLAUDE.md alongside "Model Profiles".
2. Document older-model fallback behavior in MIGRATION.md.
3. Write `docs/effort.md` with the resolution algorithm, coordinator rubric, mode semantics table, and per-agent override examples.

### Files Changed Summary

| File | Change |
|---|---|
| `src/worca/settings.json` | Add `worca.effort` block (`auto_mode: "adaptive"`, `auto_cap: "xhigh"`); add `effort` to planner (`xhigh`), coordinator (`medium`), guardian (`high`). Implementer/tester/reviewer remain unset. |
| `src/worca/orchestrator/stages.py` | Add `effort` to `get_stage_config()` return value |
| `src/worca/orchestrator/effort.py` | **New.** `resolve_effort()`, `apply_escalation()`, `clamp()`, `read_bead_effort_label()`, `EFFORT_LEVELS` |
| `src/worca/orchestrator/runner.py` | Wire `resolve_effort()` at stage invocation; post-COORDINATE warning for unlabeled beads; log line emit; SSE payload |
| `src/worca/state/status.py` | Persist `effort` dict (with `bead_classified` sub-block) in iteration record |
| `src/worca/utils/beads.py` | Add `bd_get_effort_label()` read helper; reuse `bd_label_add()` |
| `src/worca/utils/claude_cli.py` | (No code change — env-var path already works) |
| `src/worca/agents/core/coordinator.md` | Append "Effort Labeling" section with rubric + `bd create --labels` + `bd update --notes` instructions |
| `worca-ui/app/views/run-detail.js` | Per-iteration `Effort:` + `Bead:` chips with divergence indicators; run-header chip |
| `worca-ui/app/views/beads-panel.js` | Bead detail label (read-only) + `[ignored: <mode>]` chip + per-iteration mini-table |
| `worca-ui/app/views/settings.js` | "Effort" section (auto_mode, auto_cap, per-agent table); `max`-confirmation modal |
| `worca-ui/app/styles.css` | Effort-badge color CSS vars if not subsumed by existing variants |
| `worca-ui/server/settings-routes.js` | Accept `worca.effort.*` writes |
| `CLAUDE.md` | "Effort Levels" section |
| `MIGRATION.md` | Older-model fallback note |
| `docs/effort.md` | **New.** Feature documentation |

**Removed from earlier plan revision** (no longer needed under coordinator-owned classification): `src/worca/agents/core/effort_classifier.md`, `src/worca/agents/core/effort_classify.block.md`, `src/worca/schemas/effort_classify.json`, post-COORDINATE classifier loop in `runner.py`, lazy classification on IMPLEMENT entry, `classifier_failure` stop reason.

## Considerations

- **Determinism.** Adaptive effort makes runs less reproducible — the same bead set may resolve to different effort levels depending on what the coordinator returned that day. Mitigated by persisting `effort.source`, `effort.base`, `effort.escalations`, and `effort.bead_classified` per iteration so runs are explainable post-hoc.
- **Cost ceiling.** No separate classifier calls — effort labeling rides on the coordinator's existing Opus pass. The marginal cost is one extra `--labels` flag and a short `bd update --notes` per bead. Sub-percent of the coordinator's existing per-bead spend.
- **Cache freshness.** The `worca-effort:*` label persists on the bead forever. If a bead's scope changes after classification (rare — beads are typically atomic and short-lived), the cached level may be stale. Mitigation: user can delete the label manually; we do not auto-invalidate.
- **Effort and `max_turns` interaction.** Effort controls reasoning per step; `max_turns` caps the number of agent turns. They are orthogonal but compound: a high-effort agent may need more turns to express its reasoning. The current `msize` multiplier is uniform and may need per-effort calibration in a follow-up — out of scope here.
- **Coordinator concern coupling.** The coordinator now does two jobs: decomposition + effort classification. Risk: prompt growth degrades decomposition quality. Mitigation: keep the effort-labeling instructions to a single appended section in `coordinator.md` (short rubric + `bd create --labels` + `bd update --notes` directives); revisit if decomposition quality regresses in integration tests.
- **Governance.** No new governance hooks. Effort labels are attached via existing `bd create --labels` / `bd update --notes` calls; existing tool-restriction hooks apply unchanged.
- **Breaking changes:** None. Omitted `effort` field preserves current behavior; existing pipelines run identically.
- **Migration:** No required migration step. The new `worca.effort` block has the locked defaults (`auto_mode: "adaptive"`, `auto_cap: "xhigh"`) baked into the shipped `src/worca/settings.json`, so a freshly-pulled worca-cc starts using adaptive effort with the coordinator labeling beads. **Upgraders see a behavior change**: pipelines that previously ran every agent at model-default effort will start receiving the planner=xhigh / coordinator=medium / guardian=high explicit values and adaptive escalation on loopbacks. MIGRATION.md documents this and the one-line opt-out (`auto_mode: "disabled"`). Existing user pipelines that already set `worca.agents.<agent>` in their own `settings.json` see additive merge — their values win where set.
- **Older-rev coordinators.** If a user pins an older `coordinator.md` override (in `.claude/agents/`) that lacks the effort-labeling section, the coordinator simply won't emit labels and `resolve_effort()` falls back to model default with a warning. No halt.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|---|---|---|
| Python | `test_resolve_effort_omitted_disabled_returns_model_default` | `effort=None`, `auto_mode=disabled` → `(None, "model_default")` with no escalation |
| Python | `test_resolve_effort_explicit_disabled_no_escalation` | `effort="high"`, `auto_mode=disabled` → `("high", "disabled")`; no escalation even on test_failure |
| Python | `test_resolve_effort_reactive_explicit_escalates` | `effort="high"`, `auto_mode=reactive`, trigger=`test_failure` → `("xhigh", "reactive")` with `base=high`, `escalations=["test_failure"]` |
| Python | `test_resolve_effort_reactive_omitted_starts_at_model_default` | `effort=None`, `auto_mode=reactive`, trigger=`initial` → `(None, "reactive")` with `base=null` |
| Python | `test_resolve_effort_adaptive_reads_bead_label` | adaptive + bead `worca-effort:high` + no per-agent explicit → `("high", "adaptive:llm")` with `bead_classified.applied=true` |
| Python | `test_resolve_effort_adaptive_explicit_overrides_bead` | adaptive + bead `worca-effort:medium` + per-agent `effort="xhigh"` → `("xhigh", "explicit")` with `bead_classified.applied=false`, `skip_reason="explicit_override"` |
| Python | `test_resolve_effort_reactive_records_bead_skip_reason` | reactive + bead `worca-effort:medium` → `bead_classified.applied=false`, `skip_reason="mode_reactive"` |
| Python | `test_resolve_effort_disabled_records_bead_skip_reason` | disabled + bead `worca-effort:medium` → `bead_classified.applied=false`, `skip_reason="mode_disabled"` |
| Python | `test_resolve_effort_non_implementer_skip_reason` | adaptive + reviewer agent + bead `worca-effort:high` → `bead_classified.applied=false`, `skip_reason="non_classified_agent"` |
| Python | `test_resolve_effort_review_changes_plus_two` | adaptive + test_failure × 1 then review_changes × 1 → +1+2 = base+3 (clamped to cap) |
| Python | `test_resolve_effort_planner_stacks_on_replan` | planner + adaptive + 3× plan_review_changes → +3 rungs from model default |
| Python | `test_resolve_effort_auto_cap_clamps` | escalation past `auto_cap` clamps and sets `capped_from` |
| Python | `test_get_stage_config_includes_effort` | `get_stage_config()` returns `effort` key |
| Python | `test_bd_get_effort_label_parses_label` | `bd_get_effort_label()` returns `"high"` for bead with `worca-effort:high` label |
| Python | `test_bd_get_effort_label_invalid_returns_none` | `bd_get_effort_label()` returns `None` for `worca-effort:bogus` |
| Python | `test_reserved_env_keys_excludes_claude_effort` | `CLAUDE_CODE_EFFORT_LEVEL` is not denied by `utils/env.py` denylist |
| Python | `test_iteration_record_persists_effort_with_bead_classified` | `start_iteration(effort={..., bead_classified: {...}})` round-trips through `status.json` |
| JS | `effort-badge.test.js` | Level badge + source qualifier chip render correctly; divergence chip appears only when `bead_classified.applied=false` |
| JS | `effort-tooltip.test.js` | Tooltip text matches the short-line mapping in §7.1 (no prose) |
| JS | `settings-effort.test.js` | auto_mode + cap dropdowns write to `settings.json`; per-agent table renders inherited placeholders; selecting `max` triggers confirm modal |

### Integration / E2E Tests

| Scenario | Validates |
|---|---|
| `auto_mode=adaptive`, coordinator labels single bead `high` | Bead acquires `worca-effort:high` label + reasoning note; first IMPLEMENT iter runs with `CLAUDE_CODE_EFFORT_LEVEL=high`; status records `source=adaptive`, `bead_classified.applied=true` |
| `auto_mode=adaptive`, test_failure loopback | Iter 1 = base, iter 2 = base+1; verified via mock claude env capture and `status.json` `effort.escalations` |
| `auto_mode=adaptive`, implementer has explicit `effort: "xhigh"` | iter 1 runs at `xhigh` (explicit wins), `bead_classified.applied=false`, `skip_reason=explicit_override` |
| `auto_mode=reactive`, test_failure loopback | Iter 1 = model default (no env var when implementer has no explicit), iter 2 = +1 rung; bead label present but `applied=false`, `skip_reason=mode_reactive` |
| `auto_mode=disabled`, agent has explicit `effort: "high"` | Subprocess env carries `CLAUDE_CODE_EFFORT_LEVEL=high`; status records `source=disabled`; no escalation on subsequent loopback |
| Coordinator emits labels under all modes | Run with `disabled` still has bead labels + notes attached; coordinator prompt updates verified via mock claude trace |
| Pre-set `worca-effort:xhigh` on bead before run start | Coordinator preserves the label; under adaptive, iter 1 runs at `xhigh` |
| `auto_cap: high` with bead labeled `xhigh` | Resolved level clamped to `high`; `capped_from: "xhigh"` in iteration record |
| Bead missing `worca-effort:*` label after COORDINATE | Warning logged; resolve_effort falls back to model default; pipeline does not halt |

### Existing Tests to Update

| Test | Update |
|---|---|
| `tests/test_stages.py::test_get_stage_config_*` | Add assertions for new `effort` field |
| `tests/test_status.py::test_start_iteration_*` | Verify `effort` kwarg is round-tripped |
| `tests/integration/test_pipeline_end_to_end.py` | Pin `auto_mode=disabled` in fixtures so existing assertions aren't sensitive to env-var presence |
| `worca-ui/app/views/run-detail.test.js` | Update iteration-card snapshot assertions to account for new badge row |
| `worca-ui/app/views/settings.test.js` | Section ordering update |

## Files to Create/Modify

See "Files Changed Summary" under §Implementation Plan above.

## Out of Scope

- **Per-effort-level `max_turns` tuning.** A future follow-up may calibrate turn budgets per effort level (xhigh probably needs more turns); for now `max_turns` and `effort` remain independently configured.
- **Token-usage charts by effort level.** The `status.json.iterations[].effort` field makes this possible, but the chart UI is deferred.
- **Dedicated classifier agent swap-in.** If coordinator-owned classification quality proves insufficient in production, a follow-up may add an optional `effort_classifier` agent gated behind a config flag. Not pursued in this revision.
- **Per-agent `auto_cap`.** Pipeline-level cap only. Per-agent caps add config surface without a clear use case so far.
- **Mid-run UI override of bead effort labels.** Operators who need to change effort behavior mid-run edit `settings.json` or change `auto_mode`; no inline editor on the bead-detail panel.
- **Pipeline template editor UI.** Templates ship the same `effort` field structure; the editor itself is out of scope here (tracked separately).
- **Frontmatter `effort:` in worca templates.** Single source of truth is the env var; templates do not set frontmatter effort.
- **Auto-invalidation of stale `worca-effort:*` labels.** Bead scope rarely changes; manual deletion is the supported invalidation path.
