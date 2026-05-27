---
name: worca-release
description: Create a stable release for worca-cc (Python), @worca/ui (npm), or both. Bumps the version (micro or minor), commits, tags, and pushes — CI handles publishing and GitHub Release creation. Also promotes the docs site by fast-forwarding docs-live so docs.worca.dev matches the release. Triggers on "stable release", "cut a release", "release", "worca-release", or any request to create a non-RC release.
---

# Create Stable Release

Bumps the version, commits, tags, and pushes to trigger CI releases.

**Usage:**

- `/worca-release` — print help and current version status
- `/worca-release --version:micro` — bump patch version for all packages
- `/worca-release --version:minor` — bump minor version for all packages
- `/worca-release --version:micro --package:worca-cc` — Python only
- `/worca-release --version:minor --package:worca-ui` — npm only

## Procedure

### Step 0: No-args mode (help + status)

If invoked with **no arguments** (just `/worca-release`):

1. Print the usage instructions shown above
2. Read current versions from all three version files:

```bash
grep '^version' pyproject.toml
grep '__version__' src/worca/__init__.py
node -e "console.log(require('./worca-ui/package.json').version)"
```

3. Show latest release tags on master:

```bash
git tag --sort=-v:refname | grep -E '^worca-(cc|ui)-v' | head -10
```

4. **Stop here** — do NOT proceed with a release. Print a message telling the user to re-invoke with arguments.

---

### Step 1: Validate preconditions

Only reached when arguments are provided.

```bash
# Must be on master
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "master" ]; then
  echo "ERROR: Must be on master branch (currently on $BRANCH)"
  exit 1
fi

# Working tree must be clean
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is not clean"
  exit 1
fi
```

Read all three version sources:

```bash
grep '^version' pyproject.toml
grep '__version__' src/worca/__init__.py
node -e "console.log(require('./worca-ui/package.json').version)"
```

**Validate:** `pyproject.toml` and `src/worca/__init__.py` versions MUST match. If they differ, stop and report the mismatch — do not proceed.

### Step 2: Parse arguments

Two dimensions:

**Version bump (required — must specify one):**
- `--version:micro` — bump patch version (e.g. `0.6.0` → `0.6.1`)
- `--version:minor` — bump minor version, reset patch to 0 (e.g. `0.6.0` → `0.7.0`)

**Package scope (optional — defaults to all):**
- `--package:all` (default) — release both packages
- `--package:worca-cc` — release Python only
- `--package:worca-ui` — release npm only

If `--version` is not provided, stop and ask the user which bump level they want.

### Step 3: Compute new versions

**Strip any RC/pre-release suffix first:**
- Python: `0.6.0rc8` → `0.6.0`
- npm: `0.1.0-rc.6` → `0.1.0`

**Then apply the bump:**

For `--version:micro`:
- Python: `0.6.0` → `0.6.1`
- npm: `0.1.0` → `0.1.1`

For `--version:minor`:
- Python: `0.6.0` → `0.7.0`
- npm: `0.1.0` → `0.2.0`

**Print the computed versions** and confirm with the user before proceeding.

### Step 4: Update version files

Only update files for the selected package(s):

**For worca-cc** (when `--package:all` or `--package:worca-cc`):
1. **`pyproject.toml`** — update the `version = "..."` line
2. **`src/worca/__init__.py`** — update the `__version__ = "..."` line

**For @worca/ui** (when `--package:all` or `--package:worca-ui`):
3. **`worca-ui/package.json`** — update the `"version": "..."` field

### Step 5: Commit

Stage only the files that were changed and commit:

```bash
# For --package:all
git add pyproject.toml src/worca/__init__.py worca-ui/package.json
git commit -m "chore: release worca-cc <PYTHON_VERSION> + @worca/ui <NPM_VERSION>"

# For --package:worca-cc
git add pyproject.toml src/worca/__init__.py
git commit -m "chore: release worca-cc <PYTHON_VERSION>"

# For --package:worca-ui
git add worca-ui/package.json
git commit -m "chore: release @worca/ui <NPM_VERSION>"
```

Replace `<PYTHON_VERSION>` and `<NPM_VERSION>` with the actual new versions (e.g. `0.6.1`, `0.1.1`).

### Step 6: Tag and push

Create tags only for the selected package(s) and push everything:

```bash
# For --package:all
git tag worca-cc-v<PYTHON_VERSION>
git tag worca-ui-v<NPM_VERSION>
git push
git push origin worca-cc-v<PYTHON_VERSION> worca-ui-v<NPM_VERSION>

# For --package:worca-cc
git tag worca-cc-v<PYTHON_VERSION>
git push
git push origin worca-cc-v<PYTHON_VERSION>

# For --package:worca-ui
git tag worca-ui-v<NPM_VERSION>
git push
git push origin worca-ui-v<NPM_VERSION>
```

### Step 7: Promote the docs site

After the release is pushed, fast-forward the docs production branch so the published docs at `docs.worca.dev` match the released product:

```bash
git push origin master:docs-live
```

This triggers a production build of the `worca-docs` Worker from `docs-live`. The staging site `staging.docs.worca.dev` (which tracks `master`) is where docs are previewed beforehand; pages not ready to publish should already be marked `draft: true` in their frontmatter. Skip this step only if you explicitly do not want to publish the current docs state.

### Step 8: Print summary

Display the results and install/update commands:

```
Stable release complete!

  worca-cc:   <OLD_PYTHON> → <NEW_PYTHON>
  @worca/ui:  <OLD_NPM> → <NEW_NPM>

  Tags pushed:
    worca-cc-v<PYTHON_VERSION>
    worca-ui-v<NPM_VERSION>

  Docs promoted: docs-live → https://docs.worca.dev (rebuilding)

  Install / update:
    pip install --upgrade worca-cc==<PYTHON_VERSION>
    npm install -g @worca/ui@<NPM_VERSION>
```

Only show lines for the packages that were released.
