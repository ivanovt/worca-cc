"""Tests for W-037 T7: Builtin pipeline templates use append mode.

Verifies:
- All template agent overlay files start with <!-- append -->
- Each overlay has at least one ## Override: section
- Appending the overlay onto its core agent preserves {{block:name}} references
- Appending the overlay preserves governance-protected sections
"""

import pathlib

import pytest

from worca.orchestrator.overlay import OverlayResolver

TEMPLATES_DIR = (
    pathlib.Path(__file__).parent.parent / "src" / "worca" / "templates"
)
CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"

# All expected template overlay files: (template_id, agent_name)
TEMPLATE_OVERLAYS = [
    ("bugfix", "planner"),
    ("bugfix", "coordinator"),
    ("refactor", "planner"),
    ("refactor", "guardian"),
    ("quick-fix", "planner"),
    ("quick-fix", "coordinator"),
    ("investigate", "planner"),
    ("test-only", "planner"),
    ("test-only", "coordinator"),
    ("test-only", "implementer"),
]

# Core agent files that have {{block:...}} references, per agent name
BLOCK_REFS = {
    "planner": "{{block:plan}}",
    "coordinator": "{{block:coordinate}}",
    "guardian": "{{block:pr}}",
    "implementer": "{{block:implement}}",
}

# Governance marker used in core agent files
GOVERNANCE_MARKER = "<!-- governance -->"


def _read(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8")


def _overlay_path(template_id: str, agent_name: str) -> pathlib.Path:
    return TEMPLATES_DIR / template_id / "agents" / f"{agent_name}.md"


def _core_path(agent_name: str) -> pathlib.Path:
    return CORE_DIR / f"{agent_name}.md"


# ---------------------------------------------------------------------------
# Structural: overlay files exist and use append mode
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("template_id,agent_name", TEMPLATE_OVERLAYS)
def test_template_overlay_file_exists(template_id, agent_name):
    path = _overlay_path(template_id, agent_name)
    assert path.exists(), f"Missing overlay: {path}"


@pytest.mark.parametrize("template_id,agent_name", TEMPLATE_OVERLAYS)
def test_template_overlay_uses_append_mode(template_id, agent_name):
    content = _read(_overlay_path(template_id, agent_name))
    first_line = content.split("\n", 1)[0].strip()
    assert first_line == "<!-- append -->", (
        f"{template_id}/{agent_name}.md: expected first line '<!-- append -->', "
        f"got {first_line!r}"
    )


@pytest.mark.parametrize("template_id,agent_name", TEMPLATE_OVERLAYS)
def test_template_overlay_has_override_sections(template_id, agent_name):
    content = _read(_overlay_path(template_id, agent_name))
    assert "## Override:" in content, (
        f"{template_id}/{agent_name}.md: no '## Override:' section found"
    )


# ---------------------------------------------------------------------------
# Integration: appending overlay onto core agent
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("template_id,agent_name", TEMPLATE_OVERLAYS)
def test_template_overlay_preserves_block_refs(template_id, agent_name, tmp_path):
    """After appending the template overlay, {{block:name}} refs from core remain."""
    if agent_name not in BLOCK_REFS:
        pytest.skip(f"No known block ref for agent '{agent_name}'")

    core_content = _read(_core_path(agent_name))
    block_ref = BLOCK_REFS[agent_name]
    if block_ref not in core_content:
        pytest.skip(f"Core {agent_name}.md doesn't contain {block_ref}")

    # Apply overlay via OverlayResolver using an empty project overrides dir
    overrides_dir = str(tmp_path / "no_project_overrides")
    resolver = OverlayResolver(overrides_dir=overrides_dir)
    template_agents_dir = str(TEMPLATES_DIR / template_id / "agents")

    resolved = resolver.resolve(agent_name, core_content, template_agents_dir)

    assert block_ref in resolved, (
        f"After applying {template_id}/{agent_name}.md overlay, "
        f"{block_ref} was lost from resolved output"
    )


@pytest.mark.parametrize("template_id,agent_name", TEMPLATE_OVERLAYS)
def test_template_overlay_preserves_governance(template_id, agent_name, tmp_path):
    """After appending the template overlay, governance-marked sections survive."""
    core_content = _read(_core_path(agent_name))
    if GOVERNANCE_MARKER not in core_content:
        pytest.skip(f"Core {agent_name}.md has no governance section")

    overrides_dir = str(tmp_path / "no_project_overrides")
    resolver = OverlayResolver(overrides_dir=overrides_dir)
    template_agents_dir = str(TEMPLATES_DIR / template_id / "agents")

    resolved = resolver.resolve(agent_name, core_content, template_agents_dir)

    assert GOVERNANCE_MARKER in resolved, (
        f"After applying {template_id}/{agent_name}.md overlay, "
        f"<!-- governance --> marker was lost"
    )


@pytest.mark.parametrize("template_id,agent_name", TEMPLATE_OVERLAYS)
def test_template_overlay_content_appears_in_resolved(template_id, agent_name, tmp_path):
    """Override content from the template actually appears in the resolved output."""
    core_content = _read(_core_path(agent_name))
    overlay_content = _read(_overlay_path(template_id, agent_name))

    # Extract first override section body text (a short unique phrase)
    import re
    override_bodies = re.split(r"^## Override:\s*.+$", overlay_content, flags=re.MULTILINE)
    # override_bodies[0] is the preamble (<!-- append -->), rest are section bodies
    non_empty = [b.strip() for b in override_bodies[1:] if b.strip()]
    if not non_empty:
        pytest.skip(f"No override body text in {template_id}/{agent_name}.md")

    # Take first line of first section body as the probe phrase
    probe = non_empty[0].split("\n")[0].strip()
    if not probe:
        pytest.skip("First override body line is empty")

    overrides_dir = str(tmp_path / "no_project_overrides")
    resolver = OverlayResolver(overrides_dir=overrides_dir)
    template_agents_dir = str(TEMPLATES_DIR / template_id / "agents")

    resolved = resolver.resolve(agent_name, core_content, template_agents_dir)

    assert probe in resolved, (
        f"Override content from {template_id}/{agent_name}.md not found in resolved output. "
        f"Expected to find: {probe!r}"
    )
