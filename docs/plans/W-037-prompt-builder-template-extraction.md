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
agent .md file                        ← contains {{block:name}} insertion points
      ↓
  resolve blocks (load .block.md, overlay, placeholder substitution)
      ↓
fully resolved agent document  ──→ --agent flag
                                      ↕ Claude sees both
work request (minimal)         ──→ -p flag
```

The agent sees **one coherent document** via `--agent`. Static instructions (role, process, rules) and dynamic context (work request, test failures, plan content) are interleaved at specific, controllable positions. The `-p` prompt is reduced to just the raw work request title + description.

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
  plan.block.md                 ← block: plan stage context
  plan-revision.block.md        ← block: plan revision mode context
  plan-review.block.md          ← block: plan review stage context
  coordinate.block.md
  implement.block.md
  implement-retry.block.md      ← block: implement retry mode context
  test.block.md
  review.block.md
  pr.block.md
  learn.block.md
```

Block names are decoupled from agent names. An agent `.md` can reference any number of blocks, and the same block can be referenced by multiple agents.

---

## 3. Placeholder Syntax

### Types

All use double-brace `{{...}}` syntax, distinct from the existing single-brace `{name}` used by `_render_agent_templates()`.

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

### Current `planner.md` (abbreviated)

```markdown
# Planner Agent

## Role
You are the Planner. You create plan files...

## Context
You receive a work request...

## Process
1. Read and understand the work request
2. Read CLAUDE.md for project context
...

## Output
Produce a structured plan following the `plan.json` schema.

## Rules
<!-- governance -->
- Do NOT write implementation code...
```

### New `planner.md` with block insertion

```markdown
# Planner Agent

## Role
You are the Planner. You create plan files that define the architecture,
approach, and scope for a work request. The plan file path is `{plan_file}`.

## Process
1. Read and understand the work request
2. Read CLAUDE.md for project context
3. Explore the codebase to understand existing architecture
4. Identify affected components and potential risks
5. Create `{plan_file}` with: problem statement, approach, task breakdown, test strategy, branch naming
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

### New `implementer.md` with conditional block insertion

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

{{block:implement-retry}}

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

Both `{{block:implement}}` and `{{block:implement-retry}}` are in the same file. At runtime:
- For initial implementation: `implement.block.md` resolves to the task assignment + work request; `implement-retry.block.md` doesn't exist or resolves to empty
- For retry: `implement.block.md` may resolve to empty or a reference section; `implement-retry.block.md` resolves to the priority header + failure lists

PromptBuilder controls which blocks have content by setting context values that blocks reference via `{{#if}}`.

### All agent `.md` changes summary

| Agent file | Block references to add | New static content to add |
|---|---|---|
| `planner.md` | `{{block:plan}}` between Process and Output | None (already complete) |
| `plan_reviewer.md` | `{{block:plan-review}}` between Process and Output | None |
| `coordinator.md` | `{{block:coordinate}}` between Process and Output | None |
| `implementer.md` | `{{block:implement}}` + `{{block:implement-retry}}` | `## Retry Rules` section (from `_build_implement_retry` lines 389-393, 323-324) |
| `tester.md` | `{{block:test}}` between Process and Output | None |
| `guardian.md` | `{{block:pr}}` between Process and Output | None |
| `learner.md` | `{{block:learn}}` between Process and Output | 6-category analysis instructions (from `_build_learn` lines 519-543) |

A new `reviewer.md` is NOT needed — the review stage already uses `tester.md` agent or a configured agent. The implementer-capabilities disclaimer currently in `_build_review` (lines 453-458) moves into `review.block.md` since it's contextual to what the reviewer needs to know about the current run.

---

## 5. Block File Contents

### `plan.block.md`

```markdown
## Work Request

{{work_request}}

{{#if claude_md}}
## Project Context (from CLAUDE.md)

{{claude_md}}
{{/if}}
```

### `plan-revision.block.md`

```markdown
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
```

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

### `implement.block.md`

```markdown
{{#if assigned_task}}
## Assigned Task

{{assigned_task}}
{{/if}}

## Work Request

{{work_request}}
```

### `implement-retry.block.md`

```markdown
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
```

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

## Implementer Capabilities

The implementer agent can edit files and run tests but CANNOT make git commits
(commits are handled by the guardian stage). Do NOT flag uncommitted files as issues
requiring changes — focus only on code correctness, style, and adherence to the plan.
```

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

Called by `_render_agent_templates()` after existing `{single-brace}` substitution and overlay merge:

```python
def resolve_agent(content: str, context: dict, resolver: OverlayResolver,
                  core_dir: str, template_agents_dir: str | None = None) -> str:
    """Full agent .md resolution: blocks → conditionals → placeholders → cleanup."""
    # 1. Resolve {{block:name}} references
    result = resolve_blocks(content, context, resolver, core_dir, template_agents_dir)
    # 2. Resolve {{#if}}...{{/if}} conditionals
    # 3. Resolve {{name}} placeholders
    result = resolve_placeholders(result, context)
    # 4. Collapse excessive blank lines
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result
```

---

## 7. Integration: How It All Fits Together

### Updated rendering pipeline

```
_render_agent_templates() — called once per run at startup:

  For each agent .md in .claude/worca/agents/core/:
    1. Read core .md
    2. {single-brace} substitution ({plan_file}, {run_id}, {branch}, {title})
    3. Overlay merge (project → template) via OverlayResolver.resolve()
    4. Write to {run_dir}/agents/{agent}.md
          ↑ THIS IS THE EXISTING FLOW — unchanged

  NEW — after step 4, for each rendered agent .md:
    5. resolve_agent(content, context, resolver, core_dir, template_agents_dir)
       - Resolves {{block:name}} → loads block, applies overlay chain, inserts
       - Resolves {{#if}}...{{/if}} conditionals
       - Resolves {{name}} placeholders
    6. Write final result to {run_dir}/agents/{agent}.md (overwrites step 4)
```

**Important:** Step 5 cannot happen at startup because context values (test failures, review issues, plan content) don't exist yet. The full resolution must happen **per stage invocation**, not once at startup.

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

Six builtin templates ship with worca. Their agent overrides currently contain only prose instructions. After this change, templates that customize agent behavior should also control which blocks appear and what they contain.

### Templates that need block overrides

| Template | Current overrides | Block changes needed |
|---|---|---|
| `bugfix` | `planner.md`, `coordinator.md` | Add `{{block:plan}}` to planner override if not inherited from core. No block overrides needed — the prose changes are in the agent `.md`. |
| `refactor` | `planner.md`, `guardian.md` | Same — prose is in agent `.md` overrides, blocks pass through from core. |
| `quick-fix` | `planner.md`, `coordinator.md` | Same. |
| `investigate` | `planner.md` | May want to override `plan.block.md` to suppress work request formatting since this is analysis-only. |
| `test-only` | `planner.md`, `coordinator.md`, `implementer.md` | `implementer.md` override should include `{{block:implement}}` reference since it replaces the core implementer. |
| `feature` | None | No changes — uses core defaults. |

### Key migration rule for template agent overrides

Existing template agent overrides use **replace mode** (OverlayResolver default). When a template provides `agents/implementer.md`, it completely replaces the core `implementer.md`. After this change, that replacement file **must include `{{block:name}}` references** or the agent loses all dynamic context.

This is the critical migration step: every template agent `.md` override that uses replace mode must be updated to include the appropriate `{{block:name}}` references from the new core `.md` files.

**For templates using `<!-- append -->` mode:** No change needed — the core file's `{{block:name}}` references are preserved, and appended content gets added after.

### Updated template files

**`bugfix/agents/planner.md`** — currently replaces core planner. Must add `{{block:plan}}`:

```markdown
# Planner Agent — Bugfix Mode

## Role
You are the Planner in bugfix mode...

## Process
1. Reproduce the bug...
2. Identify root cause...
...

{{block:plan}}

## Output
Produce a structured plan following the `plan.json` schema.

## Rules
<!-- governance -->
...
```

Same pattern for all other template agent overrides that use replace mode.

### Alternative: switch templates to `<!-- append -->` mode

Instead of duplicating the full agent `.md` structure in each template override, templates could switch to append mode. This preserves the core file (including its `{{block:name}}` references) and only adds/modifies specific sections:

```markdown
<!-- append -->
## Override: Process
<!-- replace -->

1. Reproduce the bug...
2. Identify root cause (not just symptoms)...
```

This is less fragile — if core adds a new `{{block:name}}` reference, append-mode templates automatically pick it up. Replace-mode templates would miss it.

**Recommendation:** Migrate existing builtin templates to `<!-- append -->` mode where possible. Only use replace mode when the template fundamentally changes the agent's structure.

---

## 9. Audit: What to Move vs Keep

### Fully unconditional — duplicated in agent `.md`

These lines in `prompt_builder.py` repeat what the agent `.md` already says. **Remove** from Python — the agent `.md` already covers them.

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
| `_build_implement_retry:389-393` | "Read back changed lines to confirm fix" | `implementer.md` `## Retry Rules` |
| `_build_implement_retry:323-324` | "Do NOT re-implement from scratch" | `implementer.md` `## Retry Rules` |
| `_build_learn:519-543` | 6-category analysis instructions | `learner.md` (new section) |

### Move to blocks (dynamic context)

All data injections become `{{placeholder}}` tokens in `.block.md` files. See Section 5 for full block contents.

### Stays in Python

- Pre-formatting helpers (`_format_test_failures`, etc.)
- Context assembly (`build_context`)
- Mode routing (which context keys to populate per stage/iteration)

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
- `plan.block.md`, `plan-revision.block.md`, `plan-review.block.md`
- `coordinate.block.md`
- `implement.block.md`, `implement-retry.block.md`
- `test.block.md`, `review.block.md`, `pr.block.md`, `learn.block.md`

Content as specified in Section 5.

### Task 4: Add `{{block:name}}` references to agent `.md` files

**Files:** Modify `src/worca/agents/core/`:
- `planner.md` — add `{{block:plan}}`
- `plan_reviewer.md` — add `{{block:plan-review}}`
- `coordinator.md` — add `{{block:coordinate}}`
- `implementer.md` — add `{{block:implement}}` + `{{block:implement-retry}}` + `## Retry Rules`
- `tester.md` — add `{{block:test}}`
- `guardian.md` — add `{{block:pr}}`
- `learner.md` — add `{{block:learn}}` + 6-category analysis section

### Task 5: Update builtin pipeline templates

**Files:** Modify `src/worca/templates/`:
- `bugfix/agents/planner.md` — add `{{block:plan}}`
- `bugfix/agents/coordinator.md` — add `{{block:coordinate}}`
- `refactor/agents/planner.md` — add `{{block:plan}}`
- `refactor/agents/guardian.md` — add `{{block:pr}}`
- `quick-fix/agents/planner.md` — add `{{block:plan}}`
- `quick-fix/agents/coordinator.md` — add `{{block:coordinate}}`
- `investigate/agents/planner.md` — add `{{block:plan}}`
- `test-only/agents/planner.md` — add `{{block:plan}}`
- `test-only/agents/coordinator.md` — add `{{block:coordinate}}`
- `test-only/agents/implementer.md` — add `{{block:implement}}`

Evaluate switching each to `<!-- append -->` mode where the override only modifies specific sections, to avoid having to maintain `{{block:name}}` references in template overrides. Use replace mode only when the template fundamentally changes the agent structure.

### Task 6: Add pre-formatting helpers to PromptBuilder

**Files:** Modify `src/worca/orchestrator/prompt_builder.py`

Extract list-formatting logic into helpers:
- `_format_test_failures`, `_format_review_issues`
- `_format_review_history`, `_format_test_failure_history`
- `_format_plan_review_issues`, `_format_plan_review_history`
- `_format_implementation_summary`, `_format_test_results`

### Task 7: Refactor PromptBuilder to context assembler

**Files:** Modify `src/worca/orchestrator/prompt_builder.py`

Replace all `_build_*` methods with:
- `build_context(stage, iteration) -> dict` — assembles context for block/placeholder resolution
- `_apply_stage_context(stage, iteration, ctx)` — stage-specific context routing (mode selection, key population)

Remove `build(stage, iteration) -> str` — the string assembly now happens in `resolve_agent()`.

### Task 8: Integrate per-stage resolution in runner.py

**Files:** Modify `src/worca/orchestrator/runner.py`

Change `run_stage()`:
- Call `prompt_builder.build_context(stage, iteration)` instead of `prompt_builder.build()`
- Read rendered agent `.md` from `{run_dir}/agents/`
- Call `resolve_agent(content, context, ...)` to produce fully resolved agent document
- Write to temp file, pass as `--agent`
- Pass minimal work request as `-p`

Delete `_STAGE_PROMPT_PREFIX` and `_build_stage_prompt()`.

### Task 9: Update tests

**Files:**
- Unit tests for `resolve_placeholders()` — substitution, defaults, conditionals, missing keys, cleanup
- Unit tests for `resolve_blocks()` — block insertion, missing blocks, recursive blocks, cycle detection
- Unit tests for `resolve_block()` — three-tier resolution, overlay modes, empty override
- Rewrite 76+ existing PromptBuilder tests — assert on context dict contents rather than prompt strings
- Integration test: verify full resolve_agent() output matches expected structure per stage
- Verify builtin templates resolve correctly with sample context

### Task 10: Copy block files during `worca init`

**Files:** Modify `src/worca/cli/init.py` (or equivalent)

Ensure `worca init` and `worca init --upgrade` copy `.block.md` files alongside agent `.md` files to `.claude/worca/agents/core/`.

---

## 12. Rollout Order

```
Task 1  (template engine)
  ↓
Task 2  (resolve_block on OverlayResolver)
  ↓
Task 3  (create block files)
  ↓
Task 4  (add {{block:name}} to agent .md)     Task 5  (update builtin templates)
  ↓                                               ↓
Task 6  (pre-formatting helpers)
  ↓
Task 7  (refactor PromptBuilder)
  ↓
Task 8  (integrate in runner.py)
  ↓
Task 9  (tests)
  ↓
Task 10 (worca init copy)
```

Tasks 4 and 5 can run in parallel. Task 7 depends on Task 6.

---

## 13. Migration Safety

### Backward compatibility

- Existing project agent overrides (`.claude/agents/*.md`) continue to work — they override the agent `.md` which now contains `{{block:name}}` references that get resolved after overlay
- If a project override uses replace mode and does NOT include `{{block:name}}` references, the agent loses dynamic context — this is intentional (the project is taking full control)
- The `{single-brace}` substitution in `_render_agent_templates()` runs before `{{double-brace}}` resolution — no conflict
- `worca init --upgrade` delivers both new agent `.md` files (with `{{block:name}}` references) and `.block.md` files together — no partial state

### Breaking changes

- **Pipeline template agent overrides using replace mode** must add `{{block:name}}` references. All 6 builtin templates are updated in Task 5. Third-party templates need migration guidance.
- **PromptBuilder API changes** — `build()` is replaced by `build_context()`. Any code calling `prompt_builder.build(stage, iteration)` must be updated.
- **76+ tests** need rewriting to assert on context dicts instead of prompt strings.

### Verification

For each stage, verify the fully resolved agent document (after block insertion + placeholder resolution) contains all the information that the old system delivered across `--agent` + `-p`. The *format* will differ (single document vs two), but the *content* must be equivalent.

---

## 14. Acceptance Criteria

- [ ] Agent `.md` files contain `{{block:name}}` references at appropriate positions
- [ ] 10 `.block.md` files created with dynamic content extracted from `_build_*` methods
- [ ] `resolve_placeholders()` handles `{{name}}`, `{{name|default}}`, `{{#if}}...{{/if}}`, `{{#if}}...{{else}}...{{/if}}`
- [ ] `resolve_blocks()` handles `{{block:name}}` insertion, missing blocks (empty), recursive blocks, cycle detection
- [ ] `resolve_block()` returns `None` for missing blocks (no error)
- [ ] Three-tier overlay chain works for `.block.md` files (core → project → template)
- [ ] Pipeline templates can override blocks, introduce new blocks, or remove blocks via empty overrides
- [ ] All 6 builtin pipeline templates updated with `{{block:name}}` references (or switched to append mode)
- [ ] PromptBuilder refactored to context assembler — no prompt string assembly
- [ ] `-p` reduced to minimal work request
- [ ] `_STAGE_PROMPT_PREFIX` and `_build_stage_prompt()` deleted
- [ ] Learner analysis instructions moved to `learner.md`
- [ ] Implementer retry rules moved to `implementer.md`
- [ ] All existing tests pass (rewritten as needed)
- [ ] `worca init --upgrade` copies `.block.md` files
- [ ] Fully resolved agent document contains equivalent content to old `--agent` + `-p` combination
