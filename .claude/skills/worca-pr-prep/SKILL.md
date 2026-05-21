---
name: worca-pr-prep
description: Pre-merge gate for a worca-cc PR — verifies branch is rebased on master, CI is green, no merge conflicts, then merges via `gh pr merge --merge` (never local merge). Triggers on "merge pr", "prepare to merge", "ready to merge", "pr ready", "worca-pr-prep", or any request to land a PR for this repo.
---

# worca-cc PR Merge Gate

Enforces the merge discipline documented in CLAUDE.md: **always use `gh pr merge <#> --merge`**, never local `git merge` + push. Local merge breaks GitHub's auto-close link.

## Step 0: No-args mode

If invoked with no arguments, look up the PR for the current branch:

```bash
gh pr list --head $(git branch --show-current) --json number,title,state --jq '.[0]'
```

If found, print its number and state, then ask the user to confirm before proceeding. If no PR is found, print "no PR found for current branch" and stop.

## Step 1: Validate the PR is mergeable

```bash
gh pr view <N> --json number,title,state,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,headRefName
```

Verify:
- `state` is `OPEN`
- `mergeable` is `MERGEABLE` (not `CONFLICTING` or `UNKNOWN`)
- `mergeStateStatus` is `CLEAN` (warn but allow `UNSTABLE` if all required checks pass)
- `baseRefName` is `master`

If any of these fail, STOP and report what's blocking. Do not attempt to merge.

## Step 2: Verify CI is green

```bash
gh pr checks <N>
```

All required checks must be `pass`. If any are `pending` or `fail`, STOP. Do not merge with red or pending checks.

Common CI checks for this repo:
- Python tests + ruff
- worca-ui lint + vitest
- worca-ui playwright (only if `worca-ui/app|server/` was touched)
- Coverage upload

## Step 3: Verify the branch is up to date with master

```bash
gh pr view <N> --json baseRefOid --jq .baseRefOid
git rev-parse origin/master
```

If these differ, the PR branch is behind master. Recommend the user rebase before merging:

```bash
git fetch origin && git rebase origin/master && git push --force-with-lease
```

Do NOT auto-rebase. The user controls when their branch moves.

## Step 4: Merge

```bash
gh pr merge <N> --merge
```

**Never** use:
- `git checkout master && git merge <branch> && git push` — breaks GitHub auto-close
- `gh pr merge <N> --squash` unless the user explicitly asks for squash — this repo uses merge commits by default
- `gh pr merge <N> --rebase` unless the user explicitly asks for rebase

## Step 5: Verify post-merge state

```bash
gh pr view <N> --json state,mergedAt,mergeCommit
git fetch origin master
```

Confirm:
- PR state is `MERGED`
- Merge commit exists in `origin/master`
- Issue references in the PR body (e.g. `Closes #N`) auto-closed their issues

## Step 6: Print summary

```
PR #<N> merged:
  Title:       <title>
  Merged into: master @ <merge_commit_sha>
  Closed:      <list of issues auto-closed by Closes #N references>

Local cleanup (optional):
  git checkout master && git pull && git branch -d <head_branch>
```
