# W-064: Template zip bundles — ship overlays end-to-end

**Status:** Draft
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-06-04
**Depends on:** None

## Problem

Today's bundle export/import flow is config-only. The on-disk template directory is already self-contained — `template.json` plus an optional `agents/` directory holding prompt overlays (`planner.md`, `coordinator.md`, `plan.block.md`, etc.) — and the resolver, `worca init`, and `worca templates duplicate` all carry both halves through. But the wire format used to share templates between machines drops the overlay half:

- `src/worca/cli/templates.py:587-596` (`cmd_templates_export`) builds each manifest entry from `id`, `name`, `description`, `tags`, `config`, and `params`. There is no read of `Template.agents_dir`.
- `src/worca/orchestrator/bundle.py:130-141` (`build_export_manifest`) serializes only the JSON payload.
- `src/worca/orchestrator/bundle.py:232-249` (`fetch_bundle`) parses a single JSON document; it has no path for binary payloads.
- `worca-ui/app/main.js:2037-2062` (`_onImportFileChange`) does `JSON.parse(file.text())` and rejects anything that isn't `{ templates: [...] }`.
- `worca-ui/server/templates-routes.js:439-461` (`POST /templates/import`) accepts only a JSON body `{ bundle, dst_tier }`.

User-facing consequence: a built-in or user-authored template like `bugfix` that ships an `agents/planner.md` overlay (see `src/worca/templates/bugfix/agents/planner.md:1-12`) loses its overlay when exported. The recipient imports a config-only template that silently falls back to the base agent prompt — the differentiator that made the template worth sharing in the first place is gone, and the importer has no way to notice from the manifest.

The same visibility gap bites the **far more common** path: **duplicate**. `TemplateResolver.duplicate` (`src/worca/orchestrator/templates.py:687-693`) already does `shutil.copytree` on `agents/` when shadowing a built-in into project or user scope — so every user who clicks "Duplicate" on the `bugfix` built-in in the Pipelines view silently inherits `bugfix/agents/planner.md`. They get a behaviorally-different planner stage with no UI indication that the prompt is overlay-augmented. Today there is no way to see this from the editor.

There is also no UI surface for *viewing* the overlays attached to a template at all, so users — whether they got the overlays via import, duplicate, or filesystem drop — cannot inspect what prompts are running. The Pipelines editor (`worca-ui/app/views/pipelines-editor.js`) exposes config tabs but treats `agents_dir` as invisible.

A second, narrower gap shows up at **rename**: the editor's "rename" action is server-composed as duplicate + delete (`worca-ui/server/templates-routes.js:618-675`), which carries overlays through correctly — but does **not** rewrite the `worca.default_template` pointer when the renamed template was the project default. The pointer at `worca.default_template = { tier, id }` ends up dangling. This is a pre-existing bug independent of overlays, but rename is in the same edit-flow surface this plan touches and the fix is a few lines; folding it in closes a related papercut users will hit while exercising the new overlay flow.

## Proposal

Add a zip bundle path alongside the existing JSON bundle path — coexisting via content-type sniff in `fetch_bundle`. JSON stays the gist-renderable default for config-only templates; zip is the format used whenever a template's `agents/` directory must travel. Single-template-per-zip with a top-level `template.json` and sibling `agents/` directory. Hardened against path traversal, symlinks, zip bombs, and absolute paths. UI gains zip-aware import/export and a read-only Overlays tab in the Pipelines editor that groups overlays by stage with sub-tabs for agent prompts and user prompts — surfacing overlays acquired via *any* path (import, duplicate, or filesystem drop), not just zip import. Folds in a small rename fix so `worca.default_template` follows a renamed template instead of being left dangling.

## Design

### 1. Format coexistence and sniffing

- **Current state:** `src/worca/orchestrator/bundle.py:232-265` — `fetch_bundle` always treats its input as JSON. The HTTPS path caps at 1 MiB, refuses non-public hosts, and blocks redirects; the gist path resolves a hex ID and pulls the raw payload.
- **Obstacle:** the function returns `dict`; the call sites in `cli/templates.py:cmd_templates_import` and the UI server's `importBundle()` shim consume a dict directly. Zip is binary and produces a `(manifest_dict, extracted_overlays)` pair, not a single dict.
- **Resolution:** add a thin sniff layer that branches to one of two code paths and unifies their outputs into a single in-memory manifest shape that downstream consumers already understand.

```python
# src/worca/orchestrator/bundle.py

# Magic bytes for ZIP local file header (and empty/spanned variants).
_ZIP_MAGIC = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")

def fetch_bundle(source: str) -> dict:
    """Load a bundle from a local file, HTTPS URL, or gist.

    Returns a manifest dict shaped like the JSON bundle. For zip sources,
    extracted overlay file contents are embedded under each template entry
    as ``_overlays: {<relpath>: <content>}``. Downstream consumers
    (redact_bundle, _atomic_import) treat _overlays uniformly with config.
    """
    raw = _read_raw(source)              # bytes or text, with caps applied
    if raw[:4] in [m[:4] for m in _ZIP_MAGIC] or _sniff_zip_extension(source):
        return _manifest_from_zip(raw)   # validated layout + extracted overlays
    return _manifest_from_json(raw)
```

The sniff order is: (a) content-type header from HTTPS responses when present (`application/zip`, `application/x-zip-compressed`), (b) the leading four bytes of the payload (`PK\x03\x04`), (c) the URL/path extension (`.zip`). All three must agree on JSON to take the JSON path; any disagreement forces the zip path so a `.zip` served with `Content-Type: application/octet-stream` still works.

JSON path is unchanged. Zip path produces an in-memory manifest with the same `worca_bundle_version`, `templates`, `models`, `pricing` top-level keys — the synthesized version is `2`. Each `templates[]` entry gains an optional `_overlays` field holding `{ "planner.md": "<content>", "plan.block.md": "<content>" }`. Downstream code that does not understand `_overlays` (older importers reading a v2 manifest in-memory) is unaffected — `_overlays` is dropped on `redact_bundle` deep-copy when the path is not whitelisted, so old code sees a v1-equivalent manifest.

### 2. Zip layout — single template per archive

- **Current state:** the JSON bundle's `templates` array can hold N templates in one file. Multi-export emits one combined manifest.
- **Resolution:** zip is single-template-per-archive. Multi-template export emits one zip per template (or, in the UI, the export button is per-row so the multi-template case is naturally serialized).

Required layout (all paths relative to the zip root):

```
<template-id>.zip/
  template.json          # required, schema-matches the existing template.json
  agents/                # optional
    planner.md           # any .md or .block.md file
    coordinator.md
    plan.block.md
```

Validation rules — every member must satisfy all of these or the zip is rejected:

| Rule | Rejection reason |
|---|---|
| `template.json` at top level (exactly one) | `missing template.json` / `template.json not at archive root` |
| All other entries match `agents/[a-z0-9._-]+\.(md\|block\.md)` | `unexpected entry: <path>` |
| Resolved member path stays under staging root | `path traversal: <path>` |
| No symlinks (`external_attr & 0xA000 == 0xA000`) | `symlink not allowed: <path>` |
| No absolute paths or drive letters | `absolute path not allowed: <path>` |
| No path component is `..` | `parent traversal not allowed: <path>` |
| Compressed size ≤ 1 MiB | `bundle exceeds 1 MiB compressed` |
| Uncompressed total ≤ 4 MiB | `bundle exceeds 4 MiB uncompressed` |
| Per-file uncompressed ≤ 256 KiB | `file exceeds 256 KiB: <path>` |
| Member count ≤ 64 | `too many entries (max 64)` |
| Compression ratio per file ≤ 100× | `suspicious compression ratio: <path>` |

The per-file compression-ratio cap is the zip-bomb backstop in case a member individually expands far beyond `original_size / compressed_size` claims (Python's `zipfile` validates header sizes against actual decompressed bytes when streaming, so we use `ZipFile.open()` + read-with-limit rather than `ZipFile.extract()` which trusts the header).

Validation is performed before extraction — we iterate `ZipFile.infolist()`, apply every rule against the metadata, and only then `ZipFile.open(name).read(MAX_FILE)` each member into memory. No filesystem writes happen until the synthesized manifest passes `redact_bundle`'s allowlist + secret scan.

### 3. Path-traversal & symlink hardening

- **Current state:** none — JSON bundles have no filesystem paths.
- **Resolution:** every member's path is normalized via `pathlib.PurePosixPath` and re-anchored to a notional `staging/` root. If `(staging / member).resolve()` does not start with `staging.resolve()`, reject.

```python
def _safe_member_path(staging: Path, name: str) -> Path:
    # Reject Windows-style or absolute paths up-front
    p = PurePosixPath(name)
    if p.is_absolute() or any(part == ".." for part in p.parts):
        raise BundleError(f"unsafe path: {name}")
    if "\\" in name or ":" in name:
        raise BundleError(f"unsafe path: {name}")
    resolved = (staging / p).resolve()
    if staging.resolve() not in resolved.parents and resolved != staging.resolve():
        raise BundleError(f"path escapes staging: {name}")
    return resolved
```

Symlink detection: `zipfile` exposes Unix file modes via `ZipInfo.external_attr >> 16`. We reject any member with mode `& 0o170000 == 0o120000` (symlink) or `& 0o170000 == 0o060000` / `0o020000` (block/char device) or any mode that isn't a regular file (`0o100000`).

The staging directory itself uses `tempfile.mkdtemp(prefix="worca-zip-import-")` and is removed in a `try/finally` regardless of success. Tests cover: traversal via `../`, absolute path, drive letter, backslash separator, symlink entry, device entry, zip bomb (>100× ratio per file), oversized total, oversized single file, too many entries.

### 4. Manifest synthesis & redaction

- **Current state:** `redact_bundle()` (`bundle.py:196-223`) does one walk over the JSON manifest applying `CONFIG_ALLOWLIST` structurally to `templates[*].config.*` and `SECRET_PATTERNS` to every string value.
- **Resolution:** extend the same single walk to also redact overlay content. Overlays live under `templates[i]._overlays.<filename>` as plain strings; the existing `_walk_and_redact` recursion already hits them when given the synthesized manifest. The allowlist is unchanged — `_overlays` is added as a permitted top-level key on each template entry, parallel to `config`.

```python
# Updated allowlist comment block
CONFIG_ALLOWLIST = frozenset({
    "stages", "agents", "effort", "loops", "circuit_breaker", "models",
})
# Note: _overlays sits at templates[i]._overlays, not under config.
# It bypasses CONFIG_ALLOWLIST but goes through _walk_and_redact for
# value-level secret scanning.

_TEMPLATE_TOPLEVEL_KEYS = frozenset({
    "id", "name", "description", "tags", "config", "params", "_overlays",
})
```

Per-file SECRET_PATTERNS still apply: if a careless overlay author embedded an API key in a planner.md, redaction kicks in and the redacted-paths list includes `templates[0]._overlays.planner.md`. The importer sees `<YOUR-SECRET-HERE>` in the overlay text on disk and can fix it.

A redaction report shown at import time enumerates every redacted JSON path; the UI's import dialog renders these inline before the user commits.

### 5. Atomic import with overlays

- **Current state:** `cli/templates.py:_atomic_import` (lines 425-560) stages templates in a tmpdir, then `os.replace`s into the destination tier. It writes `template.json` only.
- **Resolution:** extend the staging step. For each template entry, after writing `template.json`, iterate `_overlays.items()` and write `<tmpl-dir>/agents/<filename>` with `0o644` mode. The existing rollback (full tmpdir cleanup on any error) covers the new files for free because they live inside the same staging tree.

```python
# cli/templates.py — inside _atomic_import staging loop
overlay_map = entry.get("_overlays") or {}
if overlay_map:
    agents_dir = tmpl_dir / "agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    for fname, content in overlay_map.items():
        # Belt-and-braces: validate the filename even though fetch_bundle
        # already filtered. Prevents anything sneaking past the JSON path.
        if not _OVERLAY_NAME_RE.match(fname):
            raise TemplateError(
                f"invalid overlay filename: {fname}",
                details={"file": fname},
            )
        (agents_dir / fname).write_text(content, encoding="utf-8")
```

`_OVERLAY_NAME_RE` is `re.compile(r"^[a-z0-9._-]{1,64}\.(md|block\.md)$")`. The allowed file basenames mirror the names already used by the runtime overlay system (`planner.md`, `coordinator.md`, `plan.block.md`, `plan-edit.block.md`, etc.) — we don't enforce that the filename matches a known agent (a template could ship an overlay for a future agent) but we do enforce the extension and the safe character set.

### 6. Export path — zip emission

- **Current state:** `cmd_templates_export` (`cli/templates.py:570-638`) always emits `{name}-bundle.json`.
- **Resolution:** the per-template export route consults `Template.agents_dir`. If non-None *and* the directory contains any `*.md` file, emit `<id>-bundle.zip`. Otherwise emit `<id>-bundle.json` as today.

```python
def _emit_template_archive(tmpl, output_path: str | None) -> Path:
    has_overlays = (
        tmpl.agents_dir
        and any(Path(tmpl.agents_dir).glob("*.md"))
    )
    if has_overlays:
        return _write_zip(tmpl, output_path or f"{tmpl.id}-bundle.zip")
    return _write_json(tmpl, output_path or f"{tmpl.id}-bundle.json")
```

Multi-template CLI export (`--templates a,b,c`) emits one file per template; if any template has overlays, those become `.zip` and the rest stay `.json`. A summary line printed to stderr lists each output path so users see which format was chosen and why.

Gist export rejects zip outright with a clear error: `gist export only supports JSON bundles; download the .zip and share via file`. The JSON path's existing `gh gist create` invocation is untouched.

### 7. Server route — accept binary uploads

- **Current state:** `worca-ui/server/templates-routes.js:439-461` accepts `{ bundle, dst_tier }` as JSON.
- **Resolution:** add a parallel binary path. The single endpoint `POST /templates/import` accepts either:
  - `Content-Type: application/json` with `{ bundle, dst_tier }` — current behavior, unchanged.
  - `Content-Type: application/zip` with the raw zip bytes in the body, and `dst_tier` as a query parameter (`?dst_tier=project`).

We use `express.raw({ type: 'application/zip', limit: '1mb' })` middleware on the import route specifically — keeps the global JSON parser intact and gives us the same 1 MiB cap as the Python side.

```javascript
// templates-routes.js
import { raw as expressRaw } from 'express';

router.post('/templates/import',
  expressRaw({ type: 'application/zip', limit: '1mb' }),
  (req, res) => {
    const ctype = req.headers['content-type'] || '';
    if (ctype.startsWith('application/zip')) {
      return handleZipImport(req, res);   // writes tmpfile, shells to CLI
    }
    return handleJsonImport(req, res);    // existing path
  }
);
```

`handleZipImport` writes the buffer to a tmpfile under `os.tmpdir()/worca-import-<rand>.zip`, runs `worca templates import --from <path>` via `execFileSync`, captures the same `cliCode` mapping as the JSON path, removes the tmpfile in a `finally`, and returns the structured result. The CLI is the single source of truth for validation — the server never opens the zip itself.

The bundle download endpoint `GET /templates/:tier/:id/bundle` gains an optional `?format=zip` query (or auto-detects based on whether the template has overlays). Response sets `Content-Type: application/zip` and `Content-Disposition: attachment; filename="<id>-bundle.zip"`.

### 8. UI — import dialog

- **Current state:** `worca-ui/app/main.js:2037` (`_onImportFileChange`) reads the file as text, parses JSON, and rejects everything else.
- **Resolution:** sniff by extension and by magic bytes; route accordingly.

```javascript
async function _onImportFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  // Read first 4 bytes for magic-byte sniff
  const headBytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = headBytes[0] === 0x50 && headBytes[1] === 0x4b
                && (headBytes[2] === 0x03 || headBytes[2] === 0x05 || headBytes[2] === 0x07);
  const looksZipByName = /\.zip$/i.test(file.name);

  if (isZip || looksZipByName) {
    // Don't parse client-side; let the server (and the Python CLI) validate.
    _updateActionDialog({
      file,
      parsed: { _kind: 'zip', name: file.name, size: file.size },
      error: null,
    });
    return;
  }

  // Existing JSON path...
}
```

On commit the dialog branches: zip files POST as binary (`fetch('/templates/import', { method: 'POST', headers: {'Content-Type': 'application/zip'}, body: file })`), JSON files keep the current path. The dialog renders a small "includes prompt overlays" hint when the file is a zip — the server returns a structured summary on successful import (template id, overlay filenames, redacted paths) and the dialog shows the overlay list before closing.

### 9. UI — export action

- **Current state:** `pipelines.js:94-159` (`exportTemplate`) fetches `/templates/:tier/:id/bundle`, JSON-stringifies the response, and downloads.
- **Resolution:** the server-side endpoint now sets `Content-Type` correctly for both JSON and zip responses. The client just uses `response.blob()` instead of `response.json()` for the download path, picks the filename from `Content-Disposition`, and triggers the same `<a download>` flow. No format toggle in the UI — the server chooses based on whether the template has overlays.

The "Copy gist URL" action (`pipelines.js:172`) gains a guard: when the template has `agents_dir` non-empty, the button is hidden and a small inline note reads "Templates with prompt overlays must be shared as a downloaded .zip file." This is checked client-side using the `agents_dir` boolean that the list endpoint already exposes per template summary (need to verify and add to the API if missing — see Phase 3).

### 10. UI — Overlays tab in Pipelines editor

- **Current state:** `worca-ui/app/views/pipelines-editor.js` exposes config tabs (General, Stages, Agents, Effort, Governance per the existing structure). No view of `agents_dir`.
- **Resolution:** add an **Overlays** tab. Visible only when `template.agents_dir` is non-empty (or, more precisely, when the new `GET /templates/:tier/:id/overlays` endpoint returns ≥1 file). Tab is read-only — no editor in this plan.

Tab structure follows the pattern the user specified — grouped by stage (expandable, like pipeline runs), with sub-tabs per stage for agent prompt and user prompt, rendered as markdown:

```
Overlays
├── Plan                                  [expand ▼]
│   ├── Agent prompt    (planner.md)      <rendered markdown>
│   └── User prompt     (plan.block.md)   <rendered markdown>
├── Plan Review                           [expand ▼]
│   ├── Agent prompt    (plan_reviewer.md)
│   └── User prompt     (plan-review.block.md)
├── Coordinate                            [expand ▼]
│   ├── Agent prompt    (coordinator.md)
│   └── User prompt     (coordinate.block.md)
├── Implement                             [expand ▼]
│   ├── Agent prompt    (implementer.md)
│   └── User prompt     (implement.block.md)
├── Test
├── Review
├── PR
└── Learn
```

A stage card is expandable only if at least one of `<stage>.<agent>.md` or `<stage>.block.md` exists in the overlay set. Cards with no overlays are collapsed and disabled (greyed-out label, no chevron). Within an expanded card, only the present sub-tab is selectable — if the template ships `planner.md` but not `plan.block.md`, the "User prompt" tab is disabled.

Stage→file mapping (mirrors `src/worca/orchestrator/stages.py`'s stage list and the existing block file naming):

| Stage | Agent prompt file | User prompt file |
|---|---|---|
| Plan | `planner.md` | `plan.block.md` |
| Plan Review | `plan_reviewer.md`, `plan_editor.md` | `plan-review.block.md`, `plan-edit.block.md` |
| Coordinate | `coordinator.md` | `coordinate.block.md` |
| Implement | `implementer.md` | `implement.block.md` |
| Test | `tester.md` | `test.block.md` |
| Review | `reviewer.md` | `review.block.md` |
| PR | `guardian.md` | `pr.block.md` |
| Learn | `learner.md` | `learn.block.md` |

The Plan Review stage has two agent prompt files (reviewer and editor) and two block files — the sub-tab area shows them as further-nested chips when both are present. This is the only stage that fans out; all others are 1-to-1.

Rendering: `marked.parse(content)` then `DOMPurify.sanitize(...)` (both already in deps — `worca-ui/package.json:68,72`). The rendered HTML lives inside `.markdown-body` so the existing dark-surface scoping applies (see memory note `markdown-body-dark-surface-contrast`).

Server endpoint:

```
GET /templates/:tier/:id/overlays
→ {
    ok: true,
    overlays: {
      "planner.md": "<content>",
      "plan.block.md": "<content>",
      ...
    }
  }
```

Implementation is small: read every `*.md` under `<tmpl>/agents/` (resolver locates the directory), apply the same `_OVERLAY_NAME_RE` filter, return contents. No write path in this plan.

### 11. Rename, duplicate, and default-template pointer integrity

- **Current state:**
  - Rename is composed at the server (`worca-ui/server/templates-routes.js:618-675`) as `duplicate` then `delete`. The CLI legs are `TemplateResolver.duplicate` (`src/worca/orchestrator/templates.py:599-710`) and `TemplateResolver.delete` (lines 528-555). Duplicate copies `agents/` via `shutil.copytree` at lines 687-693; delete removes the whole `<tier>/<id>/` directory with `shutil.rmtree`.
  - `worca.default_template = { tier, id }` is set/cleared only via the explicit `PUT /default-template` route (`templates-routes.js:698-734`). Nothing else touches it.
- **Obstacle:** if the user renames a template that is currently the project default, the pointer keeps pointing at the old `(srcTier, srcId)`. After delete, that pair no longer resolves — runs launched from the default fall back to "no template," and the UI's default-marker badge silently stops matching.
- **Resolution:** rewrite the pointer as part of the rename, inside the same atomic envelope as the leg that lands the new copy.

Two changes:

1. **Make rename a single CLI call.** Today the server composes two CLI invocations because Python only exposes `duplicate` and `delete`. Add `worca templates rename --src-id <id> --src-scope <tier> --dst-id <id> --dst-scope <tier>` that runs duplicate + delete + pointer-rewrite in one process, so a partial failure can be reported with full state in one structured exit. The server's composition shim collapses to a single `runWorcaTemplates` call.

2. **Rewrite the default-template pointer when (src_tier, src_id) matches.** Inside the CLI rename, after the new copy is committed but before delete runs:

   ```python
   # src/worca/cli/templates.py — new cmd_templates_rename
   def cmd_templates_rename(args):
       # … resolve, duplicate, then:
       settings_path = _settings_path_for_scope(args.src_scope)
       _maybe_rewrite_default_pointer(
           settings_path,
           old=(args.src_scope, args.src_id),
           new=(args.dst_scope, args.dst_id),
       )
       # … then delete src
   ```

   `_maybe_rewrite_default_pointer` reads `settings.json`, checks `worca.default_template`, and if it equals the old `{tier, id}` rewrites it to the new one via `atomic_write_json` (already used elsewhere in `init.py`). No-op when the renamed template isn't the default. Scope: project tier writes to `<project>/.claude/settings.json`; user tier writes to `~/.worca/settings.json`. The pointer can sit in either depending on where the user configured it, so both files are checked.

The `partial_rename` failure mode (`templates-routes.js:655-666`) keeps the same shape — duplicate-succeeded-but-delete-failed leaves both copies on disk plus a 500 with `code: "partial_rename"`. The orphan now also includes `<src>/agents/*.md` files (delete is rmtree, so partial-success leaks the full overlay set under the source path), but the user-recovery action is identical: manually delete one side.

**Duplicate-flow visibility.** Duplicate already carries overlays through correctly (`templates.py:687-693`), so the *behavior* is fine — the gap was visibility. The Overlays tab from §10 resolves this without any duplicate-path code changes; a freshly-duplicated template inherits the parent's overlays and the tab shows exactly what was inherited. No plan change to `duplicate()` itself; this section is the place that names the gap and resolves it via the tab.

### 12. Skill + CLI doc updates

- `/worca-template` skill (`src/worca/skills/worca-template/SKILL.md`) gains a section explaining when zip is auto-chosen and when JSON is, plus a note on the rename/default-pointer fix.
- `worca templates --help` text updated to mention zip support and the new `rename` subcommand.
- `docs/configuration/pipeline-templates.md` (and the Astro docs-site equivalent) gain a "Sharing templates with overlays" subsection plus a "Renaming templates" note clarifying that the default-template pointer follows the rename.

These are doc-only deltas; tests are not required.

## Implementation Plan

### Phase 1: Python — fetch_bundle zip sniff + extraction

**Files:** `src/worca/orchestrator/bundle.py`, `tests/test_bundle.py`

**Tasks:**
1. Add `_ZIP_MAGIC` constant and content-type/extension sniff in `fetch_bundle`.
2. Implement `_manifest_from_zip(raw_bytes)`: validate layout, extract overlays into in-memory map, synthesize v2 manifest.
3. Add `_safe_member_path()` helper for traversal/symlink defense.
4. Add `BundleError` subclass `BundleLayoutError` carrying `details={"member": ..., "rule": ...}` so the CLI can render structured rejection reasons.
5. Cover every rejection rule with a dedicated unit test (one zip fixture per rule).
6. Round-trip test: build a zip in-memory → `fetch_bundle` → assert manifest matches expected shape with `_overlays`.

### Phase 2: Python — redact + atomic_import

**Files:** `src/worca/orchestrator/bundle.py`, `src/worca/cli/templates.py`, `tests/test_bundle.py`, `tests/test_templates_cli.py`

**Tasks:**
1. Add `_overlays` to `_TEMPLATE_TOPLEVEL_KEYS`; ensure `_walk_and_redact` reaches into it.
2. In `_atomic_import` staging loop, materialize `agents/` dir from `_overlays` map.
3. Update rollback paths to confirm overlay cleanup on any failure.
4. Unit test: synthetic overlay with a fake `sk-...` value gets redacted with the correct path in `_redacted`.
5. Unit test: import a zip with overlays → assert `agents/` exists post-commit with correct contents.
6. Unit test: simulated mid-staging failure → assert no partial overlay survives.

### Phase 3: Python — cmd_templates_export

**Files:** `src/worca/cli/templates.py`, `src/worca/orchestrator/bundle.py` (new helper), `tests/test_templates_cli.py`

**Tasks:**
1. Add `_write_zip(tmpl, dest)`: build a zip in-memory with `template.json` + `agents/*` from `Template.agents_dir`.
2. Update `cmd_templates_export` to auto-pick format based on `has_overlays`.
3. Reject `--to gist` when any selected template has overlays; print an explanatory error and exit non-zero.
4. Unit test: export bugfix template → assert zip layout matches spec.
5. Unit test: export config-only template → assert JSON path unchanged.
6. CLI integration test: round-trip via tmpdir (export → import → diff).

### Phase 4: Server routes — binary import + bundle download

**Files:** `worca-ui/server/templates-routes.js`, `worca-ui/server/templates-routes.test.js`

**Tasks:**
1. Add `expressRaw({ type: 'application/zip', limit: '1mb' })` middleware to `/templates/import`.
2. Branch on `Content-Type` in the handler.
3. `handleZipImport`: write tmpfile, shell to CLI, cleanup in `finally`.
4. Update `GET /templates/:tier/:id/bundle` to set correct Content-Type/Content-Disposition for zip responses.
5. Add `GET /templates/:tier/:id/overlays` endpoint reading from `<resolver>.get(id).agents_dir`.
6. Vitest: happy-path zip import returns 200 with structured summary.
7. Vitest: oversized zip body (>1 MiB) rejected at middleware layer.
8. Vitest: malformed zip → CLI exits non-zero → server returns 400 with `error` and `code`.

### Phase 5: UI — import dialog (file-picker accept + binary POST)

**Files:** `worca-ui/app/main.js`, `worca-ui/app/views/pipelines.js` (import dialog template), `worca-ui/app/main-import-zip.test.js` (new)

**Tasks:**
1. Update `<input type="file" accept>` to include `.zip` alongside `.json`.
2. Extend `_onImportFileChange` to sniff magic bytes and route accordingly.
3. Add zip-branch in the commit handler that POSTs raw binary.
4. Render "Bundle contains prompt overlays" hint and the post-import overlay list returned by the server.
5. Vitest: dialog renders zip hint for zip files.
6. Vitest: commit handler picks the right POST shape per file type.

### Phase 6: UI — export action + gist guard

**Files:** `worca-ui/app/views/pipelines.js`, `worca-ui/app/views/pipelines-card-export.test.js` (new), `worca-ui/server/templates-routes.js` (extend list summary if needed)

**Tasks:**
1. Replace `response.json()` with `response.blob()` in `exportTemplate`; parse Content-Disposition for filename.
2. Hide "Copy gist URL" when `template.has_overlays`.
3. Add `has_overlays: boolean` to the `GET /templates` list response if not already present (audit `templates-routes.js`).
4. Vitest: list-view button rendering when `has_overlays: true` vs `false`.
5. Vitest: download path handles both Content-Types.

### Phase 7: UI — Overlays tab in Pipelines editor

**Files:** `worca-ui/app/views/pipelines-editor.js`, `worca-ui/app/views/pipelines-editor-overlays.js` (new module for the tab content), `worca-ui/app/styles.css`, `worca-ui/app/views/pipelines-editor-overlays.test.js` (new), `worca-ui/e2e/pipelines-overlays.spec.js` (new)

**Tasks:**
1. Add new tab entry; only registered when overlays endpoint returns ≥1 file.
2. Fetch overlays once on tab activation; cache in editor state.
3. Build stage→file mapping table as a constant module.
4. Render expandable stage cards using `sl-details`; disabled state for stages with no overlays.
5. Render sub-tabs per stage via `sl-tab-group`; disabled state for missing prompt files.
6. Render markdown content via `marked` + `DOMPurify` inside `.markdown-body`.
7. Vitest: stage map produces correct file matchings for a sample overlay set.
8. Vitest: disabled state when no overlays for a stage / a sub-tab.
9. Playwright e2e: import a fixture zip with overlays from the UI, navigate to the editor, assert the Overlays tab renders the right stages.

### Phase 8: Rename CLI + default-template pointer integrity

**Files:** `src/worca/cli/templates.py`, `src/worca/orchestrator/templates.py`, `worca-ui/server/templates-routes.js`, `tests/test_templates_cli.py`, `worca-ui/server/templates-routes.test.js`

**Tasks:**
1. Add `cmd_templates_rename(args)` in `cli/templates.py` wired through the `templates rename` subparser. Internally calls `TemplateResolver.duplicate` → `_maybe_rewrite_default_pointer` → `TemplateResolver.delete`.
2. Add `_maybe_rewrite_default_pointer(settings_path, old, new)` helper in `cli/templates.py` (or `utils/settings.py` if the existing module is the better fit). Reads `worca.default_template`, no-ops if it doesn't match `old`, rewrites via `atomic_write_json` if it does. Tolerate missing file / missing key — the no-op path is the common case.
3. Project-tier rename checks `<project>/.claude/settings.json`. User-tier rename checks `~/.worca/settings.json`. Cross-tier rename (e.g. project → user) checks both files and rewrites whichever matches.
4. Replace the server's two-leg composition in `templates-routes.js:618-675` with a single `runWorcaTemplates(['rename', '--src-id', ..., '--src-scope', ..., '--dst-id', ..., '--dst-scope', ...])`. Keep the same `partial_rename` response shape — the CLI surfaces structured errors (`code: "partial_rename"`) when duplicate succeeds but delete fails.
5. Python unit test: rename when `default_template` matches → pointer rewritten; rename when it doesn't → pointer unchanged.
6. Python unit test: cross-tier rename rewrites the pointer in whichever settings file holds it.
7. Python unit test: rename with overlays carries `agents/` through (regression test for the duplicate→delete legs).
8. Python unit test: rename failure between duplicate and delete leaves the CLI exit code carrying `partial_rename` plus both `(src, dst)` pairs.
9. Vitest: server route now uses a single CLI invocation; `partial_rename` response shape unchanged.

### Phase 9: Docs + skill

**Files:** `src/worca/skills/worca-template/SKILL.md`, `docs/configuration/pipeline-templates.md`, `docs-site/src/content/docs/configuration/pipeline-templates.md`, `CLAUDE.md` (add a one-line pointer to W-064 if `## Plans & Roadmap` warrants it)

**Tasks:**
1. Document the dual-format behavior with examples.
2. Show a sample zip layout in the docs.
3. Explain the gist limitation explicitly.
4. Cover security model: trust boundary unchanged, but now with the additional zip hardening rules listed.
5. Document the rename pointer-rewrite behavior: "Renaming a template that's set as the project default automatically updates the pointer; no manual reset needed."

### Files Changed Summary

| File | Change |
|---|---|
| `src/worca/orchestrator/bundle.py` | Add zip sniff, extraction, layout validation, traversal/symlink guards, `_overlays` redaction. |
| `src/worca/cli/templates.py` | `cmd_templates_export` chooses format; `_atomic_import` materializes `agents/`; gist guard; new `cmd_templates_rename` with default-pointer rewrite. |
| `src/worca/utils/settings.py` *(or `cli/templates.py`)* | New `_maybe_rewrite_default_pointer` helper. |
| `src/worca/skills/worca-template/SKILL.md` | Mention zip auto-selection and rename pointer behavior. |
| `worca-ui/server/templates-routes.js` | Accept `application/zip` import; zip download; new `/overlays` endpoint; `has_overlays` in list summary; rename route collapses to single CLI call. |
| `worca-ui/app/main.js` | `_onImportFileChange` magic-byte sniff + binary POST commit branch. |
| `worca-ui/app/views/pipelines.js` | Export blob handling; gist guard. |
| `worca-ui/app/views/pipelines-editor.js` | Register Overlays tab. |
| `worca-ui/app/views/pipelines-editor-overlays.js` | New module: stage map + rendering. |
| `worca-ui/app/styles.css` | Overlay tab styling, disabled-state for stages/sub-tabs. |
| `tests/test_bundle.py` | New: full zip layout/traversal/symlink/bomb suite. |
| `tests/test_templates_cli.py` | Round-trip, gist-rejection, overlay materialization, rename + pointer rewrite cases, duplicate-with-overlays regression. |
| `worca-ui/server/templates-routes.test.js` | Binary import, oversized, malformed, overlay endpoint, single-call rename. |
| `worca-ui/app/main-import-zip.test.js` | New: import dialog sniff + commit. |
| `worca-ui/app/views/pipelines-card-export.test.js` | New: gist guard, blob download. |
| `worca-ui/app/views/pipelines-editor-overlays.test.js` | New: stage map + rendering. |
| `worca-ui/e2e/pipelines-overlays.spec.js` | New: e2e import + view overlays. |
| `worca-ui/package.json` | Add `yauzl` if we end up needing it server-side (TBD — Phase 4 may avoid by relying on the CLI). |
| `worca-ui/server/package.json` (if separate) | Same. |
| `docs/configuration/pipeline-templates.md`, docs-site equivalent | Zip sharing subsection. |

## Considerations

### Trust boundary

The existing `bundle.py` docstring frames bundles as "config-as-data, not code-as-data." Zip bundles drift toward "files-as-data" because they materialize markdown files on disk that subsequently mount into agent system prompts. This is *prompt code*, and a malicious overlay author could craft a planner.md that instructs the agent to exfiltrate secrets, ignore governance, etc. The mitigations:

- **Author verification stays the user's responsibility.** The same `curl|sh`-class trust model.
- **No code execution at import time** — overlays are inert files until a pipeline run.
- **Path/symlink/bomb hardening prevents the import itself from compromising the host.**
- **Redaction reports show the importer exactly which overlay files arrived and what was redacted.**
- **UI prompt** at import time names each overlay file and stage before the user commits.

### Breaking changes

None. All paths are additive. JSON bundle v1 keeps working. The zip path is opt-in (only triggered by zip magic bytes or `.zip` extension). The new `_overlays` field is dropped on JSON serialization for older importers.

### Migration

None. Existing templates with `agents_dir` on disk start exporting as zip automatically once Phase 3 ships. Users who exported their templates as JSON before this plan can re-export to capture overlays; the previous JSON exports remain importable.

### Governance

No new hooks. The dispatch governance system (`worca.governance.dispatch`) is unaffected — bundle import does not change which tools/skills/subagents are available at runtime.

### Performance

Zip imports cap at 1 MiB compressed and 4 MiB uncompressed, with ≤64 entries. Validation + extraction is O(entries) and runs in <50ms for typical bundles. The new `/overlays` endpoint reads ≤8 small files per template; cached client-side after first fetch.

### Cross-platform

`zipfile` is stdlib. Symlink mode detection via `external_attr` works identically on Linux/macOS/Windows (the bits are encoded by the producer, not the consumer's filesystem). Path-traversal validation uses `PurePosixPath` so Windows-style backslashes are caught by the explicit `"\\" in name` check before they ever hit the resolver.

Windows degradations: the Python CLI runs cleanly under WSL2 and native Python (zipfile is stdlib, no fork/exec dependencies). The server-side tmpfile path uses `os.tmpdir()` which is platform-portable in Node. No specific Windows TODOs.

### Edge cases

- **Empty `agents/` dir on a built-in template:** export still chooses JSON because `any(Path.glob('*.md'))` is `False`.
- **Overlay file with no marker (`<!-- append -->` / `<!-- replace -->`):** today the overlay system treats no-marker as "replace entirely" — this is preserved; we don't enforce marker presence at import time (overlay validity is the runtime's concern, not bundle's).
- **Duplicate overlay filenames within a zip:** impossible — `zipfile` uses the last entry's bytes when extracting by name, but our explicit `infolist()` iteration would catch duplicates and reject. Implementation note in Phase 1.
- **Importing a template ID that collides with an existing one in the destination tier:** existing `TemplateResolver.save` behavior applies (409 / re-prompt). Overlay materialization happens only after `save` succeeds.
- **Duplicate of a built-in with overlays — pre-W-064 behavior was already correct, only the visibility was missing.** `TemplateResolver.duplicate` (`templates.py:687-693`) deep-copies `agents/`. So users who duplicated `bugfix` last year are already running the overlay-augmented planner; W-064's Overlays tab simply makes that visible. No data migration needed.
- **`partial_rename` failure with overlays.** Same failure shape as today (HTTP 500 + `code: "partial_rename"`), but the on-disk leak now includes the overlay files under the source path. The recovery action is unchanged — manually delete one side. Worth noting in the user-facing error message; the W-064 rename CLI surfaces the full file list in the structured payload so the UI can render it inline rather than make the user guess.
- **Rename when the renamed template is NOT the default.** `_maybe_rewrite_default_pointer` no-ops. Verified by unit test in Phase 8.
- **Rename where the user-tier `settings.json` doesn't exist.** Pointer rewrite tolerates missing file — common for fresh worca installs that haven't pinned a user-global default. The function returns without error.
- **Cross-tier rename when the same template id is the default in BOTH project and user settings.** Both files are checked and rewritten. This is an unusual configuration but legal.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|---|---|---|
| Python | `test_bundle.py::test_fetch_zip_happy_path` | Valid zip → manifest with `_overlays` populated |
| Python | `test_bundle.py::test_fetch_zip_rejects_traversal` | Member `../etc/passwd` rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_absolute` | Member `/etc/passwd` rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_drive_letter` | Member `C:\foo` rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_backslash` | Member `foo\bar` rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_symlink` | `external_attr` symlink bit rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_bomb_ratio` | Per-file ratio >100× rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_oversized_total` | Uncompressed >4 MiB rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_oversized_single` | Per-file >256 KiB rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_too_many_entries` | >64 members rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_missing_template_json` | No `template.json` at root rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_unexpected_entries` | Entry outside `agents/` rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_invalid_overlay_name` | Bad chars in `.md` name rejected |
| Python | `test_bundle.py::test_fetch_zip_rejects_duplicate_members` | Same name twice rejected |
| Python | `test_bundle.py::test_redact_walks_overlays` | Secret in overlay content redacted with correct path |
| Python | `test_templates_cli.py::test_export_emits_zip_when_overlays_present` | `Template.agents_dir` non-empty → `.zip` output |
| Python | `test_templates_cli.py::test_export_emits_json_when_no_overlays` | No overlays → `.json` (current behavior) |
| Python | `test_templates_cli.py::test_export_gist_rejects_overlays` | `--to gist` + overlays → non-zero exit |
| Python | `test_templates_cli.py::test_import_zip_materializes_agents_dir` | Post-import: `<tier>/<id>/agents/planner.md` matches input |
| Python | `test_templates_cli.py::test_import_zip_rollback_on_failure` | Mid-staging error leaves no partial state |
| Python | `test_templates_cli.py::test_round_trip_with_overlays` | export → import → identical content |
| Python | `test_templates_cli.py::test_rename_carries_overlays` | Rename of overlay-bearing template lands `agents/` under new id |
| Python | `test_templates_cli.py::test_rename_rewrites_default_pointer` | `worca.default_template = {tier, srcId}` → `{dstTier, dstId}` after rename |
| Python | `test_templates_cli.py::test_rename_does_not_rewrite_unrelated_pointer` | Pointer unchanged when renamed template isn't the default |
| Python | `test_templates_cli.py::test_rename_cross_tier_finds_pointer_in_either_settings` | Pointer rewritten in whichever of project/user settings holds it |
| Python | `test_templates_cli.py::test_rename_tolerates_missing_settings_file` | No-op + clean exit when settings file doesn't exist |
| Python | `test_templates_cli.py::test_rename_partial_failure_reports_structured_state` | Mid-rename failure surfaces `partial_rename` exit + full `(src, dst)` payload |
| Python | `test_templates_cli.py::test_duplicate_builtin_with_overlays_carries_agents_dir` | Regression covering the pre-existing duplicate→overlays path |
| JS | `templates-routes.test.js::rename uses single cli call` | Server collapses to one invocation, surfaces `partial_rename` from CLI |
| JS | `templates-routes.test.js::handles application/zip body` | Binary import returns 200 |
| JS | `templates-routes.test.js::rejects oversized zip body` | >1 MiB body rejected at middleware |
| JS | `templates-routes.test.js::overlays endpoint returns md files` | New endpoint shape |
| JS | `templates-routes.test.js::list summary includes has_overlays` | Field present |
| JS | `main-import-zip.test.js::sniffs zip magic bytes` | Zip file routed to binary path |
| JS | `main-import-zip.test.js::sniffs by extension fallback` | `.zip` filename routed even without magic |
| JS | `main-import-zip.test.js::renders overlay hint` | Dialog shows "includes prompt overlays" |
| JS | `pipelines-card-export.test.js::hides gist when has_overlays` | "Copy gist URL" button absent |
| JS | `pipelines-card-export.test.js::download uses blob` | Export path doesn't JSON-parse zip responses |
| JS | `pipelines-editor-overlays.test.js::stage map matches files` | Mapping table correctness |
| JS | `pipelines-editor-overlays.test.js::disables empty stages` | UI state for stages with no overlays |
| JS | `pipelines-editor-overlays.test.js::renders markdown via marked` | Output contains expected HTML |
| JS | `pipelines-editor-overlays.test.js::shows overlays inherited via duplicate` | Tab surfaces overlays from a `duplicate`-from-builtin source, not just import |

### Integration / E2E Tests

- **Playwright `pipelines-overlays.spec.js`:** start UI in single-project mode → POST a fixture zip via the import dialog → assert success toast → open template editor → assert Overlays tab visible → expand Plan card → assert rendered markdown contains expected heading from fixture.
- **CLI integration in `tests/integration/`:** seed a project with a builtin template carrying overlays → export → import to user tier → run a pipeline that uses the imported template → assert the planner stage sees the overlay-augmented prompt (verify by inspecting the agent prompt log in `.worca/runs/<id>/prompts/`).

### Existing Tests to Update

- `worca-ui/app/main-import.test.js` (if it exists; otherwise N/A): the JSON path stays valid but the file-input `accept` attribute now includes `.zip`. Adjust assertion.
- `tests/test_bundle.py::test_fetch_bundle_rejects_non_json` (if present): adjust to assert that a JSON-looking-but-malformed payload still fails the JSON path and does not silently fall through to the zip path.

## Files to Create/Modify

See "Files Changed Summary" table above.

## Out of Scope

- **Overlay editing in the UI.** This plan adds read-only display. A follow-up plan can add a markdown editor with marker validation and dirty-state tracking.
- **Multi-template-per-zip bundles.** Single-template-per-zip is intentional — see Design §2.
- **Zip support for gist sharing.** Explicitly rejected — see Design §6 + Considerations.
- **Overlay diff against base prompts.** User requested rendered markdown only, no diff.
- **Built-in zip viewer in the UI** (without going through import). Users wanting to inspect a zip before import can `unzip -l` locally; the import dialog's redaction report covers the post-import audit.
- **Format negotiation via Accept header on the bundle download endpoint.** The server picks based on overlay presence; clients don't choose. Adding `?format=json` for templates that have overlays (forcing config-only export) is a possible follow-up but not in this plan.
- **Compression algorithm choice / encryption.** Zip uses default deflate; no encryption. AES-encrypted entries are rejected (`external_attr` check covers this).
- **Plugin entry-point for third-party pip packages to ship templates.** A separate concern — this plan only ensures the on-disk and bundle paths handle overlays.
- **Rename-time validation against in-flight pipeline runs.** A run launched moments before a rename may resolve the template id at PRESTART and then continue using the resolved snapshot; the rename does not abort or migrate live runs. This matches today's behavior and is intentional. Cross-run pinning is out of scope.

### Explicitly IN scope (and why)

- **Default-template pointer rewrite on rename** (§11 + Phase 8). Pre-existing bug, but rename is the same edit-flow surface the rest of this plan touches and the fix is a few lines. Folding it in closes a related papercut users will hit while exercising the new overlay flow. Alternative — file separately as a `bug` issue — was rejected because the test setup and CLI surface are identical to W-064's other changes; splitting it would duplicate work without adding clarity.
- **Single-call `worca templates rename` subcommand** (Phase 8). Even without the pointer rewrite, collapsing the server's two-leg composition into one Python invocation tightens the `partial_rename` reporting surface; pairs naturally with the new rename behavior.
