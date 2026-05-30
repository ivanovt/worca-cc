"""Pipeline stage definitions and transition validation."""
from enum import Enum

from worca.utils.settings import load_settings, resolve_model


class Stage(Enum):
    """Pipeline stages in order."""
    PREFLIGHT = "preflight"
    PLAN = "plan"
    PLAN_REVIEW = "plan_review"
    COORDINATE = "coordinate"
    IMPLEMENT = "implement"
    TEST = "test"
    REVIEW = "review"
    PR = "pr"
    LEARN = "learn"


TRANSITIONS = {
    Stage.PREFLIGHT: {Stage.PLAN},
    Stage.PLAN: {Stage.PLAN_REVIEW, Stage.COORDINATE},
    Stage.PLAN_REVIEW: {Stage.COORDINATE, Stage.PLAN},
    Stage.COORDINATE: {Stage.IMPLEMENT},
    Stage.IMPLEMENT: {Stage.TEST},
    Stage.TEST: {Stage.REVIEW, Stage.IMPLEMENT},
    Stage.REVIEW: {Stage.PR, Stage.IMPLEMENT, Stage.PLAN},
    Stage.PR: set(),
}

STAGE_AGENT_MAP = {
    Stage.PREFLIGHT: None,
    Stage.PLAN: "planner",
    Stage.PLAN_REVIEW: "plan_reviewer",
    Stage.COORDINATE: "coordinator",
    Stage.IMPLEMENT: "implementer",
    Stage.TEST: "tester",
    Stage.REVIEW: "reviewer",
    Stage.PR: "guardian",
    Stage.LEARN: "learner",
}

# Agents that exist outside the per-stage flow. Workspace runs use
# `workspace_planner` to decompose a prompt across sibling projects; it's
# governed alongside the stage agents but never tied to a Stage enum value.
# Add new non-stage agents here so the JS roster + the denylist-sync test stay
# aligned without ad-hoc additions at the test layer.
NON_STAGE_AGENTS = frozenset({"workspace_planner"})

ALL_AGENTS = frozenset(
    {v for v in STAGE_AGENT_MAP.values() if v is not None} | NON_STAGE_AGENTS
)

STAGE_SCHEMA_MAP = {
    Stage.PREFLIGHT: None,
    Stage.PLAN: "plan.json",
    Stage.PLAN_REVIEW: "plan_review.json",
    Stage.COORDINATE: "coordinate.json",
    Stage.IMPLEMENT: "implement.json",
    Stage.TEST: "test_result.json",
    Stage.REVIEW: "review.json",
    Stage.PR: "pr.json",
    Stage.LEARN: "learn.json",
}


def can_transition(from_stage: Stage, to_stage: Stage, *, mode: str | None = None) -> bool:
    """Return True if transition from from_stage to to_stage is valid.

    In review_and_edit mode, PLAN_REVIEW cannot loop back to PLAN.
    """
    allowed = TRANSITIONS.get(from_stage, set())
    if mode == "review_and_edit" and from_stage == Stage.PLAN_REVIEW:
        allowed = allowed - {Stage.PLAN}
    return to_stage in allowed


# Canonical stage order (not configurable — use enabled flag to skip)
STAGE_ORDER = [Stage.PREFLIGHT, Stage.PLAN, Stage.PLAN_REVIEW, Stage.COORDINATE, Stage.IMPLEMENT, Stage.TEST, Stage.REVIEW, Stage.PR]

# Stages that default to disabled when not configured in settings.json
_STAGES_DEFAULT_DISABLED = {Stage.PLAN_REVIEW, Stage.LEARN}


def _read_settings(settings_path: str) -> dict:
    """Read and parse settings, with .local.json merge support."""
    return load_settings(settings_path)


def _resolve_model(shorthand, model_map):
    """Resolve a model shorthand to (full_id, env_dict)."""
    return resolve_model(shorthand, model_map)


def get_stage_config(stage: Stage, settings_path: str = ".claude/settings.json") -> dict:
    """Read settings.json and return agent config for the given stage.

    Agent mapping priority:
    1. worca.stages.<stage>.agent (if present)
    2. STAGE_AGENT_MAP[stage] (hardcoded default)

    Model resolution:
    1. worca.agents.<agent>.model (shorthand like "sonnet")
    2. Resolved via worca.models mapping in settings, then _DEFAULT_MODEL_MAP
    """
    settings = _read_settings(settings_path)
    worca = settings.get("worca", {})

    # Determine agent: prefer stages config, fall back to hardcoded map
    stages_config = worca.get("stages", {})
    stage_entry = stages_config.get(stage.value, {})
    agent_name = stage_entry.get("agent") or STAGE_AGENT_MAP.get(stage)

    if agent_name is None:
        return {"agent": None, "model": None, "model_env": {}, "max_turns": None, "effort": None, "schema": None}

    agent_config = worca.get("agents", {}).get(agent_name, {})
    model_map = worca.get("models", {})
    raw_model = agent_config.get("model", "sonnet")
    model_id, model_env = _resolve_model(raw_model, model_map)
    return {
        "agent": agent_name,
        "model": model_id,
        "model_env": model_env,
        "max_turns": agent_config.get("max_turns", 30),
        "effort": agent_config.get("effort"),
        "schema": STAGE_SCHEMA_MAP.get(stage, f"{stage.value}.json"),
    }


def get_enabled_stages(settings_path: str = ".claude/settings.json") -> list:
    """Return list of enabled stages in pipeline order.

    Reads worca.stages.<stage>.enabled from settings.json.
    Stages in _STAGES_DEFAULT_DISABLED default to disabled if not configured.
    All other stages default to enabled if not configured.
    """
    settings = _read_settings(settings_path)
    stages_config = settings.get("worca", {}).get("stages", {})

    enabled = []
    for stage in STAGE_ORDER:
        stage_entry = stages_config.get(stage.value, {})
        default_enabled = stage not in _STAGES_DEFAULT_DISABLED
        if stage_entry.get("enabled", default_enabled):
            enabled.append(stage)
    return enabled


VALID_PLAN_REVIEW_MODES = ("review", "review_and_edit")
VALID_PLAN_REVIEW_ENFORCE = ("auto", "review", "review_and_edit")


def resolve_plan_review_mode(settings: dict) -> tuple[str, str]:
    """Resolve the effective plan-review mode from settings.

    Precedence: governance enforce (if != auto) -> pipeline/template mode -> built-in 'review'.
    Returns (mode, reason) tuple.
    """
    worca = settings.get("worca", {})
    enforce = worca.get("governance", {}).get("plan_review_enforce", "auto")
    if enforce in ("review", "review_and_edit"):
        return (enforce, "forced by project (governance.plan_review_enforce)")

    template_mode = worca.get("stages", {}).get("plan_review", {}).get("mode")
    if template_mode in VALID_PLAN_REVIEW_MODES:
        return (template_mode, "from template/pipeline")

    return ("review", "default")


def validate_plan_review_settings(settings: dict) -> list[str]:
    """Validate plan-review enum fields in a parsed settings dict.

    Returns a list of error strings (empty if valid).
    """
    errors: list[str] = []
    worca = settings.get("worca", {})

    mode = worca.get("stages", {}).get("plan_review", {}).get("mode")
    if mode is not None:
        if not isinstance(mode, str) or mode not in VALID_PLAN_REVIEW_MODES:
            errors.append(
                f"stages.plan_review.mode must be one of: {', '.join(VALID_PLAN_REVIEW_MODES)}"
            )

    enforce = worca.get("governance", {}).get("plan_review_enforce")
    if enforce is not None:
        if not isinstance(enforce, str) or enforce not in VALID_PLAN_REVIEW_ENFORCE:
            errors.append(
                f"governance.plan_review_enforce must be one of: {', '.join(VALID_PLAN_REVIEW_ENFORCE)}"
            )

    return errors


def is_learn_enabled(settings_path: str = ".claude/settings.json") -> bool:
    """Check if learn stage is enabled. Defaults to False (opposite of other stages)."""
    settings = _read_settings(settings_path)
    return settings.get("worca", {}).get("stages", {}).get("learn", {}).get("enabled", False)
