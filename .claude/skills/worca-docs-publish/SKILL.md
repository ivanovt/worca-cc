---
name: worca-docs-publish
description: Publish the worca docs site by fast-forwarding docs-live to master (git push origin master:docs-live) so docs.worca.dev updates without cutting a version release. Builds docs-site locally first to catch breakage, shows which doc commits will go live, and confirms before pushing. Triggers on "publish docs", "publish documentation", "promote docs", "push docs live", "docs-publish", "worca-docs-publish", or any request to publish the docs site between releases.
---

# Publish the docs site

Fast-forwards the `docs-live` branch to `master`, which triggers the production
build of the `worca-docs` Worker and updates **https://docs.worca.dev**. Use this
for docs-only publishing **between** releases.

`/worca-release` already promotes docs as its final step, so a versioned release
publishes docs automatically — this skill is for the in-between case ("I updated
the docs, push them live now").

`master` is continuously deployed to **https://staging.docs.worca.dev** (the
`worca-docs-staging` Worker), so the changes are previewable there before you
publish.

**Usage:**

- `/worca-docs-publish` — build-check, show pending doc changes, confirm, publish.
- `/worca-docs-publish --dry-run` — do everything except the final push.

## Procedure

### Step 1: Validate preconditions

```bash
# Must be on master
BRANCH=$(git branch --show-current)
[ "$BRANCH" = "master" ] || { echo "ERROR: switch to master first (on $BRANCH)"; exit 1; }

# Working tree must be clean — the local build reflects committed state
[ -z "$(git status --porcelain)" ] || { echo "ERROR: commit or stash changes first"; exit 1; }

# Local master must equal origin/master, so what you build == what you publish
git fetch origin
[ "$(git rev-parse master)" = "$(git rev-parse origin/master)" ] || {
  echo "ERROR: local master and origin/master differ — 'git pull' (if behind) or 'git push' (if ahead) first";
  exit 1;
}
```

Stop on any failure and tell the user how to resolve it.

### Step 2: Build the docs locally (catch breakage before publishing)

```bash
cd docs-site && npm install && npm run build
```

If the build fails, **STOP — do not publish.** A broken build would fail the
production deploy and leave `docs.worca.dev` stale. Report the error so it can be
fixed first.

### Step 3: Show what will go live

```bash
echo "=== doc commits to publish (origin/docs-live..master) ==="
git log --oneline origin/docs-live..master -- docs-site/
echo "=== files ==="
git diff --stat origin/docs-live..master -- docs-site/
```

- If there are **no** `docs-site/` changes, report that the published site won't
  change and ask whether to continue anyway (usually: stop).
- Remind the user: these changes are live now on **https://staging.docs.worca.dev**
  — confirm they look right. Pages with `draft: true` in frontmatter will **not**
  publish.

### Step 4: Confirm

Print the pending changes and **ask the user to confirm** before pushing. If
`--dry-run` was passed, stop here without pushing.

### Step 5: Publish

```bash
git push origin master:docs-live
```

### Step 6: Report

```
Docs published.

  docs-live → <new master SHA>
  Production build triggered on the worca-docs Worker (tracks docs-live).
  Live in ~1-2 min: https://docs.worca.dev
  Build logs: Cloudflare dashboard → worca-docs → Deployments
```

If no build appears within a couple of minutes, check **worca-docs → Settings →
Build** for a "disconnected from your Git account" banner (Workers Builds
occasionally drops the Git link) and reconnect, then re-run this skill.
