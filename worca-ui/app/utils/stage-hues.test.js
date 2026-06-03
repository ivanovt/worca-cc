import { describe, expect, it } from 'vitest';
import { applyStageCSSVars, STAGE_HUES } from './stage-hues.js';
import { STAGE_ORDER } from './stage-order.js';

describe('STAGE_HUES', () => {
  it('has an entry for every Stage enum value from stages.py', () => {
    for (const stage of STAGE_ORDER) {
      expect(STAGE_HUES).toHaveProperty(stage);
    }
  });

  it('has exactly the same keys as STAGE_ORDER', () => {
    expect(Object.keys(STAGE_HUES).sort()).toEqual([...STAGE_ORDER].sort());
  });

  it('preflight is #64748b', () =>
    expect(STAGE_HUES.preflight).toBe('#64748b'));
  it('plan is #4f46e5', () => expect(STAGE_HUES.plan).toBe('#4f46e5'));
  it('plan_review is #7c3aed', () =>
    expect(STAGE_HUES.plan_review).toBe('#7c3aed'));
  it('coordinate is #0d9488', () =>
    expect(STAGE_HUES.coordinate).toBe('#0d9488'));
  it('implement is #9333ea', () =>
    expect(STAGE_HUES.implement).toBe('#9333ea'));
  it('test is #d97706', () => expect(STAGE_HUES.test).toBe('#d97706'));
  it('review is #059669', () => expect(STAGE_HUES.review).toBe('#059669'));
  it('pr is #0891b2', () => expect(STAGE_HUES.pr).toBe('#0891b2'));
  it('learn is #e11d48', () => expect(STAGE_HUES.learn).toBe('#e11d48'));
});

describe('applyStageCSSVars', () => {
  it('returns a string containing all --stage-hue-<key> declarations', () => {
    const css = applyStageCSSVars();
    for (const key of STAGE_ORDER) {
      expect(css).toContain(`--stage-hue-${key}:`);
    }
  });

  it('includes the :root selector', () => {
    expect(applyStageCSSVars()).toContain(':root');
  });
});
