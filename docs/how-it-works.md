# How worca works

A layered walkthrough of what worca is and how it organizes autonomous software development, grouped into eight sections that go from the broadest framing to the deeper mechanics. It is the basis for the introductory video and the **How it works** section of docs.worca.dev — wording will be cut and tuned per surface, but the sequence stays.

---

## I. What worca is

### 1. worca is an orchestrator for your AI coding agent

worca is an orchestrator for your AI coding agent. It helps you get software developed by following a strict set of rules and steps based on your development process. With worca, you can be sure the agent won't skip any important aspect of development — writing a detailed design document, implementing and running tests, performing a code review, and so on.

### 2. Every step runs in a dedicated agent with fresh context

Every step of the work runs in a dedicated agent with fresh context. Each agent's context is shaped and fed with content that is optimal for its assigned task — specific requirements and design decisions for the code change, the test, the review. Nothing carries over that doesn't belong, and nothing is missing that does.

### 3. The full flow runs as a pipeline, defined by a template

The full flow runs as a **pipeline**, defined by a **template**. Templates come built-in with worca or are custom-made by you. A pipeline defines your workflow as a sequence of **stages**, and every stage has an agent with a specialized role and prompt. Each agent also receives tailored, dynamic messages that match its step of the work.

---

## II. Starting a run

### 4. Work inputs differ on detail and on enforcement

Worca accepts work in four flavors that differ on **how much detail you provide** and **how strictly worca treats it**. A free-form **prompt** is the loosest input — the Planner expands it into a full design document from scratch. A **GitHub issue** with the standard Problem/Proposal/Considerations/Plan structure is richer; the Planner uses it as a brief instead of starting from zero. A pre-existing **plan file** is the most detailed and bypasses the Planner entirely — every later stage works from it directly. A **guide** is different from all three: it doesn't describe the work, it constrains it. Guides are normative — RFCs, migration specs, coding standards — and every agent treats them as the highest authority, above the plan and above the prompt. You can combine them: a prompt plus a guide is common; an issue plus a guide is how you say "do what this issue asks, but conform to this spec while you do it."

*See also: [`docs/instruction-flow.md`](./instruction-flow.md).*

### 5. Code orientation through a knowledge graph

Reading and re-reading source files is the biggest token sink in autonomous coding. Worca's optional **code graph** integration cuts it by building a structural knowledge graph of your repository once per commit; agents query the graph instead of grepping. Two engines fit this slot: **graphify** (shipped; AST and call structure of source code) and **CRG** (planned; broader coverage including documentation). When the graph is available, agents get a one-line hint that they can query it, and they choose when to look. The graph is advisory — *guide > plan > graph > description* — so it never overrides your intent; it just makes orientation cheaper.

*See also: [`docs/plans/W-053-graphify-integration.md`](./plans/W-053-graphify-integration.md).*

---

## III. Inside a run

### 6. The stages run in a clear order, and each one has a job

The **Planner** reads your task and produces a detailed design document. The **Plan Reviewer** (optional) audits that plan before any code is written. The **Coordinator** breaks the plan down into small units of work — we call them "beads" — and tags each with a complexity level. One or more **Implementer** agents then pick up beads in parallel, each writing code and tests for their slice. A **Tester** runs the full suite. A **Reviewer** audits the diff. Only then does the **Guardian** commit the work and open a pull request. An optional **Learner** stage closes the loop by extracting insights from the run so future runs improve.

*See also: [`docs/state-action-matrix.md`](./state-action-matrix.md).*

### 7. Pipelines also define the guardrails

Pipelines also define the guardrails. How many review iterations are allowed? How many test retries? How much cost can a single run accumulate before halting? These limits are part of the pipeline definition, so the same template enforces the same discipline every time it runs.

### 8. Governance isn't advice — it's enforced at runtime

worca installs Python hooks into Claude Code that gate every tool call and every commit. The Planner cannot write source files. The Implementer cannot commit. Only the Guardian can commit, and only after Review passes. This means the pipeline cannot drift off-process, no matter what the underlying model decides to do.

*See also: [`docs/governance.md`](./governance.md).*

### 9. When things fail, worca self-corrects inside bounded loops

If tests fail, the Tester sends the failure back to the Implementer — but only up to a configured max iteration count. Same for review feedback, same for plan revisions. A **circuit breaker** watches for failure patterns that suggest the loop won't converge and halts before burning more budget. **Effort** also scales: if a task keeps looping back, the next pass runs at a higher reasoning level, up to a cap you set.

*See also: [`docs/effort.md`](./effort.md).*

### 10. Every run has a cost, and every run has a budget

Every stage logs its cost, and every run rolls up a total visible in the UI. Beyond visibility, you get three knobs to control spend. The **effort cap** bounds how high reasoning effort can escalate when loops keep failing. The **circuit breaker** halts a run when failure patterns suggest it won't converge, so you don't pay for runaway retries. The pipeline's **model profile** lets you pick which model runs each stage — Opus for depth, Sonnet for speed, alternate endpoints if you've routed through your own gateway. *How much will this run cost?* becomes a budget you set.

---

## IV. Seeing what's happening

### 11. Every action and every artifact is traceable in the UI

Every action and every artifact is traceable in the worca-ui web interface. You get complete run transparency — stage progression, iterations, time spent, cost, tool calls, agent prompts and responses. Nothing the pipeline does is hidden from you.

### 12. What the UI actually exposes

The UI is the inspection surface for everything a run produces. You can read the **generated plan** and see how it evolved across review iterations. You can open any **stage** and read both the agent's system prompt and the dynamic user message it received — what worca asked the agent to do, in full. You can browse the **beads** the coordinator produced, with their complexity tiers and completion state. You can read the **reviewer's verdict** and the diff it reviewed. You can see **test output** from every iteration, not just the last. Stage-by-stage cost, time, and tool-call counts are all there.

*See also: [`docs/dashboard.md`](./dashboard.md).*

---

## V. Beyond a single run

### 13. Each run lives in its own git worktree, so parallel runs never collide

worca builds on that isolation with two scale-out modes. **Fleet mode** fans the same prompt out to N independent projects in parallel — useful for rolling a security fix across every repo you own. **Workspace mode** decomposes one prompt across a DAG of *interdependent* projects: a master planner figures out the dependency order, child pipelines execute tier by tier, and cross-project integration tests run between tiers.

*See also: [`docs/fleet-runs.md`](./fleet-runs.md), [`docs/workspace-runs.md`](./workspace-runs.md).*

---

## VI. Customizing the pipeline

### 14. You shape worca to your team without forking it

Almost every part of a pipeline is configurable — which stages run, which agent runs each stage, which model that agent uses, how many loop iterations are allowed, what prompt the agent sees. Customization happens at three layers: the **template** picks the overall shape, **per-agent overrides** tune individual stages, and the **guide** you attach at run time enforces a spec that nothing else can override.

### 15. Built-in templates, and your own

Worca ships with a set of **built-in pipeline templates** that cover common shapes of work — a feature pipeline with full review and testing, a bug-fix pipeline that skips planning, a docs-only pipeline, and so on. Each template is a complete recipe: stage list, agent prompts, loop budgets, model assignments. Picking the right template is often all you need. When the built-ins don't fit, you can author your own — today through settings, with a richer template-authoring experience planned in the UI.

---

## VII. Notifications and integrations

### 16. Events out, control in

The pipeline emits a typed event stream — around 80 event types covering stage starts, bead completions, test results, cost ticks, control decisions. You subscribe through HMAC-signed **webhooks**, and some subscribers push back: **control webhooks** can pause, resume, stop, or override a decision mid-run. The UI is itself a subscriber to this stream, which is why everything you see in the UI is also available to your own tools.

*See also: [`docs/events.md`](./events.md).*

### 17. Notifications you can act on

worca can push run updates out of the UI and into the chat tools your team already uses. You configure **integrations** (Telegram, Discord, Slack) once, and worca notifies you when something interesting happens — a plan is ready, a PR has been opened, a run has paused, a circuit breaker has tripped. On Telegram, those notifications come with **inline actions**: pause, resume, or stop a run without opening the UI. From within a run, the **notify skill** lets agents send you a targeted message — *"waiting on a clarification, please reply when you can."* You can leave the UI closed and still stay in the loop on long-running work.

---

## VIII. Continuity across sessions

### 18. Strategic context persists across sessions

Multi-step features, dependencies between tasks, and work discovered mid-run all live in **beads** — a lightweight, git-tracked issue store. The next session, the next agent, and the next fleet child all see the same state. Single-session todos stay ephemeral; anything you'd be sad to lose at a session boundary becomes a bead.

---

## Cuts for shorter variants

- **10-bullet cut** (concept video, ~5 min): §1, §3, §4, §6, §8, §9, §10, §13, §15, §17.
- **5-bullet trailer** (~90 seconds): §1, §3, §6, §8, §13 — *what it is, how it's organized, what it does, how it stays honest, how it scales*.
