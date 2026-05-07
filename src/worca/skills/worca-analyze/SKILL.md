---
name: worca-analyze
description: Analyze a GitHub issue, surface open design decisions with a recommended option for each, optionally append a `## Decisions` section to the issue body, recommend the most appropriate built-in/project/user pipeline template, and optionally launch a worktree-based pipeline for it. Triggers on `/worca-analyze <issue-url-or-number>`, on the natural phrase "analyze <github-issue-url>", and on "worca-analyze".
---

# Worca Analyze

End-to-end issue triage: analysis → decisions → issue update → template recommendation → optional pipeline launch. Designed to replace the manual "analyze <url>, decide, edit issue, pick template, kick off run" workflow with a single guided pass.

**Usage:**
- `/worca-analyze 127` — by issue number (uses current repo's `gh` default)
- `/worca-analyze https://github.com/SinishaDjukic/worca-cc/issues/127` — by URL
- "analyze https://github.com/SinishaDjukic/worca-cc/issues/127" — natural phrase

## Procedure

### Phase 0: Resolve the issue

Parse the argument:
- If it's a full GitHub URL, extract `<owner>/<repo>` and the issue number.
- If it's a bare integer, assume the current repo (use `gh repo view --json nameWithOwner -q .nameWithOwner`).

Fetch with **explicit `--json` fields** — this repo has classic-Projects-linked issues that break the unfiltered `gh issue view`:

```bash
gh issue view <N> --json number,title,body,labels,state,assignees,comments,url
```

If the call fails, surface the error and stop.

### Phase 1: Cache check

Cache path: `.worca/analyses/issue-<N>.md` (per-project, runtime state — `.worca/` is gitignored).

Each cached file starts with a frontmatter block:

```markdown
---
issue: <N>
url: <issue url>
body_sha256: <hex digest of the fetched issue body>
analyzed_at: <ISO 8601 UTC>
---
```

- If the cached file exists AND `body_sha256` matches the freshly-fetched body's SHA-256 → reuse it (still re-prompt for decisions and template; cache is for the *analysis*, not for state).
- Otherwise (no file, or hash mismatch) → regenerate and overwrite.

Compute the hash with: `python3 -c 'import hashlib,sys;print(hashlib.sha256(sys.stdin.read().encode()).hexdigest())'` piping the body in.

### Phase 2: Analyze

Read the issue body, follow any in-body file/path references and read those locally (`Read` tool — never guess line numbers, always read first). Produce a structured report with these sections:

1. **TL;DR** — one sentence.
2. **What it asks for** — bullet list of concrete changes.
3. **Scope** — files/modules touched, src vs tests vs docs, rough size estimate (small / medium / large).
4. **Risk** — backwards-compat, blast radius, reversibility.
5. **Open questions** — design decisions the issue does *not* settle. These drive Phase 3.

Anchor every claim in actual file references using `path:line` notation so the user can navigate.

Write the full report (with the frontmatter block above) to `.worca/analyses/issue-<N>.md`.

### Phase 3: Decisions

For each Open Question from Phase 2:
- Present 2-3 numbered options.
- Mark exactly one as **Recommended** with one-line reasoning grounded in SOLID, maintainability, robustness, or precedent in the codebase.
- Recommend "no decision needed — defer to implementation" only when the question genuinely doesn't change the implementation shape.

Present **all questions in one message** (decision #3 from skill design — one-shot, not iterative). Wait for the user's answers before proceeding.

If there are zero open questions, skip Phase 3 entirely and tell the user "no open decisions" — proceed to Phase 4.

### Phase 4: Offer to update the issue

Once decisions are answered, draft a `## Decisions` markdown section:

```markdown
## Decisions

- **<question summary>**: <chosen option> — <one-line rationale>
- ...
```

**Do NOT modify the `## Plan` section** — that's the planner agent's territory.

Show the user the exact diff that will be applied (the section as it'll appear, plus where it'll be inserted — append to the end of the body, after any existing `## Plan` section). Require explicit "yes" / "go" before running:

```bash
gh issue edit <N> --body-file <tmp-file>
```

Build the new body by reading the current body, appending `\n\n## Decisions\n...` (or replacing an existing `## Decisions` section if one is already present — match `^## Decisions` to end-of-section), and writing to a tmpfile. Use a tmpfile, not `--body "..."`, to preserve newlines and avoid shell quoting issues.

If the user declines, skip silently.

### Phase 5: Recommend a template

Resolve available templates across all three tiers (user > project > built-in wins on ID collision):

```bash
worca templates list --json
```

Each entry has `{id, name, description, tier, tags, builtin, created_at}`. `tier` is `"builtin" | "project" | "user"`. The resolver already enforces user > project > built-in priority, so the JSON reflects which template will actually be applied at run time on an ID collision — trust it.

Fallback discovery if the CLI form fails (older worca-cc install before this flag landed):
- Built-in: `<repo-root>/src/worca/templates/*/template.json` (when running inside worca-cc itself), or `.claude/worca/templates/*/template.json` (consumer projects after `worca init`)
- Project: `.claude/templates/*/template.json`
- User: `~/.worca/templates/*/template.json`

**Mapping rules** (apply in order, first match wins):

| Signal in issue | Template |
|---|---|
| `bug` label, scoped fix, no `## Plan` link | `bugfix` |
| Issue body uses words like "investigate", "audit", "analyze X", or asks for analysis only with no implementation | `investigate` |
| "Add tests" / "coverage" / `test-only` scope, no production code changes | `test-only` |
| Refactor / "behavioural preservation" / "no functional change" language | `refactor` |
| Trivial / single-line / typo / one-file-only fix | `quick-fix` |
| `W-NNN:` title prefix + `## Plan` link present | `feature` |
| Anything else | (low-confidence — see below) |

**Confidence rule (decision #5):** if the top match has clear signal, recommend it directly with a one-line config delta (the meaningful diff vs default — stages enabled/disabled, agent model overrides, loop limits). If two templates fit comparably (e.g. issue mentions both refactor and tests), present **both top-2 candidates with their config deltas** and ask the user to pick — don't silently fall back.

If a project-level or user-level template overrides a built-in id, surface that explicitly: "using project override of `bugfix` from `.claude/templates/bugfix/`".

### Phase 6: Offer to launch

Always worktree-based (decision #4 from the skill design). Use the first-class CLI form — `worca run --worktree` mirrors the UI's launch path (process-manager.js:425-552) and falls back to in-place automatically if `run_worktree.py` is missing in the project runtime, so the skill never has to handle that branch:

```bash
worca run --worktree --source gh:issue:<N> --template <template-id>
```

If you need a non-default base branch or a reference guide injected into the planner prompt:

```bash
worca run --worktree --source gh:issue:<N> --template <id> \
  --branch develop \
  --guide docs/spec.md
```

Spawn detached so the pipeline outlives the chat session. From a shell:

```bash
nohup worca run --worktree --source gh:issue:<N> --template <id> >/dev/null 2>&1 &
disown
```

`run_worktree.py` (which `worca run --worktree` invokes under the hood) prints `<run_id>\n<worktree_path>\n` to stdout before detaching — capture those two lines and surface them to the user so they can tail the run.

**Always confirm before launching** — show the exact command and ask "launch now?" Don't auto-fire.

## Notes & Edge Cases

- **Don't assume `master` vs `main`** — read the issue's repo default branch via `gh repo view` if branch is needed. The launch script handles its own branching.
- **Closed issues:** still analyze, but warn the user and skip the launch offer (running a pipeline against a closed issue is almost always a mistake).
- **Issues with no body:** still proceed; analysis just emphasizes "issue lacks detail" and recommends asking the author.
- **Re-running on the same issue:** cache hit means analysis section is unchanged. Decisions and template are re-asked every time — they're stateful per-session, not per-issue.
- **Pre-existing `## Decisions` section:** match `^## Decisions` and replace through to the next `^## ` heading or end-of-body. Show the user a clear "replacing existing Decisions section" note in the diff preview.
- **Multiple repos in one project:** parse the issue URL's `<owner>/<repo>` and pass `--repo <owner>/<repo>` to all `gh` commands so this works even when the cwd is unrelated.
- **Decision #2a:** never modify the `## Plan` section. If a `W-NNN:` issue is missing one, mention it in the analysis but do not auto-create the link.

## Failure Modes

- `gh` not authenticated → surface the `gh auth login` hint, stop.
- Issue body fetch fails → stop, do not proceed with stale cached analysis.
- Template resolution fails → still produce the analysis and decisions; tell the user "couldn't enumerate templates, please pick one manually" and list the 6 known built-ins as a fallback.
- Worktree script missing AND pipeline script missing → analysis + decisions + template recommendation still complete; final message tells the user to run `worca init` to install the runtime.
