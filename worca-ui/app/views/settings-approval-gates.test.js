import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPipelineFromDom } from './settings.js';

describe('Approval Gates section', () => {
  let origDocument;

  beforeEach(() => {
    origDocument = globalThis.document;
    globalThis.document = {
      querySelectorAll: () => [],
      getElementById: () => null,
    };
  });

  afterEach(() => {
    globalThis.document = origDocument;
  });

  describe('readPipelineFromDom — milestones', () => {
    it('emits plan_approval from DOM switch', () => {
      const elements = {
        'milestone-plan-approval': { checked: false },
        'milestone-pr-approval': { checked: false },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.milestones).toBeDefined();
      expect(result.milestones.plan_approval).toBe(false);
    });

    it('emits plan_approval true when checked', () => {
      const elements = {
        'milestone-plan-approval': { checked: true },
        'milestone-pr-approval': { checked: false },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.milestones.plan_approval).toBe(true);
    });

    it('omits pr_approval when switch is off (default-false)', () => {
      const elements = {
        'milestone-plan-approval': { checked: true },
        'milestone-pr-approval': { checked: false },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.milestones).not.toHaveProperty('pr_approval');
    });

    it('emits pr_approval true when user toggles it on', () => {
      const elements = {
        'milestone-plan-approval': { checked: true },
        'milestone-pr-approval': { checked: true },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.milestones.pr_approval).toBe(true);
    });

    it('defaults plan_approval to true when element missing', () => {
      globalThis.document.getElementById = () => null;

      const result = readPipelineFromDom();
      expect(result.milestones.plan_approval).toBe(true);
    });
  });
});
