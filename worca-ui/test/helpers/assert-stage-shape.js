import { STAGE_VALUES } from '../../app/utils/stage-order.js';

// Inverted from STAGE_AGENT_MAP in settings.js: agent name → stage key
const AGENT_TO_STAGE = {
  planner: 'plan',
  plan_reviewer: 'plan_review',
  coordinator: 'coordinate',
  implementer: 'implement',
  tester: 'test',
  reviewer: 'review',
  guardian: 'pr',
  learner: 'learn',
};

function assertValidStageKey(value, context) {
  if (value == null) return;
  if (!STAGE_VALUES.has(value)) {
    const hint = AGENT_TO_STAGE[value];
    const suffix = hint ? `; you probably meant '${hint}'` : '';
    throw new Error(`'${value}' is not a stage key${suffix} (in ${context})`);
  }
}

/**
 * Asserts that status.stage and all keys of status.stages are valid stage keys.
 * Throws a descriptive error for agent names mistakenly used as stage keys.
 * Exported for use in test fixtures.
 */
export function assertStageShape(status) {
  assertValidStageKey(status.stage, 'status.stage');

  if (status.stages != null) {
    for (const key of Object.keys(status.stages)) {
      assertValidStageKey(key, 'status.stages');
    }
  }
}
