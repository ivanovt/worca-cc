# W-016: Pipeline Templates

**Goal:** Eliminate repetitive pipeline reconfiguration by introducing named templates that capture complete pipeline profiles — stage configuration, agent tuning, loop limits, budget controls, and optional agent prompt overrides. Templates are selectable from both the CLI (`worca run --template`) and the UI ("New Run" dialog), and can be managed via `worca templates` subcommands or the Settings UI.

**Architecture:** Templates follow worca's three-tier resolution model:

| Tier | Location | Purpose | Tracked in git? |
|------|----------|---------|-----------------|
| **Package built-ins** | `src/worca/templates/{id}/` | Ship with `pip install worca-cc` | Yes (source repo) |
| **Project templates** | `.claude/templates/{id}/` | Team-shared, project-specific | Yes |
| **User templates** | `~/.worca/templates/{id}/` | Personal, cross-project | No |

Resolution priority: user > project > built-in (most specific wins on ID collision).

Each template is a directory containing a `template.json` config file and an optional `agents/` subdirectory with prompt overlay files. When a template is applied, the entire template directory is copied into the run's results folder (`.worca/runs/{run_id}/template/`) to provide a complete trace of the exact configuration used.

Core template logic lives in Python (`src/worca/orchestrator/templates.py`), with the UI server's `template-manager.js` acting as a thin REST adapter.

**Tech Stack:** Python `pathlib`/`shutil` for template resolution and file I/O, Express REST API for the UI layer, lit-html + Shoelace for UI components.

**Depends on:** W-009 Pipeline Control Actions (the "New Run" dialog and `POST /api/runs` endpoint must already exist).

---

## 1. Scope and Boundaries

### In scope
- Template directory format and schema (`template.json` + optional `agents/*.md` overlays)
- Three-tier template resolution (package → project → user)
- Four built-in preset templates shipped with the package: `bugfix`, `feature`, `refactor`, `quick-fix`
- Python `TemplateResolver` class as the source of truth for template operations
- CLI integration: `worca templates list|show|save|delete`, `worca run --template`
- Template parameters (`params`) with defaults and enum constraints
- Deep-merge config application (partial overrides, not wholesale replacement)
- Full template snapshot in run results (`.worca/runs/{run_id}/template/`)
- REST API: `GET/POST/DELETE /api/templates` (thin wrapper around Python resolver)
- Settings UI "Templates" tab for browsing, previewing, and deleting templates
- "Save as Template" action on the Settings > Pipeline tab
- Template picker in the "New Run" dialog

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

### 3.1 `bugfix` -- Bugfix

**Directory:** `src/worca/templates/bugfix/`

**Use when:** The bug is understood, reproduction is clear, and the fix is localized. No planning or task decomposition needed.

```json
{
  "id": "bugfix",
  "name": "Bugfix",
  "description": "Skip planner and coordinator. Focuses on direct implementation and testing. Best for well-understood bugs with a clear fix.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["fast", "no-plan"],
  "config": {
    "stages": {
      "plan":       { "enabled": false },
      "coordinate": { "enabled": false }
    },
    "loops": {
      "implement_test": 5,
      "pr_changes": 2
    },
    "milestones": {
      "plan_approval": false,
      "pr_approval": true,
      "deploy_approval": false
    }
  }
}
```

### 3.2 `feature` -- Feature Development

**Directory:** `src/worca/templates/feature/`

**Use when:** Implementing a new user-facing feature that requires planning, task breakdown, and a full review cycle.

```json
{
  "id": "feature",
  "name": "Feature Development",
  "description": "Full pipeline with planning, coordination, implementation, testing, review, and PR. Best for new features that require architectural decisions.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["full-pipeline", "requires-approval"],
  "config": {
    "loops": {
      "implement_test": 10,
      "pr_changes": 3,
      "restart_planning": 2
    },
    "milestones": {
      "plan_approval": true,
      "pr_approval": true,
      "deploy_approval": true
    }
  }
}
```

### 3.3 `refactor` -- Refactor

**Directory:** `src/worca/templates/refactor/`

**Use when:** Restructuring existing code without changing behavior. Plan is needed for coordination, but no PR is created -- the branch is ready for manual review.

```json
{
  "id": "refactor",
  "name": "Refactor",
  "description": "Full pipeline without PR creation. Focuses on restructuring code with extra test iterations. Branch is left ready for manual review.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["no-pr", "extra-test"],
  "config": {
    "stages": {
      "pr": { "enabled": false }
    },
    "loops": {
      "implement_test": 10,
      "pr_changes": 0,
      "restart_planning": 2
    },
    "milestones": {
      "plan_approval": true,
      "pr_approval": false,
      "deploy_approval": false
    }
  }
}
```

### 3.4 `quick-fix` -- Quick Fix

**Directory:** `src/worca/templates/quick-fix/`

**Use when:** A trivial one-liner fix, typo correction, or config tweak. Implementer only. No coordination, no review loop. High risk -- use only when the change is obviously safe.

```json
{
  "id": "quick-fix",
  "name": "Quick Fix",
  "description": "Minimal pipeline: implementer only, no planning, testing, or review. Use only for trivially safe changes like typos or config tweaks.",
  "builtin": true,
  "created_at": "2026-03-10T00:00:00Z",
  "tags": ["minimal", "fast", "no-review"],
  "config": {
    "stages": {
      "plan":       { "enabled": false },
      "coordinate": { "enabled": false },
      "test":       { "enabled": false },
      "review":     { "enabled": false }
    },
    "agents": {
      "implementer": { "max_turns": 100 }
    },
    "loops": {
      "implement_test": 0
    },
    "milestones": {
      "plan_approval": false,
      "pr_approval": false,
      "deploy_approval": false
    }
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

## 8. Implementation Tasks

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

**Directories to create:**
- `src/worca/templates/bugfix/template.json`
- `src/worca/templates/feature/template.json`
- `src/worca/templates/refactor/template.json`
- `src/worca/templates/quick-fix/template.json`

Write each `template.json` as specified in Section 3. No `agents/` subdirectories for the built-in presets (they use default agent prompts).

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

### Task 10: Create `app/views/templates.js`

**File to create:** `worca-ui/app/views/templates.js`

Settings > Templates tab view. Shows template cards in a grid with name, tier badge, tags, description, and delete button (disabled for built-ins).

Exported function: `templatesTab(templates, { onDelete, onSaveAsTemplate })`

---

### Task 11: Create `app/views/save-template-dialog.js`

**File to create:** `worca-ui/app/views/save-template-dialog.js`

Shoelace dialog for saving current pipeline settings as a template. Fields: name, description, tags (comma-separated). ID auto-derived from name.

Exported function: `saveTemplateDialogView(isOpen, { onSubmit, onClose, isSubmitting, error })`

---

### Task 12: Add Template Picker to "New Run" Dialog

**File to modify:** `worca-ui/app/views/new-run-dialog.js`

Add a collapsible `sl-details` section with an `sl-select` template picker at the top of the dialog. When a template is selected, show its description and tags as a preview.

Include `templateId` in the form submission payload.

---

### Task 13: Wire Templates into Settings View and `main.js`

**File to modify:** `worca-ui/app/views/settings.js`

Add "Templates" tab to the settings `sl-tab-group`. Add `loadTemplates()` function, `handleDeleteTemplate`, and "Save as Template" button on the Pipeline tab.

**File to modify:** `worca-ui/app/main.js`

Add save-template dialog state and handlers. Pass `templateId` through `handleSubmitNewRun`. Trigger template loading at appropriate points.

---

### Task 14: Add CSS for Templates

**File to modify:** `worca-ui/app/styles.css`

Add styles for template card grid, template picker in New Run dialog, and save-as-template dialog.

---

### Task 15: Create Server-Side Template Tests

**File to create:** `worca-ui/server/template-manager.test.js`

Unit tests for the JS template manager module, covering list, get, save, delete, apply, and snapshotTemplate operations.

---

### Task 16: Rebuild Frontend Bundle

```bash
cd worca-ui && npm run build
```

Run after all UI tasks are complete.

---

## 9. `worca init` Integration

**File to modify:** `src/worca/cli/init.py`

During `worca init`:
- Copy `src/worca/templates/` to `.claude/worca/templates/` (alongside other source files)
- On `--upgrade`: refresh built-in templates from package source
- Create `.claude/templates/` directory if it doesn't exist (project templates go here)

The `TemplateResolver`'s `builtin_dir` points to `.claude/worca/templates/` (the runtime copy), not directly to `src/worca/templates/`. This is consistent with how all other worca source files are resolved at runtime.

---

## 10. Testing Strategy

### Unit Tests

- **Python:** `tests/test_templates.py` (Task 3) — covers `TemplateResolver`, merge logic, params, snapshot
- **JS:** `worca-ui/server/template-manager.test.js` (Task 15) — covers REST adapter layer

### Manual Integration Checklist

**CLI:**
- `worca templates list` shows four built-ins
- `worca templates show bugfix` prints full config
- `worca templates save my-custom --description "test"` creates `.claude/templates/my-custom/template.json`
- `worca templates delete my-custom` removes the directory
- `worca run --template bugfix --prompt "Fix login"` applies template config and creates `template/` snapshot in run dir
- `worca run --template bugfix --param key=value` renders params

**Template API:**
- `GET /api/templates` returns all templates with tier badges
- `GET /api/templates/bugfix` returns full config
- `POST /api/templates` creates project template directory
- `POST /api/templates` with built-in ID returns 409
- `DELETE /api/templates/{user-id}` removes template directory
- `DELETE /api/templates/bugfix` returns 403

**Run traceability:**
- After a templated run, `.worca/runs/{run_id}/template/` contains the full template directory
- `resolved-params.json` records the params used
- `settings.json` in the run dir reflects the merged config
- Non-templated runs have no `template/` subdirectory

**UI:**
- Templates tab shows card grid with tier badges
- Built-in delete buttons disabled
- "Save as Template" opens dialog, saves correctly
- New Run dialog template picker works, includes templateId in submission

---

## 11. File Summary

### New files

| File | Purpose |
|------|---------|
| `src/worca/orchestrator/templates.py` | Python TemplateResolver — source of truth |
| `src/worca/cli/templates.py` | `worca templates` CLI subcommands |
| `src/worca/templates/bugfix/template.json` | Bugfix preset |
| `src/worca/templates/feature/template.json` | Feature development preset |
| `src/worca/templates/refactor/template.json` | Refactor preset |
| `src/worca/templates/quick-fix/template.json` | Quick fix preset |
| `tests/test_templates.py` | Python tests for TemplateResolver |
| `worca-ui/server/template-manager.js` | JS adapter for template operations |
| `worca-ui/server/template-manager.test.js` | JS template manager tests |
| `worca-ui/app/views/templates.js` | Settings > Templates tab view |
| `worca-ui/app/views/save-template-dialog.js` | Save-as-template dialog |

### Modified files

| File | Changes |
|------|---------|
| `src/worca/cli/main.py` | Register `templates` subcommand group |
| `src/worca/cli/init.py` | Copy built-in templates during init, create `.claude/templates/` |
| `src/worca/scripts/run_pipeline.py` | Add `--template` and `--param` arguments, template application logic |
| `src/worca/orchestrator/overlay.py` | Add `template_agents_dir` parameter to `resolve()` |
| `worca-ui/server/app.js` | Add template REST endpoints, extend `POST /api/runs` |
| `worca-ui/server/index.js` | Pass template directories to `createApp` |
| `worca-ui/server/process-manager.js` | Accept `settingsPath` override in `startPipeline()` |
| `worca-ui/app/views/settings.js` | Add Templates tab, loadTemplates, Save as Template button |
| `worca-ui/app/views/new-run-dialog.js` | Add template picker, include templateId in submit |
| `worca-ui/app/main.js` | Wire save-template dialog, pass templateId through |
| `worca-ui/app/styles.css` | Template card grid, picker, dialog styles |

---

## 12. Rollout Order

Tasks should be implemented in this order due to dependencies:

1. **Task 2** (preset template directories) — no code dependencies
2. **Task 1** (Python TemplateResolver) — depends on Task 2 for test fixtures
3. **Task 3** (Python tests) — depends on Tasks 1-2
4. **Task 4** (CLI subcommands) — depends on Task 1
5. **Task 5** (run_pipeline.py --template) — depends on Task 1
6. **Task 6** (OverlayResolver extension) — depends on Task 5
7. **Task 7** (JS template-manager.js) — depends on Task 1 (mirrors its API)
8. **Task 8** (REST endpoints) — depends on Task 7
9. **Task 9** (POST /api/runs extension) — depends on Tasks 7-8
10. **Task 15** (JS tests) — depends on Task 7
11. **Tasks 10-12** (UI views) — depend on REST API contract from Task 8; can be parallelized
12. **Task 13** (main.js wiring) — depends on Tasks 10-12
13. **Task 14** (CSS) — after all views are settled
14. **Task 16** (rebuild bundle) — final step
