---
name: worca-plan-new
description: File a new feature for worca-cc — triage size/complexity, then either create a lightweight GitHub feature request (no W-NNN, no plan file) or a full W-NNN plan (allocate the next plan ID, scaffold docs/plans/W-NNN-slug.md from _TEMPLATE.md, create the GitHub issue with the correct title/structure/labels, and link the plan file). Always asks which path unless the user gave an explicit instruction. Triggers on "new plan", "create plan", "start plan", "new feature plan", "feature request", "worca-plan-new", or any request to file a new feature for this repo.
---

# File a new feature (request or W-NNN plan)

This skill files a new **feature or refactor**. It first triages the size and complexity of the work, then takes one of two paths:

- **Simple feature request** — a lightweight GitHub issue. No `W-NNN:` allocation, no `docs/plans/` file. Use for small, well-scoped, low-ambiguity work.
- **Full W-NNN plan** — allocate the next plan ID, scaffold `docs/plans/W-NNN-slug.md` from `_TEMPLATE.md`, and create the GitHub issue with the `W-NNN:` title and an absolute plan blob-link. Use for larger or multi-subsystem work, or anything with open design decisions.

Both paths match the conventions in CLAUDE.md and `docs/plans/_TEMPLATE.md`.

## Step 0: No-args mode

If invoked with no arguments (just `/worca-plan-new`), print this usage:

```
/worca-plan-new --slug:<short-description> --area:cc|ui --priority:P0..P4 [--title:"..."] [--mode:fr|plan]

  --mode:fr    force a simple feature request (no W-NNN, no plan file)
  --mode:plan  force a full W-NNN plan
  (omit --mode to have the skill assess and ask)

Example:
  /worca-plan-new --slug:plan-reviewer-subagent --area:cc --priority:P2 \
    --title:"Plan-template reviewer subagent"
```

Then stop. Do not proceed without arguments.

## Step 1: Triage and choose the path

**First, confirm this is a feature or refactor, not a bug.** Bugs do NOT get a `W-NNN:` allocation OR this skill — bugs use a plain descriptive title and the `bug` label. If this is a bug, redirect to `/worca-issue` and stop.

**Then assess the size and complexity of the work.** Lean toward a *simple feature request* when most of these hold:

- Touches a single file or a tightly scoped area.
- The "how" is obvious — no real design decisions or trade-offs to resolve first.
- Implementable and testable in one short session.
- Additive, cosmetic, copy/config, or a small helper.

Lean toward a *full W-NNN plan* when any of these hold:

- Spans multiple subsystems (e.g. both `src/worca/` and `worca-ui/`).
- Changes architecture, the state model, governance, the event schema, or a public API/contract.
- Has open design decisions, trade-offs, or alternatives worth recording before coding.
- Multi-session work, has dependencies, or needs a non-trivial test plan.

**Always ask the user which path to take** — present your assessment and a recommendation, then offer the two options (recommended one first) via `AskUserQuestion`:

- **Simple feature request** — lightweight GitHub issue, no W-NNN, no plan file.
- **Full W-NNN plan** — plan file + W-NNN issue with plan blob-link.

**Skip the question ONLY when the user has already given an explicit instruction** — e.g. `--mode:fr`/`--mode:plan` in the args, or wording in the request like "just a simple feature request", "no plan needed", "create the full plan", "allocate a W-NNN". In that case proceed directly on the named path without asking.

Then continue with **Step 2 (Path A)** or **Step 3 (Path B)** accordingly.

---

## Step 2: Path A — Simple feature request (no W-NNN, no plan file)

Compose the issue body with this structure (no `## Plan` section — there is no plan file):

```markdown
## Problem

<2-5 sentences — what's wrong or missing>

## Proposal

<bullet points or short paragraphs — what to build and how>

## Considerations

<optional — trade-offs, edge cases, dependencies>
```

Ask the user for the Problem/Proposal text. Do not invent it.

Create the issue with a **plain descriptive title** (no `W-NNN:` prefix) and NO `bug` label — the absence of both is what marks it as a lightweight enhancement rather than a bug or a planned W-NNN:

```bash
gh issue create \
  --title "<plain descriptive title>" \
  --label "area:ui" \
  --label "P2" \
  --body "$(cat <<'EOF'
<body from above>
EOF
)"
```

- Title: plain descriptive, no `W-NNN:` prefix, no `bug` label.
- Labels: exactly one of `area:cc` or `area:ui`, plus exactly one of `P0`/`P1`/`P2`/`P3`/`P4`.
- Never use `--label "high"` / `"medium"` / `"low"` — those don't exist in this repo.

Print summary:

```
Feature request created:
  Issue:  #<number>  <title>
  URL:    <issue url>

Note: this issue has no plan file. Starting the pipeline on it
(--source gh:issue:<number>) will run the Planner, since there is no
## Plan blob-link to auto-detect. That's expected for a lightweight FR.
If it grows, re-run /worca-plan-new --mode:plan to promote it to a W-NNN plan.
```

---

## Step 3: Path B — Full W-NNN plan

### 3a: Allocate the next W-NNN

```bash
ls docs/plans/W-*.md 2>/dev/null \
  | sed -E 's|.*/W-([0-9]+).*|\1|' \
  | sort -n | tail -1
```

Add 1 and zero-pad to three digits. Confirm the new ID with the user before writing.

### 3b: Scaffold the plan file

Read `docs/plans/_TEMPLATE.md` and write `docs/plans/W-NNN-<slug>.md` filled in with:

- Title line: `# W-NNN: <Title>`
- Metadata block: Status `Draft`, Priority from args, Area from args, Date `YYYY-MM-DD` (today), Depends on `None`
- All other sections (Problem, Proposal, Design, Implementation Plan, Considerations, Test Plan, Files to Create/Modify, Out of Scope) as **stubs with placeholder prompts** — do not invent content.

Open the file and let the user know they need to fill it in. Do not attempt to draft Problem/Proposal/Design yourself — the user is the source of truth for what the plan should contain.

### 3c: Compose the GitHub issue body

Use this exact structure:

```markdown
## Problem

<2-5 sentences — what's wrong or missing>

## Proposal

<bullet points or short paragraphs — what to build and how>

## Considerations

<optional — trade-offs, edge cases, dependencies>

## Plan

- [docs/plans/W-NNN-<slug>.md](https://github.com/SinishaDjukic/worca-cc/blob/master/docs/plans/W-NNN-<slug>.md)
```

The `## Plan` link MUST be an absolute blob URL — the pipeline parses this exact format for `--source gh:issue:N` auto-detection. A relative path will silently fail to detect the plan and the pipeline will re-run the planner.

Ask the user for the Problem/Proposal text. Do not invent it.

### 3d: Create the GitHub issue

```bash
gh issue create \
  --title "W-NNN: <Title>" \
  --label "area:cc" \
  --label "P2" \
  --body "$(cat <<'EOF'
<body from step 3c>
EOF
)"
```

- Title format: `W-NNN: <Title>` (exact prefix, colon, single space)
- Labels: exactly one of `area:cc` or `area:ui`, plus exactly one of `P0`/`P1`/`P2`/`P3`/`P4`
- Never use `--label "high"` or `--label "medium"` — those are not the priority labels

### 3e: Print summary

```
Plan created:
  Plan file:  docs/plans/W-NNN-<slug>.md   (stub — please fill in)
  Issue:      #<number>  W-NNN: <Title>
  URL:        <issue url>

Next:
  1. Fill in the plan stub (Problem, Proposal, Design, Implementation Plan, Test Plan).
  2. Run /worca-plan-template-reviewer once the plan is drafted to check conventions.
  3. Start work with: python .claude/worca/scripts/run_worktree.py --source gh:issue:<number>
```
