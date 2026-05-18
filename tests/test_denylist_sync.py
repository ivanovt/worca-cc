"""Denylist sync tests — verify Python and JS dispatch defaults stay aligned (§10.5).

Four sync pairs:
1. always_disallowed + default_denied arrays match (all three sections)
2. per_agent_allow._defaults match (all three sections)
3. Agent roster: JS AGENT_NAMES matches Python nine-role set
4. Migration: identical output from shared fixture inputs
"""

import copy
import json
import re
import subprocess
from pathlib import Path

import pytest

from worca.cli.init import _migrate_dispatch_governance
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
    path = _UI_DIR / "app" / "views" / "settings.js"
    text = path.read_text()
    match = re.search(
        r"export\s+const\s+AGENT_NAMES\s*=\s*\[(.*?)\]",
        text,
        re.DOTALL,
    )
    if not match:
        raise ValueError("AGENT_NAMES not found in settings.js")
    return re.findall(r"'([^']+)'", match.group(1))


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

_MIGRATION_FIXTURES = {
    "legacy": {
        "governance": {
            "subagent_dispatch": {
                "planner": ["Explore"],
                "coordinator": [],
                "implementer": ["Explore", "feature-dev:code-reviewer"],
            },
            "_dispatch_legacy": {"old": True},
        }
    },
    "already_migrated": {
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
                        "_defaults": ["Explore"],
                        "planner": ["Explore"],
                    },
                },
            }
        }
    },
    "empty_governance": {"governance": {}},
}


def _migrate_python(fixture: dict) -> tuple[dict, bool]:
    data = copy.deepcopy(fixture)
    gov = data.setdefault("governance", {})
    changes: list[str] = []
    _migrate_dispatch_governance(gov, changes)
    return gov, len(changes) > 0


def _migrate_js(fixture: dict) -> tuple[dict, bool]:
    fixture_json = json.dumps(fixture)
    script = (
        "import { migrateDispatchGovernance } from './server/dispatch-migration.js';\n"
        f"const worca = {fixture_json};\n"
        "const changes = migrateDispatchGovernance(worca);\n"
        "console.log(JSON.stringify({"
        " governance: worca.governance || {},"
        " had_changes: changes.length > 0"
        " }));\n"
    )
    result = json.loads(_run_node(script))
    return result["governance"], result["had_changes"]


@pytest.mark.parametrize("fixture_name", list(_MIGRATION_FIXTURES.keys()))
def test_migration_output_match(fixture_name):
    fixture = _MIGRATION_FIXTURES[fixture_name]
    py_gov, py_changed = _migrate_python(fixture)
    js_gov, js_changed = _migrate_js(fixture)
    assert py_changed == js_changed, (
        f"[{fixture_name}] change detection: py={py_changed}, js={js_changed}"
    )
    assert py_gov == js_gov, (
        f"[{fixture_name}] output mismatch:\n"
        f"  Python: {json.dumps(py_gov, sort_keys=True)}\n"
        f"  JS:     {json.dumps(js_gov, sort_keys=True)}"
    )
