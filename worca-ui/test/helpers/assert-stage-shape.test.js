import { describe, expect, it } from 'vitest';
import { assertStageShape } from './assert-stage-shape.js';

describe('assertStageShape', () => {
  it('passes for a valid status with no stage fields', () => {
    expect(() => assertStageShape({})).not.toThrow();
  });

  it('passes for a valid status.stage', () => {
    expect(() => assertStageShape({ stage: 'pr' })).not.toThrow();
    expect(() => assertStageShape({ stage: 'implement' })).not.toThrow();
    expect(() => assertStageShape({ stage: 'preflight' })).not.toThrow();
  });

  it('passes for a valid status.stages map', () => {
    expect(() =>
      assertStageShape({ stages: { plan: {}, pr: {}, implement: {} } }),
    ).not.toThrow();
  });

  it('passes for a full valid status object', () => {
    expect(() =>
      assertStageShape({
        stage: 'implement',
        stages: { plan: {}, coordinate: {}, implement: {} },
      }),
    ).not.toThrow();
  });

  it("throws for status.stage 'guardian' with 'pr' hint", () => {
    expect(() => assertStageShape({ stage: 'guardian' })).toThrow(
      "'guardian' is not a stage key; you probably meant 'pr'",
    );
  });

  it("throws for status.stage 'planner' with 'plan' hint", () => {
    expect(() => assertStageShape({ stage: 'planner' })).toThrow(
      "'planner' is not a stage key; you probably meant 'plan'",
    );
  });

  it("throws for status.stage 'tester' with 'test' hint", () => {
    expect(() => assertStageShape({ stage: 'tester' })).toThrow(
      "'tester' is not a stage key; you probably meant 'test'",
    );
  });

  it('throws for status.stage with unknown value and no hint', () => {
    expect(() => assertStageShape({ stage: 'bogus' })).toThrow(
      "'bogus' is not a stage key",
    );
  });

  it("throws for 'guardian' key in status.stages with 'pr' hint", () => {
    expect(() => assertStageShape({ stages: { guardian: {} } })).toThrow(
      "'guardian' is not a stage key; you probably meant 'pr'",
    );
  });

  it("throws for 'planner' key in status.stages with 'plan' hint", () => {
    expect(() => assertStageShape({ stages: { planner: {} } })).toThrow(
      "'planner' is not a stage key; you probably meant 'plan'",
    );
  });

  it('throws for unknown key in status.stages with no hint', () => {
    expect(() => assertStageShape({ stages: { mystery: {} } })).toThrow(
      "'mystery' is not a stage key",
    );
  });

  it('throws for first bad key when stages has multiple invalid keys', () => {
    expect(() =>
      assertStageShape({ stages: { guardian: {}, planner: {} } }),
    ).toThrow("is not a stage key");
  });

  it('ignores null stage field', () => {
    expect(() => assertStageShape({ stage: null })).not.toThrow();
  });

  it('ignores undefined stage field', () => {
    expect(() => assertStageShape({ stage: undefined })).not.toThrow();
  });

  it('ignores null stages field', () => {
    expect(() => assertStageShape({ stages: null })).not.toThrow();
  });

  it('ignores undefined stages field', () => {
    expect(() => assertStageShape({ stages: undefined })).not.toThrow();
  });
});
