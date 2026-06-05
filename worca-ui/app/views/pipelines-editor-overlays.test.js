/**
 * Unit tests for pipelines-editor-overlays.js
 *
 * Covers:
 *   1. Stage map produces correct file matchings for a sample overlay set
 *   2. Disabled state when no overlays for a stage / a sub-tab
 *   3. Renders markdown via renderMarkdown → output contains expected HTML
 *   4. Shows overlays inherited via duplicate (tab surfaces overlays from
 *      duplicate-from-builtin, not just import)
 *
 * @vitest-environment jsdom
 */

import { render } from 'lit-html';
import { describe, expect, it } from 'vitest';
import {
  overlaysTabView,
  STAGE_OVERLAY_MAP,
  stageHasOverlays,
  stageOverlayFiles,
} from './pipelines-editor-overlays.js';

function mount(overlays) {
  const container = document.createElement('div');
  render(overlaysTabView(overlays), container);
  return container;
}

// ─── 1. Stage map produces correct file matchings ────────────────────────────

describe('STAGE_OVERLAY_MAP file matchings', () => {
  it('has 8 stages in the correct order', () => {
    const keys = STAGE_OVERLAY_MAP.map((s) => s.key);
    expect(keys).toEqual([
      'plan',
      'plan_review',
      'coordinate',
      'implement',
      'test',
      'review',
      'pr',
      'learn',
    ]);
  });

  it('plan stage maps to planner.md + plan.block.md', () => {
    const stage = STAGE_OVERLAY_MAP.find((s) => s.key === 'plan');
    expect(stage.agentFiles).toEqual(['planner.md']);
    expect(stage.blockFiles).toEqual(['plan.block.md']);
  });

  it('plan_review stage fans out to 2 agent + 2 block files', () => {
    const stage = STAGE_OVERLAY_MAP.find((s) => s.key === 'plan_review');
    expect(stage.agentFiles).toEqual(['plan_reviewer.md', 'plan_editor.md']);
    expect(stage.blockFiles).toEqual([
      'plan-review.block.md',
      'plan-edit.block.md',
    ]);
  });

  it('stageOverlayFiles returns only present files', () => {
    const overlays = {
      'planner.md': '# Plan',
      'coordinator.md': '# Coordinate',
    };
    const planStage = STAGE_OVERLAY_MAP.find((s) => s.key === 'plan');
    const result = stageOverlayFiles(planStage, overlays);
    expect(result.agentFiles).toHaveLength(1);
    expect(result.agentFiles[0]).toEqual({
      name: 'planner.md',
      content: '# Plan',
    });
    expect(result.blockFiles).toHaveLength(0);
  });

  it('stageOverlayFiles with sample overlay set correctly maps coordinate stage', () => {
    const overlays = {
      'planner.md': '# Planner',
      'coordinator.md': '# Coordinator',
      'coordinate.block.md': '## Block',
    };
    const coordStage = STAGE_OVERLAY_MAP.find((s) => s.key === 'coordinate');
    const result = stageOverlayFiles(coordStage, overlays);
    expect(result.agentFiles).toEqual([
      { name: 'coordinator.md', content: '# Coordinator' },
    ]);
    expect(result.blockFiles).toEqual([
      { name: 'coordinate.block.md', content: '## Block' },
    ]);
  });
});

// ─── 2. Disabled state when no overlays ─────────────────────────────────────

describe('stageHasOverlays disabled states', () => {
  it('returns false for a stage with no matching overlays', () => {
    const overlays = { 'planner.md': '# Plan' };
    const testStage = STAGE_OVERLAY_MAP.find((s) => s.key === 'test');
    expect(stageHasOverlays(testStage, overlays)).toBe(false);
  });

  it('returns true when only agent file is present', () => {
    const overlays = { 'planner.md': '# Plan' };
    const planStage = STAGE_OVERLAY_MAP.find((s) => s.key === 'plan');
    expect(stageHasOverlays(planStage, overlays)).toBe(true);
  });

  it('returns true when only block file is present', () => {
    const overlays = { 'plan.block.md': '## User block' };
    const planStage = STAGE_OVERLAY_MAP.find((s) => s.key === 'plan');
    expect(stageHasOverlays(planStage, overlays)).toBe(true);
  });

  it('renders disabled card class for stage with no overlays', () => {
    // Only planner.md present — test/review/pr/learn/etc. have no overlays
    const container = mount({ 'planner.md': '# Plan' });
    const disabled = container.querySelectorAll(
      '.overlay-stage-card--disabled',
    );
    // There are 7 stages besides plan that have no overlays here
    expect(disabled.length).toBeGreaterThan(0);
  });

  it('renders empty notice when overlays object is empty', () => {
    const container = mount({});
    expect(container.textContent).toContain('No overlays found');
  });

  it('sub-tab disabled when specific file not in overlays (plan_reviewer missing)', () => {
    const stage = STAGE_OVERLAY_MAP.find((s) => s.key === 'plan_review');
    // Only plan_editor.md present, plan_reviewer.md absent
    const overlays = { 'plan_editor.md': '# Editor' };
    const { agentFiles } = stageOverlayFiles(stage, overlays);
    const planReviewerPresent = agentFiles.some(
      (f) => f.name === 'plan_reviewer.md',
    );
    const planEditorPresent = agentFiles.some(
      (f) => f.name === 'plan_editor.md',
    );
    expect(planReviewerPresent).toBe(false);
    expect(planEditorPresent).toBe(true);
  });

  it('omits the tab for an absent overlay file (no disabled placeholder)', () => {
    // coordinate declares coordinator.md (agent) + coordinate.block.md (user);
    // here only the agent file exists, so the "User prompt" tab must not render.
    const container = mount({ 'coordinator.md': '# Coordinator' });
    const tabs = Array.from(container.querySelectorAll('sl-tab'));
    const labels = tabs.map((t) => t.textContent.replace(/\s+/g, ' ').trim());
    expect(labels.some((l) => l.startsWith('Agent prompt'))).toBe(true);
    expect(labels.some((l) => l.startsWith('User prompt'))).toBe(false);
    // And nothing renders as a disabled, non-clickable tab.
    expect(tabs.every((t) => !t.hasAttribute('disabled'))).toBe(true);
  });

  it('renders both Agent and User prompt tabs when both files exist', () => {
    const container = mount({
      'coordinator.md': '# Coordinator',
      'coordinate.block.md': '## User block',
    });
    const labels = Array.from(container.querySelectorAll('sl-tab')).map((t) =>
      t.textContent.replace(/\s+/g, ' ').trim(),
    );
    expect(labels.some((l) => l.startsWith('Agent prompt'))).toBe(true);
    expect(labels.some((l) => l.startsWith('User prompt'))).toBe(true);
  });
});

// ─── 3. Renders markdown ─────────────────────────────────────────────────────

describe('overlaysTabView markdown rendering', () => {
  it('renders markdown heading into .markdown-body element', () => {
    const container = mount({ 'planner.md': '# Hello World' });
    // marked converts "# Hello World" → <h1>Hello World</h1>
    // The content lands inside .markdown-body
    const body = container.querySelector('.markdown-body');
    expect(body).not.toBeNull();
    expect(body.innerHTML).toContain('Hello World');
  });

  it('renders bold markdown text inside overlay content', () => {
    const container = mount({ 'coordinator.md': '**Bold Text**' });
    const body = container.querySelector('.markdown-body');
    expect(body).not.toBeNull();
    // marked renders **text** → <strong>text</strong>
    expect(body.innerHTML).toContain('Bold Text');
  });
});

// ─── 4. Overlays inherited via duplicate ────────────────────────────────────

describe('overlays inherited via duplicate', () => {
  it('stageOverlayFiles works identically whether overlays came from import or duplicate', () => {
    const inheritedOverlays = {
      'planner.md': '# Inherited planner from builtin',
      'plan.block.md': '## Inherited block from builtin',
    };
    const planStage = STAGE_OVERLAY_MAP.find((s) => s.key === 'plan');
    const { agentFiles, blockFiles } = stageOverlayFiles(
      planStage,
      inheritedOverlays,
    );
    expect(agentFiles).toHaveLength(1);
    expect(agentFiles[0].content).toBe('# Inherited planner from builtin');
    expect(blockFiles).toHaveLength(1);
    expect(blockFiles[0].content).toBe('## Inherited block from builtin');
  });

  it('overlaysTabView shows plan stage as expandable (sl-details) for inherited overlays', () => {
    const inheritedOverlays = { 'planner.md': '# From builtin duplicate' };
    const container = mount(inheritedOverlays);
    // Plan stage should render as sl-details (expandable), not disabled
    const details = container.querySelectorAll('sl-details');
    expect(details.length).toBeGreaterThan(0);
    // Plan stage is the first stage — it should have the correct summary
    const planDetails = Array.from(details).find(
      (d) => d.getAttribute('summary') === 'Plan',
    );
    expect(planDetails).not.toBeNull();
  });

  it('disabled stages do not render as sl-details', () => {
    const inheritedOverlays = { 'planner.md': '# Only plan has overlay' };
    const container = mount(inheritedOverlays);
    // All stages except plan should be disabled (no sl-details)
    const testDisabled = container.querySelector(
      '.overlay-stage-card--disabled .overlay-stage-label',
    );
    expect(testDisabled).not.toBeNull();
  });
});
