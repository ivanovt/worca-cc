"""Tests for W-037 T12: worca init copies block files and reviewer.md.

Verifies that worca init / _copy_worca_source installs:
- All 8 .block.md files into agents/core/
- reviewer.md into agents/core/
- Agent .md files use {{double-brace}} syntax (not {single-brace})

The cross-project installation test is skipped when test-multi-01 is absent.
"""

import os
import pathlib

import pytest

from worca.cli.init import _copy_worca_source

CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"
WORCA_SRC = pathlib.Path(__file__).parent.parent / "src" / "worca"

BLOCK_FILES = [
    "plan.block.md",
    "plan-review.block.md",
    "coordinate.block.md",
    "implement.block.md",
    "test.block.md",
    "review.block.md",
    "pr.block.md",
    "learn.block.md",
]

AGENT_FILES = [
    "planner.md",
    "plan_reviewer.md",
    "coordinator.md",
    "implementer.md",
    "tester.md",
    "reviewer.md",
    "guardian.md",
    "learner.md",
]


# ---------------------------------------------------------------------------
# Unit: _copy_worca_source copies block files
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("block_file", BLOCK_FILES)
def test_copy_worca_source_includes_block_files(tmp_path, block_file):
    """_copy_worca_source must copy .block.md files to the target agents/core/."""
    target = tmp_path / "worca_installed"
    _copy_worca_source(WORCA_SRC, target)

    installed = target / "agents" / "core" / block_file
    assert installed.exists(), (
        f"{block_file} not found in installed agents/core/ — "
        "T12 init copy step is missing block file support"
    )


def test_copy_worca_source_includes_reviewer_md(tmp_path):
    """_copy_worca_source must copy reviewer.md to the target agents/core/."""
    target = tmp_path / "worca_installed"
    _copy_worca_source(WORCA_SRC, target)

    installed = target / "agents" / "core" / "reviewer.md"
    assert installed.exists(), (
        "reviewer.md not found in installed agents/core/ — "
        "T12 init copy step is missing reviewer agent"
    )


@pytest.mark.parametrize("agent_file", AGENT_FILES)
def test_copy_worca_source_includes_agent_files(tmp_path, agent_file):
    """_copy_worca_source must copy standard agent .md files."""
    target = tmp_path / "worca_installed"
    _copy_worca_source(WORCA_SRC, target)

    installed = target / "agents" / "core" / agent_file
    assert installed.exists(), (
        f"{agent_file} not found in installed agents/core/"
    )


# ---------------------------------------------------------------------------
# Unit: installed agent files use {{double-brace}} syntax
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("agent_file,placeholder", [
    ("planner.md", "{{plan_file}}"),
    ("coordinator.md", "{{plan_file}}"),
    ("coordinator.md", "{{run_id}}"),
])
def test_installed_agent_uses_double_brace(tmp_path, agent_file, placeholder):
    """Installed agent files must use {{double-brace}} syntax, not {single-brace}."""
    target = tmp_path / "worca_installed"
    _copy_worca_source(WORCA_SRC, target)

    content = (target / "agents" / "core" / agent_file).read_text()
    assert placeholder in content, (
        f"{agent_file}: expected {placeholder} but not found — "
        "agent file may not have been migrated to double-brace syntax"
    )


@pytest.mark.parametrize("agent_file,old_placeholder", [
    ("planner.md", "{plan_file}"),
    ("coordinator.md", "{plan_file}"),
    ("coordinator.md", "{run_id}"),
])
def test_installed_agent_no_single_brace(tmp_path, agent_file, old_placeholder):
    """Installed agent files must not contain {single-brace} placeholders."""
    target = tmp_path / "worca_installed"
    _copy_worca_source(WORCA_SRC, target)

    content = (target / "agents" / "core" / agent_file).read_text()
    # Strip double-brace occurrences to avoid false positives, then check
    stripped = content.replace("{{" + old_placeholder[1:-1] + "}}", "REMOVED")
    assert old_placeholder not in stripped, (
        f"{agent_file}: found old {old_placeholder!r} — "
        "single-brace placeholder not migrated to double-brace"
    )


# ---------------------------------------------------------------------------
# Unit: installed block files contain expected placeholders
# ---------------------------------------------------------------------------


def test_installed_plan_block_has_work_request(tmp_path):
    """Installed plan.block.md must contain {{work_request}}."""
    target = tmp_path / "worca_installed"
    _copy_worca_source(WORCA_SRC, target)
    content = (target / "agents" / "core" / "plan.block.md").read_text()
    assert "{{work_request}}" in content


def test_installed_implement_block_has_is_retry(tmp_path):
    """Installed implement.block.md must contain {{#if is_retry}}."""
    target = tmp_path / "worca_installed"
    _copy_worca_source(WORCA_SRC, target)
    content = (target / "agents" / "core" / "implement.block.md").read_text()
    assert "{{#if is_retry}}" in content


# ---------------------------------------------------------------------------
# Cross-project integration test (skipped when test project absent)
# ---------------------------------------------------------------------------

TEST_PROJECT = "/Volumes/Apps/dev/ccexperiments/test-multi-01"


WORCA_CC_ROOT = str(pathlib.Path(__file__).parent.parent)


@pytest.mark.skipif(
    not os.path.isdir(TEST_PROJECT),
    reason=f"test-multi-01 not available at {TEST_PROJECT}",
)
def test_worca_init_installs_blocks_in_test_project():
    """Install worca into test-multi-01 and verify block files land correctly.

    Uses --source to point at the dev worca-cc repo, ensuring we test the
    current (modified) source rather than any globally-installed worca package.
    """
    import subprocess

    project = pathlib.Path(TEST_PROJECT)
    worca_runtime = project / ".claude" / "worca"

    # Run worca init --upgrade using dev source so block files are included
    result = subprocess.run(
        ["python", "-m", "worca.cli.main", "init", "--upgrade", "--source", WORCA_CC_ROOT],
        cwd=str(project),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"worca init --upgrade failed:\nstdout: {result.stdout}\nstderr: {result.stderr}"
    )

    core_installed = worca_runtime / "agents" / "core"

    # Verify block files
    for block_file in BLOCK_FILES:
        installed = core_installed / block_file
        assert installed.exists(), f"{block_file} not installed in {core_installed}"

    # Verify reviewer.md
    assert (core_installed / "reviewer.md").exists(), (
        "reviewer.md not installed"
    )

    # Verify agent files contain {{block:name}} references
    planner_content = (core_installed / "planner.md").read_text()
    assert "{{block:plan}}" in planner_content, (
        "planner.md missing {{block:plan}} reference after install"
    )

    # Verify no {single-brace} in planner
    planner_stripped = planner_content.replace("{{plan_file}}", "REMOVED")
    assert "{plan_file}" not in planner_stripped, (
        "planner.md still has {plan_file} single-brace after install"
    )

    # Verify resolve_agent works against installed files
    from worca.orchestrator.overlay import OverlayResolver, resolve_agent

    resolver = OverlayResolver(overrides_dir=str(project / ".claude" / "agents"))
    agent_content = (core_installed / "planner.md").read_text()
    resolved = resolve_agent(
        agent_content,
        {"plan_file": "MASTER_PLAN.md", "work_request": "Test install", "claude_md": ""},
        resolver,
        str(core_installed),
    )

    assert "{{block:" not in resolved, "Unresolved block tokens after resolve_agent"
    assert "Test install" in resolved, "work_request not in resolved output"
    assert "MASTER_PLAN.md" in resolved, "plan_file placeholder not resolved"
