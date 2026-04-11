# W-005: Agent Memory & Context Sharing


**Goal:** Give every pipeline stage a durable, human-readable view of accumulated decisions, rationale, failures, and artifacts from all prior stages. Loop-backs (test failure → implement retry, review changes → implement retry) automatically inject the failure context so the retrying agent understands exactly what went wrong and why. Crucially, the context survives pause/resume — a resumed pipeline picks up the full history without loss.

**Architecture:** A new `ContextManager` class owns one Markdown file per run at `.worca/runs/{run_id}/context.md`. This file is the **primary and sole vehicle** for accumulated cross-stage context. The `runner.py` creates the file at run start, passes a `ContextManager` instance through the pipeline loop, and calls `append_stage_entry()` after each stage completes. `PromptBuilder` reads the file via `ContextManager.build_prompt_section()` and injects a `## Shared Run Context` section into every agent prompt. On resume, `PromptBuilder` starts with an empty `_context` dict, but the context file on disk preserves the full run history — this is the key advantage over in-memory accumulation.

**Design decision — file as primary context source:** The existing `prompt_builder._context` dict accumulates stage results in memory, but this state is lost on pause/resume (a fresh `PromptBuilder` is created). Rather than serializing the dict to disk (reinventing the file with worse readability) or reconstructing from `status.json` (which lacks rationale, decisions, and failure details), the context file serves as both the persistence layer and the richer accumulator. Agents receive context exclusively via `PromptBuilder`'s prompt injection — they do not read the file directly via tool calls. The `{context_file}` template variable in agent `.md` files is removed; agents rely on the `## Shared Run Context` section that `PromptBuilder` injects into their prompts.

**Tech Stack:** Python stdlib only (no new dependencies). Markdown for the context file format. Touches `runner.py`, `prompt_builder.py`, and all five agent `.md` files.

**Depends on:** Nothing. This is a standalone enhancement to the existing pipeline.

---

## 1. Scope and Boundaries

### In scope

- `ContextManager` class in `src/worca/orchestrator/context_manager.py`
- Context file format: `.worca/runs/{run_id}/context.md` (one file per run)
- Runner creates the file on fresh start; on resume, `ContextManager` opens the existing file and `PromptBuilder` reads accumulated history from it — this is the primary mechanism for restoring cross-stage context after pause/resume
- Each pipeline stage appends a structured entry on completion
- Loop-back stages (implement retry on test failure, implement retry on review changes) inject the failure/feedback entry into the prompt
- `PromptBuilder` gains a `set_context_manager()` method and injects a `## Shared Run Context` section into every stage prompt by reading the file via `ContextManager.build_prompt_section()`
- Size limit: 8,000 character safety cap (rarely hit with design-only content); truncation from start when building prompt section
- Unit tests for `ContextManager`: create, append, read, truncation

### Out of scope

- Cross-run memory (context does not persist between runs)
- Vector embedding or semantic search of past decisions
- UI display of the context file (worca-ui reads status.json only)
- Sharing context between parallel implementers (W-002 is a separate feature)
- Modifying the JSON output schemas (`plan.json`, `implement.json`, etc.)

---

## 2. Context File Format

The context file is a Markdown document with a fixed header and one fenced section per stage completion. This makes it readable by humans and straightforwardly parseable by agents as plain text.

### 2.1 File location

```
.worca/runs/{run_id}/context.md
```

The file is created when `run_pipeline()` sets up the run directory. On resume, the existing file is left intact — `ContextManager` opens it in append mode.

### 2.2 Document structure

The context file records **design decisions only** — not implementation details, test results, or per-bead progress. This keeps the file small and stable even with 30+ beads and multiple retry cycles. Implementation tracking (files changed, test pass/fail, beads completed) stays in `status.json` and `PromptBuilder._context` where it belongs.

```markdown
# Run Context

**Run:** 20260310-143022
**Request:** Add user authentication
**Branch:** worca/add-user-authentication-4Xp

---

## Plan

Implement JWT-based auth with a /api/auth/login endpoint.
Use the existing Express middleware pattern. No external auth library.

**Decisions:**
- JWT over sessions: stateless, fits current API pattern
- Token expiry: 24h access, 7d refresh in HttpOnly cookie
- New file server/auth.js; register route in server/app.js

---

## Decomposition

3 tasks, sequential: auth module → route wiring → tests.
Auth module is self-contained; route wiring depends on it; tests depend on both.

---

## Guardian Feedback (iter 1)

**Rejected:** auth middleware does not validate token audience claim.
Add `aud` check to prevent cross-service token reuse.

---
```

**What gets written and when:**

| Event | Written? | Content |
|-------|----------|---------|
| Plan approved | Yes | Approach, key decisions, constraints, trade-offs |
| Coordinate completes | Yes | Decomposition rationale, dependency logic |
| Implement completes | **No** | Implementation details tracked in status.json |
| Test pass/fail | **No** | Test results tracked in PromptBuilder._context |
| Guardian rejects | Yes | Design-level feedback — what to change and why |
| Guardian approves | No | Nothing design-relevant to record |
| Review raises design issues | Yes | Only design-level issues (pattern violations, architectural concerns) |

This means the file typically has 2-3 sections (plan + decomposition + maybe guardian feedback), regardless of how many beads or retry cycles the run goes through.

### 2.3 Section schema

Each section uses a simple `## Title` header followed by freeform Markdown. No timestamps, iteration numbers, or structured metadata in headers — the chronological order is implicit from file position.

### 2.4 Size limit

With design-decisions-only content, the file will rarely exceed a few hundred characters. The **8,000 character** limit is a safety net, not an expected constraint. If exceeded (e.g., multiple guardian rejections with lengthy feedback), `ContextManager` truncates from the start when building the prompt section, preserving the most recent decisions.

---

## 3. ContextManager Class

### 3.1 Module location

`src/worca/orchestrator/context_manager.py`

### 3.2 Public API

```python
class ContextManager:
    MAX_CHARS = 8_000

    def __init__(self, context_path: str):
        """
        Args:
            context_path: Absolute or relative path to the context.md file.
                          File need not exist yet; create() initialises it.
        """

    def create(self, run_id: str, title: str, branch: str) -> None:
        """Write the file header. Overwrites any existing file.
        Called once at the start of a fresh run."""

    def append_section(self, heading: str, body: str) -> None:
        """Append a new ## section to the context file."""

    def read_full(self) -> str:
        """Return the full content of the context file, or '' if it does not exist."""

    def build_prompt_section(self, max_chars: int = 4_000) -> str:
        """Return content suitable for injection into an agent prompt.
        Truncates from the start (most recent content preserved)
        with a leading note if truncated."""
```

`ContextManager` does not know about stage semantics — it accepts any heading and Markdown body. `runner.py` decides *when* to write and *what* to write.

---

## 4. Integration with runner.py

### 4.1 Initialization at run start

After the run directory is created and `status["run_id"]` is set, create the context file:

```python
from worca.orchestrator.context_manager import ContextManager

context_file = os.path.join(run_dir, "context.md")
ctx = ContextManager(context_file)
if not resume_stage:
    ctx.create(
        run_id=status["run_id"],
        title=work_request.title,
        branch=branch_name,
    )
# else: resume — context.md already exists, ContextManager will append
```

### 4.2 PromptBuilder wiring

After creating `prompt_builder`, call:

```python
prompt_builder.set_context_manager(ctx)
```

### 4.3 Design-decision appends

Only design-relevant events write to the context file. This happens in three places:

**After PLAN is approved:**

```python
ctx.append_section("Plan", plan_design_summary)
```

Where `plan_design_summary` is built from `result["approach"]` and `result["key_decisions"]` — the design rationale, not the task list.

**After COORDINATE completes:**

```python
ctx.append_section("Decomposition", decomposition_rationale)
```

Where `decomposition_rationale` summarizes the dependency logic and grouping rationale, not the bead IDs.

**After GUARDIAN rejects:**

```python
ctx.append_section(
    f"Guardian Feedback (iter {iter_num})",
    guardian_design_feedback,
)
```

Where `guardian_design_feedback` captures what design-level change the guardian requires. Only written on rejection — approvals don't add design context.

Implement, test, and PR stages do **not** write to the context file. Their operational details (files changed, test results, beads completed) remain in `status.json` and `PromptBuilder._context`.

### 4.4 Loop-back context

Test failures and implementation details continue to flow through the existing `PromptBuilder._context` mechanism (`update_context("test_failures", ...)`). The context file is not involved in the implement↔test retry loop — those are operational details, not design decisions.

On resume after a pause, the `_context` dict is empty but `runner.py` already reconstructs test failure context from `status.json`. The context file preserves only the design decisions that `status.json` does not carry (approach, trade-offs, guardian feedback).

---

## 5. PromptBuilder Changes

### 5.1 New method: `set_context_manager()`

```python
def set_context_manager(self, ctx) -> None:
    """Attach a ContextManager. When set, build() injects context into prompts."""
    self._ctx = ctx
```

Add `self._ctx = None` to `__init__`.

### 5.2 New method: `_context_section()`

```python
def _context_section(self) -> str:
    """Return a ## Shared Run Context section for injection into prompts.
    Returns '' if no ContextManager is attached or context file is empty."""
    if not self._ctx:
        return ""
    snippet = self._ctx.build_prompt_section(max_chars=4_000)
    if not snippet:
        return ""
    return f"## Shared Run Context\n\n{snippet}"
```

### 5.3 Injection into each stage builder

Each `_build_{stage}()` method appends `self._context_section()` to its `parts` list before joining. The section is always appended last so the work-request and structured data appear first (agents read top-to-bottom).

Example diff for `_build_plan`:

```python
def _build_plan(self, iteration: int) -> str:
    parts = [
        "Create a detailed implementation plan ...",
        ...
        self._work_request_section(),
    ]
    if self._claude_md_content:
        parts.append(f"## Project Context (from CLAUDE.md)\n\n{self._claude_md_content}")
    context_section = self._context_section()   # new
    if context_section:                          # new
        parts.append(context_section)            # new
    return "\n\n".join(parts)
```

Apply the same three-line addition to `_build_coordinate`, `_build_implement`, `_build_test`, `_build_review`, and `_build_pr`.

For `_build_plan` specifically, the context file will be empty on the first run (it was just created). On a `restart_planning` loop, the context file will contain all prior stage entries — this is intentional and valuable: the planner can see what the guardian objected to.

---

## 6. Agent Prompt Template Changes

Agents receive context exclusively through `PromptBuilder`'s `## Shared Run Context` prompt injection — they do **not** read the context file directly via tool calls. This avoids the dual-channel problem (stale file reads vs. fresh prompt content) and keeps agent templates simple.

No `{context_file}` template variable is added. No changes to `_render_agent_templates` are needed.

The five agent `.md` files in `src/worca/agents/core/` receive a single addition each: a note in their **Context** section explaining that shared run context is injected into their prompt automatically.

### 6.1 planner.md

Add to the **Context** section:

```markdown
If this is a restart (e.g., after a guardian rejection), your prompt includes a `## Shared Run Context` section with prior stage decisions, rationale, and feedback. Use it to understand what was tried before and why it was rejected.
```

### 6.2 coordinator.md

Add to the **Context** section:

```markdown
Your prompt includes a `## Shared Run Context` section with the planner's approach and key decisions. Use it to inform your task decomposition.
```

### 6.3 implementer.md

Add to the **Context** section:

```markdown
Your prompt includes a `## Shared Run Context` section with the plan's design decisions and decomposition rationale. Use it to understand the architectural intent behind your assigned task.
```

### 6.4 tester.md

Add to the **Context** section:

```markdown
Your prompt includes a `## Shared Run Context` section with design decisions and constraints. Use it to understand the architectural intent when evaluating test coverage.
```

### 6.5 guardian.md

Add to the **Context** section:

```markdown
Your prompt includes a `## Shared Run Context` section with the plan's design decisions, decomposition rationale, and any prior guardian feedback. Review it before forming a judgment.
```

---

## 7. Implementation Tasks

Tasks are ordered so that each step is independently testable and no task depends on a later one.

---

### Task 1: Create `context_manager.py`

**File:**
- Create: `src/worca/orchestrator/context_manager.py`

Implement the `ContextManager` class with the public API described in Section 3.

**Implementation details:**

`create(run_id, title, branch)`:
- Build the header block as shown in Section 2.2.
- Write the file with `open(self._path, 'w')`.

`append_section(heading, body)`:
- Append `\n---\n\n## {heading}\n\n{body}\n` to the file using `open(self._path, 'a')`.

`read_full()`:
- `open(self._path)` and return content. Return `''` if `FileNotFoundError`.

`build_prompt_section(max_chars=4_000)`:
- Call `read_full()`.
- If content is empty, return `''`.
- If `len(content) <= max_chars`, return content.
- Otherwise, return the last `max_chars` characters prefixed with:
  `"[Context truncated — showing most recent {max_chars} characters]\n\n"`.

---

### Task 2: Add unit tests for `ContextManager`

**File:**
- Create: `tests/test_context_manager.py`

**Test cases:**

`test_create_writes_header`: Call `create()`, read the file, assert header contains run_id, title, branch.

`test_append_section`: Call `create()`, then `append_section("Plan", "some body")`. Read the file. Assert `## Plan` heading and body are present.

`test_append_multiple_sections_ordered`: Append Plan, Decomposition sections. Assert they appear in order in the file.

`test_build_prompt_section_under_limit`: Create a context file under `max_chars`. Assert `build_prompt_section()` returns the full content.

`test_build_prompt_section_truncates`: Create a context file over `max_chars`. Assert `build_prompt_section(max_chars=100)` returns only the last 100 chars plus the truncation prefix.

`test_read_full_nonexistent_returns_empty`: Call `read_full()` on a non-existent path. Assert returns `''`.

`test_create_overwrites_existing`: Write a file, call `create()` again with a different run_id. Assert the old content is gone.

All tests use `tmp_path` from pytest fixtures. No mocking needed — `ContextManager` only touches the filesystem.

---

### Task 3: Update `PromptBuilder` to inject context

**File:**
- Modify: `src/worca/orchestrator/prompt_builder.py`

**Changes:**

1. Add `self._ctx = None` in `__init__`.

2. Add `set_context_manager(self, ctx) -> None` method (sets `self._ctx`).

3. Add `_context_section(self) -> str` method (calls `self._ctx.build_prompt_section(max_chars=4_000)` if `self._ctx` is set, wraps in `## Shared Run Context` header, returns `''` if empty).

4. In each of the six `_build_{stage}()` methods, append `self._context_section()` to `parts` before the final `return "\n\n".join(parts)`. Use `if context_section: parts.append(context_section)` pattern to avoid empty sections.

---

### Task 4: Add unit tests for `PromptBuilder` context injection

**File:**
- Modify: `tests/test_prompt_builder.py` (extend existing test file)

**Test cases:**

`test_build_plan_without_context_manager`: Existing tests should still pass unchanged — verify `set_context_manager` was not called, `build()` returns no `## Shared Run Context` section.

`test_build_plan_with_empty_context`: Attach a `ContextManager` pointing to a nonexistent file. Assert the built prompt has no `## Shared Run Context` section.

`test_build_plan_with_context`: Create a temp context file with one stage entry. Attach a `ContextManager`. Call `build("plan", 0)`. Assert the prompt contains `## Shared Run Context` and the stage entry text.

`test_build_implement_with_context`: Same but for the implement stage.

`test_build_test_with_context`: Same but for the test stage.

`test_context_section_truncates_large_context`: Create a context file with 10,000 characters. Attach `ContextManager`. Call `build("implement", 0)`. Assert the `## Shared Run Context` section is present but truncated.

---

### Task 5: Wire `ContextManager` into `runner.py`

**File:**
- Modify: `src/worca/orchestrator/runner.py`

**Changes:**

1. Import `ContextManager` and initialize as described in Section 4.1.
2. Wire into `PromptBuilder` as described in Section 4.2.
3. Add `ctx.append_section()` calls after PLAN approval, COORDINATE completion, and GUARDIAN rejection as described in Section 4.3.

Only three append points — implement, test, and PR stages do not write to the context file.

---

### Task 6: Update agent `.md` templates

**Files:**
- Modify: `src/worca/agents/core/planner.md`
- Modify: `src/worca/agents/core/coordinator.md`
- Modify: `src/worca/agents/core/implementer.md`
- Modify: `src/worca/agents/core/tester.md`
- Modify: `src/worca/agents/core/guardian.md`

Apply the additions described in Section 6 to each file. Agents receive context exclusively through `PromptBuilder`'s `## Shared Run Context` prompt injection — no `{context_file}` template variable, no tool-call-based reading. Each agent's **Context** section gets a note explaining what the injected context contains and when it is present.

No changes to agent **Process** sections are needed — agents do not need to perform any action to receive the context (it is injected into their prompt automatically).

---

### Task 7: Integration test — full pipeline with context file

**File:**
- Create: `tests/test_runner_context.py`

This test runs a trimmed mock pipeline through `run_pipeline()` with all agents mocked to return minimal valid structured outputs. It verifies:

1. The context file is created at the expected path.
2. After the PLAN stage, the context file contains a `## Plan` section with design decisions.
3. After the COORDINATE stage, the context file contains a `## Decomposition` section.
4. After a simulated GUARDIAN rejection, the context file contains a `## Guardian Feedback` section.
5. The rendered prompt for the next stage contains `## Shared Run Context` with the accumulated design decisions.
6. On resume (`resume=True`), the context file is not overwritten — the existing design context is preserved and injected into prompts.
7. After 30+ implement/test cycles, the context file has **not** grown — only the initial plan/decomposition sections exist.

**Setup approach:**

- Use `unittest.mock.patch` to mock `run_agent` in `runner.py` so no actual Claude CLI calls are made.
- Return minimal valid structured outputs for each stage: `{"approved": True, "approach": "test approach", "tasks_outline": []}` for plan, etc.
- Simulate test failure on first TEST call by returning `{"passed": False, "failures": [{"test_name": "t1", "error": "oops"}]}`, then pass on second.
- Use `tmp_path` (pytest) for all file system paths.

---

## 8. File Summary

### New files

| File | Purpose |
|------|---------|
| `src/worca/orchestrator/context_manager.py` | `ContextManager` class: create, append, compact, read |
| `tests/test_context_manager.py` | Unit tests for `ContextManager` |
| `tests/test_runner_context.py` | Integration test: full pipeline with context file verification |

### Modified files

| File | Changes |
|------|---------|
| `src/worca/orchestrator/prompt_builder.py` | Add `set_context_manager()`, `_context_section()`, inject context in all 6 `_build_*` methods |
| `src/worca/orchestrator/runner.py` | Import `ContextManager`, create/resume context file, pass to `PromptBuilder`, append entries after each stage |
| `src/worca/agents/core/planner.md` | Add note about injected `## Shared Run Context` section |
| `src/worca/agents/core/coordinator.md` | Add note about injected `## Shared Run Context` section |
| `src/worca/agents/core/implementer.md` | Add note about injected `## Shared Run Context` section |
| `src/worca/agents/core/tester.md` | Add note about injected `## Shared Run Context` section |
| `src/worca/agents/core/guardian.md` | Add note about injected `## Shared Run Context` section |
| `tests/test_prompt_builder.py` | Add context injection tests |

---

## 9. Rollout Order

Tasks should be implemented in this order. Each task is independently testable before proceeding.

1. **Task 1** (`context_manager.py`) — simple class, no dependencies
2. **Task 2** (unit tests for `ContextManager`) — validates Task 1
3. **Task 3** (`PromptBuilder` changes) — depends on Task 1
4. **Task 4** (unit tests for `PromptBuilder`) — validates Task 3
5. **Task 5** (`runner.py` wiring) — depends on Tasks 1 and 3; only 3 append points
6. **Task 6** (agent `.md` templates) — independent, can run in parallel with Tasks 3-5
7. **Task 7** (integration test) — depends on Tasks 1, 3, 5; confirms resume and design-only scoping

---

## 10. Acceptance Criteria

- [ ] A file `.worca/runs/{run_id}/context.md` is created for every fresh pipeline run.
- [ ] The context file contains design-decision sections only: Plan, Decomposition, and Guardian Feedback (on rejection). No implement, test, or PR sections.
- [ ] Every agent prompt includes a `## Shared Run Context` section with the accumulated design decisions.
- [ ] On pipeline resume, the context file is not overwritten; `PromptBuilder` reads the existing file and injects design decisions into prompts — no context lost across pause/resume.
- [ ] The context file stays small regardless of bead count or retry cycles (only plan/decomposition/guardian-feedback write to it).
- [ ] `build_prompt_section(max_chars=4_000)` never returns more than 4,000 characters.
- [ ] All five agent `.md` templates document the `## Shared Run Context` prompt injection in their Context section.
- [ ] Agents do **not** read the context file directly — context is delivered exclusively via `PromptBuilder` prompt injection.
- [ ] All unit tests in `tests/test_context_manager.py` pass.
- [ ] All new tests in `tests/test_prompt_builder.py` pass without breaking existing tests.
- [ ] The integration test in `tests/test_runner_context.py` passes including the resume scenario.
- [ ] No new Python package dependencies are introduced.
- [ ] The existing `tests/` suite continues to pass with no regressions.
