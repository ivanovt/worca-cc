"""Tests for GUIDE_CONFLICT event emission from agent stages.

Verifies that the runner emits workspace.guide_conflict events when agent
structured output includes guide_conflicts, and stays silent when it doesn't.
"""

import json
import os

import pytest

from worca.events import types
from worca.events.emitter import EventContext
from worca.orchestrator.runner import _emit_guide_conflicts


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def events_dir(tmp_path):
    """Temporary directory with an events.jsonl file."""
    return tmp_path


@pytest.fixture()
def event_ctx(events_dir):
    """Minimal EventContext that writes to a temp events.jsonl."""
    events_path = str(events_dir / "events.jsonl")
    settings_path = str(events_dir / "settings.json")
    # Write minimal settings so EventContext.__post_init__ doesn't fail
    with open(settings_path, "w") as f:
        json.dump({"worca": {}}, f)
    return EventContext(
        run_id="run-abc",
        branch="feature/test",
        work_request={"title": "test"},
        events_path=events_path,
        settings_path=settings_path,
        enabled=True,
    )


def _read_events(ctx):
    """Read all events from the JSONL file."""
    path = ctx.events_path
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


# ---------------------------------------------------------------------------
# Payload builder
# ---------------------------------------------------------------------------

class TestGuideConflictPayloadSignature:
    """Verify guide_conflict_payload matches §10.9 schema."""

    def test_required_fields(self):
        p = types.guide_conflict_payload(
            run_id="run-123",
            stage="plan",
            message="Description requests X but guide forbids it",
            source="description",
        )
        assert p["run_id"] == "run-123"
        assert p["stage"] == "plan"
        assert p["message"] == "Description requests X but guide forbids it"
        assert p["source"] == "description"

    def test_workspace_id_nullable(self):
        p = types.guide_conflict_payload(
            run_id="run-123",
            stage="review",
            message="conflict",
            source="plan",
            workspace_id="ws-456",
        )
        assert p["workspace_id"] == "ws-456"
        assert "fleet_id" not in p

    def test_fleet_id_nullable(self):
        p = types.guide_conflict_payload(
            run_id="run-123",
            stage="test",
            message="conflict",
            source="plan",
            fleet_id="f-789",
        )
        assert p["fleet_id"] == "f-789"
        assert "workspace_id" not in p

    def test_neither_workspace_nor_fleet(self):
        p = types.guide_conflict_payload(
            run_id="run-123",
            stage="plan",
            message="conflict",
            source="description",
        )
        assert "workspace_id" not in p
        assert "fleet_id" not in p

    def test_source_values(self):
        for src in ("plan", "description"):
            p = types.guide_conflict_payload(
                run_id="r", stage="s", message="m", source=src,
            )
            assert p["source"] == src


# ---------------------------------------------------------------------------
# Emission from stages via _emit_guide_conflicts helper
# ---------------------------------------------------------------------------

class TestPlannerEmitsOnDescriptionConflict:
    """Planner emits GUIDE_CONFLICT when description conflicts with guide."""

    def test_planner_emits_on_description_conflict(self, event_ctx):
        result = {
            "approach": "...",
            "guide_conflicts": [
                {
                    "message": "Description asks for plain-text tokens but guide mandates JWT",
                    "source": "description",
                },
            ],
        }
        _emit_guide_conflicts(event_ctx, "plan", result)
        events = _read_events(event_ctx)
        conflicts = [e for e in events if e["event_type"] == types.GUIDE_CONFLICT]
        assert len(conflicts) == 1
        payload = conflicts[0]["payload"]
        assert payload["stage"] == "plan"
        assert payload["source"] == "description"
        assert "JWT" in payload["message"]
        assert payload["run_id"] == "run-abc"


class TestReviewerEmitsOnPlanConflict:
    """Reviewer emits GUIDE_CONFLICT when plan diverges from guide."""

    def test_reviewer_emits_on_plan_conflict(self, event_ctx):
        result = {
            "outcome": "request_changes",
            "guide_conflicts": [
                {
                    "message": "Plan uses REST but guide mandates gRPC",
                    "source": "plan",
                },
            ],
        }
        _emit_guide_conflicts(event_ctx, "review", result)
        events = _read_events(event_ctx)
        conflicts = [e for e in events if e["event_type"] == types.GUIDE_CONFLICT]
        assert len(conflicts) == 1
        payload = conflicts[0]["payload"]
        assert payload["stage"] == "review"
        assert payload["source"] == "plan"
        assert "gRPC" in payload["message"]


class TestTesterEmitsOnPlanConflict:
    """Tester emits GUIDE_CONFLICT when plan conflicts with guide."""

    def test_tester_emits_on_plan_conflict(self, event_ctx):
        result = {
            "passed": True,
            "guide_conflicts": [
                {
                    "message": "Plan directs testing against staging but guide requires prod-like env",
                    "source": "plan",
                },
            ],
        }
        _emit_guide_conflicts(event_ctx, "test", result)
        events = _read_events(event_ctx)
        conflicts = [e for e in events if e["event_type"] == types.GUIDE_CONFLICT]
        assert len(conflicts) == 1
        payload = conflicts[0]["payload"]
        assert payload["stage"] == "test"
        assert payload["source"] == "plan"


class TestNoEmissionWhenNoConflict:
    """No GUIDE_CONFLICT event fires when agents report no conflicts."""

    def test_no_emission_when_no_conflict(self, event_ctx):
        _emit_guide_conflicts(event_ctx, "plan", {"approach": "..."})
        _emit_guide_conflicts(event_ctx, "review", {"outcome": "approve"})
        _emit_guide_conflicts(event_ctx, "test", {"passed": True})
        events = _read_events(event_ctx)
        conflicts = [e for e in events if e["event_type"] == types.GUIDE_CONFLICT]
        assert len(conflicts) == 0

    def test_no_emission_with_empty_conflicts_list(self, event_ctx):
        _emit_guide_conflicts(event_ctx, "plan", {"guide_conflicts": []})
        events = _read_events(event_ctx)
        conflicts = [e for e in events if e["event_type"] == types.GUIDE_CONFLICT]
        assert len(conflicts) == 0

    def test_no_emission_when_ctx_is_none(self):
        """Runner passes ctx=None when events are disabled."""
        _emit_guide_conflicts(None, "plan", {
            "guide_conflicts": [{"message": "x", "source": "description"}],
        })


class TestMultipleConflicts:
    """Multiple conflicts in a single stage result each get their own event."""

    def test_multiple_conflicts(self, event_ctx):
        result = {
            "guide_conflicts": [
                {"message": "First conflict", "source": "description"},
                {"message": "Second conflict", "source": "plan"},
            ],
        }
        _emit_guide_conflicts(event_ctx, "review", result)
        events = _read_events(event_ctx)
        conflicts = [e for e in events if e["event_type"] == types.GUIDE_CONFLICT]
        assert len(conflicts) == 2
        assert conflicts[0]["payload"]["source"] == "description"
        assert conflicts[1]["payload"]["source"] == "plan"


# ---------------------------------------------------------------------------
# Schema validation — guide_conflicts field in agent output schemas
# ---------------------------------------------------------------------------

class TestSchemaHasGuideConflicts:
    """Each agent schema accepts guide_conflicts array."""

    @pytest.fixture(autouse=True)
    def _load_schemas(self):
        schemas_dir = os.path.join(
            os.path.dirname(__file__), os.pardir, "src", "worca", "schemas",
        )
        self.schemas = {}
        for name in ("plan", "review", "test_result"):
            path = os.path.join(schemas_dir, f"{name}.json")
            with open(path) as f:
                self.schemas[name] = json.load(f)

    def test_plan_schema_has_guide_conflicts(self):
        props = self.schemas["plan"]["properties"]
        assert "guide_conflicts" in props
        assert props["guide_conflicts"]["type"] == "array"

    def test_review_schema_has_guide_conflicts(self):
        props = self.schemas["review"]["properties"]
        assert "guide_conflicts" in props
        assert props["guide_conflicts"]["type"] == "array"

    def test_test_result_schema_has_guide_conflicts(self):
        props = self.schemas["test_result"]["properties"]
        assert "guide_conflicts" in props
        assert props["guide_conflicts"]["type"] == "array"

    def test_conflict_item_has_message_and_source(self):
        for name in ("plan", "review", "test_result"):
            items = self.schemas[name]["properties"]["guide_conflicts"]["items"]
            item_props = items["properties"]
            assert "message" in item_props
            assert "source" in item_props
            assert item_props["source"]["enum"] == ["plan", "description"]


# ---------------------------------------------------------------------------
# Agent template validation — emission instructions present
# ---------------------------------------------------------------------------

class TestAgentTemplateEmissionInstructions:
    """Agent templates instruct agents to populate guide_conflicts."""

    @pytest.fixture(autouse=True)
    def _load_templates(self):
        agents_dir = os.path.join(
            os.path.dirname(__file__), os.pardir, "src", "worca", "agents", "core",
        )
        self.templates = {}
        for name in ("planner", "reviewer", "tester"):
            path = os.path.join(agents_dir, f"{name}.md")
            with open(path) as f:
                self.templates[name] = f.read()

    def test_planner_has_guide_conflicts_emission(self):
        assert "guide_conflicts" in self.templates["planner"]

    def test_reviewer_has_guide_conflicts_emission(self):
        assert "guide_conflicts" in self.templates["reviewer"]

    def test_tester_has_guide_conflicts_emission(self):
        assert "guide_conflicts" in self.templates["tester"]
