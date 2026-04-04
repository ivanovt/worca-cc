import { describe, expect, it } from 'vitest';

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
