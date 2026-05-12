# W-052: Adaptive Effort Levels for Pipeline Agents

**Status:** Draft
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-05-12
**Depends on:** None

## Problem

Claude Code exposes a discrete reasoning-effort scale (`low`, `medium`, `high`, `xhigh`, `max`) via the `--effort` flag, `CLAUDE_CODE_EFFORT_LEVEL` env var, and per-agent frontmatter (see [Claude Code model-config docs](https://code.claude.com/docs/en/model-config#adjust-effort-level)). On Opus 4.7 the default is `xhigh`; on Opus 4.6 and Sonnet 4.6 it is `high`. Effort directly controls how much adaptive reasoning the model spends per step, and is the primary lever for trading token spend against capability — distinct from `--model` (model identity) and `--max-turns` (turn budget).

worca-cc does not surface this lever anywhere today:

1. The CLI wrapper in `src/worca/utils/claude_cli.py:133-146` builds the `claude -p` command with `--model`, `--output-format`, `--no-session-persistence`, and `--dangerously-skip-permissions`, but never `--effort` and never `CLAUDE_CODE_EFFORT_LEVEL`. Every agent invocation falls through to the Claude Code default for its model.
2. Per-agent config in `worca.agents.<agent>` (`src/worca/orchestrator/stages.py:78-110`) reads only `model` and `max_turns`. There is no `effort` field.
3. The iteration trigger (`initial`, `test_failure`, `review_changes`) is already in scope at `runner.py:1839-1864` when stage config is resolved, but it is unused for effort — `max_turns` simply gets a uniform `msize` multiplier (`runner.py:1873`).
4. Status records (`src/worca/state/status.py:75-110`) capture `agent`, `model`, `trigger`, and `started_at` per iteration. There is no `effort` field, so the UI cannot show or debug which effort level a stage ran with, and the learner cannot correlate effort against outcomes.

User-facing impact: pipeline operators cannot calibrate intelligence-vs-cost per stage or per iteration. A planner that bounces three times through plan_review keeps running at the same default effort; an implementer that fails tests twice cannot escalate; a coordinator that does mostly mechanical bead splitting cannot be dialed *down* to save tokens. There is no path between "all agents at model default" and "edit the runner."

## Proposal

Add a per-agent `effort` field to `worca.agents.<agent>` accepting any of `low | medium | high | xhigh | max | auto`. Explicit levels pass through verbatim via `CLAUDE_CODE_EFFORT_LEVEL` on the per-stage env dict (reusing the existing `worca.models.*.env` merge path). Omitted means "use Claude Code's model default."

`auto` triggers orchestrator-driven adaptive selection, governed by a new `worca.effort` block with two settings:

- `auto_mode`: `disabled` | `reactive` | `adaptive` (default).
- `auto_cap`: ceiling for `auto`-resolved levels (default `xhigh`). Does not clamp explicit levels.

Adaptive mode adds a new `effort_classifier` agent (Haiku, fixed effort) that runs at coordinate-time, inspects each bead, and writes a `worca-effort:<level>` label plus a reasoning note on the bead. Implementer iterations read the label as their base level and escalate on loopbacks (`test_failure` +1, `review_changes` +2). The planner gets a simpler escalation ladder per `plan_review_changes` bounce. Resolved effort is persisted per-iteration in `status.json` and surfaced in the UI as a `Effort: auto->high` badge with a tooltip carrying the classifier reasoning or escalation chain.

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

**Resolution:** add `effort` to the returned dict, sourced from `agent_config.get("effort")`. `None` means "omitted, use model default". Resolution into a concrete level happens later in the runner (see §3).

```jsonc
// settings.json (committed)
"worca": {
  "effort": {
    "auto_mode": "adaptive",        // disabled | reactive | adaptive
    "auto_cap":  "xhigh"            // low | medium | high | xhigh | max
  },
  "agents": {
    "planner":     { "model": "opus",   "effort": "xhigh" },
    "coordinator": { "model": "opus",   "effort": "medium" },
    "implementer": { "model": "sonnet", "effort": "auto"  },
    "tester":      { "model": "sonnet" },                   // omitted — model default
    "reviewer":    { "model": "opus",   "effort": "auto"  },
    "guardian":    { "model": "opus",   "effort": "high"  },

    "effort_classifier": {                                  // new agent
      "model":     "haiku",
      "effort":    "low",
      "max_turns": 5
    }
  }
}
```

**Validation:** at pipeline start, if any agent has `effort: auto` but `worca.effort.auto_mode == "disabled"`, log an info-level message (`Effort: agent <name> set to auto, but auto_mode is disabled — using model default`) and resolve as if the field were omitted. Do not error.

### 2. Data model — bead labels and notes

The classifier persists its decision on the bead itself so the cache survives across resumes, worktrees, and re-runs of the same plan:

- **Label**: `worca-effort:<level>` (e.g. `worca-effort:high`). Namespaced to mirror the existing `run:{run_id}` convention (CLAUDE.md "Plans & Roadmap"). One value per bead.
- **Notes**: classifier reasoning appended via `bd update <id> --notes "Effort classifier: <level> — <reasoning>"`. Visible in `bd show` and the UI bead detail panel.

**User precedence**: if a `worca-effort:*` label already exists when the classifier would run, classification is skipped entirely. The user's value is authoritative; there is no "auto-set vs human-set" distinction. A user who wants to re-classify deletes the label manually.

### 3. Resolution algorithm

The runner resolves effort once per stage invocation, after `get_stage_config()` and before `claude_cli` is called. Inputs: agent config's `effort` value, `auto_mode`, `auto_cap`, current trigger, current iteration number, and (for implementer only) the assigned bead.

```
resolve_effort(agent, agent_effort, auto_mode, auto_cap, trigger, iter_num, bead) -> (level, source)

if agent_effort is None:
    return (None, "model_default")                       # omit env var entirely

if agent_effort != "auto":
    return (agent_effort, "explicit")                    # passthrough, cap does not apply

# agent_effort == "auto"
if auto_mode == "disabled":
    log_info(f"Effort: agent {agent} auto resolved to model default (auto_mode=disabled)")
    return (None, "auto_disabled")

if auto_mode == "reactive":
    base = MODEL_DEFAULT
    escalated = apply_escalation(base, agent, trigger, iter_num)
    return (clamp(escalated, auto_cap), f"auto:reactive:{trigger}")

# auto_mode == "adaptive"
if agent == "implementer" and bead is not None:
    base = read_bead_effort_label(bead) or MODEL_DEFAULT  # classifier guaranteed to have run at coordinate
elif agent == "planner":
    base = MODEL_DEFAULT
else:
    return (None, "auto:adaptive:non_classified")        # all other agents: model default, no escalation

escalated = apply_escalation(base, agent, trigger, iter_num)
return (clamp(escalated, auto_cap), f"auto:adaptive:{trigger}")
```

The `(level, source)` tuple is both persisted and used in logs (see §6).

**Escalation rules** (`apply_escalation`):

| Agent | Trigger | Delta |
|---|---|---|
| implementer | `initial` / `next_bead` | +0 |
| implementer | `test_failure` | +1 per loop (stacks across iters) |
| implementer | `review_changes` | +2 per loop (stacks across iters) |
| planner | `initial` | +0 |
| planner | `plan_review_changes` | +1 per re-run (stacks within run) |
| all others (`auto`, adaptive) | any | +0 (no escalation; non-classified agents stay at model default) |

Only the agent re-running on a loopback escalates. Tester does not escalate when re-run after an implementer fix; only the implementer does. Reviewer does not escalate when re-run after another loop; only the originating agent does.

`clamp(level, cap)` rounds the level *down* to the cap if it exceeds it, and logs `Effort: auto->xhigh (capped from max)`.

### 4. Effort classifier agent

New first-class worca agent. Same affordances as planner/coordinator: a markdown template, a JSON schema, configurable model and max_turns.

**Template:** `src/worca/agents/core/effort_classifier.md` (and matching `effort_classifier.block.md` if the block pattern is needed). The template encodes the rubric:

| Level | When to pick |
|---|---|
| `low` | Typo fixes, comment-only changes, single-line config tweaks, doc updates with no code impact. |
| `medium` | Localized changes in a single file, mechanical refactors, well-scoped feature toggles. |
| `high` | Cross-file changes, new abstractions, non-trivial logic, anything touching pipeline state or governance hooks. |
| `xhigh` | Schema/migration work, concurrency, security-sensitive paths, multi-stage refactors with subtle invariants. |
| `max` | Never pick autonomously — reserved for explicit human or template signal. |

The template also instructs the classifier to consider:
- Bead title + description
- Bead labels: `type:*`, `priority:*`, `area:*`
- Dependency count (proxy for coupling)
- Plan section sliced from the linked plan file at the bead's `## W-NNN` heading (if present)
- File-path hits regexed from the description (`\b[\w/]+\.(py|js|ts|md|json)\b`)

**Schema:** `src/worca/schemas/effort_classify.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["level", "reasoning"],
  "additionalProperties": false,
  "properties": {
    "level": {
      "type": "string",
      "enum": ["low", "medium", "high", "xhigh"]
    },
    "reasoning": {
      "type": "string",
      "minLength": 10,
      "maxLength": 500
    }
  }
}
```

`max` is intentionally absent from the enum — the classifier cannot pick it.

**Invocation site:** classifier runs from the runner's `Stage.COORDINATE` post-processing block, after the coordinator has created beads but before the run advances to `Stage.IMPLEMENT`. For each bead in the run's bead set that lacks a `worca-effort:*` label, call the classifier sequentially (Haiku is cheap; parallelism not worth the complexity).

**Failure mode:** if classification fails (network error, schema-invalid output after retries, classifier returns non-JSON), halt the entire pipeline with a `classifier_failure` stop reason. The pipeline is resumable: on resume, the orchestrator detects beads still missing the label and re-runs the classifier for those only.

**Beads created mid-run** (e.g. coordinator splits a bead during a loop) are not classified at creation. They are classified lazily on entry to `IMPLEMENT` if they reach that stage without a label. This keeps the coordinate-time batch the common path.

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
    "level":  "xhigh",
    "source": "auto:adaptive:test_failure",
    "base":   "high",
    "escalations": ["test_failure"],
    "capped_from": null               // or "max" if clamp fired
  }
}
```

`level` is the value sent to `CLAUDE_CODE_EFFORT_LEVEL` (or `null` when omitted entirely). `source` is the resolution path. `base`, `escalations`, `capped_from` are present only when `source` starts with `auto:`.

**Pipeline log format:**

| Source | Log line |
|---|---|
| `explicit` | `IMPLEMENT (iter 1) starting... Effort: high` |
| `model_default` | `IMPLEMENT (iter 1) starting... Effort: (model default)` |
| `auto:adaptive:initial` | `IMPLEMENT (iter 1) starting... Effort: auto->high` |
| `auto:reactive:test_failure` | `IMPLEMENT (iter 2) starting... Effort: auto->xhigh (escalated from high after test_failure)` |
| `auto:*` with cap firing | `IMPLEMENT (iter 3) starting... Effort: auto->xhigh (capped from max)` |
| `auto_disabled` | `IMPLEMENT (iter 1) starting... Effort: (model default; auto disabled)` |

These are emitted from the existing stage-start log in `runner.py:1887-1889`.

### 7. UI surfaces

#### 7.1 Per-iteration badge (`worca-ui/app/views/run-detail.js`)

A new badge in the iteration metadata row labeled `Effort:`, following the badge-color rules in `worca-ui/docs/badge-color-language.md`.

| Resolved level | Variant | Rationale |
|---|---|---|
| `low` | `neutral` | Informational — not a state |
| `medium` | `neutral` | Informational |
| `high` | `primary` | Active, default-ish |
| `xhigh` | `warning` | Caution — non-default, costly |
| `max` | `danger` | Highest cost, opt-in only |
| `(model default)` | `neutral` | Omitted |

**Display text:**

- Explicit / model default: `Effort: high` (or `Effort: default`)
- Auto-resolved: `Effort: auto->high`

**Tooltip** (`title=""` attribute, same approach as other badges per badge-color-language.md §6):

- `source = "explicit"` → `Set by pipeline template.`
- `source = "model_default"` → `Using Claude Code model default.`
- `source = "auto:adaptive:initial"` → classifier reasoning from the bead's notes (truncated to 200 chars).
- `source = "auto:*:test_failure"` etc. → escalation chain: `Escalated from high to xhigh after test_failure (iter 1).`
- `capped_from != null` → append ` Capped from max.`

#### 7.2 Run-header chip

A small chip in the run header showing the effective effort mode for the run: `Effort: adaptive · cap xhigh`. Lets users see at a glance which mode is in play without opening settings.

#### 7.3 Bead detail panel

- Render the `worca-effort:*` label as a badge alongside other bead labels, with the same color scale as §7.1.
- Surface the classifier reasoning from the bead notes in the detail view.
- Provide an inline dropdown to edit the label (writes via the same beads API as other bead-edit affordances). Values: `(unset)` / `low` / `medium` / `high` / `xhigh` / `max`. Editing while a run is in progress only affects future iterations on that bead.

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
│ │ implementer │ [auto ▾] │                             │ │
│ │ tester      │ [(def)▾] │ inherits Claude Code default│ │
│ │ reviewer    │ [auto ▾] │                             │ │
│ │ guardian    │ [high ▾] │                             │ │
│ └─────────────┴──────────┴─────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘
```

- Writes to `settings.json` (non-secret).
- Project settings deep-merge over global; inherited global values render as placeholder text ("inheriting `adaptive` from global") following the existing models-panel inheritance pattern.
- `auto` is selectable in the per-agent dropdown even when `auto_mode = disabled`, but a small inline note appears: "auto_mode is disabled — this agent will use model default."

#### 7.5 Pipeline template editor

When the template-editor UI lands (out of scope for this plan), the same widget reused at template scope.

### 8. Compatibility and breaking changes

- **No breaking changes to existing configs.** Omitted `effort` field continues to mean "use Claude Code model default" — current behavior preserved exactly.
- **Older models** (Sonnet 4.5, Opus 4.5, etc.) silently fall back to their highest supported rung — this is Claude Code behavior, not worca behavior. Documented in MIGRATION.md, not errored.
- **Subagent frontmatter `effort:`** is documented by Claude Code as overriding session effort for skills/subagents (`/en/sub-agents#supported-frontmatter-fields`). worca agent templates are loaded as Claude Code subagents, so a template-level frontmatter `effort:` would clobber the env var. Resolution: do **not** set frontmatter `effort:` in any worca template; env-var path is the single source of truth.

## Implementation Plan

### Phase 1: Schema and resolution core (Python)

**Files:** `src/worca/orchestrator/stages.py`, `src/worca/orchestrator/effort.py` (new), `src/worca/orchestrator/runner.py`, `src/worca/utils/settings.py`, `src/worca/settings.json`.

**Tasks:**
1. Add `worca.effort` block to `src/worca/settings.json` with `auto_mode: "adaptive"`, `auto_cap: "xhigh"`.
2. Add `effort` field to default agent entries in `settings.json` (omit on tester/guardian to preserve defaults; pre-populate `implementer: "auto"`, `reviewer: "auto"`).
3. Create `src/worca/orchestrator/effort.py` with `resolve_effort()`, `apply_escalation()`, `clamp()`, and the `EFFORT_LEVELS` ordered tuple.
4. Extend `get_stage_config()` in `stages.py:78-110` to include `effort: agent_config.get("effort")` in the returned dict.
5. In `runner.py` at the stage-invocation site (~`runner.py:1839-1864`), call `resolve_effort()` with `trigger`, `iter_num`, and the assigned bead (None for non-implementer), and merge the result into `env_overrides` before `run_agent()`.
6. Persist `effort` block in `start_iteration()` (`status.py:75-110`) as a new optional kwarg.

### Phase 2: Effort classifier agent

**Files:** `src/worca/agents/core/effort_classifier.md` (new), `src/worca/agents/core/effort_classify.block.md` (new), `src/worca/schemas/effort_classify.json` (new), `src/worca/orchestrator/runner.py`, `src/worca/utils/beads.py`.

**Tasks:**
1. Write the classifier template with the rubric in §4.
2. Write `effort_classify.json` schema (level enum without `max`, reasoning min/max length).
3. Add `effort_classifier` to default `worca.agents` in `settings.json` with `model: "haiku"`, `effort: "low"`, `max_turns: 5`.
4. Add a post-coordinate classifier loop in `runner.py`: for each bead in `prompt_builder.get_context("beads_ids")` that lacks a `worca-effort:*` label, invoke the classifier via `run_agent()` with bead context, persist label + notes.
5. Add `bd_labels_for(bead_id)` helper in `utils/beads.py` if not already present; verify `bd_label_add()` (line 181) is suitable.
6. Add lazy-classification call at the start of `IMPLEMENT` (`runner.py:1906-1932`) for beads created mid-run.
7. Wire halt-on-classifier-failure: raise a `PipelineInterrupted` with `stop_reason="classifier_failure"`. Verify resume path picks up missing-label beads.

### Phase 3: Logging and status integration

**Files:** `src/worca/orchestrator/runner.py`, `src/worca/state/status.py`, `src/worca/orchestrator/events.py` (if applicable).

**Tasks:**
1. Format-and-emit the effort log line at `runner.py:1887-1889`.
2. Extend the `STAGE_STARTED` event payload with `effort: {...}` so the UI receives it via SSE.
3. Update `stage_started_payload()` to accept and forward the effort dict.

### Phase 4: UI — per-iteration badge and tooltip

**Files:** `worca-ui/app/views/run-detail.js`, `worca-ui/app/styles.css`.

**Tasks:**
1. Add an `Effort:` row to the iteration metadata renderer, following the existing trigger-badge pattern.
2. Map levels to Shoelace variants per §7.1.
3. Render `auto->` prefix when `source` starts with `auto:`.
4. Wire tooltip per §7.1 from classifier reasoning (fetched from bead notes via existing beads API) or escalation chain.

### Phase 5: UI — run-header chip and bead detail

**Files:** `worca-ui/app/views/run-detail.js`, `worca-ui/app/views/beads-panel.js`.

**Tasks:**
1. Add the `Effort: <mode> · cap <cap>` chip to the run-header strip.
2. Render `worca-effort:*` label as a badge in bead detail.
3. Add inline edit dropdown for the bead's effort label, calling beads write API.

### Phase 6: UI — settings panel

**Files:** `worca-ui/app/views/settings.js`, `worca-ui/server/settings-routes.js` (or equivalent), `worca-ui/app/styles.css`.

**Tasks:**
1. Add "Effort" section to settings.js, between Models and Secrets.
2. Implement `auto_mode` dropdown, `auto_cap` dropdown, per-agent table.
3. Wire writes to `settings.json` via existing settings PUT endpoint.
4. Implement inheritance placeholder rendering using the models-panel pattern.

### Phase 7: Documentation

**Files:** `CLAUDE.md`, `MIGRATION.md`, `docs/effort.md` (new).

**Tasks:**
1. Add a "Effort Levels" section to CLAUDE.md alongside "Model Profiles".
2. Document older-model fallback behavior in MIGRATION.md.
3. Write `docs/effort.md` with the resolution algorithm, classifier rubric, and per-agent override examples.

### Files Changed Summary

| File | Change |
|---|---|
| `src/worca/settings.json` | Add `worca.effort` block; add `effort` to default agents; add `effort_classifier` agent entry |
| `src/worca/orchestrator/stages.py` | Add `effort` to `get_stage_config()` return value |
| `src/worca/orchestrator/effort.py` | **New.** `resolve_effort()`, `apply_escalation()`, `clamp()`, `EFFORT_LEVELS` |
| `src/worca/orchestrator/runner.py` | Wire `resolve_effort()` at stage invocation; classifier loop post-coordinate; lazy classification on IMPLEMENT entry; log line emit; SSE payload |
| `src/worca/state/status.py` | Persist `effort` dict in iteration record |
| `src/worca/utils/beads.py` | Add `bd_labels_for()` helper if missing; reuse `bd_label_add()` |
| `src/worca/utils/claude_cli.py` | (No code change — env-var path already works) |
| `src/worca/agents/core/effort_classifier.md` | **New.** Classifier prompt template |
| `src/worca/agents/core/effort_classify.block.md` | **New.** Block-template variant if needed |
| `src/worca/schemas/effort_classify.json` | **New.** Output schema (level + reasoning) |
| `worca-ui/app/views/run-detail.js` | Per-iteration `Effort:` badge + tooltip; run-header chip |
| `worca-ui/app/views/beads-panel.js` | Bead detail label + inline edit |
| `worca-ui/app/views/settings.js` | "Effort" section (auto_mode, auto_cap, per-agent table) |
| `worca-ui/app/styles.css` | Effort-badge color CSS vars if not subsumed by existing variants |
| `worca-ui/server/settings-routes.js` | Accept `worca.effort.*` writes |
| `CLAUDE.md` | "Effort Levels" section |
| `MIGRATION.md` | Older-model fallback note |
| `docs/effort.md` | **New.** Feature documentation |

## Considerations

- **Determinism.** Adaptive effort makes runs less reproducible — the same bead set may resolve to different effort levels depending on what the classifier returned that day. Mitigated by persisting `effort.source`, `effort.base`, and `effort.escalations` per iteration so runs are explainable post-hoc.
- **Cost ceiling.** Classification adds N Haiku calls per pipeline (one per bead in the initial coordinate batch). Cheap, but observable in cost reports. The `auto_mode: reactive` setting is the kill switch — same escalation behavior, no classifier calls.
- **Cache freshness.** The `worca-effort:*` label persists on the bead forever. If a bead's scope changes after classification (rare — beads are typically atomic and short-lived), the cached level may be stale. Mitigation: user can delete the label manually; we do not auto-invalidate.
- **Effort and `max_turns` interaction.** Effort controls reasoning per step; `max_turns` caps the number of agent turns. They are orthogonal but compound: a high-effort agent may need more turns to express its reasoning. The current `msize` multiplier is uniform and may need per-effort calibration in a follow-up — out of scope here.
- **Governance.** No new governance hooks. The classifier writes via the same `bd` CLI path as the coordinator; existing tool-restriction hooks apply unchanged.
- **Subagent dispatch.** The classifier is invoked from the orchestrator as a top-level `claude -p` call, not as a subagent dispatched from another worca agent. It does not appear in the `worca.governance.dispatch.allowed` map.
- **Breaking changes:** None. Omitted `effort` field preserves current behavior; existing pipelines run identically.
- **Migration:** No required migration. The new `worca.effort` block has safe defaults (`adaptive` / `xhigh`) baked into `settings.json` so a freshly-pulled worca-cc starts using adaptive effort on `auto`-marked agents. Existing user pipelines without `effort: auto` on any agent see no behavior change.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|---|---|---|
| Python | `test_resolve_effort_omitted_returns_none` | `effort=None` → `(None, "model_default")` |
| Python | `test_resolve_effort_explicit_passthrough` | `effort="high"` → `("high", "explicit")`; cap does not clamp |
| Python | `test_resolve_effort_auto_disabled` | `auto_mode="disabled"` + `effort="auto"` → `(None, "auto_disabled")` |
| Python | `test_resolve_effort_auto_reactive_initial` | implementer + reactive + initial → model default |
| Python | `test_resolve_effort_auto_reactive_test_failure_escalates` | reactive + test_failure → +1 rung |
| Python | `test_resolve_effort_auto_reactive_review_changes_escalates` | reactive + review_changes → +2 rungs |
| Python | `test_resolve_effort_auto_adaptive_reads_bead_label` | adaptive + label `worca-effort:high` → base `high` |
| Python | `test_resolve_effort_auto_adaptive_no_label_falls_back_to_default` | adaptive + no label → model default + escalation applies on loopback |
| Python | `test_resolve_effort_auto_cap_clamps` | escalation past `auto_cap` clamps and sets `capped_from` |
| Python | `test_resolve_effort_planner_auto_stacks_on_replan` | planner + adaptive + 3 plan_review_changes → +3 rungs (clamped) |
| Python | `test_resolve_effort_non_classified_agent_uses_default` | coordinator/tester/reviewer (non-planner, non-implementer) under adaptive `auto` → model default, no escalation |
| Python | `test_get_stage_config_includes_effort` | `get_stage_config()` returns `effort` key |
| Python | `test_classifier_schema_rejects_max` | `effort_classify.json` rejects `level: "max"` |
| Python | `test_classifier_writes_label_and_notes` | mock `bd_label_add` + `bd_update --notes` are called with correct values |
| Python | `test_classifier_skips_if_label_exists` | bead with existing `worca-effort:*` label → no classifier invocation |
| Python | `test_reserved_env_keys_excludes_claude_effort` | `CLAUDE_CODE_EFFORT_LEVEL` is not denied by `utils/env.py` denylist |
| Python | `test_iteration_record_persists_effort` | `start_iteration(effort={...})` stores the dict in `status.json` |
| JS | `effort-badge.test.js` | Badge renders correct variant per level; `auto->` prefix appears only when source starts with `auto:` |
| JS | `effort-tooltip.test.js` | Tooltip text matches resolution-source mapping (§7.1) |
| JS | `settings-effort.test.js` | Auto-mode + cap dropdowns write to `settings.json`; per-agent table renders inherited placeholders |

### Integration / E2E Tests

| Scenario | Validates |
|---|---|
| `auto_mode=adaptive`, single bead, mock classifier returns `high` | Bead acquires `worca-effort:high` label; first IMPLEMENT iter runs with `CLAUDE_CODE_EFFORT_LEVEL=high` in subprocess env |
| `auto_mode=adaptive`, test_failure loopback | Iter 1 = base, iter 2 = base+1; verified via mock claude env capture and `status.json` `effort.escalations` |
| `auto_mode=reactive`, test_failure loopback | Iter 1 = model default (no env var set), iter 2 = model_default+1 |
| `auto_mode=disabled` + agent `effort: auto` | Info log emitted; subprocess env lacks `CLAUDE_CODE_EFFORT_LEVEL`; status records `source: auto_disabled` |
| Classifier failure (mock claude returns non-JSON) | Pipeline halts with `stop_reason=classifier_failure`; resume re-runs classifier for unlabeled beads only |
| Pre-set `worca-effort:xhigh` on bead before run start | Classifier skips that bead; `auto`-resolved level honors `xhigh` |
| `auto_cap: high` with classifier returning `xhigh` | Resolved level clamped to `high`; `capped_from: "xhigh"` in iteration record |

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
- **Classifier model swap to a learned heuristic.** First version uses Haiku; if classification quality is insufficient, a follow-up may experiment with a fine-tuned classifier or a rule-based heuristic.
- **Per-agent `auto_cap`.** Pipeline-level cap only. Per-agent caps add config surface without a clear use case so far.
- **`effort` on `effort_classifier` itself being `auto`.** The classifier is always explicit; not configurable to `auto`.
- **Pipeline template editor UI.** Templates ship the same `effort` field structure; the editor itself is out of scope here (tracked separately).
- **Frontmatter `effort:` in worca templates.** Single source of truth is the env var; templates do not set frontmatter effort.
- **Auto-invalidation of stale `worca-effort:*` labels.** Bead scope rarely changes; manual deletion is the supported invalidation path.
