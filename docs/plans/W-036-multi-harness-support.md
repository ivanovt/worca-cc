# W-036: Multi-Harness Support

**Status:** Research complete, design pending  
**Priority:** P2  
**Area:** area:cc  
**Date:** 2026-04-10

## Problem

worca-cc is tightly coupled to Claude Code as its sole agent runtime. This limits adoption to users who have Claude Code access and prevents leveraging other AI coding CLIs that may be better suited for specific tasks, models, or cost profiles. As the ecosystem of AI coding harnesses matures (GitHub Copilot CLI, Gemini CLI, OpenCode/Crush), worca should support pluggable harness backends.

## Research Summary

Three alternative harnesses were evaluated against worca-cc's 12 critical integration surfaces. This document captures the full findings.

---

## Integration Surface Analysis

### 1. Headless / Non-Interactive CLI Mode

All harnesses support non-interactive execution via a `-p` flag.

| Harness | Command | Notes |
|---|---|---|
| Claude Code | `claude -p "prompt"` | Supports `--max-turns`, `--continue`, stdin pipe |
| Copilot CLI | `copilot -p "prompt"` | `-s` suppresses decorations; `--no-ask-user` prevents interactive input |
| Gemini CLI | `gemini -p "prompt"` | `--prompt-interactive` variant continues to interactive after prompt |
| OpenCode | `opencode -p "prompt"` | `-q` suppresses spinner; auto-approves all permissions in `-p` mode |

**Gap:** Only Claude Code supports `--max-turns` to cap agent iterations.

### 2. Agent / System Prompt Loading

| Harness | Mechanism | Per-invocation flag? |
|---|---|---|
| Claude Code | `--agent path/to/agent.md` | Yes |
| Copilot CLI | `--agent name` loads from `.github/agents/name.agent.md` | Yes (by name, not path) |
| Gemini CLI | `.gemini/agents/*.md` with YAML frontmatter | No CLI flag; agents invoked via `invoke_agent` tool |
| OpenCode | `contextPaths` in `.opencode.json`; no agent concept | No |

**Copilot** uses `.agent.md` files with YAML frontmatter (`name`, `description`, `tools`, `model`, `mcp-servers`). Agent files live in `~/.copilot/agents/` (user) or `.github/agents/` (repo).

**Gemini** uses `.gemini/agents/*.md` files with YAML frontmatter (`name`, `description`, `tools`, `model`, `max_turns`, `timeout_mins`, `mcp_servers`). Cannot be specified per-invocation from CLI.

**Mitigation for Gemini:** Write agent `.md` files to `.gemini/agents/` before invocation; use GEMINI.md for system prompt injection. For OpenCode: not feasible.

### 3. Structured Output / JSON Schema Enforcement

| Harness | Support | Mechanism |
|---|---|---|
| Claude Code | Full | `--json-schema schema.json` enforces model output conformance |
| Copilot CLI | None | NDJSON events only; no schema constraint on model output |
| Gemini CLI | None (CLI level) | API supports `responseSchema`; CLI has `complete_task` tool for structured agent output |
| OpenCode | None | `-f json` wraps text in `{"response": "..."}` |

**This is worca-cc's most pervasive dependency.** Every pipeline stage (planner, coordinator, implementer, tester, guardian, learner) produces schema-validated JSON. Schemas live in `src/worca/schemas/` (plan.json, coordinate.json, implement.json, test_result.json, review.json, pr.json, learn.json).

**Mitigation options:**
1. **Prompt-based enforcement** -- Embed the full JSON schema in the agent prompt with strict instructions. Validate output in Python post-hoc. Retry on validation failure. Works universally but less reliable.
2. **Tool-based enforcement** -- Require the agent to call a `submit_result(output: json)` tool. Gemini's `complete_task` tool already supports this pattern. Copilot could use a custom MCP tool.
3. **Two-pass extraction** -- Let agent produce free-form output, then run a cheap model (haiku/flash) to extract structured data. Adds latency and cost.
4. **Hybrid** -- Use native `--json-schema` on Claude Code; fall back to prompt+validation on others.

**Recommendation:** Hybrid approach. Use native enforcement where available, prompt+validation elsewhere. The orchestrator already has retry logic that can re-prompt on schema validation failure.

### 4. Output Format / Streaming

| Harness | Formats | Event Schema |
|---|---|---|
| Claude Code | `stream-json` (NDJSON) | Events: `system`, `assistant`, `user`, `result`, `tool_use`, `tool_result` |
| Copilot CLI | `--output-format=json` (NDJSON) | Events for tool calls, messages, errors (schema not fully documented) |
| Gemini CLI | `--output-format stream-json` (NDJSON) | Events: `init`, `message`, `tool_use`, `tool_result`, `error`, `result` |
| OpenCode | `text` or `json` (final blob) | No streaming; `{"response": "..."}` only |

**Gemini's stream-json is the closest match to Claude Code's** -- same flag name, similar event types, includes per-model token breakdowns in the `result` event.

**Copilot's NDJSON** exists but the event schema is less documented. Third-party integrations confirm it includes tool call events.

**OpenCode has no streaming** -- only a final text/JSON blob. This is a critical blocker for real-time pipeline monitoring.

**Key event mapping:**

| worca event | Claude Code | Copilot CLI | Gemini CLI |
|---|---|---|---|
| Agent text output | `assistant` | message event | `message` (role=assistant) |
| Tool invocation | `tool_use` | tool call event | `tool_use` |
| Tool result | `tool_result` | tool result event | `tool_result` |
| Final result | `result` | final event | `result` |
| Token/cost stats | In `result` | Not in output | In `result.stats` |

### 5. Hook System

| Harness | Events | Block? | Modify? | Registration |
|---|---|---|---|---|
| Claude Code | 5 (PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SubagentStart) | Yes | Yes (updatedInput) | `.claude/settings.json` hooks array |
| Copilot CLI | 6 (sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse, errorOccurred) | preToolUse only | No | JSON config with command hooks |
| Gemini CLI | 11 (BeforeTool, AfterTool, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, SessionStart, SessionEnd, PreCompress, Notification) | Yes | Yes (tool input, tool output, model response) | `settings.json` hooks with matchers |
| OpenCode | None | N/A | N/A | N/A |

**Gemini has the richest hook system** -- 11 events vs Claude's 5. It supports blocking, modifying tool inputs/outputs, injecting synthetic model responses, and forcing agent retries. The `BeforeToolSelection` hook can dynamically filter the tool list.

**Copilot's hooks** are similar in concept to Claude Code but more limited: `preToolUse` can only deny (not modify inputs), `postToolUse` cannot modify results.

**Hook input/output protocol comparison:**

All three use JSON on stdin/stdout. Exit codes differ slightly:
- Claude Code: exit 0 = allow, exit 2 = block
- Copilot: stdout `{"permissionDecision": "deny"}` to block
- Gemini: exit 0 = success (parse stdout), exit 2 = deny (stderr as reason)

**worca hook mapping:**

| worca hook | Purpose | Claude Code | Copilot CLI | Gemini CLI |
|---|---|---|---|---|
| `pre_tool_use.py` | Guard checks, cwd fix | PreToolUse | preToolUse (deny only, no input modification) | BeforeTool (full modify) |
| `post_tool_use.py` | Test gate, bd linking | PostToolUse | postToolUse | AfterTool |
| `user_prompt_submit.py` | Milestone approval | UserPromptSubmit | userPromptSubmitted | BeforeAgent |
| `subagent_start.py` | Dispatch enforcement | SubagentStart | No equivalent | BeforeAgent (when tool=invoke_agent) |
| Session start | Git context injection | SessionStart | sessionStart | SessionStart |

**Copilot gap:** No SubagentStart equivalent. Dispatch enforcement would need to be implemented via a preToolUse hook that checks the tool name for agent invocation.

**Copilot gap:** preToolUse cannot modify tool inputs. worca's `pre_tool_use.py` uses `hookSpecificOutput.updatedInput` to fix cwd paths. This would need an alternative approach (e.g., env var or wrapper script).

### 6. Tool Control

| Harness | Allow/Deny Mechanism | Granularity |
|---|---|---|
| Claude Code | `--disallowedTools "Tool1,Tool2"` | Tool name level |
| Copilot CLI | `--allow-tool='shell(git:*)'` / `--deny-tool='shell(rm)'` | Tool + argument pattern level |
| Gemini CLI | Policy Engine (`--policy`) + BeforeToolSelection hook | Tool name + dynamic filtering |
| OpenCode | None (Crush: `disabled_tools` in config) | Config-level only |

**Copilot has the most granular tool control** -- you can allow/deny at the command level within shell tools (e.g., allow `git status` but deny `git push`). This means worca's guardian-only-commits rule could be enforced purely via `--deny-tool='shell(git commit)'` without a custom hook.

### 7. Subagent / Nested Agent Dispatch

| Harness | Mechanism | Write Access? | Recursive? | Per-call Model? |
|---|---|---|---|---|
| Claude Code | `Agent` tool | Yes | Yes | No (inherits) |
| Copilot CLI | `/fleet` (parallel), `agent` tool, `/delegate` (cloud) | Yes | Yes (custom agents) | Yes (per agent def) |
| Gemini CLI | `invoke_agent` tool | Yes (per agent config) | Yes | Yes (per agent def) |
| OpenCode | `agent` tool (task agent) | No (read-only) | No | Config only |

**Copilot's `/fleet` command** is notable -- it decomposes tasks into dependency-aware parallel subtasks with SQLite tracking. This is directly comparable to worca's multi-implementer pattern and could potentially replace some orchestrator logic.

**Copilot's `/delegate`** hands off to a cloud agent (GitHub Actions), enabling async execution with PR creation. No equivalent in other harnesses.

### 8. Model Selection

| Harness | Per-invocation | Per-agent | BYOK |
|---|---|---|---|
| Claude Code | `--model model-id` | No (same model for all) | No (Anthropic only) |
| Copilot CLI | `--model model-id` | Yes (in `.agent.md`) | Yes (`COPILOT_PROVIDER_*` env vars) |
| Gemini CLI | `-m model-id` | Yes (in agent YAML) | Yes (Vertex AI, API key) |
| OpenCode | No CLI flag | Config per agent type | Yes (many providers) |

**Copilot and Gemini both support per-agent model selection** in agent definitions, which aligns well with worca's `worca.agents.<name>.model` config pattern.

### 9. Cost / Usage Tracking

| Harness | In CLI Output? | Tokens? | Cost (USD)? | Duration? |
|---|---|---|---|---|
| Claude Code | Yes (stream-json result) | Yes | Yes | Yes |
| Copilot CLI | No | No | No (premium requests) | No |
| Gemini CLI | Yes (result event stats) | Yes (per-model breakdown) | No (depends on auth method) | Yes |
| OpenCode | No (SQLite internal) | Internal only | Internal only | No |

**Only Claude Code reports dollar costs.** Gemini provides detailed token breakdowns per model. Copilot tracks "premium requests" at the subscription level only.

### 10. Permission Model

| Harness | Autonomous Flag | Granular Control |
|---|---|---|
| Claude Code | `--dangerously-skip-permissions` | `allowedTools` in settings |
| Copilot CLI | `--allow-all` / `--yolo` | `--allow-tool` / `--deny-tool` per invocation |
| Gemini CLI | `--yolo` / `--approval-mode yolo` | Policy Engine for fine-grained rules |
| OpenCode | Auto in `-p` mode | All-or-nothing |

### 11. Session Persistence

| Harness | Disable? | Resume? |
|---|---|---|
| Claude Code | `--no-session-persistence` | `--continue` / conversation ID |
| Copilot CLI | Not documented | `--resume=<sessionId>` / `--continue` |
| Gemini CLI | No disable flag | `--resume` / `--resume latest` |
| OpenCode | No (always SQLite) | No |

### 12. Environment Variable Passing

All harnesses inherit env vars from the parent process. Additionally:
- **Copilot:** `--secret-env-vars` for redaction; hook configs support `env` field
- **Gemini:** Hook configs support `env` field
- **OpenCode:** Parent inheritance only

### Tool Name Mapping

| Concept | Claude Code | Copilot CLI | Gemini CLI |
|---|---|---|---|
| Shell execution | `Bash` | `shell` / `execute` | `run_shell_command` |
| Read file | `Read` | `read` | `read_file` |
| Write file | `Write` | `write` | `write_file` |
| Edit file | `Edit` | `edit` | `edit` |
| Search content | `Grep` | `search` | `search_text` |
| Find files | `Glob` | `search` | `find_files` |
| List directory | `LS` | N/A | `list_directory` |
| Spawn subagent | `Agent` | `agent` | `invoke_agent` |
| Web search | `WebSearch` | `web` | `web_search` |
| Web fetch | `WebFetch` | `web` | `web_fetch` |
| Task tracking | `TodoWrite` | `todo` | `write_todos` |
| Plan mode | `EnterPlanMode` | N/A | `enter_plan_mode` |
| Skills | `Skill` | N/A | `activate_skill` |

---

## Harness Viability Summary

### Copilot CLI -- Best Candidate

| Category | Rating | Notes |
|---|---|---|
| Headless mode | Full parity | `-p`, `-s`, `--no-ask-user` |
| Agent loading | Full parity | `--agent name` with `.agent.md` files |
| Structured output | Gap | No schema enforcement; need prompt+validation fallback |
| Streaming | Likely parity | NDJSON output; schema less documented |
| Hooks | Near parity | 6 events; preToolUse can deny but not modify inputs |
| Tool control | Better than CC | Command-level granularity (`shell(git:*)`) |
| Subagents | Better than CC | `/fleet` parallel + `/delegate` to cloud |
| Model selection | Full parity+ | Per-invocation + per-agent + BYOK |
| Cost tracking | Gap | No per-call metrics in output |
| SDK | Available | Python, Node, Go, .NET (public preview) |

**Overall: 10/12 surfaces at parity or better. 2 gaps (schema enforcement, cost tracking).**

### Gemini CLI -- Strong Second

| Category | Rating | Notes |
|---|---|---|
| Headless mode | Full parity | `-p` flag |
| Agent loading | Partial | No `--agent` CLI flag; must use `.gemini/agents/` directory |
| Structured output | Gap | No CLI flag; `complete_task` tool offers partial workaround |
| Streaming | Full parity | `--output-format stream-json` with similar event schema |
| Hooks | Better than CC | 11 events; block, modify, inject synthetic responses |
| Tool control | Full parity | Policy Engine + hooks |
| Subagents | Full parity | `invoke_agent` tool |
| Model selection | Full parity | `-m` per invocation + per agent |
| Cost tracking | Near parity | Tokens + duration; no USD |
| SDK | Available | `@google/gemini-cli-sdk` (TypeScript) |

**Overall: 9/12 at parity or better. 3 gaps (agent flag, schema enforcement, agent loading ergonomics).**

### OpenCode / Crush -- Not Viable

| Category | Rating | Notes |
|---|---|---|
| Headless mode | Partial | `-p` but no max-turns |
| Agent loading | None | Context paths only; no agent concept |
| Structured output | None | No schema enforcement |
| Streaming | None | Final blob only; no event stream |
| Hooks | None | No hook system |
| Tool control | Minimal | Crush config only |
| Subagents | Limited | Read-only task agent |
| Overall | Blocker | 6/12 gaps, 3 critical (hooks, streaming, structured output) |

**Project is archived. Successor (Crush) does not close the critical gaps.**

---

## Recommended Abstraction Architecture

```
                    worca orchestrator
                    (harness-agnostic)
                          |
                  HarnessProvider interface
                  ________________________
                 |            |            |
           ClaudeCode    CopilotCLI    GeminiCLI
            Provider      Provider      Provider
```

### HarnessProvider Interface

```python
class HarnessProvider(Protocol):
    name: str  # "claude-code", "copilot-cli", "gemini-cli"

    def run_agent(
        self,
        prompt: str,
        agent_path: Path,
        model: str | None,
        json_schema: Path | None,
        max_turns: int | None,
        env: dict[str, str] | None,
        on_event: Callable[[NormalizedEvent], None] | None,
    ) -> NormalizedResult: ...

    def install_hooks(self, hooks_config: WorkaHooksConfig) -> None: ...
    def get_tool_name(self, canonical: str) -> str: ...
    def supports_schema_enforcement(self) -> bool: ...
```

### NormalizedEvent / NormalizedResult

```python
@dataclass
class NormalizedEvent:
    type: Literal["text", "tool_use", "tool_result", "error", "result"]
    timestamp: float
    data: dict  # type-specific payload

@dataclass
class NormalizedResult:
    output: dict | str          # structured or free-form
    tokens_in: int | None
    tokens_out: int | None
    cost_usd: float | None
    duration_ms: int | None
    num_turns: int | None
```

### Work Breakdown

| Task | Effort | Description |
|---|---|---|
| Define `HarnessProvider` protocol | 1 day | Python Protocol class + NormalizedEvent/Result types |
| Extract `ClaudeCodeProvider` | 2 days | Refactor `claude_cli.py` + `runner.py` into provider impl |
| Build `CopilotCLIProvider` | 2-3 days | CLI invocation, NDJSON parsing, hook translation |
| Build `GeminiCLIProvider` | 2-3 days | CLI invocation, stream-json parsing, hook translation |
| Schema enforcement fallback | 1-2 days | Prompt injection + post-hoc validation for non-CC harnesses |
| Hook adapter layer | 2 days | Translate worca hooks to each harness's config format |
| Tool name mapping | 0.5 day | Canonical name -> harness-specific name lookup |
| Agent prompt templating | 1 day | Remove CC-specific references; use `{TOOL_BASH}` etc. |
| Config format (`worca.harness`) | 0.5 day | Add harness selection to settings.json |
| Integration tests | 2-3 days | Test each provider against a mock harness |
| **Total** | **~2-3 weeks** | |

---

## Open Questions

1. **Should providers be installed as plugins or bundled?** Bundling all three increases package size; plugins add complexity.
2. **How to handle hook input modification?** Copilot's preToolUse cannot modify inputs (only deny). The cwd-fix hook in worca needs an alternative for Copilot.
3. **Gemini agent loading workaround** -- Is dynamically writing `.gemini/agents/stage.md` before each invocation acceptable, or too fragile?
4. **Cost normalization** -- Should worca estimate costs from token counts using a pricing table, or only report what the harness provides?
5. **Copilot SDK vs CLI** -- The SDK (public preview) offers programmatic control but may not be production-ready. Target CLI first, SDK later?

## Considerations

- **Testing strategy:** Each provider needs integration tests against the real harness binary. Mock-based unit tests for the abstraction layer, real binary tests for provider implementations.
- **Feature detection:** Providers should declare capabilities (`supports_schema_enforcement`, `supports_input_modification`, `supports_cost_tracking`) so the orchestrator can adapt behavior.
- **Graceful degradation:** If a harness lacks a feature (e.g., schema enforcement), the orchestrator should fall back gracefully rather than fail.
- **Backwards compatibility:** The `ClaudeCodeProvider` must produce identical behavior to the current direct integration. No regressions for existing users.
