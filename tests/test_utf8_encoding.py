"""Tests that source files reading .md templates specify encoding='utf-8'.

On Windows, Path.read_text() / open() default to cp1252, so reading UTF-8
files with em-dashes or ellipses either raises UnicodeDecodeError or silently
produces mojibake. These tests verify the fix is in place.
"""

import ast
import pathlib
import subprocess

import pytest

SRC_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca"
_REPO_ROOT = SRC_DIR.parent.parent

# Linux-only /proc reads — no encoding needed (not on Windows)
_PROC_FS_EXCEPTIONS = {
    ("proc_registry.py", 166),  # /proc/stat
    ("proc_registry.py", 172),  # /proc/uptime
}


def _committed_src_snapshot():
    """Map {abs Path -> source} for every tracked ``src/worca/**/*.py``, read
    from the **committed HEAD blob** rather than the working tree.

    This guard verifies the *authored* source specifies ``encoding=``. Reading
    git blobs (immutable for the duration of the run) makes it immune to
    anything that rewrites a src file mid-run — observed in CI as a transient
    rewrite of ``cli/templates.py`` by another test that no in-process snapshot
    could dodge (it happens before this module is even imported). The polluter
    itself is tracked in issue #233. Falls back to the working tree outside a
    git checkout.
    """
    # `-c safe.directory=*` defuses git's "dubious ownership" guard, which
    # otherwise makes these subprocess calls fail on CI runners (the checkout
    # dir is owned by a different uid) and silently degrade to the working tree.
    base = ["git", "-c", "safe.directory=*", "-C", str(_REPO_ROOT)]
    try:
        listing = subprocess.run(
            [*base, "ls-files", "src/worca"],
            capture_output=True, text=True, check=True,
        ).stdout
        rels = [ln for ln in listing.splitlines() if ln.endswith(".py")]
        if not rels:
            return None
        snap = {}
        for rel in rels:
            blob = subprocess.run(
                [*base, "show", f"HEAD:{rel}"],
                capture_output=True, text=True, encoding="utf-8", check=True,
            ).stdout
            snap[_REPO_ROOT / rel] = blob
        return snap
    except Exception:
        # git unavailable — signal the guard to skip rather than scan the
        # (potentially mid-run-polluted) working tree and false-positive.
        return None


_SRC_SNAPSHOT = _committed_src_snapshot()
_SRC_FILES = sorted(_SRC_SNAPSHOT) if _SRC_SNAPSHOT else []


def _is_binary_mode(node: ast.Call) -> bool:
    """Check if an open() call uses binary mode ('rb', 'wb', etc.)."""
    if node.args and len(node.args) >= 2:
        mode_arg = node.args[1]
        if isinstance(mode_arg, ast.Constant) and isinstance(mode_arg.value, str):
            return "b" in mode_arg.value
    for kw in node.keywords:
        if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
            if isinstance(kw.value.value, str) and "b" in kw.value.value:
                return True
    return False


def _open_calls_in_file(path: pathlib.Path):
    """Yield (lineno, has_encoding) for every text-mode open() call."""
    source = _SRC_SNAPSHOT[path]
    tree = ast.parse(source, filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id == "open":
            if _is_binary_mode(node):
                continue
            has_enc = any(kw.arg == "encoding" for kw in node.keywords)
            yield node.lineno, has_enc


def _fdopen_calls_in_file(path: pathlib.Path):
    """Yield (lineno, has_encoding) for every text-mode os.fdopen() call."""
    source = _SRC_SNAPSHOT[path]
    tree = ast.parse(source, filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and func.attr == "fdopen"
            and isinstance(func.value, ast.Name)
            and func.value.id == "os"
        ):
            if _is_binary_mode(node):
                continue
            has_enc = any(kw.arg == "encoding" for kw in node.keywords)
            yield node.lineno, has_enc


def _read_text_calls_in_file(path: pathlib.Path):
    """Yield (lineno, has_encoding) for every .read_text() call."""
    source = _SRC_SNAPSHOT[path]
    tree = ast.parse(source, filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "read_text":
            has_enc = any(kw.arg == "encoding" for kw in node.keywords)
            yield node.lineno, has_enc


def _write_text_calls_in_file(path: pathlib.Path):
    """Yield (lineno, has_encoding) for every .write_text() call."""
    source = _SRC_SNAPSHOT[path]
    tree = ast.parse(source, filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "write_text":
            has_enc = any(kw.arg == "encoding" for kw in node.keywords)
            yield node.lineno, has_enc


class TestOverlayEncoding:
    def test_core_path_open_has_encoding(self):
        src = (SRC_DIR / "orchestrator" / "overlay.py").read_text(encoding="utf-8")
        assert 'encoding="utf-8"' in src or "encoding='utf-8'" in src

    def test_no_bare_open_for_md_reads(self):
        path = SRC_DIR / "orchestrator" / "overlay.py"
        for lineno, has_enc in _open_calls_in_file(path):
            assert has_enc, (
                f"overlay.py:{lineno} — open() without encoding= "
                "(will mis-decode UTF-8 on Windows cp1252)"
            )


class TestPromptBuilderEncoding:
    def test_claude_md_open_has_encoding(self):
        src = (SRC_DIR / "orchestrator" / "prompt_builder.py").read_text(encoding="utf-8")
        assert 'encoding="utf-8"' in src or "encoding='utf-8'" in src

    def test_no_bare_open_for_text_reads(self):
        path = SRC_DIR / "orchestrator" / "prompt_builder.py"
        for lineno, has_enc in _open_calls_in_file(path):
            assert has_enc, (
                f"prompt_builder.py:{lineno} — open() without encoding= "
                "(will mis-decode UTF-8 on Windows cp1252)"
            )


class TestTemplatesEncoding:
    def test_manifest_read_text_has_encoding(self):
        src = (SRC_DIR / "orchestrator" / "templates.py").read_text(encoding="utf-8")
        assert "read_text(encoding=" in src


class TestTestHelperEncoding:
    """Test files that read .md files must also use encoding='utf-8'."""

    def test_fleet_docs_read_text_has_encoding(self):
        src = pathlib.Path(__file__).parent.joinpath(
            "test_fleet_docs.py"
        ).read_text(encoding="utf-8")
        assert 'encoding="utf-8"' in src or "encoding='utf-8'" in src

    def test_agent_md_refs_read_text_has_encoding(self):
        src = pathlib.Path(__file__).parent.joinpath(
            "test_agent_md_refs.py"
        ).read_text(encoding="utf-8")
        assert 'encoding="utf-8"' in src or "encoding='utf-8'" in src

    def test_investigate_template_read_text_has_encoding(self):
        src = pathlib.Path(__file__).parent.joinpath(
            "test_investigate_template.py"
        ).read_text(encoding="utf-8")
        assert 'encoding="utf-8"' in src or "encoding='utf-8'" in src


@pytest.mark.skipif(
    not _SRC_SNAPSHOT,
    reason="committed-source scan needs git; skipped to avoid working-tree false-positives",
)
class TestBroadUTF8Sweep:
    """Every text-mode open/fdopen/read_text/write_text in src/worca/ must
    specify encoding='utf-8' to avoid cp1252 mojibake on Windows."""

    def test_no_bare_open_in_src_worca(self):
        violations = []
        for py_file in _SRC_FILES:
            fname = py_file.name
            for lineno, has_enc in _open_calls_in_file(py_file):
                if (fname, lineno) in _PROC_FS_EXCEPTIONS:
                    continue
                if not has_enc:
                    rel = py_file.relative_to(SRC_DIR)
                    violations.append(f"{rel}:{lineno}")
        assert not violations, (
            f"open() without encoding= found in {len(violations)} location(s):\n"
            + "\n".join(f"  {v}" for v in violations)
        )

    def test_no_bare_fdopen_in_src_worca(self):
        violations = []
        for py_file in _SRC_FILES:
            for lineno, has_enc in _fdopen_calls_in_file(py_file):
                if not has_enc:
                    rel = py_file.relative_to(SRC_DIR)
                    violations.append(f"{rel}:{lineno}")
        assert not violations, (
            f"os.fdopen() without encoding= found in {len(violations)} location(s):\n"
            + "\n".join(f"  {v}" for v in violations)
        )

    def test_no_bare_read_text_in_src_worca(self):
        violations = []
        for py_file in _SRC_FILES:
            for lineno, has_enc in _read_text_calls_in_file(py_file):
                if not has_enc:
                    rel = py_file.relative_to(SRC_DIR)
                    violations.append(f"{rel}:{lineno}")
        assert not violations, (
            f".read_text() without encoding= found in {len(violations)} location(s):\n"
            + "\n".join(f"  {v}" for v in violations)
        )

    def test_no_bare_write_text_in_src_worca(self):
        violations = []
        for py_file in _SRC_FILES:
            for lineno, has_enc in _write_text_calls_in_file(py_file):
                if not has_enc:
                    rel = py_file.relative_to(SRC_DIR)
                    violations.append(f"{rel}:{lineno}")
        assert not violations, (
            f".write_text() without encoding= found in {len(violations)} location(s):\n"
            + "\n".join(f"  {v}" for v in violations)
        )
