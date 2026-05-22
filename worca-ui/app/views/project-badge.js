import { html, nothing } from 'lit-html';

export const GRAPHIFY_BADGE_VARIANT = {
  ready: 'success',
  disabled: 'neutral',
  'pending-install': 'warning',
  'version-mismatch': 'danger',
  degraded: 'warning',
};

export const GRAPHIFY_BADGE_LABEL = {
  ready: 'Ready',
  disabled: 'Disabled',
  'pending-install': 'Pending install',
  'version-mismatch': 'Version mismatch',
  degraded: 'Degraded',
};

export function graphifyBadgeState(status) {
  if (!status?.effective?.enabled) return 'disabled';
  const det = status.detection || {};
  if (!det.installed) return 'pending-install';
  if (!det.compatible) return 'version-mismatch';
  if (det.error) return 'degraded';
  return 'ready';
}

function _buildTooltip(status) {
  const parts = [];
  const eff = status.effective || {};
  const det = status.detection || {};
  const gs = status.graph_stats;

  parts.push(`Mode: ${eff.mode || 'n/a'}`);

  if (det.version) parts.push(`v${det.version}`);
  else if (det.installed === false) parts.push('Not installed');

  if (det.compatible === false && det.installed)
    parts.push('Incompatible version');
  if (det.error) parts.push(`Error: ${det.error}`);

  if (gs) {
    const ageMins = Math.round(gs.age_seconds / 60);
    parts.push(`Graph age: ${ageMins}m`);
  }

  if (eff.reason) parts.push(`Reason: ${eff.reason}`);

  return parts.join(' · ');
}

export function graphifyBadgeView(status) {
  if (!status) return nothing;

  const state = graphifyBadgeState(status);
  const variant = GRAPHIFY_BADGE_VARIANT[state];
  const label = GRAPHIFY_BADGE_LABEL[state];
  const tooltip = _buildTooltip(status);

  const hasGraph = status.graph_stats?.has_html;

  return html`
    <span class="graphify-badge" title="${tooltip}">
      <span class="meta-label">Graphify:</span>
      <sl-badge variant="${variant}" pill class="graphify-status-badge">${label}</sl-badge>
      ${hasGraph ? html`<a href="/api/graphify/graph.html" target="_blank" class="graphify-graph-link">View graph</a>` : nothing}
    </span>
  `;
}
