# W-039: Workspace Batch Add Projects

## Problem

The "Add Project" flow in worca-ui settings only supports adding one project at a time. Users with workspaces containing multiple git repositories (e.g., a monorepo parent or a folder of microservices) must repeat the add flow for each subfolder. This is tedious and error-prone.

## Proposal

Add a "Workspace" mode toggle to the existing Add Project dialog. When enabled, the user selects a parent folder, the system scans for git subfolders, and presents a checkbox list for batch registration. After registration, a summary dialog offers per-project worca install/update.

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
│  ☑ auth-service      /client/auth-service │
│  ☑ web-app           /client/web-app      │
│  ☐ legacy-api        /client/legacy-api   │ ← already registered
│  ☑ shared-utils      /client/shared-utils │
│                                           │
│  ⚠ 1 project already registered (greyed)  │
│                                           │
│           [Cancel]  [Add 3 Projects]      │
└───────────────────────────────────────────┘
```

**Single mode** — unchanged current behavior (path + name inputs, single submit).

**Workspace mode:**
- Path input + browse button (reuses `POST /api/choose-directory`)
- No name input (names auto-derived from subfolder basenames via existing `slugify()`)
- After path changes → `POST /api/scan-directory` → populate checkbox list
- Already-registered paths are shown greyed/disabled with "(already registered)" label
- "Select all" / "Select none" links above the list
- Submit button text updates dynamically: "Add N Projects"
- Name collisions within the batch are resolved by appending `-2`, `-3`, etc.

### Post-Add: Batch Worca Setup Dialog

After batch registration, replace the current single-project `offerWorcaSetup()` with a summary dialog:

```
┌─ Worca Setup ──────────────────────────┐
│                                        │
│  3 projects added. Install worca?      │
│                                        │
│  ☑ auth-service     (not installed)    │
│  ☑ web-app          (not installed)    │
│  ☐ shared-utils     (v0.6.0 — current)│
│                                        │
│       [Skip]  [Install/Update 2]       │
└────────────────────────────────────────┘
```

- Calls `GET /api/projects/{name}/worca-status` in parallel (`Promise.all`) for all newly added projects
- Groups by status: not installed, outdated, current
- Pre-checks "not installed" and "outdated"; unchecks "current"
- On confirm, calls `POST /api/projects/{name}/worca-setup` for each selected project sequentially
- Reuses existing server endpoints — no server changes for this part

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
    { "name": "auth-service", "path": "/workspace/auth-service", "isGit": true },
    { "name": "web-app", "path": "/workspace/web-app", "isGit": true }
  ]
}
```

**Logic:**
- Validate path is absolute and directory exists
- `readdirSync` with `{ withFileTypes: true }` → filter `isDirectory()`
- Skip dotfiles (names starting with `.`) and `node_modules`
- Check each child for `.git` subdirectory → set `isGit`
- Return only `isGit: true` entries (non-git folders are noise)
- Limit to 50 entries (safety cap)

**Validation:**
- 400 if path not absolute
- 400 if directory doesn't exist
- 200 with empty `subfolders` if no git children found

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

**Response (partial/validation failure):**
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
1. Validate all entries first (name format, path absolute, directory exists)
2. Check `existing.length + batch.length <= maxProjects`
3. If all valid, write all via `writeProject()` in a loop
4. If any invalid, return 400 with details — write nothing (all-or-nothing)

### No Changes to Existing Endpoints

- `POST /api/projects` — single add, unchanged
- `POST /api/choose-directory` — reused as-is
- `GET /api/projects/{name}/worca-status` — reused for batch setup dialog
- `POST /api/projects/{name}/worca-setup` — reused for batch setup

## Client Changes

### `add-project-dialog.js`

**New module-level state:**
- `dialogMode`: `"single"` | `"workspace"` (default: `"single"`)
- `scannedFolders`: `[]` — results from scan endpoint
- `selectedFolders`: `Set` — indices of checked folders
- `scanning`: `boolean` — loading state during scan
- `scanError`: `string` — error from scan

**Mode toggle:**
- `<sl-radio-group>` with value bound to `dialogMode`
- Switching modes resets scan state

**Workspace mode path change handler:**
- On path change (manual input or browse), debounce 300ms then call `POST /api/scan-directory`
- Set `scanning = true` during fetch, show `<sl-spinner>`
- On response, populate `scannedFolders`, auto-select all non-duplicate entries
- Cross-reference against `state.projects` to mark already-registered paths

**Checkbox list rendering:**
- Each scanned folder → `<sl-checkbox>` row with name and truncated path
- Already-registered folders: disabled checkbox, muted text, "(already registered)"
- "Select all" / "Select none" links that toggle `selectedFolders`

**Submit handler (workspace mode):**
- Collect selected folders as `{ name: slugify(folder.name), path: folder.path }`
- Resolve name collisions (within batch and against existing projects)
- `POST /api/projects/batch` with the array
- On success, call `offerBatchWorcaSetup(addedProjects, rerender)`

**Dialog reset on close:**
- Reset `dialogMode`, `scannedFolders`, `selectedFolders`, `scanning`, `scanError`

### `add-project-dialog.js` — new function: `offerBatchWorcaSetup()`

- Fetch `GET /api/projects/{name}/worca-status` for each project in parallel
- Build a list with status labels (not installed / outdated / current)
- Show a new confirm-style dialog with checkboxes
- On confirm, call `POST /api/projects/{name}/worca-setup` for each selected project
- This can reuse `showConfirm()` with a custom `message` (lit-html template with checkboxes)

### `main.js`

- `onProjectAdd` callback: handle both single project (object) and batch (array) responses
- Refetch projects list after either flow

## Validation & Edge Cases

| Case | Handling |
|---|---|
| Parent folder has no git subfolders | Show "No git projects found in this directory" message, disable submit |
| All subfolders already registered | All checkboxes disabled, submit disabled, info message |
| Name collision within batch | Auto-resolve: `my-app`, `my-app-2`, `my-app-3` |
| Name collision with existing projects | Auto-resolve same as above |
| Max projects limit exceeded | Show warning: "Adding N projects would exceed the limit of 20. Deselect some projects." Disable submit until under limit |
| Scan returns 50+ folders | Server caps at 50, client shows note: "Showing first 50 subfolders" |
| Path typed manually (not browsed) | Same scan trigger, debounced on input |
| User switches mode mid-flow | Reset scan state, keep path if already entered |
| Empty workspace path | No scan triggered, submit disabled |
| Non-existent path in workspace mode | Scan returns 400, show error |

## Test Plan

### Server Tests (vitest — `worca-ui/server/`)

#### `scan-directory` endpoint

1. **Valid workspace with git subfolders** — create temp dir with 3 subdirs (2 with `.git`, 1 without) → returns 2 entries with `isGit: true`
2. **Empty directory** — returns `{ ok: true, subfolders: [] }`
3. **Non-existent path** — returns 400
4. **Relative path** — returns 400
5. **Skips dotfiles and node_modules** — create `.hidden/` and `node_modules/` with `.git` inside → not returned
6. **Caps at 50 entries** — create 55 git subdirs → response has 50

#### `projects/batch` endpoint

7. **Batch add 3 valid projects** — all registered, 201 response
8. **Batch with one invalid name** — 400, nothing written
9. **Batch with non-existent path** — 400, nothing written
10. **Batch exceeding max projects limit** — 400 with limit error
11. **Batch with duplicate paths against existing** — 400 (or skip duplicates — TBD)
12. **Empty batch array** — 400

### Client Tests (vitest — `worca-ui/app/`)

#### Dialog mode toggle

13. **Default mode is "single"** — renders name + path inputs, no checkbox list
14. **Switch to workspace mode** — hides name input, shows scan area
15. **Switch back to single mode** — restores name input, clears scan state

#### Workspace scan flow

16. **Path change triggers scan** — mock fetch, verify `POST /api/scan-directory` called
17. **Scan results render checkbox list** — mock response with 3 folders, verify 3 checkboxes
18. **Already-registered paths shown disabled** — pass existing projects in state, verify disabled attribute
19. **Select all / select none toggles** — click each, verify checkbox states

#### Workspace submit flow

20. **Submit calls batch endpoint** — mock fetch, verify `POST /api/projects/batch` with selected entries
21. **Submit button shows count** — select 2 of 4, button reads "Add 2 Projects"
22. **Submit disabled when none selected** — deselect all, verify button disabled
23. **Max limit warning shown** — set existing=18, select 4, verify warning appears

### E2E Tests (Playwright — `worca-ui/e2e/`)

24. **Full workspace flow** — open settings → Add Project → switch to Workspace → browse folder → select subfolders → submit → verify projects appear in list
25. **Mode toggle preserves path** — enter path in single mode → switch to workspace → path still present

## Implementation Order

1. **Server: `POST /api/scan-directory`** + tests
2. **Server: `POST /api/projects/batch`** + tests
3. **Client: dialog mode toggle** (UI only, no submission) + tests
4. **Client: workspace scan + checkbox list** + tests
5. **Client: workspace batch submit** + tests
6. **Client: batch worca setup dialog** + tests
7. **E2E tests**

## Files to Create/Modify

| File | Action |
|---|---|
| `worca-ui/server/app.js` | Add `POST /api/scan-directory` route |
| `worca-ui/server/project-routes.js` | Add `POST /api/projects/batch` route |
| `worca-ui/server/project-registry.js` | Add `scanDirectory()` helper |
| `worca-ui/app/views/add-project-dialog.js` | Mode toggle, scan UI, checkbox list, batch submit |
| `worca-ui/app/main.js` | Handle batch `onProjectAdd` response |
| `worca-ui/server/__tests__/scan-directory.test.js` | New test file |
| `worca-ui/server/__tests__/projects-batch.test.js` | New test file |
| `worca-ui/app/__tests__/add-project-dialog.test.js` | Extend or create |
