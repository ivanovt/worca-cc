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

  it('readGovernanceFromDom reads plan_review_enforce', async () => {
    const mod = await import('./settings.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ worca: {} }),
    });
    await mod.loadSettings('test');

    const elements = {
      'governance-plan-review-enforce': { value: 'review_and_edit' },
    };
    globalThis.document.getElementById = (id) => elements[id] || null;
    const gov = mod.readGovernanceFromDom();
    expect(gov.plan_review_enforce).toBe('review_and_edit');
  });

  it('readGovernanceFromDom defaults plan_review_enforce to auto', async () => {
    const mod = await import('./settings.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ worca: {} }),
    });
    await mod.loadSettings('test');

    globalThis.document.getElementById = () => null;
    const gov = mod.readGovernanceFromDom();
    expect(gov.plan_review_enforce).toBe('auto');
  });

  it('pipeline tab renders mode selector for plan_review stage', async () => {
    const mod = await import('./settings.js');
    const worca = {
      stages: {
        plan: { agent: 'planner', enabled: true },
        plan_review: { agent: 'plan_reviewer', enabled: true },
        coordinate: { agent: 'coordinator', enabled: true },
        implement: { agent: 'implementer', enabled: true },
        test: { agent: 'tester', enabled: true },
        review: { agent: 'reviewer', enabled: true },
        pr: { agent: 'guardian', enabled: true },
        learn: { agent: 'learner', enabled: false },
      },
      loops: {},
      milestones: {},
      circuit_breaker: {},
      parallel: {},
      guide: {},
      fleet: {},
    };
    const output = renderToString(mod.pipelineTab(worca, () => {}));
    expect(output).toContain('id="stage-plan_review-mode"');
    expect(output).toContain('review_and_edit');
  });

  it('governance tab renders plan_review_enforce selector', async () => {
    const mod = await import('./settings.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ worca: {} }),
    });
    await mod.loadSettings('test');

    const worca = {
      governance: {
        guards: {},
        test_gate_strikes: 2,
        dispatch: { tools: {}, skills: {}, subagents: {} },
      },
    };
    const output = renderToString(
      mod.governanceTab(worca, { allow: [] }, () => {}),
    );
    expect(output).toContain('id="governance-plan-review-enforce"');
    expect(output).toContain('independent verification');
  });
});
