# How worca works

A 12-step walkthrough of what worca is and how it organizes autonomous software development. It starts from the broadest framing and progressively reveals the mechanics. It is the basis for the introductory video and the **How it works** section of docs.worca.dev — wording will be cut and tuned per surface, but the sequence stays.

---

## 1. worca is an orchestrator for your AI coding agent

worca is an orchestrator for your AI coding agent. It helps you get software developed by following a strict set of rules and steps based on your development process. With worca, you can be sure the agent won't skip any important aspect of development — writing a detailed design document, implementing and running tests, performing a code review, and so on.

## 2. Every step runs in a dedicated agent with fresh context

Every step of the work runs in a dedicated agent with fresh context. Each agent's context is shaped and fed with content that is optimal for its assigned task — specific requirements and design decisions for the code change, the test, the review. Nothing carries over that doesn't belong, and nothing is missing that does.

## 3. The full flow runs as a pipeline, defined by a template

The full flow runs as a **pipeline**, defined by a **template**. Templates come built-in with worca or are custom-made by you. A pipeline defines your workflow as a sequence of **stages**, and every stage has an agent with a specialized role and prompt. Each agent also receives tailored, dynamic messages that match its step of the work.

## 4. Pipelines also define the guardrails

Pipelines also define the guardrails. How many review iterations are allowed? How many test retries? How much cost can a single run accumulate before halting? These limits are part of the pipeline definition, so the same template enforces the same discipline every time it runs.

*See also: [`docs/configuration-precedence.md`](./configuration-precedence.md), [`docs/governance.md`](./governance.md).*

## 5. Every action and every artifact is traceable in the UI

Every action and every artifact is traceable in the worca-ui web interface. You get complete run transparency — stage progression, iterations, time spent, cost, tool calls, agent prompts and responses. Nothing the pipeline does is hidden from you.

## 6. The stages run in a clear order, and each one has a job

The stages run in a clear order, and each one has a job. The **Planner** reads your task and produces a detailed design document. The **Plan Reviewer** (optional) audits that plan before any code is written. The **Coordinator** breaks the plan down into small units of work — we call them "beads" — and tags each with a complexity level. One or more **Implementer** agents then pick up beads in parallel, each writing code and tests for their slice. A **Tester** runs the full suite. A **Reviewer** audits the diff. Only then does the **Guardian** commit the work and open a pull request. An optional **Learner** stage closes the loop by extracting insights from the run so future runs improve.

*See also: [`docs/instruction-flow.md`](./instruction-flow.md), [`docs/state-action-matrix.md`](./state-action-matrix.md).*

## 7. Governance isn't advice — it's enforced at runtime

Governance isn't advice — it's enforced at runtime. worca installs Python hooks into Claude Code that gate every tool call and every commit. The Planner cannot write source files. The Implementer cannot commit. Only the Guardian can commit, and only after Review passes. This means the pipeline cannot drift off-process, no matter what the underlying model decides to do.

*See also: [`docs/governance.md`](./governance.md).*

## 8. When things fail, worca self-corrects inside bounded loops

When things fail, worca self-corrects inside bounded loops. If tests fail, the Tester sends the failure back to the Implementer — but only up to a configured max iteration count. Same for review feedback, same for plan revisions. A **circuit breaker** watches for failure patterns that suggest the loop won't converge and halts before burning more budget. **Effort** also scales: if a task keeps looping back, the next pass runs at a higher reasoning level, up to a cap you set.

*See also: [`docs/effort.md`](./effort.md).*

## 9. Each run lives in its own git worktree, so parallel runs never collide

Each run lives in its own git worktree, so parallel runs never collide. worca builds on that isolation with two scale-out modes. **Fleet mode** fans the same prompt out to N independent projects in parallel — useful for rolling a security fix across every repo you own. **Workspace mode** decomposes one prompt across a DAG of *interdependent* projects: a master planner figures out the dependency order, child pipelines execute tier by tier, and cross-project integration tests run between tiers.

*See also: [`docs/fleet-runs.md`](./fleet-runs.md), [`docs/workspace-runs.md`](./workspace-runs.md).*

## 10. The pipeline is observable and steerable from the outside

The pipeline is observable and steerable from the outside. While the UI gives you a human view, worca also emits around 80 typed events during a run — stage starts, bead completions, test results, cost ticks, control decisions. You can subscribe webhooks (HMAC-signed) or chat adapters (Telegram, Discord, Slack) to react to them. **Control webhooks** push back the other direction: pause a run, resume it, stop it, or override a plan-review decision. The UI is just one subscriber to that same stream.

*See also: [`docs/events.md`](./events.md).*

## 11. You shape worca to your team without forking it

You shape worca to your team without forking it. Pipeline templates live in your project or your user config; you can override any agent's prompt, swap the model per stage, or attach a `--guide` file — an RFC, migration spec, or coding standard — that worca treats as **normative**. Every agent conforms to the guide above the plan and above the task description. This is how you encode "we always use this auth pattern" or "schema changes need a migration script" so the pipeline can't quietly skip them.

*See also: [`docs/configuration-precedence.md`](./configuration-precedence.md), [`docs/design-principles.md`](./design-principles.md).*

## 12. Strategic context persists across sessions

Strategic context persists across sessions. Multi-step features, dependencies between tasks, and work discovered mid-run all live in **beads** — a lightweight, git-tracked issue store. The next session, the next agent, and the next fleet child all see the same state. Single-session todos stay ephemeral; anything you'd be sad to lose at a session boundary becomes a bead.

---

## Narrative arc (for video cuts and docs-site IA)

- **§1–3 — What worca is.** Orchestrator, fresh-context specialists, pipelines & templates.
- **§4–5 — What worca guarantees.** Guardrails baked into the pipeline, full transparency in the UI.
- **§6–7 — Inside one run.** The stage sequence, and the runtime-enforced governance that keeps it on the rails.
- **§8 — When things go wrong.** Bounded self-correction.
- **§9 — Beyond one run.** Worktrees, fleets, and workspaces.
- **§10–11 — Integration and customization.** Events & control, templates & guides.
- **§12 — Continuity.** Beads as cross-session memory.

Natural cuts if a shorter version is needed:
- **10-beat cut:** drop §10 (events/webhooks — power-user material) and merge §11 + §12 into a single "shape it and let it remember" beat.
- **5-beat trailer:** §1, §3, §6, §7, §9 — *what it is, how it's organized, what it does, how it stays honest, how it scales*.
