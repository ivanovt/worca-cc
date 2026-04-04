# Contributing to worca-cc

Thank you for your interest in contributing to worca-cc!

## Development Setup

```bash
# Clone the repository
git clone https://github.com/SinishaDjukic/worca-cc.git
cd worca-cc

# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dev dependencies
pip install -e ".[dev]"

# Build the UI
cd worca-ui && npm install && npm run build && cd -
```

## Running Tests

```bash
# Python tests
pytest tests/

# UI server tests
npx vitest run worca-ui/server/

# Browser e2e tests (must run serially)
cd worca-ui && npx playwright test --workers=1
```

## Code Style

- Python: enforced by [Ruff](https://docs.astral.sh/ruff/) (`ruff check .`)
- Line length: 100 characters
- Target: Python 3.8+

## Releasing

Releases are automated via GitHub Actions. When a version tag is pushed, the workflow builds the archive, generates release notes, and publishes a GitHub Release.

### Steps to create a release

1. **Update the version** in `pyproject.toml`:

   ```toml
   version = "X.Y.Z"
   ```

2. **Commit the version bump**:

   ```bash
   git add pyproject.toml
   git commit -m "Bump version to X.Y.Z"
   ```

3. **Create and push the tag**:

   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

4. **Verify** — go to [GitHub Actions](https://github.com/SinishaDjukic/worca-cc/actions) and confirm the release workflow completes successfully. The release will appear at [Releases](https://github.com/SinishaDjukic/worca-cc/releases).

### What the workflow does

1. Validates the tag version matches `pyproject.toml`
2. Rebuilds the worca-ui bundle from source
3. Creates zip and tar.gz archives via `git archive` (respecting `.gitattributes` export-ignore rules)
4. Generates SHA-256 checksums
5. Publishes a GitHub Release with auto-generated release notes

### Release artifacts

Each release includes:

| File | Description |
|------|-------------|
| `worca-cc-X.Y.Z.zip` | Release archive (zip) |
| `worca-cc-X.Y.Z.tar.gz` | Release archive (tarball) |
| `checksums-sha256.txt` | SHA-256 checksums for verification |

### Verifying a download

```bash
sha256sum -c checksums-sha256.txt
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
