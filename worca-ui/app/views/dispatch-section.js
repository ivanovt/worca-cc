import { html, nothing } from 'lit-html';
import { isCustomized } from './dispatch-tag-state.js';

function chipView(tag, { locked, warn, removable, onRemove }) {
  const isWildcard = tag === '*';
  const classes = [
    'dispatch-chip',
    isWildcard ? 'dispatch-chip-wildcard' : '',
    locked ? 'dispatch-chip-locked' : '',
    warn ? 'dispatch-chip-warn' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const label = isWildcard ? 'any' : tag;

  if (removable && onRemove) {
    return html`<sl-tag size="small" removable class="${classes}" data-value="${tag}" @sl-remove=${onRemove}>${label}</sl-tag>`;
  }
  if (removable) {
    return html`<sl-tag size="small" removable class="${classes}" data-value="${tag}">${label}</sl-tag>`;
  }
  return html`<sl-tag size="small" class="${classes}" data-value="${tag}">${label}</sl-tag>`;
}

function tierView(title, items, { locked, warn, removable, onRemove }) {
  if (!items || items.length === 0) return nothing;
  return html`
    <div class="dispatch-tier">
      <div class="dispatch-tier-label">${title}</div>
      <div class="dispatch-tier-chips">
        ${items.map((tag) =>
          chipView(tag, {
            locked,
            warn,
            removable,
            onRemove: onRemove ? () => onRemove(tag) : undefined,
          }),
        )}
      </div>
    </div>
  `;
}

function filterSuggestions(input, knownItems, currentTags, deniedSet, warnSet) {
  const query = (input || '').trim().toLowerCase();
  const warns = warnSet || new Set();
  return (knownItems || [])
    .filter((item) => !currentTags.includes(item.name))
    .filter((item) => !query || item.name.toLowerCase().includes(query))
    .slice(0, 50)
    .map((item) => ({
      ...item,
      denied: deniedSet.has(item.name),
      warn: warns.has(item.name) && !deniedSet.has(item.name),
    }));
}

function perAgentRowView({
  section,
  agent,
  tags,
  defaultTags,
  knownItems,
  alwaysDisallowed,
  defaultDenied,
  rowState,
  onRemove,
  onReset,
  onInput,
  onFocus,
  onBlur,
  onKeydown,
  onSuggestionClick,
}) {
  const isAgent = agent !== '_defaults';
  const customized = isAgent && isCustomized(tags, defaultTags);
  const deniedSet = new Set(alwaysDisallowed || []);
  const warnSet = new Set(defaultDenied || []);
  const suggestions = rowState.showSuggestions
    ? filterSuggestions(rowState.input, knownItems, tags, deniedSet, warnSet)
    : [];

  return html`
    <div
      class="settings-dispatch-row"
      data-section="${section}"
      data-agent="${agent}"
    >
      <span class="settings-dispatch-agent">${agent}</span>
      <div class="dispatch-tag-input-wrapper">
        <div
          id="dispatch-${section}-${agent}"
          class="dispatch-tag-input"
          @click=${(e) => {
            // Focus the input when the wrapper is clicked
            const input = e.currentTarget.querySelector(
              '.dispatch-tag-input-field',
            );
            if (input && e.target !== input) input.focus();
          }}
        >
          ${tags.map((tag) =>
            chipView(tag, {
              locked: false,
              warn: false,
              removable: true,
              onRemove: () => onRemove(tag),
            }),
          )}
          <input
            class="dispatch-tag-input-field"
            type="text"
            .value=${rowState.input || ''}
            placeholder=${tags.length === 0 ? `Add ${section.slice(0, -1)}…` : ''}
            @input=${onInput}
            @focus=${onFocus}
            @blur=${onBlur}
            @keydown=${onKeydown}
          />
        </div>
        ${
          rowState.showSuggestions && suggestions.length > 0
            ? html`
              <div class="dispatch-suggestions">
                ${suggestions.map(
                  (item) => html`
                    <div
                      class="item${item.denied ? ' denied' : ''}${item.warn ? ' warn' : ''}"
                      title=${
                        item.warn
                          ? 'Default-denied — adding it opts this agent into a normally-blocked capability'
                          : nothing
                      }
                      @mousedown=${(e) => {
                        // Prevent input blur before click fires
                        e.preventDefault();
                      }}
                      @click=${() => {
                        if (!item.denied) onSuggestionClick(item.name);
                      }}
                    >
                      <span>${item.name}</span>
                      ${
                        item.warn
                          ? html`<span class="item-hint">opt-in</span>`
                          : nothing
                      }
                      ${
                        item.label
                          ? html`<span class="item-label">${item.label}</span>`
                          : nothing
                      }
                    </div>
                  `,
                )}
              </div>
            `
            : nothing
        }
      </div>
      ${
        customized
          ? html`
            <sl-button
              size="small"
              variant="text"
              class="dispatch-reset-btn"
              title="Reset to default"
              @click=${onReset}
            >
              Reset
            </sl-button>
          `
          : html`<span class="dispatch-reset-placeholder"></span>`
      }
    </div>
  `;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const _SECTION_HINTS = {
  tools:
    "Tools are governed at process-spawn time. `*` allows all built-in tools (minus the hard-deny list). A named list (e.g. Read, Grep) restricts the agent to those built-ins — `Skill` and `Agent` are auto-included so worca's skill/subagent governance keeps working. MCP tools (mcp_*) are not covered by this section.",
  skills:
    "Skills are gated by a PreToolUse hook on the `Skill` tool. Items in the second tier are blocked under `*` — add them to a specific agent's allow list to opt in.",
  subagents:
    'Subagents are gated by a SubagentStart hook. Default is `*` (any subagent except the hard-deny list). Add entries to the second tier to gate specific subagents from broad fanout.',
};

/**
 * Renders a single dispatch governance section (tools, skills, or subagents).
 *
 * @param {Object} params
 * @param {'tools'|'skills'|'subagents'} params.section
 * @param {{ always_disallowed: string[], default_denied: string[], per_agent_allow: Record<string, string[]> }} params.config
 * @param {{ name: string, label: string, group: string }[]} params.knownItems
 * @param {string[]} params.agentRoles
 * @param {Object} params.defaults
 * @param {(newConfig: Object) => void} params.onChange
 * @param {Object} [params.state] - Per-agent UI state: { [agent]: { input, showSuggestions } }
 * @param {() => void} [params.rerender]
 */
export function dispatchSectionView({
  section,
  config,
  knownItems,
  agentRoles,
  defaults,
  onChange,
  state,
  rerender,
}) {
  const alwaysDisallowed = config.always_disallowed || [];
  const defaultDenied = config.default_denied || [];
  const perAgentAllow = config.per_agent_allow || {};
  const editingState = state || {};
  const triggerRerender = rerender || (() => {});

  function getRowState(agent) {
    if (!editingState[agent]) {
      editingState[agent] = { input: '', showSuggestions: false };
    }
    return editingState[agent];
  }

  function emit(newPerAgentAllow) {
    onChange({
      ...config,
      per_agent_allow: newPerAgentAllow,
    });
  }

  function _agentDefault(agent) {
    return (
      defaults?.per_agent_allow?.[agent] ||
      defaults?.per_agent_allow?._defaults ||
      []
    );
  }

  // The "effective" tag list for an agent: the explicit per-agent value
  // when present, otherwise the section defaults. Edits materialize the
  // effective list into an explicit per-agent entry.
  function _effectiveTags(agent) {
    if (perAgentAllow[agent] !== undefined) return perAgentAllow[agent];
    if (agent === '_defaults') return [];
    return _agentDefault(agent);
  }

  function addTagToAgent(agent, tag) {
    const trimmed = (tag || '').trim();
    if (!trimmed) return;
    if (alwaysDisallowed.includes(trimmed)) return;
    const current = _effectiveTags(agent);
    if (current.includes(trimmed)) return;
    const next = [...current, trimmed];
    emit({ ...perAgentAllow, [agent]: next });
  }

  function removeTagFromAgent(agent, tag) {
    const current = _effectiveTags(agent);
    const next = current.filter((t) => t !== tag);
    emit({ ...perAgentAllow, [agent]: next });
  }

  function resetAgent(agent) {
    const next = { ...perAgentAllow };
    const agentDefault =
      defaults?.per_agent_allow?.[agent] ||
      defaults?.per_agent_allow?._defaults ||
      [];
    next[agent] = [...agentDefault];
    emit(next);
  }

  function handleRemoveDefaultDenied(tag) {
    const newDenied = defaultDenied.filter((t) => t !== tag);
    onChange({
      ...config,
      default_denied: newDenied,
    });
  }

  const allAgentKeys = ['_defaults', ...agentRoles];

  const sectionHint = _SECTION_HINTS[section];

  return html`
    <div class="dispatch-section">
      <h4 class="dispatch-section-title">${capitalize(section)}</h4>
      ${
        sectionHint
          ? html`<p class="dispatch-section-hint">${sectionHint}</p>`
          : nothing
      }

      ${tierView('Always Disallowed', alwaysDisallowed, {
        locked: true,
        warn: false,
        removable: false,
      })}

      ${tierView('Default Denied', defaultDenied, {
        locked: false,
        warn: true,
        removable: true,
        onRemove: handleRemoveDefaultDenied,
      })}

      <div class="dispatch-tier">
        <div class="dispatch-tier-label">Per-Agent Allow</div>
        <div class="settings-dispatch-table">
          ${allAgentKeys.map((agent) => {
            const tags = _effectiveTags(agent);
            const agentDefaults = _agentDefault(agent);
            const rowState = getRowState(agent);
            return perAgentRowView({
              section,
              agent,
              tags,
              defaultTags: agentDefaults,
              knownItems,
              alwaysDisallowed,
              defaultDenied,
              rowState,
              onRemove: (tag) => removeTagFromAgent(agent, tag),
              onReset: () => resetAgent(agent),
              onInput: (e) => {
                rowState.input = e.target.value;
                rowState.showSuggestions = true;
                triggerRerender();
              },
              onFocus: () => {
                rowState.showSuggestions = true;
                triggerRerender();
              },
              onBlur: () => {
                // Delay so suggestion @click can fire first
                setTimeout(() => {
                  rowState.showSuggestions = false;
                  triggerRerender();
                }, 150);
              },
              onKeydown: (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const value = rowState.input.trim();
                  if (value) {
                    addTagToAgent(agent, value);
                    rowState.input = '';
                    rowState.showSuggestions = false;
                    triggerRerender();
                  }
                } else if (e.key === 'Escape') {
                  rowState.showSuggestions = false;
                  rowState.input = '';
                  triggerRerender();
                }
              },
              onSuggestionClick: (name) => {
                addTagToAgent(agent, name);
                rowState.input = '';
                rowState.showSuggestions = false;
                triggerRerender();
              },
            });
          })}
        </div>
      </div>
    </div>
  `;
}
