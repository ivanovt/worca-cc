#!/usr/bin/env python3
"""
L2 — release-time live check for the W-061 in-app help registry.

Parses ``worca-ui/app/utils/help-links.js`` for every ``slug: '...'`` literal,
HEAD-checks ``https://docs.worca.dev/<slug>/`` for each, and exits non-zero
if any URL returns a non-200 status.

The fix path is always the same: the local docs source is fresh but
``docs-live`` hasn't been fast-forwarded to master yet. Run
``/worca-docs-publish`` (or the equivalent ``git push origin master:docs-live``)
before cutting the release.

Wired into the ``worca-release-preflight`` subagent so a release that
points the UI at not-yet-published docs is caught before it goes out.

Standalone usage:

    python3 scripts/check-help-links-live.py
    python3 scripts/check-help-links-live.py --base https://staging.docs.example
    python3 scripts/check-help-links-live.py --timeout 5

Exit codes:
    0 — every slug returns 200.
    1 — one or more 404 / network error / non-200 status.
    2 — could not find or parse ``help-links.js``.
"""

from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_BASE = "https://docs.worca.dev"
HELP_LINKS_REL = "worca-ui/app/utils/help-links.js"
# Matches `slug: '<value>'` (single-quoted form the registry uses today).
# Also tolerates `slug: "<value>"` for future flexibility, but the L1
# vitest locks the file to one canonical shape.
_SLUG_RE = re.compile(r"""slug\s*:\s*['"]([^'"]+)['"]""")


def _repo_root() -> Path:
    """Return the worca-cc repo root by walking up from this script."""
    return Path(__file__).resolve().parent.parent


def _read_slugs(path: Path) -> list[str]:
    """Extract every page-level slug from help-links.js, preserving order."""
    text = path.read_text(encoding="utf-8")
    seen: set[str] = set()
    slugs: list[str] = []
    for m in _SLUG_RE.finditer(text):
        slug = m.group(1)
        # Skip anchor-laced slugs defensively — the L1 vitest rejects
        # them, but a stale checkout shouldn't crash the script.
        if "#" in slug:
            continue
        if slug not in seen:
            seen.add(slug)
            slugs.append(slug)
    return slugs


# docs.worca.dev (and most CDN-fronted Astro / Starlight deployments)
# rejects HEAD requests and requests without a browser-shaped User-Agent
# with HTTP 403, which would look like a page-missing failure even when
# the page is fine. Probe with GET + a real UA, and read only the first
# few bytes so we don't pull the whole HTML body just to verify the
# status code.
_PROBE_UA = (
    "Mozilla/5.0 (worca-cc help-links live-check; "
    "https://github.com/SinishaDjukic/worca-cc)"
)


def _probe(url: str, timeout: float) -> tuple[bool, str]:
    """GET-probe ``url`` with a browser-shaped UA. Returns (ok, detail).

    Treats 3xx as success (the urllib opener follows redirects, so a
    final 200 is what we actually see in practice). 404 means the doc
    page is genuinely missing; any other non-2xx is reported verbatim.
    """
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": _PROBE_UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
            status = getattr(resp, "status", resp.getcode())
            # Drain a small chunk so the connection closes cleanly without
            # buffering the entire docs page into memory.
            resp.read(1024)
            if 200 <= status < 400:
                return True, str(status)
            return False, f"HTTP {status}"
    except urllib.error.HTTPError as err:
        return False, f"HTTP {err.code}"
    except urllib.error.URLError as err:
        return False, f"URL error: {err.reason}"
    except TimeoutError:
        return False, f"timeout after {timeout}s"
    except Exception as err:  # noqa: BLE001 — surface everything
        return False, f"{type(err).__name__}: {err}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument(
        "--base",
        default=DEFAULT_BASE,
        help="Docs site base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="HEAD-request timeout in seconds (default: %(default)s)",
    )
    parser.add_argument(
        "--registry",
        default=None,
        help=(
            "Path to help-links.js (default: <repo>/worca-ui/app/utils/help-links.js)"
        ),
    )
    args = parser.parse_args(argv)

    registry_path = (
        Path(args.registry).resolve()
        if args.registry
        else _repo_root() / HELP_LINKS_REL
    )
    if not registry_path.is_file():
        print(f"FAIL: help-links registry not found at {registry_path}", file=sys.stderr)
        return 2

    slugs = _read_slugs(registry_path)
    if not slugs:
        print(
            f"FAIL: no slugs parsed from {registry_path} — file format may have changed",
            file=sys.stderr,
        )
        return 2

    base = args.base.rstrip("/")
    print(f"Checking {len(slugs)} help-link URL(s) on {base} …")

    failures: list[tuple[str, str]] = []
    for slug in slugs:
        url = f"{base}/{slug}/"
        ok, detail = _probe(url, args.timeout)
        mark = "ok " if ok else "FAIL"
        print(f"  [{mark}] {url}  ({detail})")
        if not ok:
            failures.append((url, detail))

    if failures:
        print()
        print(f"FAIL: {len(failures)} of {len(slugs)} help-link URL(s) not live on {base}:")
        for url, detail in failures:
            print(f"  - {url}  →  {detail}")
        print()
        print("Fix: run /worca-docs-publish to fast-forward docs-live to")
        print("master (publishes docs.worca.dev to the current master),")
        print("then re-run this check. If a slug genuinely no longer has a")
        print("doc target, remove its entry from HELP_LINKS in")
        print("worca-ui/app/utils/help-links.js (the L1 vitest will catch")
        print("orphan entries on the next PR).")
        return 1

    print()
    print(f"OK: {len(slugs)} help-link URL(s) live on {base}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
