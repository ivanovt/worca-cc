/**
 * Overlays tab for the Pipelines editor.
 *
 * Shows per-stage prompt overlays (agent .md + block .md files) fetched from
 * GET /templates/:tier/:id/overlays. Read-only; no editing in this surface.
 *
 * Stage→file mapping follows src/worca/orchestrator/stages.py naming.
 */

import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { renderMarkdown } from '../utils/markdown.js';

/**
 * Stage→overlay file mapping.
 * agentFiles: primary agent prompt files (first present wins, shown as sub-tabs when >1)
 * blockFiles: user prompt (block) files
 */
export const STAGE_OVERLAY_MAP = [
  {
    key: 'plan',
    label: 'Plan',
    agentFiles: ['planner.md'],
    blockFiles: ['plan.block.md'],
  },
  {
    key: 'plan_review',
    label: 'Plan Review',
    agentFiles: ['plan_reviewer.md', 'plan_editor.md'],
    blockFiles: ['plan-review.block.md', 'plan-edit.block.md'],
  },
  {
    key: 'coordinate',
    label: 'Coordinate',
    agentFiles: ['coordinator.md'],
    blockFiles: ['coordinate.block.md'],
  },
  {
    key: 'implement',
    label: 'Implement',
    agentFiles: ['implementer.md'],
    blockFiles: ['implement.block.md'],
  },
  {
    key: 'test',
    label: 'Test',
    agentFiles: ['tester.md'],
    blockFiles: ['test.block.md'],
  },
  {
    key: 'review',
    label: 'Review',
    agentFiles: ['reviewer.md'],
    blockFiles: ['review.block.md'],
  },
  {
    key: 'pr',
    label: 'PR',
    agentFiles: ['guardian.md'],
    blockFiles: ['pr.block.md'],
  },
  {
    key: 'learn',
    label: 'Learn',
    agentFiles: ['learner.md'],
    blockFiles: ['learn.block.md'],
  },
];

/**
 * Collect the overlay files present for a stage from the overlays map.
 * Returns { agentFiles: [{name, content}], blockFiles: [{name, content}] }
 */
export function stageOverlayFiles(stage, overlays) {
  const present = (names) =>
    names
      .filter((n) => Object.hasOwn(overlays, n))
      .map((n) => ({ name: n, content: overlays[n] }));
  return {
    agentFiles: present(stage.agentFiles),
    blockFiles: present(stage.blockFiles),
  };
}

/**
 * Returns true if a stage has at least one overlay file present.
 */
export function stageHasOverlays(stage, overlays) {
  const { agentFiles, blockFiles } = stageOverlayFiles(stage, overlays);
  return agentFiles.length > 0 || blockFiles.length > 0;
}

/**
 * Render the content of a single overlay file as markdown.
 */
function _fileContent(file) {
  return html`
    <div class="overlay-file-content markdown-body">
      ${unsafeHTML(renderMarkdown(file.content))}
    </div>
  `;
}

/**
 * Render sub-tabs for a stage that has overlays.
 *
 * Only overlay files that actually exist become tabs. A stage declares both an
 * agent-prompt and a user-prompt (.block) slot, but most templates define only
 * some — rendering the absent ones as disabled, non-clickable placeholder tabs
 * is confusing, so they're omitted entirely.
 */
function _stageTabs(stage, overlays) {
  const presentAgentFiles = stage.agentFiles
    .filter((name) => overlays[name] != null)
    .map((name) => ({ name, content: overlays[name] }));
  const presentBlockFiles = stage.blockFiles
    .filter((name) => overlays[name] != null)
    .map((name) => ({ name, content: overlays[name] }));

  const tabs = [];
  const panels = [];

  for (const f of presentAgentFiles) {
    const panelId = `overlay-${stage.key}-${f.name.replace(/\./g, '-')}`;
    const label = f.name.replace(/\.md$/, '');
    tabs.push(html`
      <sl-tab slot="nav" panel=${panelId}>
        Agent prompt
        <span class="overlay-file-label">(${label})</span>
      </sl-tab>
    `);
    panels.push(html`
      <sl-tab-panel name=${panelId}>${_fileContent(f)}</sl-tab-panel>
    `);
  }

  for (const f of presentBlockFiles) {
    const panelId = `overlay-${stage.key}-${f.name.replace(/\./g, '-')}`;
    const label = f.name.replace(/\.md$/, '');
    tabs.push(html`
      <sl-tab slot="nav" panel=${panelId}>
        User prompt
        <span class="overlay-file-label">(${label})</span>
      </sl-tab>
    `);
    panels.push(html`
      <sl-tab-panel name=${panelId}>${_fileContent(f)}</sl-tab-panel>
    `);
  }

  if (tabs.length === 0) return nothing;

  return html`
    <sl-tab-group class="overlay-stage-tabs">
      ${tabs}
      ${panels}
    </sl-tab-group>
  `;
}

/**
 * Render the Overlays tab content.
 *
 * @param {object} overlays  - { filename: content } map from the server
 */
export function overlaysTabView(overlays) {
  if (!overlays || Object.keys(overlays).length === 0) {
    return html`<div class="settings-tab-content overlay-empty">No overlays found.</div>`;
  }

  const stageCards = STAGE_OVERLAY_MAP.map((stage) => {
    const hasAny = stageHasOverlays(stage, overlays);
    if (!hasAny) {
      return html`
        <div class="overlay-stage-card overlay-stage-card--disabled">
          <div class="overlay-stage-label">${stage.label}</div>
        </div>
      `;
    }
    return html`
      <sl-details class="overlay-stage-card" summary=${stage.label}>
        ${_stageTabs(stage, overlays)}
      </sl-details>
    `;
  });

  return html`
    <div class="settings-tab-content overlay-stages">
      ${stageCards}
    </div>
  `;
}
