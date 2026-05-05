#!/usr/bin/env python3
"""Centralized coverage workflow runner for worca-cc.

Wraps the standard ``coverage`` CLI so dev and CI invoke a single command
instead of remembering the clean / run / combine / report dance. Cross-platform
(no shell globs, no env-var quoting), and emits machine-parseable JSON for
downstream tooling — eventually the W-050 Phase 8 threshold gate.

Subcommands
-----------
- ``run``      Clean stale coverage state, then run pytest under
               WORCA_COVERAGE=1 so each pipeline subprocess writes a
               ``.coverage.<host>.<pid>.<rand>`` fragment.
- ``combine``  Merge fragments into ``.coverage`` (idempotent — no-op when
               there are no fragments).
- ``report``   Emit a coverage report. ``--format`` selects text (default),
               json, html, or xml. The json variant is augmented with an
               ``omitted`` list and a per-module summary so consumers don't
               have to re-derive them from the raw coverage output.
- ``compare``  Diff a current coverage.json against a saved baseline,
               printing per-module pp deltas. Exits 0 always (no gating
               during W-050; threshold enforcement is Phase 8).
- ``ci``       run + combine + json + xml + text in one shot. Returns the
               pytest exit code so CI can fail on test regressions while
               still uploading coverage artifacts.

Examples
--------
    # Local: full sweep
    python scripts/coverage.py ci

    # Just refresh a focused JSON for a single test file
    python scripts/coverage.py run --target=tests/integration/test_governance_hooks_live.py
    python scripts/coverage.py combine
    python scripts/coverage.py report --format=json --out=cov.json

    # Compare two saved JSONs
    python scripts/coverage.py compare --baseline=before.json --current=after.json
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
COVERAGE_DB = REPO_ROOT / ".coverage"
COVERAGERC = REPO_ROOT / ".coveragerc"
SRC_DIR = REPO_ROOT / "src" / "worca"


# ---------------------------------------------------------------------------
# Internal helpers (used by both subcommand handlers and `ci` chain)
# ---------------------------------------------------------------------------


def _info(msg: str) -> None:
    """Print a runner status line to stderr (stdout is reserved for reports)."""
    print(f"[coverage] {msg}", file=sys.stderr)


def _erase() -> None:
    """Remove the combined .coverage db and any leftover .coverage.* fragments."""
    if COVERAGE_DB.exists():
        COVERAGE_DB.unlink()
    for frag in REPO_ROOT.glob(".coverage.*"):
        frag.unlink()


def _count_fragments() -> int:
    return len(list(REPO_ROOT.glob(".coverage.*")))


def _run_pytest(target: str, timeout: str, extra: list[str] | None = None) -> int:
    env = dict(os.environ)
    env["WORCA_COVERAGE"] = "1"
    cmd = [sys.executable, "-m", "pytest", target, f"--timeout={timeout}"]
    if extra:
        cmd.extend(extra)
    _info(f"running: {' '.join(cmd)}")
    return subprocess.run(cmd, cwd=REPO_ROOT, env=env).returncode


def _combine() -> int:
    fragments = _count_fragments()
    if fragments == 0:
        _info("no fragments to combine")
        return 0
    _info(f"combining {fragments} fragments")
    # `coverage combine` refuses to overwrite an existing combined db — clear
    # it first so reruns are deterministic.
    if COVERAGE_DB.exists():
        COVERAGE_DB.unlink()
    return subprocess.run(
        [sys.executable, "-m", "coverage", "combine", f"--rcfile={COVERAGERC}"],
        cwd=REPO_ROOT,
    ).returncode


def _report_text(include: str | None = None) -> int:
    cmd = [sys.executable, "-m", "coverage", "report", f"--rcfile={COVERAGERC}"]
    if include:
        cmd.append(f"--include={include}")
    return subprocess.run(cmd, cwd=REPO_ROOT).returncode


def _report_html(out_dir: str | None) -> int:
    cmd = [sys.executable, "-m", "coverage", "html", f"--rcfile={COVERAGERC}"]
    if out_dir:
        cmd.extend(["-d", str(out_dir)])
    return subprocess.run(cmd, cwd=REPO_ROOT).returncode


def _report_xml(out_path: str | None) -> int:
    cmd = [sys.executable, "-m", "coverage", "xml", f"--rcfile={COVERAGERC}"]
    if out_path:
        cmd.extend(["-o", str(out_path)])
    return subprocess.run(cmd, cwd=REPO_ROOT).returncode


def _report_json(out_path: str) -> int:
    rc = subprocess.run(
        [sys.executable, "-m", "coverage", "json", f"--rcfile={COVERAGERC}",
         "-o", str(out_path)],
        cwd=REPO_ROOT,
    ).returncode
    if rc == 0:
        _augment_json(Path(out_path))
    return rc


def _augment_json(path: Path) -> None:
    """Rewrite a ``coverage json`` output with a richer top-level shape.

    The native shape is ``{meta, files, totals}`` — useful but verbose. We
    flatten the bits downstream consumers actually want into a top-level
    summary, a per-module map keyed by relative path, and a list of source
    files that were excluded by .coveragerc (so a measurement gap like the
    pre-2026-05 test_gate.py omission shows up as data, not silence).
    """
    raw = json.loads(path.read_text())
    files = raw.get("files", {})
    totals = raw.get("totals", {})

    modules: dict[str, dict] = {}
    for filepath, data in files.items():
        s = data.get("summary", {})
        modules[filepath] = {
            "line_pct": round(s.get("percent_covered", 0.0), 1),
            "stmts": s.get("num_statements", 0),
            "covered": s.get("covered_lines", 0),
            "missed": s.get("missing_lines", 0),
            "branches": s.get("num_branches", 0),
            "covered_branches": s.get("covered_branches", 0),
            "missing_branches": s.get("missing_branches", 0),
        }

    measured = set(files.keys())
    omitted: list[str] = []
    if SRC_DIR.is_dir():
        for py in sorted(SRC_DIR.rglob("*.py")):
            if "__pycache__" in py.parts:
                continue
            rel = str(py.relative_to(REPO_ROOT))
            if rel not in measured:
                omitted.append(rel)

    augmented = {
        "summary": {
            "line_pct": round(totals.get("percent_covered", 0.0), 1),
            "stmts": totals.get("num_statements", 0),
            "covered": totals.get("covered_lines", 0),
            "missed": totals.get("missing_lines", 0),
            "branches": totals.get("num_branches", 0),
            "covered_branches": totals.get("covered_branches", 0),
            "missing_branches": totals.get("missing_branches", 0),
        },
        "modules": modules,
        "omitted": omitted,
        "raw": raw,
    }
    path.write_text(json.dumps(augmented, indent=2))


# ---------------------------------------------------------------------------
# Subcommand handlers
# ---------------------------------------------------------------------------


def cmd_run(args: argparse.Namespace) -> int:
    _erase()
    return _run_pytest(args.target, args.timeout, args.extra)


def cmd_combine(_args: argparse.Namespace) -> int:
    return _combine()


def cmd_report(args: argparse.Namespace) -> int:
    if args.format == "text":
        return _report_text(args.include)
    if args.format == "html":
        return _report_html(args.out)
    if args.format == "xml":
        return _report_xml(args.out)
    if args.format == "json":
        return _report_json(args.out or "coverage.json")
    return 2  # argparse should have rejected this already


def cmd_compare(args: argparse.Namespace) -> int:
    base = json.loads(Path(args.baseline).read_text())
    cur_path = args.current or "coverage.json"
    cur = json.loads(Path(cur_path).read_text())

    base_mods = base.get("modules", {})
    cur_mods = cur.get("modules", {})

    print(f"{'Module':<60} {'Base':>8} {'Cur':>8} {'Delta':>9}")
    print("-" * 87)
    rows = []
    for mod in sorted(set(base_mods) | set(cur_mods)):
        b = base_mods.get(mod, {}).get("line_pct", 0.0)
        c = cur_mods.get(mod, {}).get("line_pct", 0.0)
        rows.append((mod, b, c, c - b))

    # Show only modules whose pp delta is meaningful — keeps output readable
    # on big projects. Always print the totals line at the end regardless.
    for mod, b, c, d in rows:
        if abs(d) < 0.1:
            continue
        sign = "+" if d > 0 else ""
        print(f"{mod:<60} {b:>7.1f}% {c:>7.1f}% {sign}{d:>6.1f}pp")
    print("-" * 87)
    bs = base.get("summary", {}).get("line_pct", 0.0)
    cs = cur.get("summary", {}).get("line_pct", 0.0)
    sign = "+" if (cs - bs) > 0 else ""
    print(f"{'TOTAL':<60} {bs:>7.1f}% {cs:>7.1f}% {sign}{cs - bs:>6.1f}pp")

    new_omitted = set(cur.get("omitted", [])) - set(base.get("omitted", []))
    dropped_omitted = set(base.get("omitted", [])) - set(cur.get("omitted", []))
    if new_omitted:
        print("\nNewly omitted (vs baseline):")
        for f in sorted(new_omitted):
            print(f"  + {f}")
    if dropped_omitted:
        print("\nNo longer omitted (vs baseline):")
        for f in sorted(dropped_omitted):
            print(f"  - {f}")

    return 0


def cmd_ci(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rc = _run_pytest(args.target, args.timeout, args.extra)
    if rc != 0:
        _info(f"pytest failed (rc={rc}); continuing to combine + report")

    _combine()
    _report_json(str(out_dir / "coverage.json"))
    _report_xml(str(out_dir / "coverage.xml"))
    _info(f"wrote {out_dir / 'coverage.json'} and {out_dir / 'coverage.xml'}")
    print()  # blank line between runner chatter and the text report
    _report_text(args.include)

    # Forward the pytest exit code so CI surfaces real test failures.
    return rc


# ---------------------------------------------------------------------------
# Argparse wiring
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scripts/coverage.py",
        description=__doc__.splitlines()[0],
    )
    subs = parser.add_subparsers(dest="cmd", required=True)

    p_run = subs.add_parser("run", help="Run pytest under WORCA_COVERAGE=1")
    p_run.add_argument("--target", default="tests/integration/")
    p_run.add_argument("--timeout", default="180")
    p_run.add_argument("--extra", nargs=argparse.REMAINDER,
                       help="Extra args forwarded to pytest after `--`")
    p_run.set_defaults(func=cmd_run)

    p_combine = subs.add_parser("combine", help="Merge .coverage.* fragments")
    p_combine.set_defaults(func=cmd_combine)

    p_report = subs.add_parser("report", help="Render a coverage report")
    p_report.add_argument("--format", choices=["text", "json", "html", "xml"],
                          default="text")
    p_report.add_argument("--out", help="Output path (file or dir for html)")
    p_report.add_argument("--include", help="Glob filter for the modules shown")
    p_report.set_defaults(func=cmd_report)

    p_cmp = subs.add_parser("compare",
                             help="Diff a current coverage.json vs baseline")
    p_cmp.add_argument("--baseline", required=True,
                       help="Path to a baseline coverage.json")
    p_cmp.add_argument("--current",
                       help="Path to the current coverage.json (default: coverage.json)")
    p_cmp.set_defaults(func=cmd_compare)

    p_ci = subs.add_parser("ci", help="run + combine + json + xml + text")
    p_ci.add_argument("--target", default="tests/integration/")
    p_ci.add_argument("--timeout", default="180")
    p_ci.add_argument("--out-dir", default="coverage-out",
                      help="Where to write coverage.json / coverage.xml")
    p_ci.add_argument("--include",
                      help="Glob filter for the final text report only")
    p_ci.add_argument("--extra", nargs=argparse.REMAINDER,
                      help="Extra args forwarded to pytest after `--`")
    p_ci.set_defaults(func=cmd_ci)

    return parser


def main() -> int:
    args = _build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
