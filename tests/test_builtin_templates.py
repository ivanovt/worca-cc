"""Tests for W-037 T7: Builtin pipeline templates use append mode + Phase 1
template completeness regression.

Verifies:
- All template agent overlay files start with <!-- append -->
- Each overlay has at least one ## Override: section
- Appending the overlay onto its core agent preserves {{block:name}} references
- Appending the overlay preserves governance-protected sections
- Every built-in declares every TEMPLATE_OWNED_KEYS block (except
  governance.dispatch); Phase 1 strips these from project Settings, so a
  sparse built-in would silently fall through to code defaults.
- Built-ins do not declare CROSS_TEMPLATE_CARVEOUTS (e.g. stages.preflight).
"""

import json
import pathlib

import pytest

from worca.orchestrator.overlay import OverlayResolver
from worca.orchestrator.templates import (
    CROSS_TEMPLATE_CARVEOUTS,
    TEMPLATE_OWNED_KEYS,
)

TEMPLATES_DIR = (
    pathlib.Path(__file__).parent.parent / "src" / "worca" / "templates"
)
CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"

# All expected template overlay files: (template_id, agent_name)
TEMPLATE_OVERLAYS = [
    ("bugfix", "planner"),
    ("bugfix", "coordinator"),
    ("refactor", "planner"),
    ("refactor", "reviewer"),
    ("quick-fix", "planner"),
    ("quick-fix", "coordinator"),
    ("investigate", "planner"),
    ("test-only", "planner"),
    ("test-only", "coordinator"),
    ("test-only", "implementer"),
]

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


# ---------------------------------------------------------------------------
# Phase 1: built-ins must be complete for every template-owned key.
#
# Because Phase 1 strips TEMPLATE_OWNED_KEYS from project Settings before the
# template applies, a sparse built-in would silently fall through to code
# defaults for the keys it omits. Built-ins must therefore declare every
# template-owned key explicitly. governance.dispatch is exempt — its shipped
# defaults are extensive and built-ins rely on the runtime fallback.
# ---------------------------------------------------------------------------


_BUILTIN_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "templates"
_DISPATCH_PATH = ("governance", "dispatch")


def _all_builtin_ids():
    return sorted(
        sub.name
        for sub in _BUILTIN_DIR.iterdir()
        if sub.is_dir() and (sub / "template.json").is_file()
    )


def _load_template_config(builtin_id: str) -> dict:
    return json.loads((_BUILTIN_DIR / builtin_id / "template.json").read_text())["config"]


@pytest.mark.parametrize("builtin_id", _all_builtin_ids())
def test_builtin_declares_every_template_owned_block(builtin_id):
    """Each built-in must set every TEMPLATE_OWNED_KEYS path (except
    governance.dispatch). Catches new built-ins that ship sparse configs."""
    cfg = _load_template_config(builtin_id)
    for path in TEMPLATE_OWNED_KEYS:
        if path == _DISPATCH_PATH:
            continue
        node = cfg
        for segment in path:
            assert isinstance(node, dict), (
                f"{builtin_id}: expected dict at path {path[:path.index(segment)+1]}, got {type(node).__name__}"
            )
            assert segment in node, (
                f"{builtin_id}: missing template-owned key {path} — Phase 1 strips "
                f"this block from project Settings before the template applies, so the "
                f"template must declare it (or every project loses values for it on launch)."
            )
            node = node[segment]


@pytest.mark.parametrize("builtin_id", _all_builtin_ids())
def test_builtin_does_not_declare_cross_template_carveouts(builtin_id):
    """Built-ins should not freeze cross-template carve-outs like
    stages.preflight — those are project-machine concerns and must keep
    flowing through from project Settings on every run."""
    cfg = _load_template_config(builtin_id)
    for path in CROSS_TEMPLATE_CARVEOUTS:
        node = cfg
        for segment in path:
            if not isinstance(node, dict) or segment not in node:
                node = None
                break
            node = node[segment]
        assert node is None, (
            f"{builtin_id}: declares cross-template carve-out {path} — should be omitted "
            f"so the project's Settings value keeps applying."
        )


def test_every_builtin_declares_full_agents_set():
    """`worca.agents` must enumerate every agent the orchestrator knows about,
    so picking a built-in template doesn't silently lose per-agent config for
    the agents it didn't bother to list."""
    from worca.orchestrator.templates import TEMPLATE_OWNED_KEYS as _  # noqa: F401

    # Source of truth: the shipped settings.json's agents block.
    shipped = json.loads(
        (pathlib.Path(__file__).parent.parent / "src" / "worca" / "settings.json").read_text()
    )["worca"]["agents"]
    expected_agents = set(shipped.keys())

    for builtin_id in _all_builtin_ids():
        cfg = _load_template_config(builtin_id)
        actual = set((cfg.get("agents") or {}).keys())
        missing = expected_agents - actual
        assert not missing, (
            f"{builtin_id}: missing agents {sorted(missing)} — every built-in must "
            f"enumerate the full agent set (planner, coordinator, implementer, tester, "
            f"reviewer, guardian, learner, plan_reviewer)."
        )
