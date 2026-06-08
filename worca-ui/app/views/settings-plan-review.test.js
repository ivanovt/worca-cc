import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function renderToString(template) {
  if (template == null || template === false) return '';
  if (typeof template === 'string' || typeof template === 'number')
    return String(template);
  if (template?.strings) {
    let result = '';
    for (let i = 0; i < template.strings.length; i++) {
      result += template.strings[i];
      if (i < template.values.length) {
        const v = template.values[i];
        if (v?.strings) result += renderToString(v);
        else if (Array.isArray(v)) result += v.map(renderToString).join('');
        else if (v != null && v !== false) result += String(v);
      }
    }
    return result;
  }
  return String(template);
}

describe('settings.js plan_review stage constants', () => {
  it('CONFIGURABLE_STAGES contains plan_review between plan and coordinate', async () => {
    const { CONFIGURABLE_STAGES } = await import('./settings.js');
    expect(CONFIGURABLE_STAGES).toContain('plan_review');
    const planIdx = CONFIGURABLE_STAGES.indexOf('plan');
    const reviewIdx = CONFIGURABLE_STAGES.indexOf('plan_review');
    const coordinateIdx = CONFIGURABLE_STAGES.indexOf('coordinate');
    expect(reviewIdx).toBeGreaterThan(planIdx);
    expect(reviewIdx).toBeLessThan(coordinateIdx);
  });

  it('STAGE_AGENT_MAP maps plan_review to plan_reviewer', async () => {
    const { STAGE_AGENT_MAP } = await import('./settings.js');
    expect(STAGE_AGENT_MAP.plan_review).toBe('plan_reviewer');
  });

  it('AGENT_NAMES includes plan_reviewer', async () => {
    const { AGENT_NAMES } = await import('./settings.js');
    expect(AGENT_NAMES).toContain('plan_reviewer');
  });
});

describe('plan_review mode + enforce UI controls', () => {
  let origDocument;
  let origFetch;

  beforeEach(() => {
    origDocument = globalThis.document;
    origFetch = globalThis.fetch;
    globalThis.document = {
      querySelectorAll: () => [],
      getElementById: () => null,
    };
  });

  afterEach(() => {
    globalThis.document = origDocument;
    globalThis.fetch = origFetch;
  });

  it('PLAN_REVIEW_MODES exports review and review_and_edit', async () => {
    const { PLAN_REVIEW_MODES } = await import('./settings.js');
    expect(PLAN_REVIEW_MODES).toEqual(['review', 'review_and_edit']);
  });

  it('PLAN_REVIEW_ENFORCE_OPTIONS exports auto, review, review_and_edit', async () => {
    const { PLAN_REVIEW_ENFORCE_OPTIONS } = await import('./settings.js');
    expect(PLAN_REVIEW_ENFORCE_OPTIONS).toEqual([
      'auto',
      'review',
      'review_and_edit',
    ]);
  });

  it('readStagesFromDom reads plan_review mode', async () => {
    const mod = await import('./settings.js');
    const elements = {
      'stage-plan_review-mode': { value: 'review_and_edit' },
    };
    globalThis.document.getElementById = (id) => elements[id] || null;
    const stages = mod.readStagesFromDom();
    expect(stages.plan_review.mode).toBe('review_and_edit');
  });

  it('readStagesFromDom defaults plan_review mode to review', async () => {
    const mod = await import('./settings.js');
    globalThis.document.getElementById = () => null;
    const stages = mod.readStagesFromDom();
    expect(stages.plan_review.mode).toBe('review');
  });

  it('readGovernanceFromDom no longer reads plan_review_enforce (template-owned)', async () => {
    // plan_review_enforce moved to TEMPLATE_OWNED_KEYS in the W-062
    // Phase 6 cleanup; readGovernanceFromDom in Project Settings
    // intentionally drops it now. The field lives on the template
    // editor's Governance tab.
    const mod = await import('./settings.js');
    const gov = mod.readGovernanceFromDom();
    expect(gov.plan_review_enforce).toBeUndefined();
    expect(gov.test_gate_strikes).toBeUndefined();
    expect(gov.dispatch).toBeUndefined();
    expect(gov.guards).toBeDefined();
  });

  it('pipeline tab no longer renders the plan_review mode selector (moved to template editor)', async () => {
    // Stage configuration (including plan_review.mode) was stripped
    // from the Project Settings Pipeline tab in the W-062 Phase 6
    // option-B cleanup — those keys are template-driven and edited
    // on the Templates page. The governance.plan_review_enforce
    // selector below covers the cross-template part that stayed.
    const mod = await import('./settings.js');
    const worca = {
      stages: {
        plan_review: {
          agent: 'plan_reviewer',
          enabled: true,
          mode: 'review_and_edit',
        },
      },
      milestones: {},
      parallel: {},
      guide: {},
      fleet: {},
    };
    const output = renderToString(mod.pipelineTab(worca, () => {}));
    expect(output).not.toContain('id="stage-plan_review-mode"');
  });

  it('Project-Settings governance tab no longer renders the plan_review_enforce selector', async () => {
    // The selector moved to the template editor's Governance tab —
    // each template owns its own enforcement posture now.
    const mod = await import('./settings.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ worca: {} }),
    });
    await mod.loadSettings('test');

    const worca = {
      governance: {
        guards: {},
      },
    };
    const output = renderToString(
      mod.governanceTab(worca, { allow: [] }, () => {}),
    );
    expect(output).not.toContain('id="governance-plan-review-enforce"');
    expect(output).not.toContain('id="test-gate-strikes"');
  });
});
