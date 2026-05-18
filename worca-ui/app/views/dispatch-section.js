import { html, nothing } from 'lit-html';

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

function perAgentRowView(agent, tags, _defaultTags) {
  return html`
    <div class="settings-dispatch-row">
      <span class="settings-dispatch-agent">${agent}</span>
      <div class="dispatch-tag-input-wrapper">
        <div class="dispatch-tag-input">
          ${tags.map((tag) =>
            chipView(tag, { locked: false, warn: false, removable: true }),
          )}
        </div>
      </div>
    </div>
  `;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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
 */
export function dispatchSectionView({
  section,
  config,
  knownItems: _knownItems,
  agentRoles,
  defaults,
  onChange,
}) {
  const alwaysDisallowed = config.always_disallowed || [];
  const defaultDenied = config.default_denied || [];
  const perAgentAllow = config.per_agent_allow || {};

  function handleRemoveDefaultDenied(tag) {
    const newDenied = defaultDenied.filter((t) => t !== tag);
    onChange({
      ...config,
      default_denied: newDenied,
    });
  }

  const allAgentKeys = ['_defaults', ...agentRoles];

  return html`
    <div class="dispatch-section">
      <h4 class="dispatch-section-title">${capitalize(section)}</h4>

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
            const tags = perAgentAllow[agent] || [];
            const agentDefaults =
              defaults?.per_agent_allow?.[agent] ||
              defaults?.per_agent_allow?._defaults ||
              [];
            return perAgentRowView(agent, tags, agentDefaults);
          })}
        </div>
      </div>
    </div>
  `;
}
