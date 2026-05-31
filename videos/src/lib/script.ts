/**
 * Video script — bullets parsed from /docs/how-it-works.md.
 *
 * Encoded inline (not generated from markdown yet) so the first pass has a
 * trivial dependency footprint. A follow-up will add `scripts/parse-script.ts`
 * that walks the markdown H3 headings and emits this file, keeping the
 * markdown as the canonical source of truth.
 *
 * Word counts match `python3 scripts/wordcount.py` output for the markdown
 * paragraph text (heading and "See also" lines excluded).
 */

export interface BulletScene {
  /** 1-based bullet number from how-it-works.md (1..18). */
  id: number;
  /** Heading text — appears on the title card. */
  title: string;
  /** Spoken paragraph — appears as on-screen body / captions. */
  body: string;
  /** Word count of `body`, used to derive scene duration. */
  words: number;
}

export interface Chapter {
  /** "Video 1", "Video 2", "Video 3". */
  number: 1 | 2 | 3;
  /** Chapter title shown on the intro card. */
  title: string;
  /** Bullets that belong to this chapter, in narration order. */
  scenes: BulletScene[];
}

// ─── Video 1 — Introducing worca ───────────────────────────────────────────

const v1: BulletScene[] = [
  {
    id: 1,
    title: "worca is an orchestrator for your AI coding agent",
    body:
      "worca is an orchestrator for your AI coding agent. It runs your development process step by step. So the agent always starts with a design document. It always implements and runs the tests. It always performs a code review. Nothing important gets skipped.",
    words: 43,
  },
  {
    id: 2,
    title: "Every step runs in a dedicated agent with fresh context",
    body:
      "Every step runs in a fresh agent. That agent only sees what it needs to do its job. The planner sees the request. The implementer sees the design decisions for one code change. The reviewer sees the diff to review. Nothing leaks across stages. Nothing is missing. Each agent stays focused.",
    words: 51,
  },
  {
    id: 3,
    title: "The full flow runs as a pipeline, defined by a template",
    body:
      "The full flow runs as a pipeline. A pipeline is your workflow, written down. It moves through stages. Each stage has its own specialized agent. Each agent gets a prompt tailored to its role. And it gets a message tailored to the current state of the work. worca ships with several pipeline templates built in. You can also write your own.",
    words: 61,
  },
  {
    id: 4,
    title: "Work inputs differ on detail and on enforcement",
    body:
      "There are four ways to tell worca what to do. The simplest is a prompt. You describe the work in plain language, and the planner takes it from there. Next up is a GitHub issue. It carries more structure, and the planner uses it as a brief. Even richer is a pre-existing plan file. With that, the planner stage is skipped entirely. Every later stage works from your plan directly. The fourth input is different from the first three. It's called a guide. A guide doesn't describe the work. It constrains how the work is done. Think of an RFC, a migration spec, or a coding standard. Every agent treats the guide as the highest authority. If the plan and the guide disagree, the guide wins.",
    words: 126,
  },
  {
    id: 5,
    title: "Code orientation through a knowledge graph",
    body:
      "Reading and re-reading source files is the biggest token sink in autonomous coding. To cut that cost, worca can build a structural knowledge graph of your repository. The graph captures how your code fits together. Agents query the graph instead of grepping their way around. Two engines plug in here. The first is graphify. It maps the AST and call structure of your source code. The second is CRG. CRG runs in structural mode today, and a richer semantic mode is on the roadmap. Either way, the graph is advisory. It never overrides what you asked for. It just helps the agents find their way around faster.",
    words: 107,
  },
];

// ─── Video 2 — Inside a worca run ──────────────────────────────────────────

const v2: BulletScene[] = [
  {
    id: 6,
    title: "The stages run in a clear order, and each one has a job",
    body:
      "Let's look inside a single run. First, the planner reads your task and produces a detailed design document. Next, an optional plan reviewer audits that plan, before any code is written. Then the coordinator takes over. It breaks the plan into small units of work. We call those units beads. Each bead gets a complexity tag. Now one or more implementer agents pick up beads in parallel. Each one writes the code and tests for its slice. After that, a tester runs the full suite. A reviewer audits the diff. Only then does the guardian commit the work and open the pull request. Finally, an optional learner extracts insights from the run, so future runs can improve.",
    words: 117,
  },
  {
    id: 7,
    title: "Pipelines also define the guardrails",
    body:
      "Pipelines also define the guardrails. How many review rounds are allowed? How many test retries? How much can a single run cost before it halts? All these limits live in the pipeline definition. So the same template enforces the same discipline every time it runs.",
    words: 45,
  },
  {
    id: 8,
    title: "Governance isn't advice — it's enforced at runtime",
    body:
      "Here's the part that makes worca trustworthy. Governance is not advice. It's enforced at runtime. worca installs hooks that gate every tool call and every commit. The planner cannot write source files. The implementer cannot commit. Only the guardian can commit, and only after the reviewer has signed off. The pipeline cannot drift off process, no matter what the underlying model decides to do.",
    words: 64,
  },
  {
    id: 9,
    title: "When things fail, worca self-corrects inside bounded loops",
    body:
      "When things fail, worca self-corrects. If tests fail, the tester sends the failure back to the implementer, and the implementer tries again. The same thing happens with review feedback and with plan revisions. Each loop has a maximum number of iterations. A circuit breaker watches for patterns that suggest the loop won't converge. When it sees one, it halts the run before more budget is wasted. There's also a smarter dial. If a task keeps looping back, the next pass runs at a higher reasoning level. Up to a cap you set.",
    words: 92,
  },
  {
    id: 10,
    title: "Every run has a cost, and every run has a budget",
    body:
      "Cost is a real concern. Every stage logs what it spent. Every run rolls up a total. You can see all of it in the UI. But visibility alone is not enough. worca gives you three ways to control spend. The first is the effort cap. It bounds how high reasoning effort can escalate. The second is the circuit breaker. It halts a run when failure patterns suggest you're throwing good money after bad. The third is the model profile. You choose which model runs each stage. Use Opus where you need depth. Use Sonnet where you need speed. Route through your own gateway if you have one. So the question of how much a run will cost becomes a budget you set.",
    words: 123,
  },
  {
    id: 11,
    title: "Every action and every artifact is traceable in the UI",
    body:
      "Every action and every artifact is traceable. The worca-ui web interface gives you the full picture. Stage progression. Iterations. Time spent. Cost. Tool calls. Agent prompts and responses. Nothing the pipeline does is hidden from you.",
    words: 36,
  },
  {
    id: 12,
    title: "What the UI actually exposes",
    body:
      "Let's get specific about what you can do in the UI. You can read the generated plan. You can see how it evolved across review iterations. You can open any stage and read its agent prompt. You can also read the dynamic message that agent received. In other words, you see exactly what worca asked the agent to do. You can browse the beads the coordinator produced. You can read the reviewer's verdict and the diff it reviewed. You can see test output from every iteration, not just the last one. Cost, time, and tool-call counts are all there, stage by stage.",
    words: 102,
  },
];

// ─── Video 3 — Worca in your workflow ──────────────────────────────────────

const v3: BulletScene[] = [
  {
    id: 13,
    title: "Each run lives in its own git worktree, so parallel runs never collide",
    body:
      "Each run lives in its own git worktree. That means parallel runs never collide with each other. worca builds on this with two scale-out modes. The first is fleet mode. It takes one prompt and runs it across many independent projects at the same time. That's perfect for rolling a fix across every repo you own. The second is workspace mode. This one is for interdependent projects. A master planner figures out the dependency order. Child pipelines run tier by tier. And between tiers, worca runs cross-project integration tests to keep everything in sync.",
    words: 94,
  },
  {
    id: 14,
    title: "You shape worca to your team without forking it",
    body:
      "You can shape worca to your team without forking it. Almost every part of a pipeline is configurable. Which stages run. Which agent runs each stage. Which model the agent uses. How many loop iterations are allowed. Even the prompt the agent sees. Customization happens at three layers. The template picks the overall shape. Per-agent overrides tune individual stages. And the guide you attach at run time enforces a spec that nothing else can override.",
    words: 75,
  },
  {
    id: 15,
    title: "Built-in templates, and your own",
    body:
      "worca ships with a set of built-in pipeline templates. They cover the common shapes of work. There's a full feature pipeline with planning, review, and testing. There's a bug-fix pipeline that skips planning. There's a docs-only pipeline. And several more. Each template is a complete recipe. Stage list. Agent prompts. Loop budgets. Model assignments. Most of the time, picking the right template is all you need. When the built-ins don't fit, you can write your own. Today this is done through settings. A richer template-authoring experience is coming to the UI.",
    words: 91,
  },
  {
    id: 16,
    title: "Events out, control in",
    body:
      "The pipeline emits a typed event stream. There are around 80 different event types in total. Stage starts. Bead completions. Test results. Cost ticks. Control decisions. You subscribe to these events through webhooks. The webhooks are signed for security. Some subscribers can also push back. Control webhooks let you pause, resume, stop, or override a decision while the run is in flight. The UI itself is just one subscriber to this stream. That's why everything you see in the UI is also available to your own tools.",
    words: 87,
  },
  {
    id: 17,
    title: "Notifications you can act on",
    body:
      "worca can push run updates into the chat tools your team already uses. Set up an integration once. That can be Telegram, Discord, or Slack. From then on, worca notifies you when something interesting happens. A plan is ready. A pull request has been opened. The run has paused. A circuit breaker tripped. On Telegram, those notifications come with inline actions. You can pause, resume, or stop a run right from the chat. No need to open the UI. And from inside a run, agents can reach out to you directly through the notify skill. For example, an agent might say: \"I'm waiting on a clarification, please reply when you can.\" You can leave the UI closed and still stay in the loop on long-running work.",
    words: 126,
  },
];

export const chapters: Record<1 | 2 | 3, Chapter> = {
  1: { number: 1, title: "Introducing worca", scenes: v1 },
  2: { number: 2, title: "Inside a worca run", scenes: v2 },
  3: { number: 3, title: "Worca in your workflow", scenes: v3 },
};

/** Total bullets across all three videos. Drives the "NN / TOTAL"
 *  counter shown in the top-right of each bullet scene. */
export const totalBullets =
  chapters[1].scenes.length +
  chapters[2].scenes.length +
  chapters[3].scenes.length;
