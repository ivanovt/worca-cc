# Adaptive Effort Levels

Worca surfaces Claude Code's reasoning-effort scale (`low | medium | high | xhigh | max`) as a per-agent, per-iteration configuration lever. Effort controls how much adaptive reasoning the model spends per step — orthogonal to model identity (`--model`) and turn budget (`--max-turns`).

Configuration lives under `worca.effort` and `worca.agents.<agent>.effort` in `.claude/settings.json`.

## Precedence

Effort values resolve through three layers, each overriding the previous:

**template > project > model default**

1. **Model default** — when no `effort` value is configured, the env var is omitted and Claude Code uses its built-in default.
2. **Project settings** — `worca.agents.<agent>.effort` in `.claude/settings.json`. Applies to all runs in the project.
3. **Template override** — the template `config` block is deep-merged over project `worca` settings (`templates.py:deep_merge_config`; template scalars win) into the temp settings file the runner reads end-to-end (`run_pipeline.py:271-294`); worktree runs forward `--template` through (`run_worktree.py:166`). Unspecified keys fall through to the project value.

Under `adaptive` mode, per-bead labels add a fourth dimension: the coordinator's structured-output classification drives the implementer's starting point when no explicit per-agent value is set. This interacts with precedence as follows: an explicit template or project value overrides the bead label (`skip_reason = "explicit_override"`); an unset value lets the label through.

### Design principle

Set explicit effort for:
- **High-stakes/irreversible work** (guardian — commit/PR is permanent)
- **Heavy upfront reasoning** (planner — plan quality compounds)
- **Loop-controlling judgment gates** (reviewer, plan_reviewer, coordinator — review quality drives `review_changes` loop count; coordinator effort determines classification quality)

Leave unset for:
- **Mechanical/verification work** (tester — deterministic pass/fail)
- **Adaptive-label-driven work** (implementer — bead label is the intended driver under `adaptive` mode)
- **Low-stakes/disabled-by-default stages** (learner)

## Mode semantics

The `worca.effort.auto_mode` field controls two orthogonal axes: **starting point** (where does the effort level come from?) and **escalation** (does loopback bump it?).

| Mode | Starting point | Escalation on loopbacks |
|---|---|---|
| `disabled` | Per-agent `effort` value (if set), else model default | No |
| `reactive` | Per-agent `effort` value (if set), else model default | Yes |
| `adaptive` | Per-agent `effort` value if explicitly set (wins), else coordinator-set bead label | Yes |

**`adaptive`** is the shipped default. The coordinator classifies each bead's complexity during decomposition and attaches a `worca-effort:<level>` label. The implementer uses that label as its starting point (unless an explicit per-agent value overrides it). Other agents fall back to model default.

**`reactive`** ignores bead labels for resolution (they're still emitted for forensic comparison) and uses the per-agent value or model default as the starting point. Escalation still fires on loopbacks.

**`disabled`** pins every agent to its per-agent value (or model default) with no escalation. Set `auto_mode: "disabled"` to reproduce pre-W-052 behavior exactly.

## Resolution algorithm

`resolve_effort()` in `src/worca/orchestrator/effort.py` runs once per stage invocation, after `get_stage_config()` and before `claude_cli` is called.

**Inputs:** agent name, per-agent `effort` value (or `None`), `auto_mode`, `auto_cap`, iteration trigger, iteration number, assigned bead (implementer only), resolved model id.

**Returns:** `(level, requested, source, base, bead_classified)`.

| Field | Meaning |
|---|---|
| `level` | Value sent to `CLAUDE_CODE_EFFORT_LEVEL` after model-ladder collapse. `None` = omit (use model default). |
| `requested` | Pre-collapse canonical level the policy produced. Differs from `level` only when the model lacks that rung. |
| `source` | One of: `explicit`, `model_default`, `adaptive:llm`, `reactive`, `disabled`. |
| `base` | Starting point before escalation. |
| `bead_classified` | `{level, applied, skip_reason}` or `None` for non-bead stages. |

### Step-by-step

1. **Determine starting point.**
   - If the agent has an explicit `effort` value in config: use it (`source = "explicit"`). Bead label is recorded but skipped (`skip_reason = "explicit_override"`).
   - Else if `adaptive` mode, agent is `implementer`, and the bead has a `worca-effort:*` label: use the label (`source = "adaptive:llm"`, `bead_classified.applied = true`).
   - Otherwise: use model default (`base = None`).

2. **Look up the model's effort ladder** (see [Model-aware ladders](#model-aware-effort-ladders) below).

3. **Under `disabled` mode:** collapse the base down to the nearest supported rung and return. No escalation.

4. **Apply escalation** (see [Escalation deltas](#escalation-deltas)). Deltas are index steps on the model's ladder and saturate at the top rung.

5. **Clamp to `auto_cap`.** The cap is rounded *up* to the nearest supported rung on the model's ladder before comparison. If the resolved level exceeds the cap, it is clamped down and `capped_from` records the pre-clamp level.

6. **Persist** the full `(level, requested, source, base, bead_classified)` tuple in the iteration record in `status.json`.

## Model-aware effort ladders

Effort rungs are model-specific. Not every model supports every rung:

| Model | Supported rungs |
|---|---|
| Opus 4.7 | `low`, `medium`, `high`, `xhigh`, `max` |
| Opus 4.6 / Sonnet 4.6 | `low`, `medium`, `high`, `max` (no `xhigh`) |
| Sonnet 4.5 / Opus 4.5 / Haiku | Effort not supported (empty ladder) |

The shipped `worca.models` aliases resolve to Opus 4.6 (`opus`) and Sonnet 4.6 (`sonnet`) — **neither supports `xhigh`**. Model-aware resolution is mandatory, not a nicety.

### Rounding rules

| Operation | Direction | Rationale |
|---|---|---|
| Base collapse | Round **down** to the highest supported rung <= requested | Mirrors Claude Code's own runtime fallback. The recorded `level` matches what the model actually runs. |
| `auto_cap` collapse | Round **up** to the nearest supported rung >= configured cap | Prevents the cap from accidentally pinning escalation below what the ladder allows. |

**Example:** `planner: xhigh` on Opus 4.6 (4-rung ladder).
- Base `xhigh` rounds down to `high` (sent to the model).
- `status.json` records `level: "high"`, `requested: "xhigh"` so the UI can show "policy wanted xhigh, model ran high."

**Example:** `auto_cap: xhigh` on Sonnet 4.6.
- Cap `xhigh` rounds up to `max` — escalation to `max` is not blocked.

### Unsupported and unknown models

- **Unsupported models** (Sonnet 4.5, Opus 4.5, Haiku): empty ladder. The `CLAUDE_CODE_EFFORT_LEVEL` env var is omitted entirely and no escalation occurs. No error.
- **Unknown/unmapped models**: fall back to the canonical 5-rung ladder (`low/medium/high/xhigh/max`) with a logged warning. Claude Code does its own runtime fallback.

## Escalation deltas

Escalation fires when an agent re-runs on a loopback trigger. Deltas are **index steps on the resolved model's ladder**, not fixed canonical rungs, and **saturate at the top rung**.

| Agent | Trigger | Delta per loop |
|---|---|---|
| implementer | `initial` / `next_bead` | +0 |
| implementer | `test_failure` | +1 |
| implementer | `review_changes` | +2 |
| planner | `initial` | +0 |
| planner | `plan_review_revise` | +1 |
| planner | `restart_planning` | +1 |
| coordinator, tester, reviewer, guardian | any | +0 (no escalation) |

Deltas stack across iterations: iter 1 = base, iter 2 = base + delta, iter 3 = base + 2*delta, etc. Only the agent re-running on the loopback escalates — the tester does not escalate when re-run after an implementer fix.

**Plan review `review_and_edit` mode (W-059):** in edit mode the plan reviewer rewrites the plan in place and self-approves — there is no loopback to the Planner, so `auto_mode` escalation does not engage. Editing is arguably harder than reviewing (in-place rewrite vs. read-only verdict), but cost is bounded to a single iteration. The shipped `plan_reviewer: high` effort applies as a fixed starting point with no escalation path.

Here "iter" counts **escalation loopbacks only**, not total stage iterations. The implementer runs once per bead during Phase-1 implementation (trigger `next_bead`, zero delta); those per-bead iterations do **not** count toward escalation depth. So the first `test_failure` after implementing N beads is escalation loop 1 (+1 rung), not loop N. `escalation_iter_num()` in `effort.py` computes this depth by counting only escalation-relevant prior triggers; the runner passes it to `resolve_effort()`.

### Aggressive escalation on 4-rung ladders

On the shipped 4-rung models (Opus 4.6, Sonnet 4.6), escalation is coarser than on Opus 4.7's 5-rung ladder. A single `test_failure` (+1 rung) takes a `high`-base implementer straight to `max`:

```
Sonnet 4.6 ladder: low(0) → medium(1) → high(2) → max(3)
                                         ^^^^        ^^^^
                                         base      base + 1
```

The default `auto_cap: xhigh` permits this because `xhigh` rounds up to `max` on the 4-rung ladder. This relaxes the "`max` only via explicit opt-in" guarantee to "explicit opt-in **or** loopback escalation on a model lacking `xhigh`."

**To prevent auto-escalation to `max` on 4-rung models**, pin `auto_cap: high`. This creates a deliberate dead-zone: escalation clamps at `high` with `capped_from: "max"` recorded in the iteration.

Pointing `worca.models.opus` at Opus 4.7 restores the full 5-rung ladder and gentler escalation.

## Coordinator rubric

The coordinator classifies effort for every bead during decomposition, regardless of `auto_mode`. Under `reactive`/`disabled` the labels are informational (forensic comparison); under `adaptive` the implementer consumes them.

| Level | When to pick |
|---|---|
| `low` | Typo fixes, comment-only changes, single-line config tweaks, doc updates with no code impact. |
| `medium` | Localized changes in a single file, mechanical refactors, well-scoped feature toggles. |
| `high` | Cross-file changes, new abstractions, non-trivial logic, anything touching pipeline state or governance hooks. |
| `xhigh` | Schema/migration work, concurrency, security-sensitive paths, multi-stage refactors with subtle invariants. |
| `max` | Never pick autonomously. Reserved for explicit human or template signal. |

### Reliable labels via structured output

Labels reach beads through two complementary paths (belt-and-suspenders):

1. **`--labels` flag on `bd create`** — the coordinator attaches `worca-effort:<level>` during decomposition. This is best-effort; the model may omit the flag.
2. **`effort` map in structured output** — the coordinator returns an `effort` object in its `coordinate.json` response, mapping each bead ID to its classified level. The runner applies `worca-effort:<level>` labels programmatically from this map immediately after the existing `run:` label backfill (`runner.py:2970`).

The structured output is the reliable fallback. The runner applies from the map only when no `worca-effort:*` label is already present on the bead, so a coordinator-set or user-set label is never overwritten. Unknown bead IDs and invalid levels are skipped with a stderr warning — the pipeline never halts on label issues.

The `effort` field in `coordinate.json` is optional and validated against a `low|medium|high|xhigh|max` enum. Runs that omit it keep pre-existing behavior (model-default fallback + warning).

Reasoning is written via `bd update <id> --notes "Effort: <level> -- <reasoning>"`.

If a bead already has a `worca-effort:*` label (user-set), the coordinator preserves it. User-set labels are authoritative.

If a bead is missing a label after both paths, the runner logs a warning and `resolve_effort()` falls back to model default. The pipeline does not halt.

## Per-agent override examples

Per-agent `effort` values are set in `worca.agents.<agent>.effort`. They accept literal rungs only: `low | medium | high | xhigh | max`. There is no `auto` value — the mode field controls escalation, the per-agent field is just the starting point.

### Shipped defaults

```jsonc
{
  "worca": {
    "effort": {
      "auto_mode": "adaptive",
      "auto_cap": "xhigh"
    },
    "agents": {
      "planner":      { "effort": "xhigh" },  // heavy upfront reasoning
      "coordinator":  { "effort": "high"  },   // complexity classification is a judgment call
      "implementer":  { },                     // unset — adaptive bead label drives base
      "tester":       { },                     // unset — mechanical verification
      "reviewer":     { "effort": "high"  },   // review quality controls loop count
      "plan_reviewer":{ "effort": "high"  },   // judgment gate (disabled by default)
      "guardian":     { "effort": "high"  },   // irreversible commit/PR work
      "learner":     { }                      // unset — low stakes, disabled by default
    }
  }
}
```

| Agent | Level | Rationale |
|---|---|---|
| planner | `xhigh` | Heavy upfront reasoning; plan quality compounds downstream |
| coordinator | `high` | Complexity classification is a judgment call, not mechanical decomposition |
| reviewer | `high` | Review quality directly controls `review_changes` loop count |
| plan_reviewer | `high` | Judgment gate (only active when `worca.stages.plan_review.enabled`) |
| guardian | `high` | Irreversible commit and PR creation |
| implementer | unset | Adaptive bead label drives starting point; explicit value would override classification |
| tester | unset | Deterministic verification; model default is sufficient |
| learner | unset | Low stakes, disabled by default |

**Caveat:** the shipped `opus` alias resolves to Opus 4.6, which has a 4-rung ladder (`low/medium/high/max` — no `xhigh`). The planner's `xhigh` collapses to `high` at runtime (`status.json` records `level: "high"`, `requested: "xhigh"`). Pointing `worca.models.opus` at Opus 4.7 activates the full 5-rung ladder.

### Pin all agents to model defaults (pre-W-052 behavior)

```jsonc
{
  "worca": {
    "effort": {
      "auto_mode": "disabled"
    }
  }
}
```

### Cost-conscious: cap escalation at `high`

```jsonc
{
  "worca": {
    "effort": {
      "auto_mode": "reactive",
      "auto_cap": "high"
    }
  }
}
```

Escalation fires on loopbacks but never exceeds `high`. Bead labels are emitted for forensic comparison but do not drive the implementer's starting point.

### Override a single agent

```jsonc
{
  "worca": {
    "agents": {
      "implementer": { "effort": "high" }
    }
  }
}
```

Under `adaptive` mode, this explicit value overrides the coordinator's bead label. The label is still recorded with `bead_classified.skip_reason = "explicit_override"`.

## Per-agent recommended effort floor (advisory indicator)

The template editor ships a hardcoded recommendation for which agents warrant a careful starting effort. When the user picks a per-agent `effort` below that floor, the editor shows a yellow ⚠ indicator on the Effort field (Agents tab) and a matching chip under the stage's agent picker (Stages tab). Saving is never blocked.

The recommendation is **not** template-editable, **not** persisted to template config, and **not** read by the runtime — `resolve_effort` neither knows about it nor adjusts behavior for it. It exists purely so users notice when a low effort would be unusual for the role.

Source: `worca-ui/app/utils/effort-recommendations.js`.

```js
RECOMMENDED_MIN_EFFORT = {
  planner:           'high',
  plan_reviewer:     'high',
  coordinator:       'medium',
  implementer:       'low',
  tester:            'low',
  reviewer:          'high',
  guardian:          'medium',
  learner:           'low',
  workspace_planner: 'high',
};
```

| Floor | Agents | Rationale |
|---|---|---|
| `high` | planner, plan_reviewer, reviewer, workspace_planner | Heavy reasoning — plan quality compounds, review quality drives loop counts, cross-project planning is judgment-heavy |
| `medium` | coordinator, guardian | Tighter-scope judgment — classification calls, irreversible PR/git work |
| `low` | implementer, tester, learner | Mechanical or adaptive-driven — bead label or verification semantics carry the load |

Templates running below these floors get a yellow ⚠ indicator on the Effort field and a matching chip on the Stages tab. The shipped fast-and-cheap templates (`quick-fix`, `feature-fast`) intentionally run some agents at `low` — those will show indicators and that's fine.

To change the shipped recommendations, edit the map in `effort-recommendations.js` and rebuild worca-ui. There is no project-level or template-level override surface.

## Shipped template effort divergences

Templates override the project defaults via deep-merge (see [Precedence](#precedence)). Unspecified keys fall through to the baseline. Only templates that diverge from the default `adaptive` + shipped agent values are listed:

| Template | Divergence | Why |
|---|---|---|
| `quick-fix` | `effort.auto_mode: disabled`; planner `medium`, coordinator `low`, implementer `low` | Trivial work — deterministic and cheap; intentional disable prevents wasted escalation |
| `bugfix` | `effort.auto_cap: high` | Clamp escalation cost on focused fixes; prevents auto-escalation to `max` |
| `feature-minor` | `effort.auto_cap: high` | Well-scoped features — keep adaptive labels but bound cost like `bugfix` |
| `feature` | none (baseline + adaptive) | Complex beads get `high`/`xhigh` naturally via the coordinator's classification |
| `investigate` | none (baseline + adaptive) | Same as feature |
| `refactor` | none (baseline + adaptive) | Same as feature |
| `test-only` | none (baseline + adaptive) | Same as feature |

The `quick-fix` template is the only one that disables `auto_mode`. This is intentional: for trivial one-liner changes, adaptive classification adds overhead with no benefit — the work is known-simple at template selection time. All agent efforts are pinned low, and no escalation fires.

The `bugfix` template keeps `auto_mode: adaptive` (labels still drive the implementer) but caps escalation at `high` to bound cost. On the shipped 4-rung models this prevents the `high → max` jump on the first `test_failure` loopback.

## Output-token truncation at high/max effort

At `high` and `max` effort the model generates more thinking tokens and is more likely to hit `stop_reason: "max_tokens"` (truncated output). Loopback escalation toward `max` can silently truncate the very iteration the escalation was meant to strengthen.

Operators hitting truncation should raise `CLAUDE_CODE_MAX_OUTPUT_TOKENS` via the `worca.models.*.env` path:

```jsonc
{
  "worca": {
    "models": {
      "sonnet": {
        "id": "claude-sonnet-4-6-20250514",
        "env": {
          "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32000"
        }
      }
    }
  }
}
```

Per-effort-level `CLAUDE_CODE_MAX_OUTPUT_TOKENS` calibration is a planned follow-up. The workaround above is the supported path today.

## Implementation seam

Resolved effort is injected via `CLAUDE_CODE_EFFORT_LEVEL` on the per-stage env dict, reusing the `worca.models.*.env` merge path in `src/worca/utils/claude_cli.py`. The env var is the only non-interactive way to set `max` (the `effortLevel` settings field rejects it). This seam is load-bearing for `max` support.

## Observability

Each iteration record in `status.json` carries a full effort block:

```jsonc
{
  "effort": {
    "level": "max",                  // sent to CLAUDE_CODE_EFFORT_LEVEL (null = omitted)
    "requested": "max",              // canonical pre-collapse value
    "source": "adaptive",            // explicit | model_default | adaptive:llm | reactive | disabled
    "base": "high",                  // starting point before escalation
    "escalations": ["test_failure"], // triggers that caused escalation
    "capped_from": null,             // pre-clamp level if auto_cap fired
    "bead_classified": {             // null for non-bead stages
      "level": "high",              // coordinator's verdict
      "applied": true,              // was this level used as the base?
      "skip_reason": null           // null | mode_reactive | mode_disabled | explicit_override | non_classified_agent
    }
  }
}
```

The `requested` vs `level` pair is the model-collapse forensic signal. When they differ, the UI shows "policy wanted X, model ran Y."

Pipeline log lines follow a terse `key=value` format:

| Scenario | Log line |
|---|---|
| Adaptive, bead label used | `IMPLEMENT iter 1: effort=high source=adaptive bead=high` |
| Explicit override, model lacks rung | `IMPLEMENT iter 1: effort=high req=xhigh source=explicit bead=medium(overridden) model-collapsed` |
| Reactive, bead label informational | `IMPLEMENT iter 1: effort=high source=reactive bead=medium(ignored)` |
| Loopback escalation (4-rung) | `IMPLEMENT iter 2: effort=max source=adaptive bead=high +test_failure` |
| Cap fired | `IMPLEMENT iter 3: effort=high source=adaptive bead=high +test_failure capped_from=max` |
| Non-bead stage, model collapse | `PLAN iter 1: effort=high req=xhigh source=explicit model-collapsed` |
| Model default fallback | `TEST iter 1: effort=- source=model_default` |
