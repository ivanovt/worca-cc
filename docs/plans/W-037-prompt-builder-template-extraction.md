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

  For each file in .claude/worca/agents/core/:
    0. Skip .block.md files (they are resolved via resolve_block(), not as agent templates)
    1. Read core .md
    2. Overlay merge (project → template) via OverlayResolver.resolve()
    3. Write to {run_dir}/agents/{agent}.md
          ↑ This is the TEMPLATE — contains unresolved {{block:name}} and {{placeholder}} tokens

  (Step 2 from the old flow — {single-brace} substitution — is REMOVED.
   All substitution now happens in resolve_agent() at stage invocation time.
   The .block.md exclusion filter prevents block files from being treated as agents.)
```

**Important:** Block and placeholder resolution cannot happen at startup because context values (test failures, review issues, plan content) don't exist yet. The full resolution happens **per stage invocation** in the pipeline loop (runner.py:1416-1482), before `run_stage()` is called.

### Per-stage resolution flow

```
Pipeline loop (before calling run_stage()):
  1. PromptBuilder.build_context(stage, iteration)
     - Selects which context values to populate (mode routing)
     - Pre-formats complex data (test failures → markdown)
     - Returns the context dict
  2. Read the agent .md template from {run_dir}/agents/{agent}.md
     (overlay already applied, but contains unresolved {{block:name}} and {{placeholder}} tokens)
  3. resolve_agent(agent_content, context, resolver, core_dir, template_agents_dir)
     → produces the fully resolved agent document
  4. Write resolved content to a temp file
  5. Pass temp file as --agent override to run_stage(), work request as prompt_override
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

### Task 6: Remove `{single-brace}` substitution from `_render_agent_templates()` and exclude `.block.md` files

**Files:** Modify `src/worca/orchestrator/runner.py`

Two changes to `_render_agent_templates()`:

1. **Add `.block.md` exclusion filter.** The existing loop iterates `os.listdir(src_dir)` filtering on `filename.endswith('.md')`. Files like `plan.block.md` match this filter and would be treated as agent templates — copied to `run_dir/agents/`, overlay-resolved as agents named `plan.block`, `implement.block`, etc. This creates a parallel overlay path that conflicts with the block-specific `resolve_block()` chain. Fix: add `if filename.endswith('.block.md'): continue` before the existing `.md` check, so block files are skipped entirely. Block files are only resolved through the `resolve_block()` chain at stage invocation time.

```python
for filename in os.listdir(src_dir):
    if filename.endswith('.block.md'):
        continue  # block files resolved via resolve_block(), not as agent templates
    if not filename.endswith(".md"):
        continue
    # ... rest of loop
```

2. **Remove the `{single-brace}` substitution loop.** Delete the `for key, value in template_vars.items(): content.replace(...)` loop. The function now only does: read core → overlay merge → write to `{run_dir}/agents/`. All placeholder substitution is deferred to `resolve_agent()` at stage invocation time.

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

**Constructor change:** Add `resolver`, `core_dir`, and `template_agents_dir` parameters to `PromptBuilder.__init__()`. The current constructor (line 20-28) only accepts `work_request_title`, `work_request_description`, `claude_md_path`, `context_path`, and `master_plan_path`. The `build()` shim and `_load_agent_template()` need these to perform agent resolution. New signature:

```python
def __init__(self, work_request_title: str, work_request_description: str = "",
             claude_md_path: str = "CLAUDE.md", context_path: str = None,
             master_plan_path: str = "MASTER_PLAN.md",
             resolver: OverlayResolver = None,
             core_dir: str = None, template_agents_dir: str = None,
             run_dir: str = None):
    # ... existing init ...
    self._resolver = resolver
    self._core_dir = core_dir
    self._template_agents_dir = template_agents_dir
    self._run_dir = run_dir
```

All new parameters default to `None` for backward compatibility — existing callers that don't pass them still work (they just can't use the shim). The pipeline loop in runner.py (Task 10) passes these when constructing PromptBuilder.

Add:
- `build_context(stage, iteration) -> dict` — assembles context for block/placeholder resolution
- `_apply_stage_context(stage, iteration, ctx)` — stage-specific context routing
- `_load_agent_template(stage) -> str` — reads the overlay-merged agent `.md` template from `{run_dir}/agents/{agent}.md` (contains unresolved `{{block:name}}` and `{{placeholder}}` tokens)

**Keep `build()` as a backward-compatible shim** during transition:

```python
def build(self, stage: str, iteration: int = 0) -> str:
    """DEPRECATED — backward-compatible wrapper.

    Calls build_context() + resolve_agent() to produce the same output
    that old callers expect. Remove once all call sites migrate to
    build_context().
    """
    ctx = self.build_context(stage, iteration)
    agent_content = self._load_agent_template(stage)
    return resolve_agent(agent_content, ctx, self._resolver,
                         self._core_dir, self._template_agents_dir)
```

This ensures the running pipeline (which uses the old `prompt_builder.build()` call in runner.py) continues to work even if Task 10 is not yet applied. The shim is removed as part of Task 10 when the pipeline loop is updated to call `build_context()` directly.

### Task 10: Integrate per-stage resolution in the pipeline loop (runner.py)

**Files:** Modify `src/worca/orchestrator/runner.py`

**Important:** The primary call site for `prompt_builder.build()` is the main pipeline loop at runner.py:1422 (`rendered_prompt = prompt_builder.build(current_stage.value, pb_iteration)`), NOT `run_stage()`. `run_stage()` receives the already-built prompt via `prompt_override`. The build happens in the loop before `run_stage()` is called (runner.py:1479-1482).

Change the pipeline loop (around runner.py:1416-1482):
1. Replace `prompt_builder.build(current_stage.value, pb_iteration)` with `prompt_builder.build_context(current_stage.value, pb_iteration)` to get the context dict
2. Read the agent `.md` template from `{run_dir}/agents/{agent}.md` (overlay already applied, contains unresolved `{{block:name}}` and `{{placeholder}}` tokens). Use `STAGE_AGENT_MAP` to determine the agent name for the current stage
3. Call `resolve_agent(agent_content, context, resolver, core_dir, template_agents_dir)` to produce the fully resolved agent document
4. Write the resolved agent document to a temp file
5. Pass the temp file path to `run_stage()` as an `--agent` override (or modify `run_stage()`/`run_agent()` to accept a resolved agent content parameter)
6. Pass minimal work request (title + description) as `prompt_override` instead of the full PromptBuilder output

Also update the PromptBuilder constructor call in the pipeline loop to pass the new parameters (`resolver`, `core_dir`, `template_agents_dir`, `run_dir`).

Remove the `build()` shim from PromptBuilder (added in Task 9 as a transitional measure) — it is no longer needed once this task is complete.

### Task 11: Update tests

See Section 15 (Testing Strategy) for full details. Summary:

**Unit tests (new):**
- `resolve_placeholders()` — substitution, defaults, conditionals, missing keys, cleanup
- `resolve_blocks()` — block insertion, missing blocks, recursive blocks, cycle detection
- `resolve_block()` — three-tier resolution, overlay modes, empty override
- Pre-formatting helpers — structured data → Markdown string assertions
- `build_context()` — context dict contents per stage/iteration
- Reviewer agent — STAGE_AGENT_MAP change, guard.py read-only enforcement

**Unit tests (rewrite):**
- 76+ existing PromptBuilder tests → assert on context dict contents instead of prompt strings

**Integration tests:**
- Parameterized golden-fragment tests per stage — verify resolved agent document contains expected content
- Builtin template resolution — verify append-mode templates resolve correctly with sample context
- Cross-project installation test — install into `/Volumes/Apps/dev/ccexperiments/test-multi-01/`, verify files land correctly and resolve_agent produces valid output against installed templates

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

## 15. Testing Strategy

### Runtime isolation

The pipeline implementing this change runs from an **installed copy** of worca (`.claude/worca/` in the target project). The source files being modified (`src/worca/`, `src/worca/agents/core/`) are separate from the running pipeline's runtime. There is no bootstrapping problem:

```
Pipeline runtime:     .claude/worca/  (in target project)  ← OLD installed code, untouched
Source being modified: src/worca/     (in worca-cc repo)   ← NEW code being written
Unit tests (pytest):  imports from editable install        ← tests NEW code in subprocess
```

The tester agent's own prompt is built by the old `.claude/worca/` code. `pytest` runs in a subprocess and imports the modified `src/worca/` via editable install. Completely separate.

### Test layers

#### Layer 1: Unit tests (deterministic, no LLM)

**Template engine (`tests/test_overlay_placeholders.py`):**

| Test | What it verifies |
|---|---|
| `test_simple_placeholder` | `{{name}}` → value from context |
| `test_placeholder_missing_key` | `{{name}}` → empty string when key absent |
| `test_placeholder_default` | `{{name\|fallback}}` → fallback when key absent |
| `test_placeholder_default_key_present` | `{{name\|fallback}}` → value when key present |
| `test_conditional_truthy` | `{{#if x}}body{{/if}}` → body when x truthy |
| `test_conditional_falsy` | `{{#if x}}body{{/if}}` → empty when x falsy |
| `test_conditional_else_truthy` | `{{#if x}}a{{else}}b{{/if}}` → a |
| `test_conditional_else_falsy` | `{{#if x}}a{{else}}b{{/if}}` → b |
| `test_nested_conditionals` | `{{#if a}}...{{#if b}}...{{/if}}...{{/if}}` |
| `test_blank_line_cleanup` | 3+ blank lines → 2 after empty conditional removal |
| `test_block_insertion` | `{{block:name}}` ��� loads and inserts block content |
| `test_block_missing` | `{{block:name}}` → empty when block file absent |
| `test_block_recursive` | Block A contains `{{block:B}}`, B resolves |
| `test_block_cycle_detection` | Block A → B → A → stops |

**Block resolution (`tests/test_overlay_blocks.py`):**

| Test | What it verifies |
|---|---|
| `test_resolve_block_core_only` | Loads from core_dir when no overlays exist |
| `test_resolve_block_project_replaces` | Project override replaces core block |
| `test_resolve_block_project_appends` | Project `<!-- append -->` appends to core block |
| `test_resolve_block_template_replaces` | Template override replaces after project |
| `test_resolve_block_all_tiers` | Core → project append → template replace chain |
| `test_resolve_block_missing_all_tiers` | Returns None when no tier provides block |
| `test_resolve_block_empty_override` | Empty project file → empty string (block removed) |
| `test_resolve_block_introduced_by_project` | No core, project provides → returns content |
| `test_resolve_block_introduced_by_template` | No core/project, template provides → returns content |

**Agent template rendering (`tests/test_runner.py` or `tests/test_render_agent_templates.py`):**

| Test | What it verifies |
|---|---|
| `test_render_agent_templates_skips_block_files` | `.block.md` files in `agents/core/` are NOT copied to `run_dir/agents/` or overlay-resolved as agent templates |
| `test_render_agent_templates_copies_agent_md` | Regular `.md` files (e.g. `planner.md`) are still copied and overlay-resolved |

**Pre-formatting helpers (`tests/test_prompt_builder.py` — rewritten):**

| Test | What it verifies |
|---|---|
| `test_format_test_failures` | List of failure dicts → numbered Markdown |
| `test_format_review_issues` | List of issue dicts → severity/file/line Markdown |
| `test_format_*_empty` | Empty list → empty string |
| `test_format_*_missing_fields` | Dicts with missing keys → graceful defaults |

**Context assembly (`tests/test_prompt_builder.py` — rewritten):**

76+ existing tests rewritten to assert on `build_context()` output dict rather than prompt strings:

| Test pattern | What it verifies |
|---|---|
| `test_build_context_plan_initial` | Returns `work_request`, `claude_md`, no `plan_revision_mode` |
| `test_build_context_plan_revision` | Returns `plan_revision_mode=True`, `plan_content`, `plan_review_issues_formatted` |
| `test_build_context_implement_initial` | Returns `assigned_task`, `work_request`, no `is_retry` |
| `test_build_context_implement_retry` | Returns `is_retry=True`, `issue_type`, `test_failures_formatted` |
| `test_build_context_*` | One per stage × mode combination |

**Reviewer agent (`tests/test_reviewer_agent.py`):**

| Test | What it verifies |
|---|---|
| `test_stage_agent_map_review` | `STAGE_AGENT_MAP[Stage.REVIEW] == "reviewer"` |
| `test_reviewer_md_exists` | `src/worca/agents/core/reviewer.md` exists |
| `test_guard_reviewer_read_only` | guard.py blocks writes for reviewer agent |

#### Layer 2: Integration tests (deterministic, no LLM)

**Golden-fragment tests (`tests/test_resolve_agent_integration.py`):**

Parameterized tests that verify the full `resolve_agent()` pipeline produces output containing expected content fragments:

```python
@pytest.mark.parametrize("stage,agent,context,expected_fragments", [
    ("plan", "planner", {
        "plan_file": "MASTER_PLAN.md",
        "work_request": "Add user authentication",
        "claude_md": "# My Project\nUses FastAPI...",
    }, [
        "Add user authentication",      # work request present
        "# My Project",                  # claude_md present
        "plan.json schema",              # output format from agent .md
        "Do NOT write implementation",   # governance from agent .md
        "MASTER_PLAN.md",               # plan_file placeholder resolved
    ]),
    ("implement", "implementer", {
        "is_retry": True,
        "issue_type": "Test Failures",
        "attempt_count": "2",
        "test_failures_formatted": "1. **test_auth** ...",
        "work_request": "Add auth",
    }, [
        "PRIORITY: Fix Test Failures",   # retry header
        "attempt 2",                     # attempt count
        "1. **test_auth**",              # failures list
        "Do NOT re-implement",           # retry rules from agent .md
        "TDD",                           # process from agent .md
    ]),
    # ... one entry per stage × mode combination
])
def test_resolved_agent_contains_fragments(stage, agent, context, expected_fragments, tmp_path):
    # Set up core dir with agent .md and block files
    # Run resolve_agent()
    # Assert all fragments present in output
```

**Builtin template tests (`tests/test_builtin_templates.py`):**

For each of the 6 builtin templates, verify that append-mode overrides produce valid resolved output:

```python
@pytest.mark.parametrize("template_id", ["bugfix", "refactor", "quick-fix", "investigate", "test-only", "feature"])
def test_template_resolves_with_blocks(template_id, tmp_path):
    # Load template's agents/ dir
    # Apply overlay chain: core → template
    # Resolve with sample context
    # Assert block content appears (not just raw {{block:name}} tokens)
    # Assert governance sections preserved
```

**Cross-project installation test (`tests/test_worca_init_blocks.py`):**

Verifies that `worca init --upgrade` correctly installs block files into a target project:

```python
TEST_PROJECT = "/Volumes/Apps/dev/ccexperiments/test-multi-01"

@pytest.mark.skipif(not os.path.isdir(TEST_PROJECT), reason="test-multi-01 not available")
def test_worca_init_installs_blocks():
    """Install worca into test-multi-01 and verify block files land correctly."""
    # 1. Run: pip install -e /Volumes/Apps/dev/ccexperiments/worca-cc
    # 2. Run: cd test-multi-01 && worca init --upgrade
    # 3. Assert .claude/worca/agents/core/*.block.md files exist
    # 4. Assert .claude/worca/agents/core/reviewer.md exists
    # 5. Assert agent .md files contain {{block:name}} (not old {single-brace})
    # 6. Load a sample context, run resolve_agent() against installed files
    # 7. Assert resolved output contains expected content (no unresolved {{...}} tokens)
```

This test is skipped in CI (test-multi-01 is a local development repo). It runs when the tester executes `pytest tests/` in the worca-cc repo on a machine where test-multi-01 exists.

#### Layer 3: Backward-compatible shim verification

The `build()` shim (Task 9) ensures the old API still works during transition:

```python
def test_build_shim_produces_equivalent_output():
    """Verify build() shim produces same output as build_context() + resolve_agent()."""
    pb = PromptBuilder(...)
    pb.update_context("work_request", "Add auth")
    # ... set up context

    # Old path (via shim)
    shim_output = pb.build("plan", 0)

    # New path (explicit)
    ctx = pb.build_context("plan", 0)
    agent_content = load_agent_template("planner")
    direct_output = resolve_agent(agent_content, ctx, ...)

    assert shim_output == direct_output
```

### What is NOT tested by the pipeline

The pipeline cannot test whether agents **behave correctly** with the new prompt structure (one document vs two). This requires running actual pipeline stages with real LLM calls, which is outside the tester's scope.

**Post-merge manual validation:** After the PR is created, run a smoke pipeline on test-multi-01:

```bash
cd /Volumes/Apps/dev/ccexperiments/test-multi-01
worca init --upgrade
worca run --prompt "Add a hello world function" --template quick-fix
```

Verify the pipeline completes successfully — planner produces a plan, coordinator creates tasks, implementer writes code, tester runs tests. This confirms the new prompt system produces working agent behavior end-to-end.

---

## 16. Acceptance Criteria

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
- [ ] `_render_agent_templates()` skips `.block.md` files (exclusion filter prevents block files from being treated as agent templates)
- [ ] `{single-brace}` substitution loop removed from `_render_agent_templates()`
- [ ] `_STAGE_PROMPT_PREFIX` and `_build_stage_prompt()` deleted
- [ ] PromptBuilder constructor accepts `resolver`, `core_dir`, `template_agents_dir`, `run_dir` parameters
- [ ] PromptBuilder refactored to context assembler — `build_context()` replaces `build()`
- [ ] Pipeline loop (runner.py:~1422) calls `build_context()` + `resolve_agent()` instead of `build()`
- [ ] `-p` reduced to minimal work request
- [ ] Learner analysis instructions moved to `learner.md`
- [ ] Implementer retry rules moved to `implementer.md`
- [ ] Implementer capabilities disclaimer in `reviewer.md` (static content)
- [ ] All existing tests pass (rewritten as needed)
- [ ] `worca init --upgrade` copies `.block.md` files and `reviewer.md`
- [ ] Fully resolved agent document contains equivalent content to old `--agent` + `-p` combination
- [ ] `build()` shim produces identical output to `build_context()` + `resolve_agent()` path
- [ ] Golden-fragment tests pass for all stage × mode combinations
- [ ] Cross-project installation test passes against `test-multi-01`
- [ ] Post-merge smoke pipeline completes successfully on `test-multi-01` (manual)
