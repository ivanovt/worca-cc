# Instruction & Document Flow

This document explains how the things you hand to a pipeline run — a request, an
optional guide, an optional plan — are turned into the concrete prompts each
agent receives, stage by stage. It covers where every input comes from, how it
is transformed, which stage sees which artifact, and how the review loops
reshape what flows downstream.

It is the implementation-accurate reference; `file:line` anchors point at the
authoritative code, and it is the source for the user-facing docs site.

---

## 1. What goes into a pipeline run

A run is fed a small, fixed set of inputs. Everything an agent ever sees is
derived from these:

- **The work request** — *what* you want done, expressed as intent rather than a
  finished design. It is normalized from one of several sources:
  - a free-form **prompt** (`--prompt`),
  - a **spec file** (`--spec`),
  - a **plan file** (`--plan`),
  - a **GitHub issue** (`--source gh:issue:N`),
  - a **bead** / tracked task (`--source bd:ID`).
- **A reference guide** (optional, `--guide`, repeatable) — a normative document
  such as a migration spec, RFC, or compliance requirement. When present it is
  the **highest-authority** input and overrides everything else.
- **A pre-written plan** (optional) — supplied directly with `--plan`, or
  discovered from a GitHub issue whose body links a plan file. When a plan is
  provided, the run uses it instead of authoring a new one.
- **Project context** — the repository's `CLAUDE.md` (tech stack, conventions,
  test commands), read by the planning stages.
- **A code knowledge graph** (optional) — an advisory, queryable map of the
  codebase that agents consult on demand for orientation.

Two of these have fundamentally different roles, and keeping them straight is
the key to the whole model:

> **The work request is *intent*** — the lowest-authority description of the
> goal. It drives **planning** and is shown to a few late stages as reference,
> but it never reaches the stages that build code.
>
> **The plan is the *authoritative work artifact*** — the spec the build is
> derived from. It flows through planning into the **Coordinator**, which breaks
> it into tasks, and is then the source of truth for every implementer.

Authority, highest to lowest: **guide › plan › knowledge graph › description
(the work request)**, with **accumulated design notes** below all of them.

---

## 2. How the inputs are transformed (the journey)

At a high level, a run is a funnel: several possible sources collapse into a
single work request, that work request produces (or adopts) a plan, the plan is
refined and then decomposed into tasks, and those tasks are built, verified, and
shipped. The guide, if any, rides alongside the entire way as the top authority.

**Normalization.** Whatever you pass — a prompt, a file, an issue, a bead — is
first reduced to a common shape: a *work request* with a short title and a body.
A GitHub issue, for example, becomes a work request whose title is the issue
title and whose body is the issue text verbatim; a free-form prompt becomes a
work request whose body is the prompt and whose title is a short generated
summary. If you attached a guide, its contents are collected and carried along
on the work request as separate, clearly-marked normative material.

**Getting to a plan.** The pipeline always works from a plan. There are two ways
to obtain one. If you provided a plan (directly, or via an issue's plan link),
the run **ingests a copy of it** and skips planning entirely. If you did not,
the **Planner** reads the work request and the project context, explores the
codebase, and **authors** a plan. Either way, the plan becomes a run-owned file
that the rest of the pipeline treats as the source of truth.

**Refining the plan.** When plan review is enabled, the **Plan Reviewer** reads
the plan and either approves it or sends it back for revision. A revision does
not edit the plan in place; instead the Planner writes a **new, complete version
of the plan**, and the pipeline keeps every version as an append-only history.
This loop repeats, bounded by a configurable limit, until the plan is approved
(or the limit is reached, in which case the remaining concerns are forwarded to
the next stage so they are not silently dropped).

**Decomposition and build.** The **Coordinator** takes the *current* (latest)
plan and decomposes it into atomic **beads** — small, independently
implementable tasks, each with its own description. The **Implementer** then
works one bead at a time. The **Tester** runs the suite and the **Reviewer**
checks the result; a failure on either sends the implementer back to fix that
specific bead. Once the work passes, the **Guardian** commits and opens the PR,
and an optional **Learner** stage writes a post-mortem.

**What each stage is *and isn't* told.** The guide reaches every stage. The plan
reaches the stages that need it — the reviewer and coordinator read it in full,
the implementer gets a pointer to it. The raw work request, by contrast, is only
shown to the stages where it is genuinely useful and low-conflict: the Planner
(which authors from it), the Plan Reviewer (which checks the plan against it),
and the PR and Learner stages. It is deliberately **withheld from the build
stages** (coordinate, implement, test, review): by the time they run, the
request has already been refined into a plan and decomposed into beads, and
showing the agents the original wording alongside the refined plan caused them
to treat two sources as authoritative and loop work back on phantom mismatches.

```
                 ┌─────────────┐
  --guide ─────► │   guide     │ (normative, highest authority — overrides all)
                 └─────────────┘
                        │ injected into every stage's user message
                        ▼
 source ──► work request {title, body, plan link?} ─┐
 (prompt / spec /                                    │
  gh issue / bead)                                   │
                                                     ▼
                 plan provided?  ──no──►  PLANNER ──► plan (v1)
                        │                 (authors)        │
                       yes                                 │
                        ▼                                  │
                 ingest copy ──► plan (v1) ────────────────┤
                 (Planner skipped)                         │
                                                           ▼
                                                    PLAN REVIEW ──approve──┐
                                                       │   ▲               │
                                                  revise   │ (re-plan)     │
                                                       ▼   │               │
                                            PLANNER (revision) ──► plan (v2, …)
                                            (append-only; latest = current)  │
                                                                             ▼
                                            COORDINATOR ◄── full current plan
                                            └─► beads (one task each)
                                                       │
                                                       ▼
                                            IMPLEMENTER (one bead + plan pointer)
                                                  │   ▲
                                             test / review loopbacks
                                                  ▼   │
                                            TESTER → REVIEWER → GUARDIAN (PR) → LEARN
```

The rest of this document fills in the details.

---

## 3. The inputs in detail

### 3.1 The work request

Every run normalizes its source into a `WorkRequest`
(`src/worca/orchestrator/work_request.py:99`):

| Field | Meaning |
|---|---|
| `source_type` | `prompt` \| `spec_file` \| `plan_file` \| `github_issue` \| `beads` |
| `title` | short label (used in branch names, PR titles, the `## Work Request` heading) |
| `description` | the body — the actual intent text |
| `source_ref` | the origin (`gh:42`, a path, `bd:ID`) |
| `plan_path` | a pre-existing plan, when the source carries one (see §3.3) |
| `guide_content` | the collected guide text (see §3.2); empty when no guide |

How `title` and `description` are derived, per source:

| Source | `title` | `description` |
|---|---|---|
| **prompt** | the text if ≤ 60 chars, else a short title from a lightweight model, else the first 60 chars | the full prompt text |
| **spec file** | smart title → first `#` heading → filename | the file contents |
| **plan file** | smart title → first `#` heading → filename | the file contents (and `plan_path` = the file) |
| **GitHub issue** | the issue title | the issue body, **verbatim** (no summarization); `plan_path` = the linked plan file, if the body has one |
| **bead** | from the bead | from the bead |

Code: `normalize_prompt` (`:141`), `normalize_spec_file` (`:154`),
`normalize_plan_file` (`:110`), `normalize_github_issue` (`:203`),
`normalize_beads_task` (`:233`); dispatched by `normalize()` (`:343`).

In a prompt the work request appears via the `{{work_request}}` placeholder,
which resolves to **`**{title}**` followed by the `{description}`** — title and
body only, with no heading (the templates supply the `## Work Request` heading).
See `PromptBuilder._work_request_section()` (`prompt_builder.py:410`).

> A practical consequence for GitHub issues: the `description` is the *entire*
> issue body (problem, proposal, design, considerations, decisions, plan link —
> all of it). That is exactly why it is kept out of the build stages (§6.1).

### 3.2 The reference guide

`attach_guide(wr, guide_paths)` (`work_request.py:279`) reads each guide file and
concatenates them under `### <filename>` subsections into `guide_content`. The
guide is the **highest-authority** input.

- The body lives in `guide_content`; the **header and precedence wording live in
  the templates**, never in Python code (enforced by
  `test_agent_md_refs.py::test_guide_header_not_in_python_source`).
- It is injected into **every** stage's user message via
  `{{#if has_guide}} … {{guide_content}} … {{/if}}`.
- An optional size cap, `worca.guide.max_bytes`, fails the run before it starts
  if the combined guide is too large.

When a guide is present, agents must treat a guide-vs-plan or guide-vs-request
conflict as a defect in the *lower-authority* source and surface it rather than
silently resolving it.

### 3.3 The plan: provided vs generated

A plan is **provided** when either `--plan <file>` is passed, or the source is a
GitHub issue whose body contains a `## Plan` section linking an absolute blob URL
to a plan file — `_extract_plan_path()` (`work_request.py:182`) pulls it into
`plan_path`. A provided plan causes the **Planner stage to be skipped** and the
plan to be **ingested** (§4).

When no plan is provided, the **Planner authors one** from the work request and
the project context.

---

## 4. The plan lifecycle: run-scoped and append-only

Plans live in the **run directory** as append-only, numbered files. The
highest-numbered file is always the current plan:

```
.worca/runs/<run_id>/
  plan-001.md   ← the original: an ingested copy of a provided plan,
                  or the Planner's first generated draft
  plan-002.md   ← first revision (a complete rewrite)
  plan-003.md   ← next revision / restart …
```

- **Ingest (provided plan):** the supplied file is **copied** to
  `plan-001.md`. `status.plan_file` points at the copy and `status.plan_source`
  records the original path. The original file is **never modified** during the
  run — so a provided plan's source stays clean, no spurious working-tree diff
  appears, and plan edits cannot leak into the feature PR.
- **Generate (no plan):** the Planner writes `plan-001.md`
  (`_next_plan_path()`, `runner.py:375`).
- **Revise (append-only):** when the Plan Reviewer requests changes, the runner
  mints the next number (`plan-002.md`, …), hands the Planner the *current* plan
  as the basis, and **re-points** `status.plan_file` / `WORCA_PLAN_FILE` /
  `{{plan_file}}` to the new file. The Planner writes a **complete** updated plan
  there; earlier versions remain as immutable audit history.
- **Governance:** the plan-check hook permits source writes only once an approved
  plan file exists, and the Planner may write *only* the current plan file.

The UI surfaces the history: a per-iteration **View plan** button on the planner
and plan-review stages, plus a revision selector (`v1 · original` …
`vN · current`) in the plan dialog.

---

## 5. The two entry flows

**No plan provided** (a free-form prompt, or a GitHub issue without a plan link):

```
work request ─► PLANNER (reads the request + CLAUDE.md, explores, writes plan)
                  └─► plan-001.md
                ─► [PLAN REVIEW?] ─► COORDINATE (decomposes the current plan)
```

**Plan provided** (`--plan`, or a GitHub issue with a plan link):

```
plan source ─(ingest copy)─► plan-001.md          (original left untouched)
work request ─(still built; used by plan-review / pr / learn — not to plan)
PLANNER: skipped
                ─► [PLAN REVIEW?] ─► COORDINATE (decomposes the current plan)
```

Once a plan exists, the two flows are identical: optional plan review (with its
revision loop), then decomposition of the **current** plan.

---

## 6. Per-stage context: what each agent receives

Each stage's prompt has two parts:

1. **System prompt** — the agent's role template (e.g. `planner.md`), resolved
   and written to `run_dir/agents/resolved/<stage>-<agent>-iter-N.md`. This is
   the static role, rules, and how-to-use guidance; it carries no per-run
   payload.
2. **User message** — the stage's block template (`<stage>.block.md`), resolved
   per iteration and stored at `status.stages.<stage>.prompt`. This is where the
   work request, guide, plan, task, and artifacts are interpolated.

The table below describes the **user message** for each stage (✓ present,
✗ absent):

| Stage | work&nbsp;request | guide | plan | other artifacts it carries |
|---|:--:|:--:|:--:|---|
| **plan** (initial) | ✓ | ✓ | — | `CLAUDE.md` project context; writes the plan file |
| **plan** (revision) | ✓ | ✓ | full text (the current plan) | review issues + review history; writes the complete new plan file |
| **plan_review** | ✓ | ✓ | full text (the plan under review) | convergence framing on revision rounds |
| **coordinate** | ✗ | ✓ | full text (the current plan) | unresolved-plan concerns (only if the review loop was exhausted) |
| **implement** | ✗ | ✓ | **pointer** (path to the current plan) | the assigned bead; accumulated design notes; on retry: test failures / review issues / previous attempts |
| **test** | ✗ | ✓ | — | the implementation summary |
| **review** | ✗ | ✓ | — | test results; files changed |
| **pr** | ✓ | ✓ | the approach | — |
| **learn** | ✓ | ✓ | full text | termination type/reason; run data; the files-changed diff |

### 6.1 The keep / build split

Stages fall into two groups by how they treat the raw work request:

- **Stages that keep the work request** — `plan`, `plan_review`, `pr`, `learn`.
  Here the request is a legitimate, low-conflict input: the Planner authors from
  it, the Reviewer uses it as a coverage yardstick, the PR body needs it, and the
  Learner assesses goals against it. These stages render `{{work_request}}` under
  a `## Work Request` heading.
- **Stages that withhold it** — `coordinate`, `implement`, `test`, `review`. By
  the time these run, the request has been refined into a plan and decomposed
  into beads. Re-injecting the raw request alongside the refined plan made agents
  treat two sources as authoritative and loop work back on "doesn't match the
  original request" — so the build stages work from the plan and the bead only.
  Their guide block also states the precedence ladder explicitly: *"the guide …
  outranks the plan, your assigned task, and the original description."*

### 6.2 The plan, three ways

The plan reaches different stages in three shapes — all derived from the current
run-scoped file, never from a stale summary:

- **Full text, as the artifact to read** — for the stages that *work on* the
  plan: `plan` (the basis for a revision), `plan_review` (the artifact under
  review), and `learn`.
- **Full text, as the thing to decompose** — for `coordinate`. This is built from
  the current plan file's content, not from the Planner's structured task
  outline (which only describes what changed on a revision).
- **A pointer (path)** — for `implement`: an advisory, read-on-demand reference
  to the current approved plan, for design context and file references, scoped to
  the agent's single bead so it doesn't widen scope.

### 6.3 Beads — the Coordinator's output

The Coordinator decomposes the current plan into atomic **beads** (one
implementable task each, with a description) via `bd create` (and optional
`bd dep add`), labelling each `run:<run_id>`. The **Implementer** then works
**one bead at a time**: the bead is its operative directive, and the plan pointer
lets it consult the authoritative spec without exceeding that bead's scope.
Cross-bead decisions surface to sibling beads as **accumulated design notes**
(advisory, lowest authority).

### 6.4 Knowledge graph (advisory)

When a knowledge graph is enabled, every block carries a one-line **availability
note**, and the how-to-use guidance lives in the agent's role template. Agents
**query the graph on demand** — the graph report is never injected into the
prompt. The note sits *after* the guide block, reflecting `guide > graph`.

---

## 7. Prompt assembly mechanism

- Templates live in `src/worca/agents/core/` and are copied to
  `.claude/worca/agents/core/` at install time. The **role** is `<agent>.md`;
  the **dynamic user message** is `<stage>.block.md`.
- A **three-tier overlay** (core → project `.claude/agents/` → user) merges
  templates. Placeholders (`{{var}}`, with `{{var|default}}`) and conditionals
  (`{{#if key}} … {{else}} … {{/if}}`) are resolved at dispatch time
  (`orchestrator/overlay.py`, `orchestrator/prompt_builder.py`).
- A conditional `{{#if key}}` is truthy when the context value is non-empty — it
  works for booleans (`has_guide`) and for strings alike (`current_plan`,
  `plan_file`).
- The runner threads inter-stage context into the `PromptBuilder`
  (`orchestrator/runner.py`): the work request, the guide, the plan file/path and
  content, the assigned bead, accumulated design notes, the knowledge-graph
  availability flags, and the per-stage artifacts (implementation summary, test
  results, files changed, review issues, unresolved-plan concerns).
- The resolved system prompt is written to
  `run_dir/agents/resolved/<stage>-<agent>-iter-N.md`; the resolved user message
  is stored at `status.stages.<stage>.prompt`. Both are inspectable per
  iteration, and the UI reads them.

---

## 8. How review reshapes the flow

### 8.1 Plan review → revision loop

The Plan Reviewer returns a structured verdict (`outcome`: `approve` or
`revise`):

- **approve** → proceed to `coordinate`.
- **revise** (critical/major issues, or an empty issue list, which is treated as
  fail-closed) → loop back to the Planner in revision mode. The runner appends
  the next plan version, hands over the current plan as the basis, re-points the
  plan file, and re-enters planning. The Planner rewrites the **complete** plan;
  the Reviewer then re-checks it with convergence framing — *verify the prior
  issues are resolved, don't re-review from scratch*.
- The loop is bounded by `worca.loops.plan_review`. If it is **exhausted**, the
  remaining critical concerns are **carried forward** to `coordinate`, which must
  account for each (create a bead for it, or note it on the bead it affects).

Because each review iteration reviews exactly one plan version in order, **review
iteration *K* reviewed plan version *K*** — the mapping the UI uses for its
per-iteration view-plan buttons.

### 8.2 Implement ↔ test ↔ review loops

- A **test failure** sends the Implementer back in retry mode: its prompt leads
  with `## PRIORITY: Fix …` and the failures, and demotes the assigned task and
  plan to a "Reference (already implemented)" footer. Bounded by
  `worca.loops.implement_test`.
- **Review issues** trigger the same retry mode with the issues to fix.
- A running list of previous failed attempts is included so the Implementer does
  not repeat them.

These loops never reintroduce the raw work request — they operate on the bead,
the plan (by pointer), and the concrete failures.

---

## 9. Fleet & workspace runs

- **Fleet runs** fan a single work request (and an optional guide and plan) out
  to many independent projects; each child is a standard run, so everything above
  applies per child.
- **Workspace runs** decompose one prompt into per-project sub-plans via a master
  planner, execute in dependency order, and inject upstream context between
  tiers; each child still ingests its plan and follows the per-stage flow above.

See `docs/fleet-runs.md` and `docs/workspace-runs.md`.

---

## 10. Quick reference

**Authority ladder:** guide › plan › knowledge graph › description (work
request) › accumulated design notes.

**Who sees the raw work request:** planner, plan_review, pr, learn. **Who does
not:** coordinate, implement, test, review.

**How the plan reaches stages:** full text to plan (revision), plan_review,
learn, and coordinate; a path pointer to implement.

**Where the plan lives:** `.worca/runs/<id>/plan-NNN.md`, append-only, latest =
current. `status.plan_file` points at the latest; `status.plan_source` records a
provided plan's original path.

**Where to inspect a stage's actual prompt:** the system prompt at
`run_dir/agents/resolved/<stage>-<agent>-iter-N.md`; the user message at
`status.stages.<stage>.prompt`.

**Related references:** `docs/design-principles.md` (rationale),
`docs/governance.md` (write carve-outs and dispatch), `docs/effort.md`,
`docs/events.md`; the per-stage block templates in
`src/worca/agents/core/*.block.md`.
