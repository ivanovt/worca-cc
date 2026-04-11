# W-037: Prompt Builder Template Extraction

**Goal:** Move hardcoded instruction text out of `prompt_builder.py` into composable **block** files (`.block.md`) that are embedded within agent `.md` files via `{{block:name}}` references. The agent sees one coherent document via `--agent` containing both static instructions and dynamic per-invocation context. Blocks are overlayable by project overrides and fully replaceable by pipeline templates. If a block file does not exist, the `{{block:name}}` reference resolves to empty — no error, no output.

**Why:** Today the same instructions appear in two places — the agent `.md` file (system prompt via `--agent`) and the PromptBuilder user prompt (`-p`). This duplication means:
- Edits to agent behavior require changes in both Python and Markdown
- Project overlays (W-008) can only customize the system prompt half; the user prompt is locked in Python
- The PromptBuilder methods mix structural logic (what context to include) with instructional prose (how the agent should behave)

**Key concepts:**
- A **block** (`.block.md`) is a reusable, overlayable unit of dynamic content with `{{placeholder}}` tokens
- A **prompt** is the final assembled agent `.md` with all `{{block:name}}` references resolved and placeholders substituted — this goes to `--agent`
- The `-p` flag becomes minimal (just the work request), or can be eliminated entirely
- All placeholder substitution uses **double-brace** `{{name}}` syntax — the legacy single-brace `{name}` substitution in `_render_agent_templates()` is removed

**Depends on:** W-008 (OverlayResolver, already implemented).

---

## 1. How Prompts Reach the Agent Today

```
agent .md file ──→ --agent flag (system prompt)
                     ↕ Claude sees both
PromptBuilder    ──→ -p flag     (user prompt)
```

The agent `.md` defines persona, process, rules. The PromptBuilder output defines what to do *this invocation* — the work request, accumulated context, retry instructions, etc. They are complementary, but the split creates duplication and limits customizability.

### New architecture

```
agent .md file                        ← contains {{block:name}} insertion points + {{placeholder}} tokens
      ↓
  resolve blocks (load .block.md, overlay chain, placeholder substitution)
      ↓
fully resolved agent document  ──→ --agent flag
                                      ↕ Claude sees both
work request (minimal)         ──→ -p flag
```

The agent sees **one coherent document** via `--agent`. Static instructions (role, process, rules) and dynamic context (work request, test failures, plan content) are interleaved at specific, controllable positions. The `-p` prompt is reduced to just the raw work request title + description.

### One agent per stage

Each pipeline stage maps to exactly one agent. This is critical for the block-in-agent architecture: the agent `.md` is resolved once per stage invocation with stage-specific context. A single agent serving multiple stages would require per-stage conditional gating on every block, defeating the purpose.

Currently, the **guardian** agent serves both REVIEW and PR stages. This plan introduces a dedicated **reviewer** agent for the REVIEW stage, separating concerns:

| Stage | Agent (before) | Agent (after) |
|---|---|---|
| REVIEW | guardian | **reviewer** (new) |
| PR | guardian | guardian (unchanged) |

---

## 2. Block Concept

### What is a block?

A block is a `.block.md` file that contains a self-contained piece of dynamic prompt content. Blocks are:

- **Embeddable** — inserted at specific positions in agent `.md` files via `{{block:name}}`
- **Overlayable** — project overrides (`.claude/agents/`) can replace or append to any block
- **Replaceable** — pipeline templates (`template_agents_dir`) can fully redefine any block
- **Optional** — if a block file doesn't exist at any tier, `{{block:name}}` resolves to empty string
- **Resolvable** — `{{placeholder}}` tokens within blocks are resolved against the context dict

### Resolution chain (per block)

```
1. core block         .claude/worca/agents/core/{name}.block.md
       ↓
2. project overlay    .claude/agents/{name}.block.md          (replace or append)
       ↓
3. template overlay   {template_agents_dir}/{name}.block.md   (replace or append)
       ↓
4. {{placeholder}} resolution against context dict
       ↓
5. result string (or empty if no tier provides the block)
```

This mirrors the existing resolution chain for agent `.md` files — same three tiers (core → project → template), same OverlayResolver, same overlay modes (replace default, `<!-- append -->` for section merge).

### Missing block semantics

If no tier provides a block file, `{{block:name}}` resolves to an empty string. Blank line cleanup removes the resulting gap. This allows:
- Pipeline templates to add new blocks by placing a file at tier 3 and adding `{{block:name}}` to their agent `.md` override
- Projects to remove a block by providing an empty override at tier 2
- Stages to have optional blocks that only appear when context data exists

### File naming

```
src/worca/agents/core/
  planner.md                    ← agent definition, contains {{block:plan}}
  plan.block.md                 ← block: plan stage context (includes revision mode via conditional)
  plan_reviewer.md
  plan-review.block.md          ← block: plan review stage context
  coordinator.md
  coordinate.block.md
  implementer.md
  implement.block.md            ← block: implement stage context (includes retry mode via conditional)
  tester.md
  test.block.md
  reviewer.md                   ← NEW agent for REVIEW stage
  review.block.md
  guardian.md
  pr.block.md
  learner.md
  learn.block.md
```

8 block files total (down from 10 — plan-revision and implement-retry merged into their parent blocks via `{{#if}}` conditionals).

Block names are decoupled from agent names. An agent `.md` can reference any number of blocks, and the same block can be referenced by multiple agents.

---

## 3. Placeholder Syntax

### Unified double-brace syntax

All placeholder substitution — in agent `.md` files, block files, and project/template overrides — uses double-brace `{{...}}` syntax. The legacy single-brace `{name}` substitution in `_render_agent_templates()` is **removed**. This eliminates the confusing situation where agent `.md` uses `{plan_file}` but blocks use `{{plan_file}}` for the same variable.

Migration: existing `{plan_file}`, `{run_id}`, `{branch}`, `{title}` in agent `.md` files become `{{plan_file}}`, `{{run_id}}`, `{{branch}}`, `{{title}}`.

### Types

| Syntax | Purpose | Resolution |
|---|---|---|
| `{{block:name}}` | Insert a resolved block | Load `name.block.md`, apply overlay chain, resolve inner placeholders, insert result |
| `{{name}}` | Simple value substitution | Replace with context dict value, or empty string if absent |
| `{{name\|default text}}` | Value with default | Replace with context dict value, or the literal default if absent |
| `{{#if name}}...{{/if}}` | Conditional section | Include content only if `name` is truthy in context |
| `{{#if name}}...{{else}}...{{/if}}` | Conditional with else | Include if-body or else-body based on truthiness |

### Processing order

1. **Block insertion** — resolve all `{{block:name}}` references first (recursive: blocks can contain other blocks, with cycle detection)
2. **Conditionals** — resolve `{{#if}}...{{/if}}` blocks
3. **Placeholders** — resolve `{{name}}` and `{{name|default}}` tokens
4. **Cleanup** — collapse 3+ consecutive blank lines to 2

Block insertion happens first so that blocks can contain their own conditionals and placeholders that get resolved in passes 2-3.

### Pre-formatted context values

Complex data structures (lists of test failures, review issue tables, history entries) are pre-formatted into Markdown strings by helper methods on PromptBuilder *before* being stored in context. The block just inserts the pre-rendered string via `{{test_failures_formatted}}`.

No loop constructs in the template engine — Python handles list formatting.

---

## 4. Agent `.md` File Changes

### Single-brace to double-brace migration

All existing `{name}` references in agent `.md` files become `{{name}}`:

| Before | After |
|---|---|
| `` `{plan_file}` `` | `` `{{plan_file}}` `` |
| `run:{run_id}` | `run:{{run_id}}` |
| `{branch}` | `{{branch}}` |
| `{title}` | `{{title}}` |

The `_render_agent_templates()` function's `str.replace(f"{{{key}}}", ...)` loop is removed. All substitution happens in `resolve_agent()`.

### New `planner.md` with block insertion

```markdown
# Planner Agent

## Role
You are the Planner. You create plan files that define the architecture,
approach, and scope for a work request. The plan file path is `{{plan_file}}`.

## Process
1. Read and understand the work request
2. Read CLAUDE.md for project context
3. Explore the codebase to understand existing architecture
4. Identify affected components and potential risks
5. Create `{{plan_file}}` with: problem statement, approach, task breakdown, test strategy, branch naming
6. Set `approved: true` in your output

{{block:plan}}

## Output
Produce a structured plan following the `plan.json` schema.

## Rules
<!-- governance -->
- Do NOT write implementation code — guard hooks WILL BLOCK any Write/Edit to source files
...
```

The `{{block:plan}}` reference is positioned between Process and Output — the agent sees the work request and dynamic context right after understanding what to do, before the output format and governance rules.

### New `reviewer.md` (new agent for REVIEW stage)

The REVIEW stage currently maps to the **guardian** agent, which also serves the PR stage. This creates a conflict: one agent `.md` cannot contain stage-specific blocks for two different stages without per-stage conditional gating on every block.

**Solution:** Introduce a dedicated `reviewer.md` agent for the REVIEW stage. The guardian retains the PR stage only.

```markdown
# Reviewer Agent

## Role
You are the Reviewer. You review code changes for correctness, style, and
adherence to the plan. You do NOT modify code — you report issues for the
implementer to fix.

## Process
1. Read the work request and plan to understand intent
2. Review all changed files against the plan
3. Check for correctness, style, security, and adherence to conventions
4. Report issues with file, line, severity, and description
5. If no issues found, approve the changes

{{block:review}}

## Implementer Capabilities

The implementer agent can edit files and run tests but CANNOT make git commits
(commits are handled by the guardian stage). Do NOT flag uncommitted files as issues
requiring changes — focus only on code correctness, style, and adherence to the plan.

## Output
Produce a structured result following the `review.json` schema.

## Rules
<!-- governance -->
- Do NOT modify source code — only review and report
- Do NOT run tests — the tester stage handles that
- Do NOT invoke skills (superpowers, executing-plans, etc.)
```

**`STAGE_AGENT_MAP` change:**

```python
Stage.REVIEW: "reviewer",   # was "guardian"
Stage.PR: "guardian",        # unchanged
```

### New `implementer.md` with block insertion

```markdown
# Implementer Agent

## Role
You are an Implementer. You claim and complete individual Beads tasks by writing code following TDD.

## Process
1. If a bead ID is provided in the prompt, use it directly. Otherwise: `bd ready`
2. Claim a task: `bd update <id> --status=in_progress`
3. Read the task description: `bd show <id>`
4. Implement using TDD...
5. Close the task: `bd close <id>`

{{block:implement}}

## Fix Mode
When your prompt says "Fix All Issues" or "Fix Test Failures" or "Fix Review Issues":
1. Read the error list carefully
2. For each error, identify the root cause
3. Fix the code — you are NOT limited to a single bead's scope
4. Run only the tests related to the files you changed
5. Do NOT use `bd ready` or `bd close`

## Retry Rules
- After making each fix, read back the changed lines to confirm the fix is correct
- Do NOT re-implement the plan from scratch
- Do NOT just rebuild and exit

## Output
Produce a structured result following the `implement.json` schema.

## Rules
<!-- governance -->
- Follow the project's testing approach as documented in CLAUDE.md
...
```

The `{{block:implement}}` block uses an internal `{{#if}}` conditional to switch between initial implementation context and retry context (see Section 5).

### All agent `.md` changes summary

| Agent file | Status | Block references | New static content |
|---|---|---|---|
| `planner.md` | Modify | `{{block:plan}}` between Process and Output | Migrate `{single-brace}` → `{{double-brace}}` |
| `plan_reviewer.md` | Modify | `{{block:plan-review}}` between Process and Output | None |
| `coordinator.md` | Modify | `{{block:coordinate}}` between Process and Output | Migrate `{run_id}` → `{{run_id}}` |
| `implementer.md` | Modify | `{{block:implement}}` between Process and Fix Mode | `## Retry Rules` section (from `_build_implement_retry`) |
| `tester.md` | Modify | `{{block:test}}` between Process and Output | None |
| `reviewer.md` | **New** | `{{block:review}}` between Process and Output | Full agent definition including implementer-capabilities disclaimer |
| `guardian.md` | Modify | `{{block:pr}}` between Process and Output | None (no longer serves REVIEW) |
| `learner.md` | Modify | `{{block:learn}}` between Process and Output | 6-category analysis instructions (from `_build_learn` lines 519-543) |

---

## 5. Block File Contents

### `plan.block.md` (plan + plan-revision in one block)

A single block handles both initial planning and revision mode via `{{#if plan_revision_mode}}`:

```markdown
{{#if plan_revision_mode}}
## Revision Required

The plan reviewer has identified issues that must be addressed.
Revise the existing plan — do NOT start from scratch.

## Work Request

{{work_request}}

{{#if plan_content}}
## Current Plan

{{plan_content}}
{{/if}}

{{#if plan_review_issues_formatted}}
## Issues to Address

{{plan_review_issues_formatted}}
{{/if}}

{{#if plan_review_history_formatted}}
## Review History

{{plan_review_history_formatted}}
{{/if}}

Address each issue above. Preserve all parts of the plan that were not flagged.
Write the updated plan. In your JSON output, set `approved: true` to signal
that the revised plan is ready for review.
{{else}}
## Work Request

{{work_request}}

{{#if claude_md}}
## Project Context (from CLAUDE.md)

{{claude_md}}
{{/if}}
{{/if}}
```

The planner agent `.md` has a single `{{block:plan}}` reference. PromptBuilder sets `plan_revision_mode` in the context dict to control which branch renders.

### `plan-review.block.md`

```markdown
## Work Request

{{work_request}}

{{#if plan_content}}
## Implementation Plan

{{plan_content}}
{{else}}
## Implementation Plan

*Plan file not found or empty — this is itself a critical issue to report.*
{{/if}}

{{#if plan_review_history_formatted}}
## Previous Review Attempts

{{plan_review_history_formatted}}

Check whether the issues from previous review attempts have been addressed
in the revised plan above.
{{/if}}
```

### `coordinate.block.md`

```markdown
## Work Request

{{work_request}}

{{#if plan_summary}}
## Approved Plan

{{plan_summary}}
{{/if}}
```

### `implement.block.md` (initial + retry in one block)

A single block handles both initial implementation and retry mode via `{{#if is_retry}}`:

```markdown
{{#if is_retry}}
## PRIORITY: Fix {{issue_type}} (attempt {{attempt_count}})

{{#if test_failures_formatted}}
### Failures to Fix

{{test_failures_formatted}}
{{/if}}

{{#if review_issues_formatted}}
### Issues to Fix

{{review_issues_formatted}}
{{/if}}

{{#if previous_attempts}}
### Previous Attempts (all failed to resolve)

{{previous_attempts}}
{{/if}}

---

### Reference: Task & Plan (already implemented)

{{#if assigned_task}}
{{assigned_task}}

{{/if}}
{{work_request}}
{{else}}
{{#if assigned_task}}
## Assigned Task

{{assigned_task}}
{{/if}}

## Work Request

{{work_request}}
{{/if}}
```

The implementer agent `.md` has a single `{{block:implement}}` reference. PromptBuilder sets `is_retry` in the context dict to control which branch renders.

### `test.block.md`

```markdown
## Work Request

{{work_request}}

{{#if implementation_summary}}
## Implementation Summary

{{implementation_summary}}
{{/if}}
```

### `review.block.md`

```markdown
## Work Request

{{work_request}}

{{#if test_results}}
## Test Results

{{test_results}}
{{/if}}

{{#if files_changed_formatted}}
## Files Changed

{{files_changed_formatted}}
{{/if}}
```

Note: the implementer-capabilities disclaimer moves to `reviewer.md` as static content (Section 4), not in the block.

### `pr.block.md`

```markdown
## Work Request

{{work_request}}

{{#if plan_approach}}
## Approach

{{plan_approach}}
{{/if}}
```

### `learn.block.md`

```markdown
## Work Request

{{work_request}}

## Termination

**Type:** {{termination_type|unknown}}
{{#if termination_reason}}
**Reason:** {{termination_reason}}
{{/if}}

{{#if plan_content}}
## Plan File

{{plan_content}}
{{/if}}

## Run Reference

**Run ID:** `{{run_id}}`
**Run directory:** `.worca/runs/{{run_id}}/`
**Logs directory:** `.worca/runs/{{run_id}}/logs/`

## Run Data

```json
{{run_data}}
```
```

---

## 6. OverlayResolver Changes

### New capabilities

Add to `overlay.py`:

1. **`resolve_placeholders(content, context)`** — resolves `{{name}}`, `{{name|default}}`, `{{#if}}...{{/if}}`
2. **`resolve_blocks(content, context, core_dir, template_agents_dir)`** — finds all `{{block:name}}` references, loads each block through the three-tier overlay chain, resolves inner placeholders, inserts results
3. **`resolve_agent(content, context, core_dir, template_agents_dir)`** — full resolution pipeline: blocks → conditionals → placeholders → cleanup

### `resolve_blocks` implementation

```python
_BLOCK_RE = re.compile(r"^\{\{block:(\S+)\}\}\s*$", re.MULTILINE)

def resolve_blocks(content: str, context: dict, resolver: OverlayResolver,
                   core_dir: str, template_agents_dir: str | None = None,
                   _seen: set | None = None) -> str:
    """Replace {{block:name}} with resolved block content.

    Blocks are loaded through the three-tier overlay chain, then inner
    placeholders are resolved. Supports recursive blocks with cycle detection.
    """
    if _seen is None:
        _seen = set()

    def _replace_block(m):
        block_name = m.group(1)
        if block_name in _seen:
            return ""  # cycle detected — skip
        block_content = resolver.resolve_block(
            block_name, core_dir, template_agents_dir
        )
        if block_content is None:
            return ""  # block doesn't exist at any tier
        # Recurse for nested block references
        _seen.add(block_name)
        resolved = resolve_blocks(
            block_content, context, resolver,
            core_dir, template_agents_dir, _seen
        )
        _seen.discard(block_name)
        return resolved.strip()

    return _BLOCK_RE.sub(_replace_block, content)
```

### `resolve_block` on OverlayResolver

```python
def resolve_block(self, block_name: str, core_dir: str,
                  template_agents_dir: str | None = None) -> str | None:
    """Load a block through the three-tier overlay chain.

    Returns merged content string, or None if no tier provides the block.
    """
    filename = f"{block_name}.block.md"
    core_path = os.path.join(core_dir, filename)

    # Start with core content (may not exist)
    base = None
    if os.path.exists(core_path):
        try:
            with open(core_path) as f:
                base = f.read()
        except OSError:
            pass

    # Apply project overlay
    base = self._apply_block_overlay(block_name, base, self.overrides_dir)

    # Apply template overlay
    if template_agents_dir is not None:
        base = self._apply_block_overlay(block_name, base, template_agents_dir)

    return base
```

### Full resolution pipeline

Called by `_render_agent_templates()` **replacing** the old `{single-brace}` substitution loop:

```python
def resolve_agent(content: str, context: dict, resolver: OverlayResolver,
                  core_dir: str, template_agents_dir: str | None = None) -> str:
    """Full agent .md resolution: blocks → conditionals → placeholders → cleanup."""
    # 1. Resolve {{block:name}} references
    result = resolve_blocks(content, context, resolver, core_dir, template_agents_dir)
    # 2. Resolve {{#if}}...{{/if}} conditionals
    # 3. Resolve {{name}} and {{name|default}} placeholders
    result = resolve_placeholders(result, context)
    # 4. Collapse excessive blank lines
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result
```

This replaces the old `for key, value in template_vars.items(): content.replace(f"{{{key}}}", str(value))` loop entirely. One syntax, one resolution pass.

---

## 7. Integration: How It All Fits Together

### Updated rendering pipeline

```
_render_agent_templates() — called once per run at startup (SIMPLIFIED):

  For each agent .md in .claude/worca/agents/core/:
    1. Read core .md
    2. Overlay merge (project → template) via OverlayResolver.resolve()
    3. Write to {run_dir}/agents/{agent}.md
          ↑ This is the TEMPLATE — contains unresolved {{block:name}} and {{placeholder}} tokens

  (Step 2 from the old flow — {single-brace} substitution — is REMOVED.
   All substitution now happens in resolve_agent() at stage invocation time.)
```

**Important:** Block and placeholder resolution cannot happen at startup because context values (test failures, review issues, plan content) don't exist yet. The full resolution happens **per stage invocation** in `run_stage()`.

### Per-stage resolution flow

```
run_stage() is called:
  1. PromptBuilder.build(stage, iteration)
     - Selects which context values to populate (mode routing)
     - Pre-formats complex data (test failures → markdown)
     - Builds the context dict
  2. Read the rendered agent .md from {run_dir}/agents/{agent}.md
     (this has {single-brace} vars + overlay already applied, but NOT blocks/placeholders)
  3. resolve_agent(agent_content, context, resolver, core_dir, template_agents_dir)
     → produces the fully resolved agent document
  4. Write resolved content to a temp file
  5. Pass temp file as --agent, work request as -p
```

### What `-p` becomes

The `-p` prompt shrinks to just the work request title + description. All the structured context (test failures, plan content, retry instructions) is now embedded in the agent document. This is a significant simplification:

```python
# Before: PromptBuilder produces elaborate multi-section prompt for -p
prompt = prompt_builder.build(stage, iteration)  # 50+ lines of markdown

# After: -p is just the work request
prompt = f"{work_request.title}\n\n{work_request.description}"
```

### PromptBuilder's new role

PromptBuilder no longer builds the `-p` prompt. It becomes a **context assembler**:

```python
class PromptBuilder:
    def build_context(self, stage: str, iteration: int = 0) -> dict:
        """Assemble the context dict for block/placeholder resolution."""
        ctx = dict(self._context)
        ctx["work_request"] = self._work_request_section()
        ctx["assigned_task"] = self._assigned_task_section()
        # Pre-format complex data
        if "test_failures" in ctx:
            ctx["test_failures_formatted"] = self._format_test_failures(...)
        # Stage-specific context routing
        self._apply_stage_context(stage, iteration, ctx)
        return ctx
```

The `_build_*` methods are replaced by `_apply_stage_context()` which populates mode-specific keys (e.g., setting `issue_type` for retry mode, clearing `implement-retry` block content for initial mode).

---

## 8. Builtin Pipeline Templates Update

Six builtin templates ship with worca. Their agent overrides currently use replace mode (the OverlayResolver default). After this change, replace-mode overrides **must include `{{block:name}}` references** or the agent loses all dynamic context.

**Recommendation:** Migrate all builtin templates to `<!-- append -->` mode. This preserves the core file (including its `{{block:name}}` references) and only adds/modifies specific sections. Append mode is less fragile — if core adds a new block reference, append-mode templates automatically inherit it.

### Migration plan per template

| Template | Current overrides | Migration |
|---|---|---|
| `feature` | None | No changes — uses core defaults |
| `bugfix` | `planner.md`, `coordinator.md` | Switch both to `<!-- append -->` with section-level replace |
| `refactor` | `planner.md`, `guardian.md` | Switch both to `<!-- append -->`. `guardian.md` no longer handles REVIEW, so override scope is narrower |
| `quick-fix` | `planner.md`, `coordinator.md` | Switch both to `<!-- append -->` |
| `investigate` | `planner.md` | Switch to `<!-- append -->`. Optionally add `plan.block.md` override to customize work request presentation |
| `test-only` | `planner.md`, `coordinator.md`, `implementer.md` | Switch all to `<!-- append -->` |

### Example: `bugfix/agents/planner.md` (before → after)

**Before (replace mode):**
```markdown
# Planner Agent — Bugfix Mode
...full agent file...
```

**After (append mode with section replace):**
```markdown
<!-- append -->
## Override: Role
<!-- replace -->

You are the Planner in bugfix mode. You investigate bugs and identify root causes.
Stay tightly focused on the reported problem — avoid new features or broad refactors.

## Override: Process
<!-- replace -->

1. Reproduce the bug from the description
2. Identify root cause (not just symptoms)
3. Determine the minimal fix
4. Create a focused plan describing exactly what to change and where
```

The core `planner.md` is preserved — including `{{block:plan}}`, `{{plan_file}}` references, Output section, and governance Rules. The template only overrides Role and Process.

---

## 9. Audit: What to Move vs Keep

### Remove from Python — duplicated in agent `.md`

| Method | Lines | Duplicated instruction |
|---|---|---|
| `_build_plan` | 148-150 | "Create a detailed implementation plan...Start by reading CLAUDE.md" |
| `_build_coordinate` | 271-272 | "Decompose the approved plan...Do NOT implement anything" |
| `_build_implement_initial` | 298 | "Implement the code changes...Follow TDD" |
| `_build_test` | 420 | "Run the full test suite...Do NOT modify source code" |
| `_build_review` | 436 | "Review the code changes...Do NOT modify code" |
| `_build_pr` | 462 | "Create a pull request...Ensure the commit history is clean" |
| `_build_learn` | 484-485, 519-543 | "Analyze the completed pipeline run" + 6 analysis categories |
| `_build_plan_review` | 215-216, 231-241, 261-266 | "Review the plan...read-only analyst" + MCP instructions + output format |

### Move to agent `.md` (not currently there)

| Source | Instruction | Target |
|---|---|---|
| `_build_review:453-458` | Implementer capabilities disclaimer | `reviewer.md` (new agent) — static content |
| `_build_implement_retry:389-393` | "Read back changed lines to confirm fix" | `implementer.md` `## Retry Rules` |
| `_build_implement_retry:323-324` | "Do NOT re-implement from scratch" | `implementer.md` `## Retry Rules` |
| `_build_learn:519-543` | 6-category analysis instructions | `learner.md` (new section) |

### Move to blocks (dynamic context)

All data injections become `{{placeholder}}` tokens in `.block.md` files. See Section 5.

### Stays in Python (by design)

| What | Where | Why |
|---|---|---|
| Pre-formatting helpers (`_format_test_failures`, etc.) | `prompt_builder.py` ~60 lines | No loop constructs in template engine — Python formats lists into Markdown |
| Context formatters (`_work_request_section`, `_assigned_task_section`) | `prompt_builder.py` ~20 lines | Assemble structured context values from raw data |
| Mode routing (`_apply_stage_context`) | `prompt_builder.py` ~30 lines | Selects which context keys to populate per stage/iteration |
| Error classification prompt | `error_classifier.py:108-119` | Self-contained LLM call, fully dynamic, not a stage prompt |
| Smart title prompt | `work_request.py:20-23` | Two-line utility prompt, not worth a template file |
| CLI prompt offloading bridge | `claude_cli.py:76-79` | Infrastructure code for ARG_MAX handling |
| Hook governance messages (15 total) | `hooks/guard.py`, `plan_check.py`, `prompt.py`, `test_gate.py`, `tracking.py` | Tightly coupled to enforcement logic, short, agent-facing error strings |
| Preflight diagnostic messages (~14) | `scripts/preflight_checks.py` | Status messages, not instructions |

---

## 10. Dead Code Removal

### `_STAGE_PROMPT_PREFIX` (runner.py:479-520)

Dead code — PromptBuilder always provides `prompt_override`. Delete along with `_build_stage_prompt()` (runner.py:523-528).

### All `_build_*` methods in prompt_builder.py

Replaced by `build_context()` + block/placeholder resolution. The entire class is refactored from "prompt builder" to "context assembler."

### `error_classifier.py:108-118` / `work_request.py:20-22`

Keep as-is — self-contained utilities, not stage prompts.

---

## 11. Implementation Tasks

### Task 1: Template engine in `overlay.py`

**Files:** Modify `src/worca/orchestrator/overlay.py`

Add:
- `resolve_placeholders(content, context)` — `{{name}}`, `{{name|default}}`, `{{#if}}...{{/if}}`
- `resolve_blocks(content, context, resolver, core_dir, template_agents_dir)` — `{{block:name}}` with cycle detection
- `resolve_agent(content, context, resolver, core_dir, template_agents_dir)` — full pipeline: blocks → conditionals → placeholders → cleanup

### Task 2: `resolve_block()` on OverlayResolver

**Files:** Modify `src/worca/orchestrator/overlay.py`

Add `resolve_block(block_name, core_dir, template_agents_dir)`:
- Three-tier resolution (core → project → template) for `.block.md` files
- Returns `None` if no tier provides the block
- Uses same `_apply_overlay` logic as agent `.md` resolution

### Task 3: Create block files

**Files:** Create in `src/worca/agents/core/`:
- `plan.block.md` (includes plan-revision via `{{#if plan_revision_mode}}`)
- `plan-review.block.md`
- `coordinate.block.md`
- `implement.block.md` (includes retry via `{{#if is_retry}}`)
- `test.block.md`, `review.block.md`, `pr.block.md`, `learn.block.md`

8 block files total. Content as specified in Section 5.

### Task 4: Create `reviewer.md` agent and update `STAGE_AGENT_MAP`

**Files:**
- Create `src/worca/agents/core/reviewer.md` — full agent definition (see Section 4)
- Modify `src/worca/orchestrator/stages.py` — change `Stage.REVIEW: "guardian"` to `Stage.REVIEW: "reviewer"`
- Modify `src/worca/hooks/guard.py` — add `"reviewer"` to the read-only agent list (same restrictions as current guardian-in-review-mode)

### Task 5: Add `{{block:name}}` references to agent `.md` files + migrate to `{{double-brace}}`

**Files:** Modify all files in `src/worca/agents/core/`:
- `planner.md` — add `{{block:plan}}`; migrate `{plan_file}` → `{{plan_file}}`
- `plan_reviewer.md` — add `{{block:plan-review}}`
- `coordinator.md` — add `{{block:coordinate}}`; migrate `{plan_file}`, `{run_id}` → `{{plan_file}}`, `{{run_id}}`
- `implementer.md` — add `{{block:implement}}` + `## Retry Rules`
- `tester.md` — add `{{block:test}}`
- `guardian.md` — add `{{block:pr}}`; remove REVIEW-related content
- `learner.md` — add `{{block:learn}}` + 6-category analysis section

### Task 6: Remove `{single-brace}` substitution from `_render_agent_templates()`

**Files:** Modify `src/worca/orchestrator/runner.py`

Remove the `for key, value in template_vars.items(): content.replace(...)` loop from `_render_agent_templates()`. The function now only does: read core → overlay merge → write to `{run_dir}/agents/`. All placeholder substitution is deferred to `resolve_agent()` at stage invocation time.

Also delete `_STAGE_PROMPT_PREFIX` dict and `_build_stage_prompt()` function.

### Task 7: Migrate builtin pipeline templates to `<!-- append -->` mode

**Files:** Modify all files in `src/worca/templates/`:
- `bugfix/agents/planner.md`, `bugfix/agents/coordinator.md`
- `refactor/agents/planner.md`, `refactor/agents/guardian.md`
- `quick-fix/agents/planner.md`, `quick-fix/agents/coordinator.md`
- `investigate/agents/planner.md`
- `test-only/agents/planner.md`, `test-only/agents/coordinator.md`, `test-only/agents/implementer.md`

Switch each from replace mode to `<!-- append -->` with `## Override: <Section>` blocks. This preserves core `{{block:name}}` references and governance rules.

### Task 8: Add pre-formatting helpers to PromptBuilder

**Files:** Modify `src/worca/orchestrator/prompt_builder.py`

Extract list-formatting logic into helpers:
- `_format_test_failures`, `_format_review_issues`
- `_format_review_history`, `_format_test_failure_history`
- `_format_plan_review_issues`, `_format_plan_review_history`
- `_format_implementation_summary`, `_format_test_results`

### Task 9: Refactor PromptBuilder to context assembler

**Files:** Modify `src/worca/orchestrator/prompt_builder.py`

Replace all `_build_*` methods with:
- `build_context(stage, iteration) -> dict` — assembles context for block/placeholder resolution
- `_apply_stage_context(stage, iteration, ctx)` — stage-specific context routing

Remove `build(stage, iteration) -> str`.

### Task 10: Integrate per-stage resolution in runner.py

**Files:** Modify `src/worca/orchestrator/runner.py`

Change `run_stage()`:
- Call `prompt_builder.build_context(stage, iteration)` instead of `prompt_builder.build()`
- Read agent `.md` template from `{run_dir}/agents/` (contains unresolved `{{block:name}}` and `{{placeholder}}` tokens)
- Call `resolve_agent(content, context, ...)` to produce fully resolved agent document
- Write to temp file, pass as `--agent`
- Pass minimal work request as `-p`

### Task 11: Update tests

**Files:**
- Unit tests for `resolve_placeholders()` — substitution, defaults, conditionals, missing keys, cleanup
- Unit tests for `resolve_blocks()` — block insertion, missing blocks, recursive blocks, cycle detection
- Unit tests for `resolve_block()` — three-tier resolution, overlay modes, empty override
- Rewrite 76+ existing PromptBuilder tests — assert on context dict contents rather than prompt strings
- Integration test: verify full `resolve_agent()` output matches expected structure per stage
- Verify builtin templates resolve correctly with sample context
- Test new reviewer agent: verify STAGE_AGENT_MAP change, guard.py read-only enforcement

### Task 12: Copy block files and reviewer agent during `worca init`

**Files:** Modify `src/worca/cli/init.py` (or equivalent)

Ensure `worca init` and `worca init --upgrade` copy `.block.md` files and `reviewer.md` alongside other agent `.md` files to `.claude/worca/agents/core/`.

---

## 12. Rollout Order

```
Task 1  (template engine)           Task 4  (reviewer agent + STAGE_AGENT_MAP)
  ↓                                    ↓
Task 2  (resolve_block)
  ↓
Task 3  (create block files)
  ↓
Task 5  ({{block:name}} + double-brace in agent .md)
  ↓
Task 6  (remove {single-brace} from runner.py)     Task 7  (migrate builtin templates)
  ↓                                                    ↓
Task 8  (pre-formatting helpers)
  ↓
Task 9  (refactor PromptBuilder)
  ↓
Task 10 (integrate in runner.py)
  ↓
Task 11 (tests)
  ↓
Task 12 (worca init copy)
```

Tasks 1 and 4 can run in parallel (no dependency). Tasks 6 and 7 can run in parallel. Task 9 depends on Task 8.

---

## 13. Migration Safety

### Backward compatibility

- Existing project agent overrides (`.claude/agents/*.md`) using **append mode** continue to work — the core file's `{{block:name}}` references are preserved, appended content is added after
- Project overrides using **replace mode** that do NOT include `{{block:name}}` references will result in the agent losing dynamic context — this is intentional (the project is taking full control of the agent)
- `worca init --upgrade` delivers new agent `.md` files (with `{{block:name}}` and `{{double-brace}}`), `.block.md` files, and `reviewer.md` together — no partial state
- The `{single-brace}` → `{{double-brace}}` migration is transparent to users — the syntax only appears in agent/block template files, not in user-facing config

### Breaking changes

- **`STAGE_AGENT_MAP`:** REVIEW stage now maps to `reviewer` instead of `guardian`. Projects that override the review agent in `settings.json` via `worca.stages.review.agent` are unaffected (settings override takes precedence). Projects relying on the default guardian-as-reviewer behavior will see different agent behavior.
- **Pipeline template agent overrides using replace mode** must add `{{block:name}}` references or switch to append mode. All 6 builtin templates are migrated in Task 7. Third-party templates using replace mode will lose dynamic context until updated.
- **PromptBuilder API:** `build()` is replaced by `build_context()`. Any code calling `prompt_builder.build(stage, iteration)` must be updated (runner.py, run_learn.py).
- **76+ tests** need rewriting to assert on context dicts instead of prompt strings.
- **`{single-brace}` syntax removed:** Any project override or pipeline template agent `.md` that uses `{plan_file}`, `{run_id}`, `{branch}`, or `{title}` must update to `{{double-brace}}` syntax.

### Verification

For each stage, verify the fully resolved agent document (after block insertion + placeholder resolution) contains all the information that the old system delivered across `--agent` + `-p`. The *format* will differ (single document vs two), but the *content* must be equivalent.

---

## 14. Acceptance Criteria

- [ ] Dedicated `reviewer.md` agent created; `STAGE_AGENT_MAP` updated for REVIEW stage
- [ ] 8 `.block.md` files created (plan, plan-review, coordinate, implement, test, review, pr, learn)
- [ ] All agent `.md` files migrated from `{single-brace}` to `{{double-brace}}` syntax
- [ ] Agent `.md` files contain `{{block:name}}` references at appropriate positions
- [ ] `resolve_placeholders()` handles `{{name}}`, `{{name|default}}`, `{{#if}}...{{/if}}`, `{{#if}}...{{else}}...{{/if}}`
- [ ] `resolve_blocks()` handles `{{block:name}}` insertion, missing blocks (empty), recursive blocks, cycle detection
- [ ] `resolve_block()` returns `None` for missing blocks (no error)
- [ ] Three-tier overlay chain works for `.block.md` files (core → project → template)
- [ ] Pipeline templates can override blocks, introduce new blocks, or remove blocks via empty overrides
- [ ] All 6 builtin pipeline templates migrated to `<!-- append -->` mode
- [ ] `{single-brace}` substitution loop removed from `_render_agent_templates()`
- [ ] `_STAGE_PROMPT_PREFIX` and `_build_stage_prompt()` deleted
- [ ] PromptBuilder refactored to context assembler — `build_context()` replaces `build()`
- [ ] `-p` reduced to minimal work request
- [ ] Learner analysis instructions moved to `learner.md`
- [ ] Implementer retry rules moved to `implementer.md`
- [ ] Implementer capabilities disclaimer in `reviewer.md` (static content)
- [ ] All existing tests pass (rewritten as needed)
- [ ] `worca init --upgrade` copies `.block.md` files and `reviewer.md`
- [ ] Fully resolved agent document contains equivalent content to old `--agent` + `-p` combination
