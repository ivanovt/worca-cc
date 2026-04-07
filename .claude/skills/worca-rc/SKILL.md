---
name: worca-rc
description: Cut a release candidate for both worca-cc (Python) and @worca/ui (npm). Triggers on "release candidate", "cut an RC", "bump RC", "new RC", "worca-rc", or any request to create a release candidate. No arguments required — versions are auto-detected and incremented.
---

# Cut Release Candidate

Bumps the RC number for both packages, commits, tags, and pushes to trigger CI releases.

**Usage:** `/worca-rc` — no arguments needed.

## Procedure

### Step 1: Read current versions

Read all three version sources:

```bash
# pyproject.toml — line matching: version = "..."
grep '^version' pyproject.toml

# src/worca/__init__.py — line matching: __version__ = "..."
grep '__version__' src/worca/__init__.py

# worca-ui/package.json — "version" field
node -e "console.log(require('./worca-ui/package.json').version)"
```

**Validate:** `pyproject.toml` and `src/worca/__init__.py` versions MUST match. If they differ, stop and report the mismatch — do not proceed.

### Step 2: Compute next RC versions

**Python version** (PEP 440 format: `X.Y.ZrcN`):
- If current version contains `rc`, extract N and increment: `0.6.0rc6` → `0.6.0rc7`
- If no `rc` suffix, append `rc1`: `0.6.0` → `0.6.0rc1`

**npm version** (semver pre-release format: `X.Y.Z-rc.N`):
- If current version contains `-rc.`, extract N and increment: `0.1.0-rc.4` → `0.1.0-rc.5`
- If no `-rc.` suffix, append `-rc.1`: `0.1.0` → `0.1.0-rc.1`

### Step 3: Update version files

Edit these three files with the new versions:

1. **`pyproject.toml`** — update the `version = "..."` line
2. **`src/worca/__init__.py`** — update the `__version__ = "..."` line
3. **`worca-ui/package.json`** — update the `"version": "..."` field

### Step 4: Commit

```bash
git add pyproject.toml src/worca/__init__.py worca-ui/package.json
git commit -m "chore: bump RC to worca-cc <PYTHON_VERSION> + @worca/ui <NPM_VERSION>"
```

Replace `<PYTHON_VERSION>` and `<NPM_VERSION>` with the actual new versions (e.g. `0.6.0rc7`, `0.1.0-rc.5`).

### Step 5: Tag and push

Create both tags and push everything:

```bash
git tag worca-cc-v<PYTHON_VERSION>
git tag worca-ui-v<NPM_VERSION>
git push
git push origin worca-cc-v<PYTHON_VERSION> worca-ui-v<NPM_VERSION>
```

For example: `git tag worca-cc-v0.6.0rc7` and `git tag worca-ui-v0.1.0-rc.5`.

### Step 6: Print summary

Display the results and install/update commands:

```
RC release complete!

  worca-cc:   <OLD_PYTHON> → <NEW_PYTHON>
  @worca/ui:  <OLD_NPM> → <NEW_NPM>

  Tags pushed:
    worca-cc-v<PYTHON_VERSION>
    worca-ui-v<NPM_VERSION>

  Install / update:
    pip install --upgrade worca-cc==<PYTHON_VERSION>
    npm install -g @worca/ui@<NPM_VERSION>
```
