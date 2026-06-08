---
title: Reviewing the result
description: The pull request, test proof, beads, and learnings a finished run leaves behind.
sidebar:
  order: 6
---

When a run finishes, the Guardian agent opens a pull request with the implemented, tested, and reviewed change. Everything you need to judge that PR is surfaced in the dashboard.

## The pull request

The PR is the run's deliverable. When the PR stage completes, an inline **PR info strip** appears on the stage card the moment it's expanded:

- the linked PR number with a provider-aware external-link icon;
- the **provider** — GitHub, GitLab, Bitbucket, Azure DevOps, or Gitea, auto-detected from the PR URL;
- the short commit SHA with a copy button;
- the source → target branch flow;
- a review-status badge, when the host surfaces one.

![The PR info strip on the expanded Guardian stage card.](/screenshots/reviewing-the-result/01-pr-strip.png)

## Test proof

The Tester collects proof artifacts — the suite that ran, coverage, and outcomes — which the Guardian verifies before committing. You can read these from the Test stage in run detail, so a green PR is backed by evidence rather than a claim.

## Beads

Each run decomposes its plan into tracked tasks (**beads**). The **Beads** view lists runs that produced beads, each card showing the branch, template, timing, cost, and a closed/total count (e.g. `7/7 Beads`). Drill into a run to see its per-bead list and dependency graph.

![The Beads view: run cards with bead counts, and a run's dependency graph.](/screenshots/reviewing-the-result/02-beads.png)

## Learnings

If the **Learn** stage is enabled (it's off by default), a finished run produces ranked observations and actionable suggestions. Copy-to-clipboard buttons let you feed an insight straight into a future run — copied prompts include a `## Source` block (project, run ID, branch, artifacts path, start time) for traceability.

:::tip
Learn is disabled by default. Enable it per project in **Settings → Stages** when you want a post-run retrospective.
:::
