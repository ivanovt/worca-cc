import { describe, expect, it } from 'vitest';
import { STAGE_ORDER, STAGE_VALUES } from './stage-order.js';

describe('STAGE_VALUES', () => {
  it('is a Set', () => {
    expect(STAGE_VALUES).toBeInstanceOf(Set);
  });

  it('contains all entries from STAGE_ORDER', () => {
    for (const stage of STAGE_ORDER) {
      expect(STAGE_VALUES.has(stage)).toBe(true);
    }
  });

  it('has the same size as STAGE_ORDER', () => {
    expect(STAGE_VALUES.size).toBe(STAGE_ORDER.length);
  });

  it('provides O(1) membership check — known stage returns true', () => {
    expect(STAGE_VALUES.has('pr')).toBe(true);
  });

  it('returns false for agent names that are not stage keys', () => {
    expect(STAGE_VALUES.has('guardian')).toBe(false);
  });
});
