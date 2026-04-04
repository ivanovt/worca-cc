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

# Install dev dependencies (editable install)
pip install -e ".[dev]"
worca init .              # creates .claude/worca/ runtime copy

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

Two independent packages with independent version numbers and release cadences.

### Python pipeline (`worca-cc` on PyPI)

| Item | Value |
|---|---|
| Version source | `pyproject.toml` + `src/worca/__init__.py` |
| Tag format | `worca-cc-vX.Y.Z` |
| CI workflow | `.github/workflows/release-pypi.yml` |

Steps:

1. Bump version in **both** `pyproject.toml` and `src/worca/__init__.py`
2. Commit: `git commit -m "chore: bump worca-cc to X.Y.Z"`
3. Tag and push:
   ```bash
   git tag worca-cc-vX.Y.Z
   git push origin main && git push origin worca-cc-vX.Y.Z
   ```
4. CI validates tag matches pyproject.toml, builds wheel+sdist, publishes to PyPI (trusted publishing), creates GitHub Release with artifacts + checksums

### Dashboard (`@worca/ui` on npm)

| Item | Value |
|---|---|
| Version source | `worca-ui/package.json` |
| Tag format | `worca-ui-vX.Y.Z` |
| CI workflow | `.github/workflows/release-npm.yml` |

Steps:

1. Bump version in `worca-ui/package.json`
2. Commit: `git commit -m "chore: bump @worca/ui to X.Y.Z"`
3. Tag and push:
   ```bash
   git tag worca-ui-vX.Y.Z
   git push origin main && git push origin worca-ui-vX.Y.Z
   ```
4. CI validates tag matches package.json, builds, runs tests, publishes to npm

### Version table

| Package | Version source | Tag format |
|---|---|---|
| `worca-cc` | `pyproject.toml` + `src/worca/__init__.py` | `worca-cc-vX.Y.Z` |
| `@worca/ui` | `worca-ui/package.json` | `worca-ui-vX.Y.Z` |

Releases are independent — a UI fix doesn't require a Python release.

### Release artifacts

**worca-cc:** wheel (.whl), sdist (.tar.gz), checksums-sha256.txt — published to PyPI, attached to GitHub Release

**@worca/ui:** published to npm registry

### Verifying a PyPI download

```bash
pip download worca-cc --no-deps
sha256sum worca_cc-*.whl
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
