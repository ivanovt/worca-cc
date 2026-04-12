# W-039: Workspace Batch Add Projects

## Problem

The "Add Project" flow in worca-ui settings only supports adding one project at a time. Users with workspaces containing multiple git repositories (e.g., a monorepo parent or a folder of microservices) must repeat the add flow for each subfolder. This is tedious and error-prone.

## Proposal

Add a "Workspace" mode toggle to the existing Add Project dialog. When enabled, the user selects a parent folder, the system scans for immediate git subfolders, and presents a scrollable checkbox list for batch registration. After registration, a summary dialog offers per-project worca install/update with version-aware defaults.

## Design

### Dialog UI (Option B — Explicit Toggle)

The Add Project dialog gains a `<sl-radio-group>` at the top:

```
┌─ Add Project ─────────────────────────────┐
│                                           │
│  ○ Single project  ● Workspace            │
│                                           │
│  Path: /Users/me/workspaces/client  [📁]  │
│                                           │
│  Found 4 git projects:                    │
│  [Select all] [Select none]               │
│ ┌───────────────────────────────────────┐ │
│ │ ☑ auth-service    /client/auth-serv…  │ │
│ │ ☑ web-app         /client/web-app     │ │
│ │ ☐ legacy-api      /client/legacy-api  │ │ ← already registered
│ │ ☑ shared-utils    /client/shared-ut…  │ │
│ │                    (scrollable)        │ │
│ └───────────────────────────────────────┘ │
│                                           │
│  ⚠ 1 project already registered (greyed)  │
│                                           │
│           [Cancel]  [Add 3 Projects]      │
└───────────────────────────────────────────┘
```

**Single mode** — unchanged current behavior (path + name inputs, single submit).

**Workspace mode:**
- Path input + browse button (reuses `POST /api/choose-directory`)
- No name input (names auto-derived from subfolder basenames via `slugify()`)
- After path changes → `POST /api/scan-directory` → populate checkbox list
- Checkbox list in a scrollable container (`max-height: 300px; overflow-y: auto`) — no folder cap, all results shown
- Results sorted alphabetically by name
- Already-registered paths are shown greyed/disabled with "(already registered)" label
- Name collisions shown inline: if `my-app` conflicts, the row displays `my-app → my-app-2`
- "Select all" / "Select none" links above the list
- Submit button text updates dynamically: "Add N Projects"
- Name collisions within the batch and against existing projects are resolved client-side by appending `-2`, `-3`, etc., iterating until unique

### Post-Add: Batch Worca Setup Dialog

After batch registration, replace the current single-project `offerWorcaSetup()` with a summary dialog:

```
┌─ Worca Setup ──────────────────────────────┐
│                                            │
│  3 projects added. Install worca?          │
│                                            │
│  ☑ auth-service     (not installed)        │
│  ☑ web-app          (outdated — v0.5.2)    │
│  ☐ shared-utils     (v0.6.0 — current)    │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ auth-service   ✓ started            │  │
│  │ web-app        ⏳ installing…        │  │
│  └──────────────────────────────────────┘  │
│                                            │
│       [Skip]  [Install/Update 2]           │
└────────────────────────────────────────────┘
```

- Calls `GET /api/projects/{name}/worca-status` in parallel (`Promise.all`) for all newly added projects
- Groups by status: not installed, outdated, current
- Pre-checks "not installed" and "outdated"; unchecks "current"
- On confirm, calls `POST /api/projects/{name}/worca-setup` for each selected project sequentially
- Shows inline progress per project: pending (spinner), started (check), failed (x with error message)
- "Started" means the API call succeeded (setup process spawned) — no polling of setup completion

## Server Changes

### New Endpoint: `POST /api/scan-directory`

Scans a directory for immediate child folders that contain a `.git` directory.

**Request:**
```json
{ "path": "/absolute/path/to/workspace" }
```

**Response:**
```json
{
  "ok": true,
  "subfolders": [
    { "name": "auth-service", "path": "/workspace/auth-service" },
    { "name": "web-app", "path": "/workspace/web-app" }
  ]
}
```

**Logic:**
- Validate path is absolute and directory exists
- `readdirSync` with `{ withFileTypes: true }` → filter `isDirectory()`
- Skip dotfiles (names starting with `.`) and `node_modules`
- Check each child for `.git` subdirectory
- Return only entries with `.git` (non-git folders are noise)
- Sort results alphabetically by name
- No entry cap — return all matching subfolders

**Validation:**
- 400 if path not absolute
- 400 if directory doesn't exist
- 200 with empty `subfolders` if no git children found

### Enhanced Endpoint: `GET /api/projects/:projectId/worca-status`

Extend the existing endpoint to return version information.

**Current response:** `{ ok: true, installed: bool }`

**New response:**
```json
{
  "ok": true,
  "installed": true,
  "version": "0.5.2",
  "outdated": true
}
```

**Logic:**
- `installed`: unchanged — checks `existsSync('.claude/worca')`
- `version`: read from `.claude/worca/version.json` (or equivalent marker), `null` if not installed
- `outdated`: compare installed version against current worca-cc package version, `false` if not installed or versions match

This is backward-compatible — existing callers that only read `installed` are unaffected.

### New Endpoint: `POST /api/projects/batch`

Registers multiple projects atomically.

**Request:**
```json
{
  "projects": [
    { "name": "auth-service", "path": "/workspace/auth-service" },
    { "name": "web-app", "path": "/workspace/web-app" }
  ]
}
```

**Response (success):**
```json
{
  "ok": true,
  "projects": [
    { "name": "auth-service", "path": "/workspace/auth-service" },
    { "name": "web-app", "path": "/workspace/web-app" }
  ]
}
```

**Response (validation failure):**
```json
{
  "ok": false,
  "error": "2 projects failed validation",
  "failed": [
    { "name": "bad project", "error": "name must match /^[a-z0-9_-]{1,64}$/i" }
  ]
}
```

**Logic:**
1. Reject empty arrays with 400
2. Validate all entries first (name format, path absolute, directory exists)
3. Check `existing.length + batch.length <= maxProjects`
4. If all valid, write all via `writeProject()` in a loop
5. If any invalid, return 400 with details — write nothing (all-or-nothing)

### Unchanged Existing Endpoints

- `POST /api/projects` — single add, unchanged
- `POST /api/choose-directory` — reused as-is
- `POST /api/projects/{name}/worca-setup` — reused for batch setup

## Client Changes

### `add-project-dialog.js`

**New module-level state:**
- `dialogMode`: `"single"` | `"workspace"` (default: `"single"`)
- `scannedFolders`: `[]` — results from scan endpoint
- `selectedFolders`: `Set` — indices of checked folders
- `scanning`: `boolean` — loading state during scan
- `scanError`: `string` — error from scan
- `scanAbortController`: `AbortController | null` — for cancelling in-flight scan requests

**New client-side helper: `slugify(name)`**
- Lowercase, replace non-`[a-z0-9_-]` with `-`, collapse consecutive dashes, truncate to 64 chars
- Duplicates the server-side logic (3 lines, not worth sharing across client/server)
- Used for deriving names from scanned folder basenames and for collision resolution display

**Mode toggle:**
- `<sl-radio-group>` with value bound to `dialogMode`
- Switching modes resets scan state

**Workspace mode path change handler:**
- On path change (manual input or browse), debounce 300ms then call `POST /api/scan-directory`
- Before each scan request, abort any in-flight request via `scanAbortController.abort()` and create a new `AbortController`
- Set `scanning = true` during fetch, show `<sl-spinner>`
- On response, populate `scannedFolders`, auto-select all non-duplicate entries
- Cross-reference against `state.projects` to mark already-registered paths

**Checkbox list rendering:**
- Scrollable container: `max-height: 300px; overflow-y: auto`
- Each scanned folder → `<sl-checkbox>` row with name and truncated path
- If the derived name collides (with existing projects or within batch), show resolved name: `my-app → my-app-2`
- Already-registered folders: disabled checkbox, muted text, "(already registered)"
- "Select all" / "Select none" links that toggle `selectedFolders`

**Name collision resolution (client-side):**
- Build a set of existing project names from `state.projects`
- For each selected folder, derive name via `slugify(folder.name)`
- If name conflicts with existing set or a previously resolved name in this batch, append `-2`, increment until unique
- Show the resolved name in the checkbox list so the user sees what they'll get
- Server still validates independently — on TOCTOU race the batch returns 400 and the user retries

**Submit handler (workspace mode):**
- Collect selected folders as `{ name: resolvedName, path: folder.path }`
- `POST /api/projects/batch` with the array
- On success, call `offerBatchWorcaSetup(addedProjects, rerender)`
- On failure, set `dialogError` with the server's error message — dialog stays open with error shown, selections preserved

**Dialog reset on close:**
- Reset `dialogMode`, `scannedFolders`, `selectedFolders`, `scanning`, `scanError`, `scanAbortController`

### `add-project-dialog.js` — new function: `offerBatchWorcaSetup()`

- Fetch `GET /api/projects/{name}/worca-status` for each project in parallel
- Build a list with status labels: "not installed", "outdated — vX.Y.Z", "vX.Y.Z — current"
- Show a confirm-style dialog with checkboxes (reuse `showConfirm()` with a lit-html template `message`)
- Pre-check "not installed" and "outdated"; uncheck "current"
- On confirm, call `POST /api/projects/{name}/worca-setup` for each selected project sequentially
- Show inline status per project as each call completes: pending (spinner), started (checkmark), failed (x with error)

### `main.js`

- `onProjectAdd` callback: handle both single project (object) and batch (array) responses
- Refetch projects list after either flow

## Validation & Edge Cases

| Case | Handling |
|---|---|
| Parent folder has no git subfolders | Show "No git projects found in this directory" message, disable submit |
| All subfolders already registered | All checkboxes disabled, submit disabled, info message |
| Name collision within batch | Auto-resolve client-side: `my-app`, `my-app-2`, `my-app-3` — shown in checkbox list |
| Name collision with existing projects | Auto-resolve same as above |
| Max projects limit exceeded | Show warning: "Adding N projects would exceed the limit of M. Deselect some projects." Disable submit until under limit |
| Large workspace (100+ folders) | All results shown in scrollable list, sorted alphabetically, count in header |
| Path typed manually (not browsed) | Same scan trigger, debounced on input |
| User switches mode mid-flow | Reset scan state, keep path if already entered |
| Empty workspace path | No scan triggered, submit disabled |
| Non-existent path in workspace mode | Scan returns 400, show error in `scanError` |
| Path changed while scan in-flight | Previous request aborted via `AbortController`, new scan starts |
| Batch submit fails (network/server error) | `dialogError` set with error message, dialog stays open, selections preserved |
| Worca setup call fails for one project | That project shows error inline, remaining projects continue |
| Symlinked directories | Followed by Node.js `readdirSync` + `isDirectory()` — may cause duplicates if both symlink and target are in same parent; acceptable edge case |

## Test Plan

### Server Tests (vitest — `worca-ui/server/`)

#### `scan-directory` endpoint

1. **Valid workspace with git subfolders** — create temp dir with 3 subdirs (2 with `.git`, 1 without) → returns 2 entries
2. **Empty directory** — returns `{ ok: true, subfolders: [] }`
3. **Non-existent path** — returns 400
4. **Relative path** — returns 400
5. **Skips dotfiles and node_modules** — create `.hidden/` and `node_modules/` with `.git` inside → not returned
6. **Results sorted alphabetically** — create `zebra/`, `alpha/`, `middle/` with `.git` → returned in order alpha, middle, zebra
7. **No entry cap** — create 60 git subdirs → response has all 60

#### `projects/batch` endpoint

8. **Batch add 3 valid projects** — all registered, 201 response
9. **Batch with one invalid name** — 400, nothing written
10. **Batch with non-existent path** — 400, nothing written
11. **Batch exceeding max projects limit** — 400 with limit error
12. **Batch with duplicate paths against existing** — 400
13. **Empty batch array** — 400

#### `worca-status` version extension

14. **Installed with version file** — returns `{ installed: true, version: "0.6.0", outdated: false }`
15. **Installed without version file** — returns `{ installed: true, version: null, outdated: false }`
16. **Not installed** — returns `{ installed: false, version: null, outdated: false }`
17. **Outdated version** — returns `{ installed: true, version: "0.5.0", outdated: true }`

### Client Tests (vitest — `worca-ui/app/`)

#### Dialog mode toggle

18. **Default mode is "single"** — renders name + path inputs, no checkbox list
19. **Switch to workspace mode** — hides name input, shows scan area
20. **Switch back to single mode** — restores name input, clears scan state

#### Workspace scan flow

21. **Path change triggers scan** — mock fetch, verify `POST /api/scan-directory` called
22. **Scan results render checkbox list** — mock response with 3 folders, verify 3 checkboxes
23. **Already-registered paths shown disabled** — pass existing projects in state, verify disabled attribute
24. **Select all / select none toggles** — click each, verify checkbox states
25. **Path change aborts previous scan** — trigger two path changes, verify first fetch aborted

#### Workspace submit flow

26. **Submit calls batch endpoint** — mock fetch, verify `POST /api/projects/batch` with selected entries
27. **Submit button shows count** — select 2 of 4, button reads "Add 2 Projects"
28. **Submit disabled when none selected** — deselect all, verify button disabled
29. **Max limit warning shown** — set existing=18, select 4, verify warning appears
30. **Submit error shown in dialog** — mock 400 response, verify `dialogError` displayed and dialog stays open

#### Name collision resolution

31. **Collision with existing project** — existing project `my-app`, scanned folder `my-app` → displays `my-app → my-app-2`
32. **Collision within batch** — two scanned folders named `utils` → displays `utils` and `utils → utils-2`

#### Batch worca setup dialog

33. **Status fetch renders checkboxes** — mock 3 status responses (not installed, outdated, current) → verify 3 rows with correct labels, first two checked, last unchecked
34. **Confirm triggers setup calls** — select 2 projects, confirm, verify 2 `POST /worca-setup` calls made
35. **Skip closes dialog without setup calls** — click skip, verify no setup calls made
36. **Setup progress shown inline** — trigger confirm, verify spinner then checkmark per project as calls resolve

### E2E Tests (Playwright — `worca-ui/e2e/`)

37. **Full workspace flow** — open settings → Add Project → switch to Workspace → browse folder → select subfolders → submit → verify projects appear in list
38. **Mode toggle preserves path** — enter path in single mode → switch to workspace → path still present

## Implementation Order

1. **Server: `GET /worca-status` version extension** + tests
2. **Server: `POST /api/scan-directory`** + tests
3. **Server: `POST /api/projects/batch`** + tests
4. **Client: `slugify()` helper + name collision resolution logic** + tests
5. **Client: dialog mode toggle** (UI only, no submission) + tests
6. **Client: workspace scan + checkbox list** (with abort controller) + tests
7. **Client: workspace batch submit** (with error handling) + tests
8. **Client: batch worca setup dialog** (with progress) + tests
9. **E2E tests**

## Files to Create/Modify

| File | Action |
|---|---|
| `worca-ui/server/app.js` | Add `POST /api/scan-directory` route |
| `worca-ui/server/project-routes.js` | Add `POST /api/projects/batch` route, extend `GET /worca-status` |
| `worca-ui/server/project-registry.js` | Add `scanDirectory()` helper |
| `worca-ui/app/views/add-project-dialog.js` | Mode toggle, scan UI, checkbox list, batch submit, abort controller, error handling, batch worca setup with progress |
| `worca-ui/app/main.js` | Handle batch `onProjectAdd` response |
| `worca-ui/server/__tests__/scan-directory.test.js` | New test file |
| `worca-ui/server/__tests__/projects-batch.test.js` | New test file |
| `worca-ui/server/__tests__/worca-status.test.js` | New or extend existing |
| `worca-ui/app/__tests__/add-project-dialog.test.js` | Extend or create |
