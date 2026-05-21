---
name: worca-issue
description: Read, list, or create GitHub issues for worca-cc using the correct `gh ... --json` invocation (works around classic-Projects deprecation), the W-NNN-vs-bug title convention, and the required label set. Triggers on "issue", "gh issue", "read issue", "list issues", "create bug", "worca-issue", or any request to view or file issues for this repo.
---

# worca-cc Issue Read/List/Create

Wraps `gh` commands with the workarounds and conventions baked in. The bare `gh issue view N` fails on this repo because of a deprecated classic-Projects GraphQL field — this skill never uses the unfiltered form.

## Step 0: No-args mode

If invoked with no arguments, print this usage:

```
/worca-issue --view <N>
/worca-issue --list [--label <area:cc|area:ui|bug|P0..P4>] [--state open|closed|all]
/worca-issue --create-bug --title "<desc>" [--label <area:cc|area:ui>]
```

For new W-NNN feature plans, redirect to `/worca-plan-new` — this skill does not allocate W-NNN.

## View mode

Always pass `--json` with an explicit field list. Never use the bare `gh issue view N`.

```bash
gh issue view <N> --json number,title,body,labels,state,assignees,comments
```

For human-readable output, post-process with `--jq`:

```bash
gh issue view <N> --json number,title,body,labels,state \
  --jq '"#\(.number) [\(.state)] \(.title)\n\nLabels: \([.labels[].name] | join(\", \"))\n\n\(.body)"'
```

After fetching, verify:
- If the title starts with `W-NNN:`, check the `## Plan` section contains an absolute blob URL to `docs/plans/W-NNN-*.md` (not a relative path). Warn if missing.
- If the title does NOT start with `W-NNN:`, check the issue has the `bug` label. Warn if missing.

## List mode

```bash
gh issue list --json number,title,labels,state --limit 30
gh issue list --label area:cc --json number,title,labels --limit 30
gh issue list --label bug --json number,title,labels,state --limit 30
gh issue list --state closed --json number,title,labels --limit 30
```

For readable output:

```bash
gh issue list --json number,title,labels,state --limit 30 \
  --jq '.[] | "#\(.number) [\(.state)] \(.title)  (\([.labels[].name] | join(\", \")))"'
```

## Create-bug mode

Bugs use a **plain descriptive title** (no `W-NNN:` prefix) and the `bug` label plus exactly one of `area:cc` or `area:ui`.

```bash
gh issue create \
  --title "<plain descriptive title>" \
  --label bug \
  --label "area:cc" \
  --body "$(cat <<'EOF'
## Problem

<What's broken — 2-5 sentences, include file:line if known>

## Repro

<Steps to reproduce, if applicable>

## Expected vs Actual

<What should happen vs what happens>
EOF
)"
```

**Title rules:**
- Bugs: plain title, no prefix. Example: `gh issue list --json fails on classic-Projects repos`
- Never start a bug title with `W-NNN:` — that prefix is reserved for planned features/refactors

**Label rules:**
- One of `area:cc` / `area:ui` (required)
- `bug` (required for bugs)
- Priority labels `P0`-`P4` are optional but encouraged
- Never use `--label "high"` / `"medium"` / `"low"` — those don't exist in this repo

## Common pitfalls

- `gh issue view N` without `--json` errors with `GraphQL: Projects (classic) is being deprecated... (repository.issue.projectCards)`. Always pass `--json`.
- `gh issue list` without `--json` can hit the same error on issues linked to classic Projects. Always pass `--json` with explicit fields.
- The `## Plan` section in a W-NNN issue body must use the absolute blob URL form. The pipeline's `--source gh:issue:N` plan auto-detection parses this exact format.
