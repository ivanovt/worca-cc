"""Event-type sync tests — verify the JS renderer registry stays aligned with
the Python event-type constants (arch review 2026-06).

The Tier 1 chat set is *defined by* worca-ui/server/integrations/renderers.js
(docs/events.md § Chat-rendered), while the event-type vocabulary is defined
by src/worca/events/types.py. A renderer keyed on a typo'd or renamed event
type silently never fires — these tests catch that drift at CI time.

The app-side list (worca-ui/app/views/integrations.js) is codegen'd from the
renderer registry by scripts/build-frontend.js and needs no test here.
"""

import json
import re
import subprocess
from pathlib import Path

import pytest

from worca.events import types as event_types

_REPO_ROOT = Path(__file__).resolve().parent.parent
_UI_DIR = _REPO_ROOT / "worca-ui"

_DOMAIN_RE = re.compile(r"^(pipeline|control|fleet|workspace)\.")


def _python_event_types() -> set[str]:
    """All event-type string constants defined in worca.events.types."""
    return {
        v
        for k, v in vars(event_types).items()
        if k.isupper() and isinstance(v, str) and _DOMAIN_RE.match(v)
    }


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
    return result.stdout


@pytest.fixture(scope="module")
def js_renderer_keys() -> dict:
    """{'tier1': [...], 'opt_in': [...]} from the JS renderer registry."""
    script = (
        "import { TIER1_EVENTS, OPT_IN_RENDERERS } from"
        " './server/integrations/renderers.js';"
        "console.log(JSON.stringify({"
        "tier1: TIER1_EVENTS,"
        "opt_in: Object.keys(OPT_IN_RENDERERS)"
        "}));"
    )
    return json.loads(_run_node(script))


def test_python_event_types_nonempty():
    types = _python_event_types()
    assert len(types) > 50  # ~86 as of 2026-06
    assert "pipeline.run.started" in types


def test_tier1_renderer_keys_are_valid_event_types(js_renderer_keys):
    """Every Tier 1 renderer key must be a real Python event type — a typo'd
    or renamed key means the event fires but never reaches chat."""
    unknown = set(js_renderer_keys["tier1"]) - _python_event_types()
    assert not unknown, (
        f"renderers.js EVENT_RENDERERS keys not defined in "
        f"worca.events.types: {sorted(unknown)}"
    )


def test_opt_in_renderer_keys_are_valid_event_types(js_renderer_keys):
    unknown = set(js_renderer_keys["opt_in"]) - _python_event_types()
    assert not unknown, (
        f"renderers.js OPT_IN_RENDERERS keys not defined in "
        f"worca.events.types: {sorted(unknown)}"
    )


def test_tier1_and_opt_in_do_not_overlap(js_renderer_keys):
    overlap = set(js_renderer_keys["tier1"]) & set(js_renderer_keys["opt_in"])
    assert not overlap, f"event types in both registries: {sorted(overlap)}"
