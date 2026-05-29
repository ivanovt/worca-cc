# Instruction & Document Flow

How a request becomes per-stage agent prompts: where the **work request**, the
**guide**, and the **plan** come from, how they are transformed, which stage
receives which artifact, and how the review loops reshape them.

This is the consolidated, implementation-accurate reference (current as of W-060
+ W-061). It is the source for the eventual docs-site pages, so it errs on the
side of completeness; `file:line` anchors point at the authoritative code.

---

## 1. Mental model (read this first)

There are two distinct kinds of input, with two distinct lifecycles:

- **The work request** is the *lowest-authority intent*. It is the raw thing the
  user/issue asked for. It feeds the **Planner** (to author or revise the plan)
  and is shown as low-conflict reference to **plan-review / pr / learn**. It is
  **never** shown to the build stages (coordinate / implement / test / review).
- **The plan** is the *authoritative work artifact*. It is a run-scoped,
  append-only file. It flows **Planner → Plan Reviewer → Coordinator** (which
  decomposes it into beads) and is referenced (by path) by the **Implementer**.

The single most important sentence:

> **work request = intent (feeds planning); plan file = the authoritative spec
> (drives the build). The Coordinator decomposes the *full current plan*, not
> the raw request and not a summary of it.**

Authority, highest to lowest: **guide › plan › knowledge graph › description
(work request)**, with **accumulated design notes** below all of them.

```
                 ┌─────────────┐
  --guide ─────► │   guide     │ (normative, highest authority — overrides all)
                 └─────────────┘
                        │ injected into every stage's user message
                        ▼
 source ──► WorkRequest{title, description, plan_path?} ─┐
 (prompt/spec/                                           │
  gh issue/bead)                                         │
                                                         ▼
                 has plan_path?  ──no──►  PLANNER ──► plan-001.md
                        │                 (authors)        │
                       yes                                 │
                        ▼                                  │
                 ingest copy ──► plan-001.md ──────────────┤
                 (Planner skipped)                         │
                                                           ▼
                                                    PLAN REVIEW ──approve──┐
                                                       │   ▲               │
                                                  revise   │ (re-plan)     │
                                                       ▼   │               │
                                            PLANNER (revision) ──► plan-002.md, …
                                            (append-only; re-point)        │
                                                                           ▼
                                            COORDINATOR ◄── full current plan
                                            └─► beads (one task each)
                                                       │
                                                       ▼
                                            IMPLEMENTER (one bead + plan path)
                                                  │   ▲
                                             test/review loopbacks
                                                  ▼   │
                                            TESTER → REVIEWER → GUARDIAN(PR) → LEARN
```

---

## 2. Inputs

### 2.1 The work request

Every run normalizes its source into a `WorkRequest`
(`src/worca/orchestrator/work_request.py:99`):

| Field | Meaning |
|---|---|
| `source_type` | `prompt` \| `spec_file` \| `plan_file` \| `github_issue` \| `beads` |
| `title` | short label (used in branch names, PR titles, the `## Work Request` heading) |
| `description` | the body — the actual intent text |
| `source_ref` | the origin (`gh:42`, a path, `bd:ID`) |
| `plan_path` | a pre-existing plan, when the source carries one (see §2.3) |
| `guide_content` | populated by `attach_guide()` (see §2.2) — empty otherwise |

How `title`/`description` are derived, per source:

| Source | `title` | `description` |
|---|---|---|
| **prompt** (`--prompt`) | the text if ≤ 60 chars, else a smart title from a lightweight model (`haiku`), else first 60 chars | the full prompt text |
| **spec file** (`--spec`) | smart title → first `#` heading → filename | the file contents |
| **plan file** (`--plan`) | smart title → first `#` heading → filename | the file contents; `plan_path` = the file |
| **GitHub issue** (`--source gh:issue:N`) | the issue **title** | the issue **body, verbatim** (no summarization); `plan_path` = the `## Plan` blob link if present |
| **bead** (`--source bd:ID`) | from the bead | from the bead |

Code: `normalize_prompt` (`:141`), `normalize_spec_file` (`:154`),
`normalize_plan_file` (`:110`), `normalize_github_issue` (`:203`),
`normalize_beads_task` (`:233`); dispatch in `normalize()` (`:343`).

**Key consequence:** for a GitHub issue, `description` *is* the entire issue
body (Problem / Proposal / Design / Considerations / Decisions / Plan-link, all
of it). Pre-W-060 this raw body was injected into every stage; W-060 removed it
from the build stages (§5).

In a prompt, the work request appears via the `{{work_request}}` placeholder,
which resolves to **`**{title}**\n\n{description}`** — title and description
only, no heading (the block templates supply the `## Work Request` heading).
See `PromptBuilder._work_request_section()` (`prompt_builder.py:410`).

### 2.2 The guide (`--guide`, repeatable)

`attach_guide(wr, guide_paths)` (`work_request.py:279`) reads each guide file and
concatenates them under `### <filename>` subsections into `guide_content`. It is
the **highest-authority** input: a migration spec, RFC, or compliance doc that
**overrides everything else**.

- The body lives in `guide_content`; the **header and precedence wording live in
  the `.block.md` templates**, never in Python (enforced by
  `test_agent_md_refs.py::test_guide_header_not_in_python_source`).
- It is injected into **every** stage's user message via
  `{{#if has_guide}} … {{guide_content}} … {{/if}}`.
- Optional size cap: `worca.guide.max_bytes` (raises before the run if exceeded).

Authority order when a guide is present: **guide > plan > graph > description**.
Agents must treat a guide-vs-plan or guide-vs-description conflict as a defect in
the *lower-authority* source and surface it rather than silently resolving it.

### 2.3 The plan (provided vs generated)

A plan is "provided" when:

- `--plan <file>` is passed, **or**
- the source is a GitHub issue whose body contains a `## Plan` section with an
  absolute blob link to `docs/plans/W-NNN-*.md` — `_extract_plan_path()`
  (`work_request.py:182`) pulls it into `plan_path`.

When `plan_path`/`--plan` is set, the runner treats it as a pre-made plan: the
**PLAN stage is skipped** and the plan is **ingested** (§3). When no plan is
present, the **Planner authors one** from the work request.

---

## 3. The plan lifecycle (W-061): run-scoped, append-only

Plans live in the **run directory** as append-only numbered files:

```
.worca/runs/<run_id>/
  plan-001.md   ← the original: an ingested copy of a provided plan,
                  OR the Planner's first generated draft
  plan-002.md   ← first plan_review revision (a complete rewrite)
  plan-003.md   ← next revision / restart …
                  the highest number is always the CURRENT plan
```

- **Ingest (provided plan):** the supplied file is **copied** to
  `run_dir/plan-001.md`; `status.plan_file` points at the copy and
  `status.plan_source` records the original path. The original is **never
  mutated** — no source dirtying, no misleading `git diff`, no plan-doc edits
  leaking into the feature PR (`runner.py`, plan-file handling).
- **Generate (no plan):** the Planner writes `run_dir/plan-001.md`
  (`_next_plan_path()`, `runner.py:375`).
- **Revise (append-only):** on a `plan_review` revise, the runner mints the next
  number (`plan-00N+1.md`), threads the *current* plan content as the revision
  source, and **re-points** `status.plan_file` / `WORCA_PLAN_FILE` / `{{plan_file}}`
  forward. The Planner (restricted to `WORCA_PLAN_FILE`) writes the **complete**
  updated plan there; older revisions are immutable audit history
  (`runner.py`, the revise loopback).
- **Governance:** the `plan_check` hook gates source writes on `WORCA_PLAN_FILE`
  existence (path-agnostic — `claude_hooks`/`hooks/plan_check.py`), and the
  Planner may write *only* `WORCA_PLAN_FILE`.

The UI surfaces every revision: a per-iteration **View plan** button on the
planner and plan_review stages, plus a revision selector (`v1 · original` …
`vN · current`) in the plan dialog.

> Pre-W-061 a provided plan was referenced in place and a revision overwrote it,
> which dirtied the committed source and led the Coordinator to decompose a
> stale 2-task delta instead of the full plan. The numbered, run-scoped scheme
> fixes that.

---

## 4. The two entry flows

### Flow A — no plan (free-form prompt, or a GitHub issue with no `## Plan` link)

```
work_request ─► PLANNER (reads work_request + CLAUDE.md, explores, writes plan)
                  └─► run_dir/plan-001.md
                ─► [PLAN REVIEW?] ─► COORDINATE (decomposes the current plan)
```

### Flow B — plan provided (`--plan`, or a GitHub issue with a `## Plan` link)

```
plan source ─(ingest copy)─► run_dir/plan-001.md      (original left pristine)
work_request ─(still built; used by plan_review / pr / learn — NOT to plan)
PLANNER: skipped
                ─► [PLAN REVIEW?] ─► COORDINATE (decomposes the current plan)
```

In both flows, once a plan exists the rest is identical: optional plan-review
(with its revision loop), then the Coordinator decomposes the **current** plan.

---

## 5. Per-stage context — what each agent actually receives

Each stage prompt has two parts:

1. **System prompt** — the agent's role `.md` (e.g. `planner.md`), resolved and
   written to `run_dir/agents/resolved/<stage>-<agent>-iter-N.md`. Static role,
   rules, and how-to-use guidance (e.g. the knowledge-graph section). Carries no
   per-run payload.
2. **User message** — the stage's `.block.md`, resolved per iteration and stored
   at `status.stages.<stage>.prompt` (and in the per-iteration record). This is
   where the work request / guide / plan / task / artifacts are interpolated.

The table below is the user-message (block) content. ✓ = present, ✗ = absent.

| Stage (block) | work&nbsp;request | guide | plan | task/artifacts it carries |
|---|:--:|:--:|:--:|---|
| **plan** (initial) | ✓ | ✓ | — | CLAUDE.md context; writes `{{plan_file}}` |
| **plan** (revision) | ✓ | ✓ | `{{plan_content}}` (current plan) | review issues + review history; writes the **complete** new `{{plan_file}}` |
| **plan_review** | ✓ | ✓ | `{{plan_content}}` (the plan to review) | review-history convergence framing on revision rounds |
| **coordinate** | ✗ | ✓ | `{{current_plan}}` (**full** current plan) | unresolved-plan-issues (only if the review loop exhausted) |
| **implement** | ✗ | ✓ | `{{plan_file}}` (**path**, advisory) | `{{assigned_task}}` (the bead); accumulated design notes; on retry: test failures / review issues / previous attempts |
| **test** | ✗ | ✓ | — | `{{implementation_summary}}` |
| **review** | ✗ | ✓ | — | `{{test_results}}`, `{{files_changed_formatted}}` |
| **pr** | ✓ | ✓ | `{{plan_approach}}` | — |
| **learn** | ✓ | ✓ | `{{plan_content}}` | termination type/reason; run data; files-changed diff |

### 5.1 The keep-block / execution-block split (W-060)

The stages divide into two groups by how they treat the raw work request:

- **Keep-blocks — work request retained:** `plan`, `plan-review`, `pr`, `learn`.
  Here the request is the legitimate input (Planner authors from it; reviewer
  uses it as a coverage yardstick; PR body; learn goal-assessment). They wrap
  `{{work_request}}` under a `## Work Request` heading inside a
  `## Reference Guide … --- ## Task` envelope.
- **Execution-blocks — work request removed:** `coordinate`, `implement`,
  `test`, `review`. By the time these run, the Planner has *refined* the request
  into a plan and the Coordinator has decomposed it into beads. Re-injecting the
  raw request alongside the refined plan caused **false-positive loopbacks**
  ("doesn't match the original request"), so W-060 removed it. These blocks use a
  **standalone** guide section whose wording states the precedence ladder
  explicitly: *"the guide … outranks the plan, your assigned task, and the
  original description."*

> Note: the keep-blocks still carry the older guide-wrapper wording ("…bug in the
> task description") and the `## Task` divider; the execution-blocks use the
> newer standalone wording. The two forms are intentionally different (the
> execution stages have no `## Task` body to divide). Byte-identical-wording
> tests guard each form separately (`test_agent_md_refs.py`).

### 5.2 The plan, three ways

The plan reaches different stages in three different shapes — all derived from
the same run-scoped file, never from a stale summary:

- **`{{plan_content}}`** — the full plan text, for the stages that *read* the
  plan: `plan` (revision source), `plan_review` (the artifact under review),
  `learn`.
- **`{{current_plan}}`** — the full text of the **latest** plan file, for
  `coordinate` (W-061). Built in `PromptBuilder` from `plan_file_content` or by
  reading the current plan file — *not* from the Planner's structured
  `tasks_outline` (which is delta-scoped after a revision).
- **`{{plan_file}}`** — the **path** to the current approved plan, for
  `implement` (W-061): an advisory, read-on-demand reference for design context
  and file references, scope-guarded to the agent's one bead.

### 5.3 Beads — the Coordinator's output

The Coordinator decomposes `{{current_plan}}` into atomic **beads** (one
implementable task each), with descriptions, via `bd create` (and optional
`bd dep add`). Each bead is labelled `run:<run_id>`. The **Implementer** then
works **one bead at a time** — the bead (`{{assigned_task}}`) is its operative
directive; the `{{plan_file}}` path lets it consult the authoritative spec
without widening scope. Cross-bead decisions surface to siblings as
**accumulated design notes** (advisory, lowest authority).

### 5.4 Knowledge graph (advisory)

When graphify or code-review-graph is enabled, every block carries a one-line
**availability note** (`{{#if has_graphify}}` / `{{#if has_code_review_graph}}`)
and the how-to-use guidance lives in the agent's role `.md`. Agents **query the
graph on demand**; the report is never injected. The note sits **after** the
guide block to respect `guide > graph`.

---

## 6. Prompt assembly mechanism

- Templates live in `src/worca/agents/core/` and are copied to
  `.claude/worca/agents/core/` by `worca init`. The **role** is `<agent>.md`; the
  **dynamic user message** is `<stage>.block.md`.
- The **three-tier overlay** (core → project `.claude/agents/` → user) merges
  templates; placeholders (`{{var}}`, with `{{var|default}}`) and conditionals
  (`{{#if key}} … {{else}} … {{/if}}`) are resolved at dispatch time
  (`orchestrator/overlay.py`, `orchestrator/prompt_builder.py`).
- A conditional `{{#if key}}` is truthy when the context value is non-empty
  (works for booleans like `has_guide` and for strings like `current_plan` /
  `plan_file`).
- The runner threads inter-stage context into the `PromptBuilder`
  (`runner.py`): `work_request`, `guide_content`/`has_guide`, `plan_file`,
  `plan_content`/`plan_file_content`, `assigned_task`, `accumulated_design_notes`,
  `has_graphify`/`has_code_review_graph`, the per-stage artifacts
  (`implementation_summary`, `test_results`, `files_changed_formatted`,
  `plan_review_issues_formatted`, `unresolved_plan_issues_formatted`, …).
- The resolved system prompt → `agents/resolved/<stage>-<agent>-iter-N.md`; the
  resolved user message → `status.stages.<stage>.prompt`. Both are inspectable
  per iteration (the UI reads them).

---

## 7. How review reshapes the flow

### 7.1 Plan review → revision loop

`plan_review` returns a structured verdict (`outcome`: `approve` | `revise`):

- **approve** → proceed to `coordinate`.
- **revise** (critical/major issues, or an empty issue list — fail-closed) →
  loop back to `PLAN` in **revision mode**. The runner: appends the next
  numbered plan file, threads the current plan as the revision source, re-points
  `plan_file`, and re-enters PLAN. The Planner rewrites the **complete** plan
  into the new file; `plan_review` then re-reviews it (with convergence framing —
  "verify the prior issues are resolved, don't re-review from scratch").
- Bounded by `worca.loops.plan_review`. On **exhaustion**, the unresolved
  critical issues are **carried forward** to `coordinate` as
  `{{unresolved_plan_issues_formatted}}` so the Coordinator must account for each
  (create a bead or note it on an affected bead).

Because each `plan_review` iteration reviews exactly one plan revision in order,
**plan_review iteration K reviewed `plan-00K.md`** — the 1:1 mapping the UI uses
for its per-iteration View-plan buttons.

### 7.2 Implement ↔ test ↔ review loops

- **test failure** → the Implementer re-runs in retry mode (`{{#if is_retry}}`):
  the block leads with `## PRIORITY: Fix …` + `{{test_failures_formatted}}` and
  the assigned task/plan demoted to a "Reference … (already implemented)"
  footer. Bounded by `worca.loops.implement_test`.
- **review issues** → same retry mode with `{{review_issues_formatted}}`.
- `{{previous_attempts}}` accumulates failed attempts so the Implementer doesn't
  repeat them.

These loops never reintroduce the raw work request — they operate on the bead,
the plan (by path), and the concrete failures.

---

## 8. Fleet & workspace propagation

- **Fleet runs** fan one work request (and optional `--guide`, `--plan`) to N
  independent projects; each child is a standard worktree run, so all of the
  above applies per child.
- **Workspace runs** decompose one prompt into per-project sub-plans via a
  master planner, execute in DAG order, and inject upstream context between
  tiers; each child run still ingests its plan and follows the per-stage flow
  above. See `docs/fleet-runs.md` and `docs/workspace-runs.md`.

---

## 9. Quick reference

**Authority ladder:** guide › plan › knowledge graph › description (work
request) › accumulated design notes.

**Who sees the raw work request:** planner, plan_review, pr, learn (keep-blocks).
**Who does not:** coordinate, implement, test, review (execution-blocks, W-060).

**Who sees the plan, and how:**
- full text: plan (revision), plan_review, learn (`{{plan_content}}`); coordinate
  (`{{current_plan}}`).
- by path: implement (`{{plan_file}}`).

**Where the plan lives:** `.worca/runs/<id>/plan-NNN.md`, append-only, latest =
current; `status.plan_file` points at the latest, `status.plan_source` records a
provided plan's original path.

**Where to inspect a stage's actual prompt:** system prompt at
`run_dir/agents/resolved/<stage>-<agent>-iter-N.md`; user message at
`status.stages.<stage>.prompt`.

**Related references:** `docs/design-principles.md` (rationale),
`docs/governance.md` (write carve-outs / dispatch), `docs/effort.md`,
`docs/events.md`; the per-stage block templates in
`src/worca/agents/core/*.block.md`.
