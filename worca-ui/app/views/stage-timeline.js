import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  iconSvg,
  Loader,
  Pause,
  RefreshCw,
  RotateCw,
} from '../utils/icons.js';
import { sortByStageOrder } from '../utils/stage-order.js';
import { resolveStatus, statusClass } from '../utils/status-badge.js';

function _sortedEntries(stages) {
  return sortByStageOrder(Object.entries(stages));
}

const STAGE_ICON = {
  pending: Circle,
  running: Loader,
  in_progress: Loader,
  completed: CircleCheck,
  failed: CircleAlert,
  error: CircleAlert,
  paused: Pause,
  interrupted: Pause,
  resuming: RotateCw,
  skipped: CircleSlash,
};

function stageLabel(key, stageUi) {
  if (stageUi?.[key]?.label) return stageUi[key].label;
  return key.replace(/_/g, ' ').toUpperCase();
}

export function stageTimelineView(stages, stageUi = {}, isActive = true) {
  if (!stages || typeof stages !== 'object') return html``;

  const entries = _sortedEntries(stages);
  if (entries.length === 0)
    return html`<div class="empty-state">No stages</div>`;

  return html`
    <div class="stage-timeline">
      ${entries.map(([key, stage], i) => {
        const status = resolveStatus(stage.status || 'pending', isActive);
        const iconData = STAGE_ICON[status] || Circle;
        const label = stageLabel(key, stageUi);
        const isPulse =
          status === 'in_progress' ||
          status === 'running' ||
          status === 'resuming';
        const iteration = stage.iteration;
        const iconClass = isPulse ? 'icon-spin' : '';

        return html`
          ${i > 0 ? html`<div class="stage-connector ${entries[i - 1]?.[1]?.status === 'completed' ? 'completed' : ''}"></div>` : ''}
          <div class="stage-node ${statusClass(status)} ${isPulse ? 'pulse' : ''}">
            <div class="stage-icon">${unsafeHTML(iconSvg(iconData, 22, iconClass))}</div>
            <div class="stage-label">${label}</div>
            ${iteration > 1 ? html`<span class="loop-indicator">${unsafeHTML(iconSvg(RefreshCw, 10))}${iteration}</span>` : ''}
          </div>
        `;
      })}
    </div>
  `;
}
