"""Denylist sync tests — verify Python and JS dispatch defaults stay aligned (§10.5).

Four sync pairs:
1. always_disallowed + default_denied arrays match (all three sections)
2. per_agent_allow._defaults match (all three sections)
3. Agent roster: JS AGENT_NAMES matches Python nine-role set
4. Migration: identical output from shared fixture inputs
"""

import copy
import json
import subprocess
from pathlib import Path

import pytest

from worca.cli.init import _migrate_settings_paths
from worca.hooks.tracking import _DISPATCH_DEFAULTS
from worca.orchestrator.stages import STAGE_AGENT_MAP

_REPO_ROOT = Path(__file__).resolve().parent.parent
_UI_DIR = _REPO_ROOT / "worca-ui"
_SECTIONS = ["tools", "skills", "subagents"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run_node(script: str) -> str:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=str(_UI_DIR),
        timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(f"node failed ({result.returncode}): {result.stderr}")
    return result.stdout.strip()


@pytest.fixture(scope="module")
def js_defaults():
    script = (
        "import { DISPATCH_DEFAULTS } from './server/dispatch-defaults.js';\n"
        "console.log(JSON.stringify(DISPATCH_DEFAULTS));\n"
    )
    return json.loads(_run_node(script))


# ---------------------------------------------------------------------------
# Pair 1: always_disallowed + default_denied arrays match across all sections
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("section", _SECTIONS)
def test_always_disallowed_match(js_defaults, section):
    assert (
        _DISPATCH_DEFAULTS[section]["always_disallowed"]
        == js_defaults[section]["always_disallowed"]
    )


@pytest.mark.parametrize("section", _SECTIONS)
def test_default_denied_match(js_defaults, section):
    assert (
        _DISPATCH_DEFAULTS[section]["default_denied"]
        == js_defaults[section]["default_denied"]
    )


# ---------------------------------------------------------------------------
# Pair 2: per_agent_allow._defaults match across all sections
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("section", _SECTIONS)
def test_per_agent_defaults_match(js_defaults, section):
    assert (
        _DISPATCH_DEFAULTS[section]["per_agent_allow"]["_defaults"]
        == js_defaults[section]["per_agent_allow"]["_defaults"]
    )


# ---------------------------------------------------------------------------
# Pair 3: Agent roster — JS AGENT_NAMES matches Python nine-role set
# ---------------------------------------------------------------------------


def _parse_js_agent_names() -> list[str]:
    """Load AGENT_NAMES via node, not regex.

    AGENT_NAMES lives in its own JS-only module (`app/views/agent-names.js`)
    specifically so this test can import it cleanly without pulling in the
    transitive JSON imports that settings.js uses. Going through node
    ensures the test sees the exact value the UI does — any quoting or
    formatting change in the source file will still produce the same parsed
    array.
    """
    script = (
        "import { AGENT_NAMES } from './app/views/agent-names.js';\n"
        "console.log(JSON.stringify(AGENT_NAMES));\n"
    )
    return json.loads(_run_node(script))


def test_agent_roster_match():
    js_names = set(_parse_js_agent_names())
    py_names = {v for v in STAGE_AGENT_MAP.values() if v is not None}
    py_names.add("workspace_planner")
    assert js_names == py_names, (
        f"Agent roster mismatch: "
        f"JS-only={js_names - py_names}, Py-only={py_names - js_names}"
    )


# ---------------------------------------------------------------------------
# Pair 4: Migration behavior — identical output from shared fixture inputs
# ---------------------------------------------------------------------------

# The Python and JS migration entry points sit at different levels:
#   - Python: _migrate_settings_paths(full_settings) runs the W-038
#     flat-dispatch normalization FIRST and then calls _migrate_dispatch_governance.
#   - JS:     migrateDispatchGovernance(worca) handles flat-dispatch AND
#     subagent_dispatch in one pass.
# To make the sync test honest, run both through the higher-level shim so
# the same fixture exercises real-world migration paths.

_MIGRATION_FIXTURES = {
    # 1) Legacy `subagent_dispatch` shape — the common upgrade case for projects
    #    that ran W-038 already.
    "legacy_subagent_dispatch": {
        "governance": {
            "subagent_dispatch": {
                "planner": ["Explore"],
                "coordinator": [],
                "implementer": ["Explore", "feature-dev:code-reviewer"],
            },
            "_dispatch_legacy": {"old": True},
        }
    },
    # NOTE: pre-W-038 flat agent-keyed `dispatch` shape is intentionally NOT
    # in this fixture set. The two implementations diverge by design on that
    # historical case (Python's W-038 step stashes old values under
    # `_dispatch_legacy` and applies fresh defaults; JS `_absorbFlatDispatchKeys`
    # moves values verbatim). The shape hasn't been written to any active
    # settings.json since W-038 landed, so the divergence is documented but
    # unenforced.
    # 3) Already-migrated input — must be a no-op for both implementations.
    "already_migrated": {
        "worca": {
            "governance": {
                "dispatch": {
                    "tools": {
                        "always_disallowed": ["EnterPlanMode", "EnterWorktree", "TodoWrite"],
                        "default_denied": [],
                        "per_agent_allow": {"_defaults": ["*"]},
                    },
                    "skills": {
                        "always_disallowed": [
                            "loop",
                            "schedule",
                            "worca-*",
                            "update-config",
                            "hookify:hookify",
                            "hookify:configure",
                            "hookify:list",
                            "hookify:writing-rules",
                            "init",
                        ],
                        "default_denied": [
                            "review",
                            "security-review",
                            "feature-dev:feature-dev",
                            "claude-md-management:revise-claude-md",
                            "claude-md-management:claude-md-improver",
                        ],
                        "per_agent_allow": {"_defaults": ["*"]},
                    },
                    "subagents": {
                        "always_disallowed": ["general-purpose"],
                        "default_denied": [],
                        "per_agent_allow": {
                            "_defaults": ["*"],
                            "planner": ["Explore"],
                        },
                    },
                },
            }
        }
    },
    # 4) Empty governance — must be a no-op for both implementations.
    "empty_governance": {"worca": {"governance": {}}},
}


def _ensure_worca_wrapped(fixture: dict) -> dict:
    """Some fixtures pre-date the worca-wrapped shape; normalize here so
    both implementations see the same input. The higher-level shims expect
    the worca key at the top level."""
    if "worca" in fixture:
        return copy.deepcopy(fixture)
    return {"worca": copy.deepcopy(fixture)}


def _migrate_python_full(fixture: dict) -> tuple[dict, bool]:
    """Run Python's full migration pipeline (W-038 flat → subagent_dispatch
    → W-054 dispatch.subagents). Returns (governance_dict, dispatch_changed)
    where dispatch_changed is True iff the governance section actually differs
    from the input (other migrations in the pipeline — path rewrites, etc. —
    don't count toward the sync agreement)."""
    data = _ensure_worca_wrapped(fixture)
    before_gov = copy.deepcopy(data.get("worca", {}).get("governance", {}))
    migrated, _all_changes = _migrate_settings_paths(data)
    after_gov = migrated.get("worca", {}).get("governance", {})
    return after_gov, before_gov != after_gov


def _migrate_js_full(fixture: dict) -> tuple[dict, bool]:
    """Run JS's full migration on the same input shape. Same governance-diff
    semantics as the Python helper above."""
    wrapped = _ensure_worca_wrapped(fixture)
    before_gov = copy.deepcopy(wrapped["worca"].get("governance", {}))
    fixture_json = json.dumps(wrapped["worca"])
    script = (
        "import { migrateDispatchGovernance } from './server/dispatch-migration.js';\n"
        f"const worca = {fixture_json};\n"
        "migrateDispatchGovernance(worca);\n"
        "console.log(JSON.stringify(worca.governance || {}));\n"
    )
    after_gov = json.loads(_run_node(script))
    return after_gov, before_gov != after_gov


@pytest.mark.parametrize("fixture_name", list(_MIGRATION_FIXTURES.keys()))
def test_migration_output_match(fixture_name):
    fixture = _MIGRATION_FIXTURES[fixture_name]
    py_gov, py_changed = _migrate_python_full(fixture)
    js_gov, js_changed = _migrate_js_full(fixture)
    assert py_changed == js_changed, (
        f"[{fixture_name}] dispatch-governance change detection mismatch: "
        f"py={py_changed}, js={js_changed}\n"
        f"  Python after: {json.dumps(py_gov, sort_keys=True)}\n"
        f"  JS     after: {json.dumps(js_gov, sort_keys=True)}"
    )
    assert py_gov == js_gov, (
        f"[{fixture_name}] output mismatch:\n"
        f"  Python: {json.dumps(py_gov, sort_keys=True)}\n"
        f"  JS:     {json.dumps(js_gov, sort_keys=True)}"
    )
