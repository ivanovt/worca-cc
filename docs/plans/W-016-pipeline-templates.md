# W-016: Pipeline Templates

**Goal:** Eliminate repetitive pipeline reconfiguration by introducing named templates that capture complete pipeline profiles — stage configuration, agent tuning, loop limits, budget controls, and optional agent prompt overrides. Templates are selectable from the CLI (`worca run --template`) and manageable via `worca templates` subcommands.

**Scope:** This plan covers the Python core and CLI integration only (Tasks 1-6). The UI integration (REST API, template picker, settings tab, editor dialog) is documented in Sections 7-8 as a design reference for a follow-up effort.

**Architecture:** Templates follow worca's three-tier resolution model:

| Tier | Location | Purpose | Tracked in git? |
|------|----------|---------|-----------------|
| **Package built-ins** | `src/worca/templates/{id}/` | Ship with `pip install worca-cc` | Yes (source repo) |
| **Project templates** | `.claude/templates/{id}/` | Team-shared, project-specific | Yes |
| **User templates** | `~/.worca/templates/{id}/` | Cross-project, per-user | No |

Resolution priority: user > project > built-in (most specific wins on ID collision).

Each template is a directory containing a `template.json` config file and an optional `agents/` subdirectory with prompt overlay files. When a template is applied, the entire template directory is copied into the run's results folder (`.worca/runs/{run_id}/template/`) to provide a complete trace of the exact configuration used.

Core template logic lives in Python (`src/worca/orchestrator/templates.py`).

**Tech Stack:** Python `pathlib`/`shutil` for template resolution and file I/O.

**Depends on:** Nothing (CLI-only scope). UI integration (follow-up) depends on W-009.

---

## 1. Scope and Boundaries

### In scope (this plan)
- Template directory format and schema (`template.json` + optional `agents/*.md` overlays)
- Three-tier template resolution (package → project → user)
- Four built-in preset templates shipped with the package: `bugfix`, `feature`, `refactor`, `quick-fix`
- Python `TemplateResolver` class as the source of truth for template operations
- CLI integration: `worca templates list|show|save|delete`, `worca run --template`
- Template parameters (`params`) with defaults and enum constraints
- Deep-merge config application (partial overrides, not wholesale replacement)
- Full template snapshot in run results (`.worca/runs/{run_id}/template/`)
- OverlayResolver extension for template agent prompt overlays
- `worca init` integration (copy built-in templates to runtime)

### Follow-up (design reference in Sections 7-8, not implemented in this plan)
- REST API: `GET/POST/DELETE /api/templates` (thin wrapper around Python resolver)
- Settings UI "Templates" tab for browsing, previewing, and deleting templates
- "Save as Template" action on the Settings > Pipeline tab
- Template picker in the "New Run" dialog
- Template editor dialog (Clone/Edit/Save-as-template)
- Run detail template indicator

### Out of scope
- Template versioning or history
- Template sharing / export to remote registries
- Template inheritance or composition (each template is self-contained)
- Authentication or access control (single-user local tool)

---

## 2. Template Directory Format

Each template is a directory (not a single file), enabling bundled agent prompt overrides alongside config.

### Directory structure

```
templates/
  {template-id}/
    template.json          # Required: metadata + config overrides
    agents/                # Optional: agent prompt overlays
      guardian.md           #   merged via OverlayResolver at runtime
      implementer.md        #   supports <!-- append --> and <!-- replace --> modes
```

### `template.json` schema

```json
{
  "id": "security-audit",
  "name": "Security Audit",
  "description": "Full pipeline with hardened review and custom guardian checklist.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["security", "full-pipeline"],
  "params": {
    "severity_threshold": {
      "description": "Minimum severity to flag in review",
      "default": "medium",
      "enum": ["low", "medium", "high", "critical"]
    }
  },
  "config": {
    "stages": {
      "plan": { "enabled": false }
    },
    "agents": {
      "guardian": { "model": "opus", "max_turns": 100 }
    },
    "loops": {
      "implement_test": 10
    },
    "milestones": {
      "plan_approval": false,
      "pr_approval": true
    },
    "circuit_breaker": {
      "max_consecutive_failures": 1
    },
    "budget": {
      "max_cost_usd": 100
    }
  }
}
```

### Field definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | URL-safe identifier, unique within its tier. Max 64 chars, `[a-z0-9\-]` only. |
| `name` | string | yes | Human-readable display name. Max 80 chars. |
| `description` | string | yes | One or two sentences explaining when to use this template. Max 500 chars. |
| `builtin` | boolean | yes | `true` for shipped presets, `false` for user/project-created. |
| `created_at` | ISO 8601 | yes | Creation timestamp. |
| `tags` | string[] | no | Short labels shown as badges. Max 5 tags, 20 chars each. |
| `params` | object | no | Template parameters. Keys are param names; values have `description` (string), `default` (any), and optional `enum` (array). |
| `config` | object | yes | Partial subset of `worca.*` settings. Any key valid in the `worca` namespace of `settings.json` can appear here: `stages`, `agents`, `loops`, `milestones`, `circuit_breaker`, `budget`, `governance`, etc. |

### Config merge rules (deep merge)

When a template is applied, its `config` is **deep-merged** into the current `worca` settings:

- Object keys are merged recursively: only specified keys are overridden, unspecified keys are preserved from the base settings.
- Scalar values in the template replace the corresponding base value.
- To wholesale-replace an object key (instead of merging), use the `"__replace__": true` sentinel:

```json
{
  "config": {
    "agents": {
      "__replace__": true,
      "implementer": { "model": "opus", "max_turns": 500 }
    }
  }
}
```

This means a template only needs to specify the settings it wants to change. A bugfix template that only disables `plan` and `coordinate` stages doesn't need to repeat the entire `stages` object.

### Agent prompt overlays

Files in `{template-dir}/agents/{agent_name}.md` are processed by the existing `OverlayResolver`:

- `<!-- append -->` mode: sections merge into the core agent prompt (can use `## Override: {section}` blocks)
- `<!-- replace -->` mode (or no tag): replaces the core prompt entirely

Template overlays are applied **after** any project-level overlays from `.claude/agents/`. The resolution chain is:

1. Core agent prompt (`src/worca/agents/core/{agent}.md`)
2. Project overlay (`.claude/agents/{agent}.md`)
3. Template overlay (`{template-dir}/agents/{agent}.md`)

Template `params` are rendered into overlay content as `{{param_name}}` placeholders before overlay resolution.

---

## 3. Preset Templates

### Design constraint: stage dependency chain

The orchestrator has a hard dependency chain: **PLAN → COORDINATE → IMPLEMENT**. The coordinator creates beads (tasks) from the plan, and the implementer consumes those beads. Skipping links in this chain causes the implementer to fish for unscoped beads from prior runs.

**Templates must not skip stages in the middle of the chain.** Instead, they reshape stages via:
- **Agent prompt overlays** — different instructions for the same stage (e.g., a bugfix planner investigates root cause instead of designing architecture)
- **Model overrides** — cheaper/faster models for lightweight stages (haiku for trivial planning)
- **Turn limits** — fewer turns for stages that should be quick
- **Tail trimming** — disabling stages from the end (no PR, no review) is safe because no downstream stage depends on them

### Overview

| Preset | Chain | Tail trimmed | Model overrides | Agent overlays |
|---|---|---|---|---|
| `bugfix` | full | none | sonnet for plan+coord | planner, coordinator |
| `feature` | full + plan_review + learn | none | none (defaults) | none |
| `refactor` | full | PR | none | planner, guardian |
| `quick-fix` | full | test, review | haiku for plan+coord | planner, coordinator |
| `investigate` | plan only | coord thru PR | opus planner, 200 turns | planner |
| `test-only` | full | none | sonnet for plan+coord | planner, coordinator, implementer |

### 3.1 `bugfix` -- Bugfix

**Directory:** `src/worca/templates/bugfix/`

**Use when:** A bug needs fixing. The planner investigates root cause and scopes the fix, the coordinator creates 1-3 focused tasks, and the implementer fixes them. Faster and cheaper than the default pipeline.

**Agent overlays:**
- `agents/planner.md` — "Investigate this bug, identify root cause, scope the minimal fix"
- `agents/coordinator.md` — "Create 1-3 focused fix tasks, no broad decomposition"

```json
{
  "id": "bugfix",
  "name": "Bugfix",
  "description": "Fast bug fix pipeline. Planner investigates root cause, coordinator creates focused tasks, implementer fixes. Sonnet for planning, budget-capped.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["fast", "focused"],
  "config": {
    "agents": {
      "planner":     { "model": "sonnet", "max_turns": 30 },
      "coordinator": { "model": "sonnet", "max_turns": 50 }
    },
    "loops": {
      "implement_test": 8,
      "pr_changes": 3
    },
    "milestones": {
      "plan_approval": false,
      "deploy_approval": false
    },
    "budget": { "max_cost_usd": 30 }
  }
}
```

### 3.2 `feature` -- Feature Development

**Directory:** `src/worca/templates/feature/`

**Use when:** Implementing a new user-facing feature that requires full planning, task breakdown, and review. Enables the opt-in plan_review and learn stages that defaults leave off, with higher retry limits.

```json
{
  "id": "feature",
  "name": "Feature Development",
  "description": "Full pipeline with plan review and learn stages enabled. Higher retry limits for complex features. All approval gates active.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["full-pipeline", "plan-review", "learn"],
  "config": {
    "stages": {
      "plan_review": { "enabled": true },
      "learn": { "enabled": true }
    },
    "loops": {
      "implement_test": 10,
      "pr_changes": 5,
      "restart_planning": 3,
      "plan_review": 3
    }
  }
}
```

### 3.3 `refactor` -- Refactor

**Directory:** `src/worca/templates/refactor/`

**Use when:** Restructuring existing code without changing behavior. Full pipeline minus PR — the branch is left ready for manual review. Guardian focuses on behavioral preservation.

**Agent overlays:**
- `agents/planner.md` — "Analyze current structure, design target architecture, identify safe refactoring steps"
- `agents/guardian.md` — "Focus on behavioral preservation, no new features, verify test equivalence"

```json
{
  "id": "refactor",
  "name": "Refactor",
  "description": "Full pipeline without PR. Planner analyzes structure, guardian reviews for behavioral preservation. Branch left for manual review.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["no-pr", "extra-test"],
  "config": {
    "stages": {
      "pr": { "enabled": false }
    },
    "loops": {
      "implement_test": 10,
      "restart_planning": 2
    },
    "milestones": {
      "plan_approval": true,
      "pr_approval": false,
      "deploy_approval": false
    },
    "budget": { "max_cost_usd": 50 }
  }
}
```

### 3.4 `quick-fix` -- Quick Fix

**Directory:** `src/worca/templates/quick-fix/`

**Use when:** A trivial one-liner fix, typo correction, or config tweak. Full dependency chain (plan → coordinate → implement) runs with haiku for pennies-cost planning. Test and review trimmed from the tail. Tight budget and circuit breaker.

**Agent overlays:**
- `agents/planner.md` — "Identify the single change needed. One file, one fix."
- `agents/coordinator.md` — "Create exactly one task for this fix."

```json
{
  "id": "quick-fix",
  "name": "Quick Fix",
  "description": "Minimal pipeline for trivial changes. Haiku plans and coordinates in seconds, sonnet implements, no test or review. Budget-capped at $5.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["minimal", "fast", "no-review"],
  "config": {
    "stages": {
      "test":   { "enabled": false },
      "review": { "enabled": false }
    },
    "agents": {
      "planner":     { "model": "haiku", "max_turns": 15 },
      "coordinator": { "model": "haiku", "max_turns": 15 },
      "implementer": { "model": "sonnet", "max_turns": 100 }
    },
    "loops": {
      "implement_test": 0
    },
    "milestones": {
      "plan_approval": false,
      "pr_approval": false,
      "deploy_approval": false
    },
    "budget": { "max_cost_usd": 5 },
    "circuit_breaker": { "max_consecutive_failures": 1 }
  }
}
```

### 3.5 `investigate` -- Investigation

**Directory:** `src/worca/templates/investigate/`

**Use when:** Root cause analysis, architecture review, or codebase exploration. Produces a plan/report (`MASTER_PLAN.md`) without implementing anything. Output can feed into a subsequent `feature` or `bugfix` run.

**Agent overlay:**
- `agents/planner.md` — "Deep analysis mode: explore codebase, document findings, produce actionable report. Do NOT propose implementation."

```json
{
  "id": "investigate",
  "name": "Investigation",
  "description": "Analysis only. Opus planner explores codebase and produces a detailed report. No code changes, no PR. Output is a reusable MASTER_PLAN.md.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["analysis", "no-code", "plan-only"],
  "config": {
    "stages": {
      "coordinate": { "enabled": false },
      "implement":  { "enabled": false },
      "test":       { "enabled": false },
      "review":     { "enabled": false },
      "pr":         { "enabled": false }
    },
    "agents": {
      "planner": { "model": "opus", "max_turns": 200 }
    },
    "milestones": {
      "plan_approval": false,
      "pr_approval": false,
      "deploy_approval": false
    },
    "budget": { "max_cost_usd": 20 }
  }
}
```

### 3.6 `test-only` -- Test Coverage

**Directory:** `src/worca/templates/test-only/`

**Use when:** Adding test coverage, fixing flaky tests, or verifying existing behavior. Full chain runs but all agents are instructed to only touch test files.

**Agent overlays:**
- `agents/planner.md` — "Analyze test coverage gaps. Identify which modules need tests. Do NOT plan production code changes."
- `agents/coordinator.md` — "Create tasks for test files only. Each task targets one module's test coverage."
- `agents/implementer.md` — "Write test files ONLY. Do NOT modify production source files."

```json
{
  "id": "test-only",
  "name": "Test Coverage",
  "description": "Add test coverage without changing production code. Planner analyzes gaps, coordinator creates per-module test tasks, implementer writes tests only.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["tests", "no-prod-changes"],
  "config": {
    "agents": {
      "planner":     { "model": "sonnet", "max_turns": 30 },
      "coordinator": { "model": "sonnet", "max_turns": 50 }
    },
    "loops": {
      "implement_test": 8,
      "pr_changes": 2
    },
    "milestones": {
      "plan_approval": false,
      "deploy_approval": false
    },
    "budget": { "max_cost_usd": 25 }
  }
}
```

---

## 4. Python Template Resolver

### File: `src/worca/orchestrator/templates.py`

The authoritative implementation for all template operations. The UI server delegates to this via subprocess or direct import.

### Classes and functions

```python
@dataclass
class TemplateSummary:
    id: str
    name: str
    description: str
    builtin: bool
    tags: list[str]
    created_at: str
    tier: str  # "builtin" | "project" | "user"

@dataclass
class Template:
    id: str
    name: str
    description: str
    builtin: bool
    created_at: str
    tags: list[str]
    params: dict          # param definitions
    config: dict          # partial worca config
    agents_dir: str | None  # path to agents/ subdirectory (if exists)
    source_dir: str       # path to the template directory on disk
    tier: str             # "builtin" | "project" | "user"

class TemplateError(Exception):
    def __init__(self, message, code, details=None):
        # code: 'not_found' | 'builtin' | 'builtin_conflict' | 'validation_error' | 'parse_error'
        ...

class TemplateResolver:
    def __init__(self, builtin_dir, project_dir, user_dir):
        """
        builtin_dir: src/worca/templates/ (from installed package)
        project_dir: .claude/templates/ (project-local)
        user_dir:    ~/.worca/templates/ (user-global)
        """

    def list(self) -> list[TemplateSummary]:
        """Return all templates across all tiers.
        Sorted: built-ins first (alpha by id), project (alpha), user (newest first).
        If an id exists in multiple tiers, only the highest-priority one is returned.
        """

    def get(self, template_id: str) -> Template | None:
        """Fetch a template by ID. Searches user > project > builtin."""

    def apply(self, template_id: str, current_worca: dict, params: dict | None = None) -> dict:
        """Deep-merge template config into current worca settings.
        Resolves params, returns merged dict. Does not mutate inputs.
        """

    def snapshot_to_run(self, template_id: str, run_dir: str, params: dict | None = None):
        """Copy entire template directory to {run_dir}/template/ for traceability.
        Also writes a resolved-params.json with the param values used.
        """

    def save(self, template_data: dict, scope: str = "project") -> Template:
        """Save a new template. scope is 'project' or 'user'.
        Validates all fields. Raises TemplateError on failure.
        Cannot use a built-in id.
        Creates {scope_dir}/{id}/ directory and writes template.json.
        """

    def delete(self, template_id: str, scope: str = "project") -> bool:
        """Delete a template directory. Cannot delete built-ins.
        Raises TemplateError with appropriate code on failure.
        """
```

### Deep-merge implementation

```python
def deep_merge_config(base: dict, overlay: dict) -> dict:
    """Deep-merge overlay into base. Overlay values win for scalars.
    Dicts are merged recursively unless overlay has '__replace__': True,
    in which case the overlay replaces the base key wholesale.
    """
    result = base.copy()
    for key, value in overlay.items():
        if key == "__replace__":
            continue
        if isinstance(value, dict) and not value.get("__replace__"):
            if key in result and isinstance(result[key], dict):
                result[key] = deep_merge_config(result[key], value)
            else:
                clean = {k: v for k, v in value.items() if k != "__replace__"}
                result[key] = clean
        else:
            if isinstance(value, dict):
                result[key] = {k: v for k, v in value.items() if k != "__replace__"}
            else:
                result[key] = value
    return result
```

### Param rendering

```python
def render_params(content: str, params: dict, param_defs: dict) -> str:
    """Replace {{param_name}} placeholders in content with resolved values.
    Uses param_defs for defaults; params dict overrides defaults.
    Raises TemplateError if a required param without a default is missing.
    """
```

### Agent overlay chain

When a template with an `agents/` dir is active, the `OverlayResolver` chain becomes:

1. Core prompt → `.claude/agents/{agent}.md` overlay → template `agents/{agent}.md` overlay

The runner passes the template's `agents_dir` to `OverlayResolver` as a secondary overlay source.

---

## 5. CLI Integration

### File: `src/worca/cli/templates.py` (new)

New `worca templates` subcommand group, registered in `cli/main.py`.

```bash
# List all templates across all tiers
worca templates list
# Output:
#   ID            NAME                 TIER      TAGS
#   bugfix        Bugfix               builtin   fast, no-plan
#   feature       Feature Development  builtin   full-pipeline, requires-approval
#   refactor      Refactor             builtin   no-pr, extra-test
#   quick-fix     Quick Fix            builtin   minimal, fast, no-review
#   my-fast       My Fast Run          project   custom

# Show template details
worca templates show bugfix
# Output: full template.json content, formatted

# Save current settings as a project template
worca templates save my-fast --description "Quick iterations, no review"

# Save as a user-global template
worca templates save my-fast --global --description "Quick iterations"

# Delete a template
worca templates delete my-fast
worca templates delete my-fast --global
```

### Run with template

Extend `run_pipeline.py` argument parser:

```python
parser.add_argument("--template", help="Template ID to apply before running")
parser.add_argument("--param", action="append", metavar="KEY=VALUE",
                    help="Template parameter override (repeatable)")
```

In `build_work_request()` / pipeline launch:

1. If `--template` is provided, resolve the template via `TemplateResolver`
2. Deep-merge template config into loaded settings
3. Copy template directory to `{status_dir}/runs/{run_id}/template/`
4. Write `resolved-params.json` alongside
5. If template has `agents/` dir, configure overlay chain
6. Pass merged settings to `run_pipeline()`

---

## 6. Run Traceability

When a template is used for a run, the **entire template directory** is copied into the run results:

```
.worca/runs/{run_id}/
  status.json
  settings.json              # Full merged settings used for this run
  template/                  # Complete template snapshot
    template.json             # Template config as it was at run time
    agents/                   # Agent overlays (if any)
      guardian.md
      implementer.md
    resolved-params.json      # Actual param values used
  logs/
    ...
```

This provides:
- **Full reproducibility:** the exact config that produced a given run is always available
- **Auditability:** diff two runs' `template/` dirs to see what changed
- **Debugging:** if a run fails, inspect the template snapshot alongside the logs

The `snapshot_to_run()` method handles this copy. It also writes a `resolved-params.json`:

```json
{
  "template_id": "security-audit",
  "template_tier": "project",
  "params": {
    "severity_threshold": "critical"
  },
  "snapshot_at": "2026-04-07T10:30:00Z"
}
```

When no template is used, the `template/` subdirectory is absent — the run's `settings.json` (which is always written) serves as the sole config record.

---

## 7. REST API Design

All endpoints are prefixed `/api/`. Responses follow the existing convention `{ ok: true, ...data }` on success, `{ ok: false, error: string }` on failure.

The JS server delegates to the Python `TemplateResolver` via a helper that instantiates it with the correct directory paths.

### `GET /api/templates`

Return all available templates across all tiers, deduplicated by ID (highest-priority tier wins).

**Response:**
```json
{
  "ok": true,
  "templates": [
    {
      "id": "bugfix",
      "name": "Bugfix",
      "description": "...",
      "builtin": true,
      "tags": ["fast", "no-plan"],
      "tier": "builtin",
      "created_at": "2026-03-10T00:00:00Z"
    }
  ]
}
```

Note: The `config` field is omitted from the list response for brevity. Use `GET /api/templates/:id` to fetch the full template including config.

### `GET /api/templates/:id`

Fetch a single template by ID.

**Response on success:**
```json
{ "ok": true, "template": { ...full template object including config... } }
```

**Response if not found:**
```json
HTTP 404: { "ok": false, "error": "Template 'xyz' not found" }
```

### `POST /api/templates`

Create or replace a project-scope template. Built-in templates cannot be overwritten.

**Request body:**
```json
{
  "id": "my-fast-run",
  "name": "My Fast Run",
  "description": "Custom template for quick iterations.",
  "tags": ["custom"],
  "config": { ... }
}
```

**Validation rules:**
- `id` must match `[a-z0-9\-]{1,64}`
- `name` must be non-empty string, max 80 chars
- `description` must be non-empty string, max 500 chars
- `tags` optional, max 5 entries, each max 20 chars, each matching `[a-z0-9\-]`
- `config` must be an object; validated as a partial `worca` config
- Cannot use a built-in id

**Response on success:**
```json
{ "ok": true, "template": { ...saved template... } }
```

**Response on validation error:**
```json
HTTP 400: { "ok": false, "error": "...", "details": [...] }
```

**Response if id matches a built-in:**
```json
HTTP 409: { "ok": false, "error": "Cannot overwrite built-in template 'bugfix'" }
```

### `DELETE /api/templates/:id`

Delete a project-scope template. Built-in templates cannot be deleted.

**Response on success:**
```json
{ "ok": true, "deleted": true }
```

**Response if built-in:**
```json
HTTP 403: { "ok": false, "error": "Cannot delete built-in template" }
```

**Response if not found:**
```json
HTTP 404: { "ok": false, "error": "Template 'xyz' not found" }
```

### Extension to `POST /api/runs`

The `POST /api/runs` endpoint accepts optional `templateId` and `params` fields:

```json
{
  "inputType": "prompt",
  "inputValue": "Fix login crash",
  "templateId": "bugfix",
  "params": {}
}
```

When `templateId` is present, the server:
1. Resolves the template
2. Deep-merges config into current settings
3. Writes merged settings to the run directory
4. Copies the template directory to the run directory
5. Passes the merged settings path to `run_pipeline.py`

---

## 8. UI Design

### Terminology and visual language

Three source tiers, each with a consistent `sl-badge` variant used everywhere:

| Tier | Badge label | Badge variant | Meaning |
|------|-------------|---------------|---------|
| Package | `worca` | `neutral` (grey) | Shipped with `pip install worca-cc` |
| Project | `project` | `primary` (blue) | Team-shared, version-controlled |
| User | `user` | `success` (green) | Cross-project, per-user |

The `sourceBadge(tier)` helper renders the badge. Used in template cards, run detail headers, run list items, and the template picker.

### 8.1 Templates tab (Settings > Templates)

A single grid with a filter bar — not separate tabs per tier:

```
[All ▾] [worca] [project] [user]         [Save Current as Template]
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Bugfix       │ │ Feature Dev  │ │ Refactor     │
│ ●worca       │ │ ●worca       │ │ ●worca       │
│ fast no-plan │ │ full-pipeline│ │ no-pr extra  │
│ Skip planner │ │ Full pipeline│ │ Full pipeline│
│              │ │              │ │              │
│    [Clone]   │ │    [Clone]   │ │    [Clone]   │
└─────────────┘ └─────────────┘ └─────────────┘
┌─────────────┐
│ My Fast Run  │
│ ●project     │
│ custom       │
│ Quick itera… │
│ [Edit] [Del] │
└─────────────┘
```

- `worca` templates are read-only: Clone button only
- `project` and `user` templates show Edit and Delete buttons
- Each card shows: name, source badge, tags as small badges, description (2-line clamp)

### 8.2 Clone / Edit / Save-as-template (unified editor dialog)

A single `templateEditorDialog` component serves three entry points:

| Entry point | Pre-populated from | Save target |
|-------------|-------------------|-------------|
| **Clone** (any card) | Source template's config | User picks: `project` or `user` |
| **Edit** (project/user card) | The template being edited | Same scope (overwrites in place) |
| **Save Current as Template** (Pipeline tab button) | Current pipeline settings from DOM | User picks: `project` or `user` |

```
┌─ Template Editor ────────────────────────────┐
│                                               │
│  Name:  [My Security Audit            ]      │
│  ID:    my-security-audit (auto-derived)      │
│  Desc:  [Hardened review with custom...  ]   │
│  Tags:  [security, full-pipeline         ]   │
│                                               │
│  ┌─ Config ─────────────────────────────────┐ │
│  │ Stages    Agents    Loops    Advanced    │ │
│  │ ┌──────────────────────────────────────┐ │ │
│  │ │ ☑ Plan        ☐ Coordinate          │ │ │
│  │ │ ☑ Implement   ☑ Test                │ │ │
│  │ │ ☑ Review      ☑ PR                  │ │ │
│  │ └──────────────────────────────────────┘ │ │
│  └──────────────────────────────────────────┘ │
│                                               │
│  Save to: (●) Project  ( ) User              │
│                                               │
│              [Cancel]  [Save Template]         │
└───────────────────────────────────────────────┘
```

ID auto-derivation: `name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64)`

### 8.3 Template picker (New Run dialog)

Collapsible `sl-details` section at the top of the "New Run" dialog:

```
▶ Pipeline Template (optional)
  ┌─────────────────────────────────────────┐
  │ None (use current settings)           ▾ │
  │  Bugfix                       ●worca    │
  │  Feature Development          ●worca    │
  │  Refactor                     ●worca    │
  │  Quick Fix                    ●worca    │
  │  My Fast Run                  ●project  │
  └─────────────────────────────────────────┘
  fast · no-plan
  Skip planner and coordinator. Focuses on...
```

When a template is selected, its tags and description appear below the selector as a preview. Clearing the selection reverts to "use current settings."

### 8.4 Run detail template indicator

When a run used a template, the run detail view shows it:

- **Run header badge:** `Template: bugfix (worca)` — small inline badge using `templateSummaryBadge(templateInfo)`
- **Template details panel** (expandable or as a tab):
  - Template name, source tier badge, description
  - Config diff: what the template changed vs. base settings
  - Agent overlays: list of bundled `.md` files, clickable to view content
  - Params used (from `resolved-params.json`)

This data comes from the `template/` snapshot in the run directory — always available even if the original template has been modified or deleted since.

### 8.5 Reusable components

| Component | Used in |
|-----------|---------|
| `sourceBadge(tier)` | Template cards, run detail, template picker, run list |
| `templateCard(template, actions)` | Templates tab grid, template picker preview |
| `templateEditorDialog(data, mode, options)` | Save-as-template, Clone, Edit |
| `templateSummaryBadge(info)` | Run cards, run detail header, run list |
| `templateConfigPreview(config)` | Template editor, run detail template panel |
| `tagBadges(tags)` | Template cards, template picker, run detail |

---

## 9. Implementation Tasks (W-016 scope)

### Task 1: Create Python TemplateResolver

**Files to create:**
- `src/worca/orchestrator/templates.py`

Implement the `TemplateResolver` class, `TemplateSummary` and `Template` dataclasses, `TemplateError` exception, `deep_merge_config()`, and `render_params()` functions as specified in Section 4.

**Key implementation details:**
- `list()`: scan all three tier directories for subdirectories containing `template.json`, parse each, deduplicate by ID (user > project > builtin)
- `get()`: search tiers in priority order, return first match
- `apply()`: load template, render params into agent overlays, deep-merge config into current settings
- `snapshot_to_run()`: `shutil.copytree()` the template directory into `{run_dir}/template/`, write `resolved-params.json`
- `save()`: validate fields, create `{scope_dir}/{id}/template.json`, set `builtin: false` and `created_at` to now
- `delete()`: check not built-in, `shutil.rmtree()` the template directory
- Tier directory resolution: use `importlib.resources` or `Path(__file__).parent.parent / "templates"` for built-in dir

---

### Task 2: Create Preset Template Directories

**Directories to create (6 presets, each with `template.json` + optional `agents/` overlays):**

- `src/worca/templates/bugfix/template.json` + `agents/planner.md`, `agents/coordinator.md`
- `src/worca/templates/feature/template.json` (no overlays — uses default prompts)
- `src/worca/templates/refactor/template.json` + `agents/planner.md`, `agents/guardian.md`
- `src/worca/templates/quick-fix/template.json` + `agents/planner.md`, `agents/coordinator.md`
- `src/worca/templates/investigate/template.json` + `agents/planner.md`
- `src/worca/templates/test-only/template.json` + `agents/planner.md`, `agents/coordinator.md`, `agents/implementer.md`

Write each `template.json` as specified in Section 3. Agent overlay files use `<!-- append -->` mode with `## Override:` blocks to modify specific sections of core agent prompts while preserving governance rules.

---

### Task 3: Create Python Tests for TemplateResolver

**File to create:** `tests/test_templates.py`

Test cases using pytest with `tmp_path` fixture:

**`list()`:**
- Returns built-in templates sorted alphabetically
- Returns project templates after built-ins
- Returns user templates, deduplicates by ID (user wins over project, project wins over builtin)
- Gracefully handles missing tier directories
- Skips unparseable `template.json` files

**`get()`:**
- Returns template from highest-priority tier
- Returns `None` for unknown ID
- Populates `agents_dir` when `agents/` subdirectory exists
- Populates `source_dir` with the template directory path

**`apply()`:**
- Deep-merges template stages into current settings (partial override)
- Preserves unspecified keys (e.g., `governance` not in template → unchanged)
- Handles `__replace__` sentinel for wholesale replacement
- Renders params into config values
- Returns new dict (does not mutate inputs)

**`snapshot_to_run()`:**
- Copies entire template directory to `{run_dir}/template/`
- Writes `resolved-params.json` with param values and metadata
- Copies `agents/` subdirectory when present

**`save()`:**
- Creates template directory with `template.json`
- Sets `builtin: false` and `created_at`
- Creates tier directory if it doesn't exist
- Raises `TemplateError(code='builtin_conflict')` for built-in IDs
- Raises `TemplateError(code='validation_error')` for invalid fields
- Collects multiple validation errors into `details`

**`delete()`:**
- Removes template directory
- Raises `TemplateError(code='not_found')` for missing templates
- Raises `TemplateError(code='builtin')` for built-in templates

**`deep_merge_config()`:**
- Merges nested dicts recursively
- Overlay scalars replace base scalars
- `__replace__: true` triggers wholesale replacement
- Returns new dict (no mutation)

---

### Task 4: Add CLI `worca templates` Subcommands

**Files to create:**
- `src/worca/cli/templates.py`

**File to modify:**
- `src/worca/cli/main.py` — register the `templates` subcommand group

Subcommands:
- `worca templates list` — tabular output of all templates
- `worca templates show <id>` — pretty-printed template.json
- `worca templates save <id> --description "..." [--global]` — save current settings as template
- `worca templates delete <id> [--global]` — delete a project or user template

---

### Task 5: Extend `run_pipeline.py` for `--template`

**File to modify:** `src/worca/scripts/run_pipeline.py`

Add `--template` and `--param KEY=VALUE` arguments to `create_parser()`.

In the main execution flow, after loading settings and before calling `run_pipeline()`:

1. If `--template` is provided, instantiate `TemplateResolver` with appropriate dirs
2. Call `resolver.apply(template_id, worca_settings, params)`
3. Call `resolver.snapshot_to_run(template_id, run_dir, params)`
4. If template has `agents_dir`, pass it to `OverlayResolver` as a secondary source
5. Write merged settings to `{run_dir}/settings.json`

---

### Task 6: Extend OverlayResolver for Template Overlays

**File to modify:** `src/worca/orchestrator/overlay.py`

Add support for a secondary overlay source (template agents dir). The `resolve()` method gains an optional `template_agents_dir` parameter:

```python
def resolve(self, agent_name: str, rendered_core: str, template_agents_dir: str | None = None) -> str:
```

Resolution chain:
1. Apply project overlay (`.claude/agents/{agent}.md`) → intermediate result
2. Apply template overlay (`{template_agents_dir}/{agent}.md`) → final result

---

## 9b. Follow-up Tasks (UI integration — not in W-016 scope)

The tasks below are documented as a design reference for a follow-up effort. They depend on the Python core (Tasks 1-6) being complete and on W-009 (Pipeline Control Actions).

### Task 7: Create `server/template-manager.js`

**File to create:** `worca-ui/server/template-manager.js`

A thin adapter that delegates to the Python `TemplateResolver`. Alternatively, a pure JS reimplementation for the subset of operations needed by the REST API (list, get, save, delete, apply).

**Exports:**

```javascript
export function listTemplates(builtinDir, projectDir, userDir)
export function getTemplate(id, builtinDir, projectDir, userDir)
export function saveTemplate(template, projectDir)
export function deleteTemplate(id, builtinDir, projectDir)
export function applyTemplateConfig(currentWorca, templateConfig)
export function snapshotTemplate(templateDir, runDir, params)
export class TemplateError extends Error { constructor(message, code, details) }
```

The `snapshotTemplate()` function copies the template directory to `{runDir}/template/` and writes `resolved-params.json`. Called by the `POST /api/runs` handler when `templateId` is present.

---

### Task 8: Add Template REST Endpoints to `server/app.js`

**File to modify:** `worca-ui/server/app.js`

Add `GET /api/templates`, `GET /api/templates/:id`, `POST /api/templates`, `DELETE /api/templates/:id` routes as specified in Section 7.

Update `createApp(options)` to accept `templatesProjectDir` and `templatesUserDir`. The built-in dir is resolved from the worca package location.

**File to modify:** `worca-ui/server/index.js`

Pass template directories to `createApp`.

---

### Task 9: Extend `POST /api/runs` to Accept `templateId`

**File to modify:** `worca-ui/server/app.js` (or `process-manager.js`)

When `templateId` is present in the request body:

1. Load the template via `getTemplate()`
2. Read current settings
3. Deep-merge template config into worca section
4. Write merged settings to `{worcaDir}/runs/{runId}/settings.json`
5. Copy template directory to `{worcaDir}/runs/{runId}/template/`
6. Spawn `run_pipeline.py` with `--settings` pointing to the run-scoped settings file

**File to modify:** `worca-ui/server/process-manager.js`

Accept `settingsPath` in `startPipeline()` options and pass as `--settings` arg when provided.

---

### Task 10: Create Reusable UI Components

**File to create:** `worca-ui/app/views/template-components.js`

Implement the shared components from Section 8.5:

- `sourceBadge(tier)` — renders `sl-badge` with consistent variant mapping (`worca`→neutral, `project`→primary, `user`→success)
- `templateCard(template, actions)` — card with name, source badge, tags, description, and action buttons (Clone for all; Edit/Delete for project/user only)
- `templateSummaryBadge(info)` — inline badge for run headers showing `Template: {name} ({tier})`
- `templateConfigPreview(config)` — summarizes stage enable/disable, agent models, loop limits
- `tagBadges(tags)` — renders tag array as small `sl-badge` elements

---

### Task 11: Create `app/views/templates.js`

**File to create:** `worca-ui/app/views/templates.js`

Settings > Templates tab view as specified in Section 8.1. Uses `templateCard` from Task 10. Includes tier filter bar (`[All] [worca] [project] [user]`) and "Save Current as Template" button.

Exported function: `templatesTab(templates, { onDelete, onClone, onEdit, onSaveAsTemplate, tierFilter })`

---

### Task 12: Create `app/views/template-editor-dialog.js`

**File to create:** `worca-ui/app/views/template-editor-dialog.js`

Unified editor dialog as specified in Section 8.2. Handles three modes: Clone, Edit, Save-as-template.

Fields: name, auto-derived ID, description, tags, config sub-tabs (Stages, Agents, Loops, Advanced), save-target radio (Project/User).

Exported function: `templateEditorDialogView(isOpen, { mode, data, onSubmit, onClose, isSubmitting, error })`

---

### Task 13: Add Template Picker to "New Run" Dialog

**File to modify:** `worca-ui/app/views/new-run-dialog.js`

Add template picker as specified in Section 8.3. Collapsible `sl-details` with `sl-select`. Uses `sourceBadge` and `tagBadges` from Task 10.

Include `templateId` in the form submission payload.

---

### Task 14: Add Template Indicator to Run Detail View

**File to modify:** `worca-ui/app/views/run-detail.js`

Add template indicator as specified in Section 8.4. Uses `templateSummaryBadge` in the header and an expandable panel for template details (config diff, agent overlays, params).

Data sourced from the `template/` snapshot in the run's results directory via a new `GET /api/runs/:id/template` endpoint.

---

### Task 15: Wire Templates into Settings View and `main.js`

**File to modify:** `worca-ui/app/views/settings.js`

Add "Templates" tab to the settings `sl-tab-group`. Add `loadTemplates()` function, `handleDeleteTemplate`, `handleCloneTemplate`, `handleEditTemplate`, and "Save as Template" button on the Pipeline tab.

**File to modify:** `worca-ui/app/main.js`

Add template editor dialog state and handlers. Pass `templateId` through `handleSubmitNewRun`. Trigger template loading at appropriate points.

---

### Task 16: Add CSS for Templates

**File to modify:** `worca-ui/app/styles.css`

Add styles for template card grid, tier filter bar, template picker in New Run dialog, template editor dialog, and run detail template indicator.

---

### Task 17: Create Server-Side Template Tests

**File to create:** `worca-ui/server/template-manager.test.js`

Unit tests for the JS template manager module, covering list, get, save, delete, apply, and snapshotTemplate operations.

---

### Task 18: Rebuild Frontend Bundle

```bash
cd worca-ui && npm run build
```

Run after all UI tasks are complete.

---

## 10. `worca init` Integration

**File to modify:** `src/worca/cli/init.py`

During `worca init`:
- Copy `src/worca/templates/` to `.claude/worca/templates/` (alongside other source files)
- On `--upgrade`: refresh built-in templates from package source
- Create `.claude/templates/` directory if it doesn't exist (project templates go here)

The `TemplateResolver`'s `builtin_dir` points to `.claude/worca/templates/` (the runtime copy), not directly to `src/worca/templates/`. This is consistent with how all other worca source files are resolved at runtime.

---

## 11. Testing Strategy

Testing is a first-class deliverable for W-016. Every task must have corresponding test coverage before it is considered complete. The project follows TDD — write failing tests first, then implement.

### Unit Tests (Task 3 — `tests/test_templates.py`)

This is the largest test file in the plan. It covers the entire `TemplateResolver` surface:

**`TemplateResolver.list()`** — 5 tests:
- Returns built-in templates sorted alphabetically
- Returns project templates after built-ins
- Returns user templates; deduplicates by ID (user > project > builtin)
- Gracefully handles missing tier directories
- Skips unparseable `template.json` files without crashing

**`TemplateResolver.get()`** — 4 tests:
- Returns template from highest-priority tier on ID collision
- Returns `None` for unknown ID
- Populates `agents_dir` when `agents/` subdirectory exists
- Populates `source_dir` with the template directory path

**`TemplateResolver.apply()`** — 5 tests:
- Deep-merges template stages into current settings (partial override)
- Preserves unspecified keys (`governance` not in template → unchanged)
- Handles `__replace__` sentinel for wholesale replacement
- Renders params into config values
- Returns new dict (does not mutate either input)

**`TemplateResolver.snapshot_to_run()`** — 3 tests:
- Copies entire template directory to `{run_dir}/template/`
- Writes `resolved-params.json` with param values and metadata
- Copies `agents/` subdirectory when present

**`TemplateResolver.save()`** — 6 tests:
- Creates template directory with `template.json`
- Sets `builtin: false` and `created_at`
- Creates tier directory if it doesn't exist
- Raises `TemplateError(code='builtin_conflict')` for built-in IDs
- Raises `TemplateError(code='validation_error')` for invalid fields (bad id, missing name, too many tags)
- Collects multiple validation errors into `details` array

**`TemplateResolver.delete()`** — 3 tests:
- Removes template directory from disk
- Raises `TemplateError(code='not_found')` for missing templates
- Raises `TemplateError(code='builtin')` for built-in templates

**`deep_merge_config()`** — 4 tests:
- Merges nested dicts recursively
- Overlay scalars replace base scalars
- `__replace__: true` triggers wholesale replacement
- Returns new dict (no mutation of inputs)

**`render_params()`** — 3 tests:
- Replaces `{{param_name}}` placeholders with values
- Falls back to defaults from param definitions
- Raises `TemplateError` for required params missing both value and default

**Total: ~33 test cases minimum.**

### CLI Tests (Task 4)

Test the CLI subcommands via subprocess or by calling the handler functions directly:
- `worca templates list` — output format, all tiers shown
- `worca templates show <id>` — full JSON output, 404 for unknown
- `worca templates save` — creates directory, validates fields
- `worca templates delete` — removes directory, rejects built-ins

### Integration Tests (Task 5)

Test `--template` flag in `run_pipeline.py`:
- Template config is merged into settings before pipeline launch
- Template snapshot is written to run directory
- `--param KEY=VALUE` overrides template defaults
- Unknown template ID fails with clear error
- Running without `--template` works unchanged (no regression)

### OverlayResolver Tests (Task 6)

Extend existing overlay tests to cover the template agents chain:
- Core → project overlay → template overlay (three-layer merge)
- Template overlay applies when `template_agents_dir` is provided
- No template overlay when `template_agents_dir` is `None` (backwards compatible)
- Append and replace modes both work in template overlays

### Manual Integration Checklist

**CLI:**
- `worca templates list` shows four built-ins with tier/tags columns
- `worca templates show bugfix` prints full config
- `worca templates save my-custom --description "test"` creates `.claude/templates/my-custom/template.json`
- `worca templates save my-custom --global --description "test"` creates `~/.worca/templates/my-custom/template.json`
- `worca templates delete my-custom` removes the directory
- `worca run --template bugfix --prompt "Fix login"` applies template config and creates `template/` snapshot in run dir
- `worca run --template bugfix --param key=value` renders params

**Run traceability:**
- After a templated run, `.worca/runs/{run_id}/template/` contains the full template directory
- `resolved-params.json` records the params used
- `settings.json` in the run dir reflects the merged config
- Non-templated runs have no `template/` subdirectory

### Follow-up test coverage (UI integration)

- **JS:** `worca-ui/server/template-manager.test.js` (Task 17) — covers REST adapter layer
- **UI:** Templates tab, editor dialog, picker, run detail indicator

---

## 12. File Summary (W-016 scope)

### New files

| File | Purpose |
|------|---------|
| `src/worca/orchestrator/templates.py` | Python TemplateResolver — source of truth |
| `src/worca/cli/templates.py` | `worca templates` CLI subcommands |
| `src/worca/templates/bugfix/template.json` | Bugfix preset config |
| `src/worca/templates/bugfix/agents/planner.md` | Bugfix planner overlay (root cause focus) |
| `src/worca/templates/bugfix/agents/coordinator.md` | Bugfix coordinator overlay (1-3 focused tasks) |
| `src/worca/templates/feature/template.json` | Feature development preset config |
| `src/worca/templates/refactor/template.json` | Refactor preset config |
| `src/worca/templates/refactor/agents/planner.md` | Refactor planner overlay (structural analysis) |
| `src/worca/templates/refactor/agents/guardian.md` | Refactor guardian overlay (behavioral preservation) |
| `src/worca/templates/quick-fix/template.json` | Quick fix preset config |
| `src/worca/templates/quick-fix/agents/planner.md` | Quick fix planner overlay (single change) |
| `src/worca/templates/quick-fix/agents/coordinator.md` | Quick fix coordinator overlay (one task) |
| `src/worca/templates/investigate/template.json` | Investigation preset config |
| `src/worca/templates/investigate/agents/planner.md` | Investigation planner overlay (analysis mode) |
| `src/worca/templates/test-only/template.json` | Test coverage preset config |
| `src/worca/templates/test-only/agents/planner.md` | Test planner overlay (coverage gaps) |
| `src/worca/templates/test-only/agents/coordinator.md` | Test coordinator overlay (per-module tasks) |
| `src/worca/templates/test-only/agents/implementer.md` | Test implementer overlay (test files only) |
| `tests/test_templates.py` | Python tests for TemplateResolver |

### Modified files

| File | Changes |
|------|---------|
| `src/worca/cli/main.py` | Register `templates` subcommand group |
| `src/worca/cli/init.py` | Copy built-in templates during init, create `.claude/templates/` |
| `src/worca/scripts/run_pipeline.py` | Add `--template` and `--param` arguments, template application logic |
| `src/worca/orchestrator/overlay.py` | Add `template_agents_dir` parameter to `resolve()` |

### Follow-up files (UI integration, not in W-016 scope)

| File | Purpose |
|------|---------|
| `worca-ui/server/template-manager.js` | JS adapter for template operations |
| `worca-ui/server/template-manager.test.js` | JS template manager tests |
| `worca-ui/app/views/template-components.js` | Reusable components: sourceBadge, templateCard, tagBadges, etc. |
| `worca-ui/app/views/templates.js` | Settings > Templates tab view |
| `worca-ui/app/views/template-editor-dialog.js` | Unified Clone/Edit/Save-as-template dialog |
| `worca-ui/server/app.js` | Add template REST endpoints, extend `POST /api/runs` |
| `worca-ui/server/index.js` | Pass template directories to `createApp` |
| `worca-ui/server/process-manager.js` | Accept `settingsPath` override in `startPipeline()` |
| `worca-ui/app/views/settings.js` | Add Templates tab, loadTemplates, Save as Template button |
| `worca-ui/app/views/new-run-dialog.js` | Add template picker, include templateId in submit |
| `worca-ui/app/views/run-detail.js` | Add template indicator badge and expandable template details panel |
| `worca-ui/app/main.js` | Wire template editor dialog, pass templateId through |
| `worca-ui/app/styles.css` | Template card grid, tier filter, picker, editor dialog, run detail indicator styles |

---

## 13. Rollout Order (W-016 scope)

All six tasks are Python-only and should be implemented in this order:

1. **Task 2** (preset template directories) — no code dependencies, pure data
2. **Task 1** (Python TemplateResolver) — depends on Task 2 for test fixtures
3. **Task 3** (Python tests) — depends on Tasks 1-2; validates core logic
4. **Task 4** (CLI subcommands) — depends on Task 1; thin wrappers
5. **Task 5** (run_pipeline.py --template) — depends on Task 1; integrates with pipeline launch
6. **Task 6** (OverlayResolver extension) — depends on Task 5; enables template agent overlays

Tasks 4-6 are independent of each other and can be parallelized after Task 3 passes.

### Follow-up rollout (UI integration)

7. **Task 7** (JS template-manager.js) — mirrors Python TemplateResolver API
8. **Task 8** (REST endpoints) — depends on Task 7
9. **Task 9** (POST /api/runs extension) — depends on Tasks 7-8
10. **Task 17** (JS tests) — depends on Task 7
11. **Task 10** (reusable UI components) — depends on REST API contract from Task 8
12. **Tasks 11-14** (UI views) — depend on Task 10; can be parallelized
13. **Task 15** (main.js wiring) — depends on Tasks 11-14
14. **Task 16** (CSS) — after all views are settled
15. **Task 18** (rebuild bundle) — final step

---

## Appendix A: Stage Coupling Analysis

This appendix documents how tightly the orchestrator is coupled to its current stage definitions. Templates (W-016) work within these constraints — they configure the existing stages but do not redefine them. A future effort (see note at end) could make stages themselves configurable.

### Hard-coupled areas (require source edits to change)

| Area | File | What's locked |
|------|------|---------------|
| **Stage enum** | `orchestrator/stages.py:7-17` | `Stage(Enum)` with 9 fixed values |
| **Transitions** | `orchestrator/stages.py:20-29` | `TRANSITIONS` dict — fixed state machine graph |
| **Runner logic** | `orchestrator/runner.py:1741-2330` | ~800 lines of `if current_stage == Stage.X` chains with per-stage output parsing, loopback triggers, and context management |
| **Prompt builder** | `orchestrator/prompt_builder.py:124-542` | Hardcoded `_build_{stage}()` methods dispatched via `getattr(self, f"_build_{stage}")` |
| **Schema map** | `orchestrator/stages.py:43-53` | `STAGE_SCHEMA_MAP` — fixed stage→schema filename mapping |

### Soft-coupled areas (configurable within bounds)

| Area | File | What's flexible |
|------|------|----------------|
| **Agent assignment** | `stages.py:31-41` + settings.json | `stages.{name}.agent` overrides `STAGE_AGENT_MAP` default |
| **Enable/disable** | settings.json | `stages.{name}.enabled: false` skips a stage |
| **Loop limits** | settings.json | `loops.implement_test`, `loops.pr_changes`, etc. |
| **Model/turns** | settings.json | `agents.{name}.model` and `agents.{name}.max_turns` |
| **Status tracking** | `state/status.py` | Generic — accepts any stage name string, no validation against enum |
| **Hooks** | `claude_hooks/*.py` | Check `WORCA_AGENT` role, not stage name |
| **Events** | `events/types.py` | Generic stage events (`STAGE_STARTED`, `STAGE_COMPLETED`) plus stage-specific ones (`TEST_SUITE_FAILED`, `REVIEW_VERDICT`) hardcoded in runner |

### Hardcoded transition paths

```
PREFLIGHT → PLAN
PLAN → PLAN_REVIEW | COORDINATE
PLAN_REVIEW → COORDINATE | PLAN (revision)
COORDINATE → IMPLEMENT
IMPLEMENT → TEST
TEST → REVIEW | IMPLEMENT (test failure loopback)
REVIEW → PR | IMPLEMENT (changes requested) | PLAN (restart planning)
PR → (end)
```

Loopbacks are controlled by trigger strings (`"test_failure"`, `"review_changes"`, `"next_bead"`) set in the runner's per-stage if/elif blocks and consumed by the IMPLEMENT stage handler to choose between initial/next-bead/fix modes.

### Per-stage special-case logic in runner.py

- **PREFLIGHT:** Runs via script (`run_preflight()`), not agent. Skippable via `--skip-preflight`.
- **PLAN:** Parses `plan.json` schema output, sets `plan_approved` milestone, handles plan revision mode via `plan_revision_mode` context key.
- **PLAN_REVIEW:** Parses `outcome` field ("approve"/"revise"), filters by severity (critical/major), loops back to PLAN on revision.
- **COORDINATE:** Parses bead task list from `coordinate.json`, populates dependency graph.
- **IMPLEMENT:** Three trigger paths — `initial` (assign bead), `next_bead` (next task), `test_failure`/`review_changes` (fix mode). Tracks `bead_prompt_iteration` for retry prompts.
- **TEST:** Parses test results, severity-gates loopback (only failures trigger `TEST→IMPLEMENT`), tracks `implement_test` loop counter.
- **REVIEW:** Parses `outcome` field, three loopback paths (`→IMPLEMENT`, `→PLAN`, `→PR`), filters issues by severity for fix mode, tracks `pr_changes` loop counter.
- **PR:** Emits `GIT_PR_CREATED` event. Terminal stage.
- **LEARN:** Post-completion only, conditional on termination type. Not in main stage loop.

### What templates CAN control (W-016 scope)

- Which stages are enabled/disabled
- Which agent handles each stage (and its model/turns)
- Loop iteration limits
- Milestones (approval gates)
- Budget and circuit breaker thresholds
- Agent prompt overlays (via template `agents/` directory)

### What templates CANNOT control

- Adding new stages
- Changing transition graph (which stages connect to which)
- Changing loopback conditions (what triggers a retry)
- Changing stage order
- Custom output schema parsing logic

### Future: data-driven stage machine

Making stages fully configurable would require:

1. Moving `TRANSITIONS`, `STAGE_ORDER`, `STAGE_AGENT_MAP`, `STAGE_SCHEMA_MAP` into settings.json
2. Replacing the ~800 lines of if/elif with a generic dispatch table and pluggable stage handlers
3. Defining loopback conditions as data (e.g., `"on_failure": "implement"` in transition config)
4. Making prompt builders loadable from template files rather than hardcoded methods
5. Making output parsing generic (check schema-defined outcome fields)

This is a separate feature from W-016 and would be a significant architectural refactor.
