import { html, nothing } from 'lit-html';
import { isCustomized } from './dispatch-tag-state.js';

// Follow-up #4: hovering over the `*` chip explains what wildcard means.
// Hovering a locked chip explains why it's there (e.g. always_disallowed
// or, in the Tools section, the auto-included Skill/Agent meta-tools).
const _WILDCARD_CHIP_TITLE =
  'Any item not in the Always Disallowed or Default Denied tiers';
const _LOCKED_CHIP_TITLE_DEFAULT = 'Hard-deny — cannot be removed';

function chipView(tag, { locked, warn, removable, onRemove, titleOverride }) {
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
  const title =
    titleOverride ??
    (isWildcard
      ? _WILDCARD_CHIP_TITLE
      : locked
        ? _LOCKED_CHIP_TITLE_DEFAULT
        : '');

  if (removable && onRemove) {
    return html`<sl-tag size="small" removable class="${classes}" data-value="${tag}" title="${title}" @sl-remove=${onRemove}>${label}</sl-tag>`;
  }
  if (removable) {
    return html`<sl-tag size="small" removable class="${classes}" data-value="${tag}" title="${title}">${label}</sl-tag>`;
  }
  return html`<sl-tag size="small" class="${classes}" data-value="${tag}" title="${title}">${label}</sl-tag>`;
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

// Follow-up #3 / #5: meta-tools that worca uses to dispatch skills and
// subagents. When a Tools per-agent row has a *named* list (not wildcard,
// not empty), the runtime auto-includes these so the skill_use.py and
// subagent_start.py hooks still fire. The UI surfaces them as locked
// pseudo-chips with a tooltip so the user understands why they're there.
const _AUTO_INCLUDED_META_TOOLS = ['Skill', 'Agent'];
const _AUTO_INCLUDED_TITLE =
  'Auto-included so the worca skill/subagent governance hooks keep firing';

function _autoIncludedMetaChips(section, tags) {
  // Only render for the Tools section when the user supplied a named list.
  if (section !== 'tools') return null;
  if (!tags || tags.length === 0) return null;
  if (tags.includes('*')) return null;
  // Don't duplicate chips the user already typed.
  const userSet = new Set(tags);
  const auto = _AUTO_INCLUDED_META_TOOLS.filter((t) => !userSet.has(t));
  if (auto.length === 0) return null;
  return auto.map(
    (tag) => html`<sl-tag
      size="small"
      class="dispatch-chip dispatch-chip-locked dispatch-chip-auto"
      data-value="${tag}"
      data-auto-included="true"
      title="${_AUTO_INCLUDED_TITLE}"
      >${tag}</sl-tag
    >`,
  );
}

// Must match LOCKDOWN_SENTINEL in src/worca/hooks/tracking.py. An entry of
// exactly ["none"] means "lock this agent out — allow nothing"; any other
// combination (including bare []) falls through to _defaults at resolve time.
const LOCKDOWN_SENTINEL = 'none';

function _isLockdownEntry(entry) {
  return (
    Array.isArray(entry) && entry.length === 1 && entry[0] === LOCKDOWN_SENTINEL
  );
}

function _isEmptyExplicit(entry) {
  return Array.isArray(entry) && entry.length === 0;
}

function _lockdownChip(section, agent, perAgentAllow) {
  // True lockdown is the singleton sentinel ["none"] — matching the
  // resolver in src/worca/hooks/tracking.py. An empty list [] is NOT
  // lockdown; it falls through to _defaults (see _inheritsDefaultsChip).
  if (agent === '_defaults') return null;
  if (!_isLockdownEntry(perAgentAllow?.[agent])) return null;
  const noun = section.slice(0, -1); // "tools" -> "tool"
  return html`<sl-tag
    size="small"
    class="dispatch-chip dispatch-chip-locked dispatch-chip-lockdown"
    data-value="${LOCKDOWN_SENTINEL}"
    data-lockdown="true"
    title="Explicit lockdown — no ${noun} available to this agent"
    >Lockdown</sl-tag
  >`;
}

function _inheritsDefaultsChip(_section, agent, perAgentAllow) {
  // Explicit empty per_agent_allow entry falls through to _defaults at
  // resolve time. The placeholder makes that explicit so users don't
  // misread an empty chip row as a hard block.
  if (agent === '_defaults') return null;
  if (!_isEmptyExplicit(perAgentAllow?.[agent])) return null;
  return html`<sl-tag
    size="small"
    class="dispatch-chip dispatch-chip-inherits"
    data-inherits="true"
    title="Empty list — falls through to _defaults at dispatch time"
    >Inherits defaults</sl-tag
  >`;
}

function perAgentRowView({
  section,
  agent,
  tags,
  defaultTags,
  knownItems,
  alwaysDisallowed,
  defaultDenied,
  perAgentAllow,
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

  // When lockdown is active, the sentinel ("none") lives in `tags` but we
  // surface it as the Lockdown placeholder instead of a raw chip.
  const lockdownActive = isAgent && _isLockdownEntry(perAgentAllow?.[agent]);
  const visibleTags = lockdownActive
    ? tags.filter((t) => t !== LOCKDOWN_SENTINEL)
    : tags;

  const autoIncludedChips = _autoIncludedMetaChips(section, visibleTags);
  const lockdownChip = _lockdownChip(section, agent, perAgentAllow);
  const inheritsChip = _inheritsDefaultsChip(section, agent, perAgentAllow);

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
          ${visibleTags.map((tag) =>
            chipView(tag, {
              locked: false,
              warn: false,
              removable: true,
              onRemove: () => onRemove(tag),
            }),
          )}
          ${autoIncludedChips ?? nothing}
          ${lockdownChip ?? nothing}
          ${inheritsChip ?? nothing}
          <input
            class="dispatch-tag-input-field"
            type="text"
            .value=${rowState.input || ''}
            placeholder=${visibleTags.length === 0 && !lockdownChip && !inheritsChip ? `Add ${section.slice(0, -1)}…` : ''}
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
  showTitle = true,
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

  // Footgun guard: a bare `*` in a deny tier matches everything and locks
  // every candidate out of the section. Surface as a non-blocking warning so
  // the operator can see what they're about to ship without taking the rule
  // out of their hands (settings.json edits remain authoritative).
  const wildcardTiers = [];
  if (alwaysDisallowed.includes('*')) wildcardTiers.push('Always Disallowed');
  if (defaultDenied.includes('*')) wildcardTiers.push('Default Denied');
  const wildcardWarning =
    wildcardTiers.length > 0
      ? html`
        <sl-alert
          variant="warning"
          open
          class="dispatch-wildcard-deny-warning"
          data-section="${section}"
        >
          A bare <code>*</code> in
          ${wildcardTiers.join(' and ')} blocks every ${section.slice(0, -1)}
          for every agent — including ones explicitly listed in Per-Agent
          Allow. If this isn't intentional, remove the <code>*</code> and use a
          prefix glob (e.g. <code>worca-*</code>) or an exact name.
        </sl-alert>
      `
      : nothing;

  return html`
    <div class="dispatch-section">
      ${
        showTitle
          ? html`<h4 class="dispatch-section-title">${capitalize(section)}</h4>`
          : nothing
      }
      ${
        sectionHint
          ? html`<p class="dispatch-section-hint">${sectionHint}</p>`
          : nothing
      }
      ${wildcardWarning}

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
              perAgentAllow,
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
