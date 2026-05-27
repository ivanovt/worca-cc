# worca-cc — Design Principles

Consolidated rationale behind worca-cc's major architectural choices — the *why*, not the *how*.
Implementation detail lives in the per-feature plans under [`docs/plans/`](./plans/); this doc is the index of decisions.

## UI Stack
- **Shoelace** for components — polished modern UI without adopting a heavy framework.
- **lit-html** retained as the templating layer — lightweight, no build-time framework lock-in.
- **xterm.js** for log rendering — handles very large logs with virtual scroll where manual rendering choked.
- **esbuild** for bundling — fast builds, single bundle output, no webpack complexity.
- **Push-only WebSocket** state delivery — UI never polls; server pushes on change.
- **File-watcher sourcing** — UI state derives from watching `.worca/status.json`, not API polling.

## UI Component Reusability
- **Components are state-driven, not stage-specific** — a component renders from data shape, so new stages reuse existing UI without new widgets.
- **Generic status/badge/outcome components** — one badge component parameterized by semantic role, never per-stage copies.
- **lit-html templates compose, not inherit** — shared fragments are functions returning templates, reused across views.
- **Views own layout, components own rendering** — components stay context-free so they drop into any view.
- **No component knows the pipeline shape** — adding or removing stages/events touches data, not the component tree.

## Pipeline Architecture
- **Stages are discrete, separable concerns** — each stage has its own agent and model.
- **Opus for reasoning stages, Sonnet for execution stages** — match model cost/capability to task.
- **Optional stages are opt-in** — the default path stays lean; heavier stages enabled via config.
- **Generic stage system** — stages are data-driven, not hardcoded, so the pipeline is reconfigurable.

## State Model
- **One unified canonical state set** — replaced inconsistent, divergent terminal paths with a single model.
- **`interrupted` vs `failed` are distinct** — user/signal halt is not the same as an error halt.
- **`running` blocks destructive actions** — state gates which actions are even offered.
- **`cancel` is the universal escape hatch** — every non-terminal state can reach a clean terminal.
- **`resume` covers all recovery** — one action semantics instead of divergent dispatch paths.

See [`docs/state-action-matrix.md`](./state-action-matrix.md) for the full state/action specification.

## Governance
- **Only the guardian agent may `git commit`** — enforced by a hook checking `WORCA_AGENT`, not convention.
- **Source writes blocked until the plan file exists** — plan-first is enforced, not suggested.
- **Consecutive test failures halt the pipeline** — circuit breaker against runaway broken loops.
- **All governance lives in Python hooks** — enforcement at every tool call, not in agent prompts.
- **`general-purpose` subagent is denied by default** — it spawns an unconstrained full-tool session, so it sits in `default_denied` (off under the wildcard); a project opts an agent in explicitly. Hard safety guardrail without a dead-end.
- **Subagent dispatch uses per-agent allowlists** — least-privilege per role over global controls.

## Modularity & Configuration
- **Tiered template resolution: user > project > built-in** — override without forking.
- **Agent prompts are composable section blocks** — overlay-merge model for targeted overrides.
- **Governance-protected sections cannot be replaced** — safety sections are immutable by design.
- **Entire template directory snapshotted into results** — complete trace of the exact config used.
- **Config namespaced under the `worca` key in `settings.json`** — coexists with other tooling config.
- **Secrets isolated to gitignored `settings.local.json`** — deep-merged over base, never committed.
- **Reserved env keys (`WORCA_*`, `PATH`, `CLAUDECODE`) stripped** — misconfiguration can't break internals.

## Parallel Execution
- **Git worktrees as the isolation boundary** — OS-level process, filesystem, and HEAD isolation.
- **Worktrees persist until explicitly cleaned** — never auto-removed while running; cleanup is deliberate.
- **Parent secrets materialized into worktree `settings.json`** — same plaintext-on-disk model as `~/.aws/credentials`.

## Events & Webhooks
- **Versioned event schema** — events evolve without breaking consumers.
- **Observer webhooks are async** — never block the pipeline.
- **Control webhooks are sync** — they gate progression, so they must complete inline.
- **HMAC-SHA256 signed payloads** — recipients can verify authenticity.
- **Retry with exponential backoff** — transient delivery failures don't drop events.

## Design System
- **Semantic color language for badges** — blue = active, orange = caution, green = done.
- **Triggers are always grey** — context, not judgment.
- **Outcomes follow a three-tier scale** — positive, needs-rework, hard failure.

See [`worca-ui/docs/badge-color-language.md`](../worca-ui/docs/badge-color-language.md) for the full color language.

## Testing
- **TDD: failing test → minimal code → refactor** — implementer agents read this as the methodology.
- **Mock Claude CLI for integration tests** — full pipeline runs without API cost or flakiness.
- **Subprocess-level coverage** — each pipeline subprocess emits its own coverage fragment.

## Release
- **Two independently versioned packages** — a UI fix doesn't force a Python release.
- **Releases triggered by pushing tags** — CI validates, builds, and publishes; no manual `twine`/`npm publish`.
