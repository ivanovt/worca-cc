---
name: worca-plan-new
description: Create a new W-NNN feature plan end-to-end — allocate the next plan ID, scaffold docs/plans/W-NNN-slug.md from _TEMPLATE.md, create the GitHub issue with the correct title/structure/labels, and link the plan file in the issue body. Triggers on "new plan", "create plan", "start plan", "new feature plan", "worca-plan-new", or any request to file a new W-NNN plan for this repo.
---

# Create a new W-NNN feature plan

Walks the full ritual: plan file + GitHub issue + cross-link, matching the conventions in CLAUDE.md and `docs/plans/_TEMPLATE.md`.

## Step 0: No-args mode

If invoked with no arguments (just `/worca-plan-new`), print this usage:

```
/worca-plan-new --slug:<short-description> --area:cc|ui --priority:P0..P4 [--title:"..."]

Example:
  /worca-plan-new --slug:plan-reviewer-subagent --area:cc --priority:P2 \
    --title:"Plan-template reviewer subagent"
```

Then stop. Do not proceed without arguments.

## Step 1: Validate this is a feature, not a bug

Ask the user to confirm this is a planned feature or refactor warranting a `W-NNN:` allocation. **Bugs do NOT get W-NNN.** Bugs use a plain descriptive title and the `bug` label — if this is a bug, redirect to `/worca-issue` instead.

## Step 2: Allocate the next W-NNN

```bash
ls docs/plans/W-*.md 2>/dev/null \
  | sed -E 's|.*/W-([0-9]+).*|\1|' \
  | sort -n | tail -1
```

Add 1 and zero-pad to three digits. Confirm the new ID with the user before writing.

## Step 3: Scaffold the plan file

Read `docs/plans/_TEMPLATE.md` and write `docs/plans/W-NNN-<slug>.md` filled in with:

- Title line: `# W-NNN: <Title>`
- Metadata block: Status `Draft`, Priority from args, Area from args, Date `YYYY-MM-DD` (today), Depends on `None`
- All other sections (Problem, Proposal, Design, Implementation Plan, Considerations, Test Plan, Files to Create/Modify, Out of Scope) as **stubs with placeholder prompts** — do not invent content.

Open the file and let the user know they need to fill it in. Do not attempt to draft Problem/Proposal/Design yourself — the user is the source of truth for what the plan should contain.

## Step 4: Compose the GitHub issue body

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

## Step 5: Create the GitHub issue

```bash
gh issue create \
  --title "W-NNN: <Title>" \
  --label "area:cc" \
  --label "P2" \
  --body "$(cat <<'EOF'
<body from step 4>
EOF
)"
```

- Title format: `W-NNN: <Title>` (exact prefix, colon, single space)
- Labels: exactly one of `area:cc` or `area:ui`, plus exactly one of `P0`/`P1`/`P2`/`P3`/`P4`
- Never use `--label "high"` or `--label "medium"` — those are not the priority labels

## Step 6: Print summary

```
Plan created:
  Plan file:  docs/plans/W-NNN-<slug>.md   (stub — please fill in)
  Issue:      #<number>  W-NNN: <Title>
  URL:        <issue url>

Next:
  1. Fill in the plan stub (Problem, Proposal, Design, Implementation Plan, Test Plan).
  2. Run /worca-plan-template-reviewer once the plan is drafted to check conventions.
  3. Start work with: python .claude/scripts/run_worktree.py --source gh:issue:<number>
```
