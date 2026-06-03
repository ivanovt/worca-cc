import { describe, expect, it } from 'vitest';
import { computeTimelineLayout } from './timeline-layout.js';

// Helper: build a minimal iteration entry
function iter(startedAt, completedAt, opts = {}) {
  return {
    started_at: startedAt,
    completed_at: completedAt,
    status: opts.status ?? 'completed',
    cost_usd: opts.cost ?? 0,
    model: opts.model ?? 'sonnet',
    agent: opts.agent ?? 'implementer',
    number: opts.number ?? 1,
    bead_id: opts.bead_id,
    bead_title: opts.bead_title,
    duration_ms:
      opts.duration_ms ??
      (completedAt ? new Date(completedAt) - new Date(startedAt) : null),
  };
}

// Base timestamp helpers (all relative to T0 = '2024-01-01T00:00:00.000Z')
const T0 = '2024-01-01T00:00:00.000Z';
const T = (offsetMs) =>
  new Date(new Date(T0).getTime() + offsetMs).toISOString();

describe('computeTimelineLayout', () => {
  describe('runStart from earliest iteration', () => {
    it('picks the earliest started_at across all rows', () => {
      const stages = {
        plan: { iterations: [iter(T(5000), T(15000))] },
        implement: { iterations: [iter(T(1000), T(10000))] },
      };
      const layout = computeTimelineLayout(stages, T(20000));
      expect(layout.runStart).toBe(T(1000));
    });

    it('uses the single iteration start when only one row exists', () => {
      const stages = {
        implement: { iterations: [iter(T(3000), T(8000))] },
      };
      const layout = computeTimelineLayout(stages, T(10000));
      expect(layout.runStart).toBe(T(3000));
    });
  });

  describe('runEnd for active runs', () => {
    it('uses provided runEndTime when passed', () => {
      const stages = {
        implement: { iterations: [iter(T(0), T(5000))] },
      };
      const endTime = T(9000);
      const layout = computeTimelineLayout(stages, endTime);
      expect(layout.runEnd).toBe(endTime);
    });

    it('runEnd from runEndTime is later than all completed_at', () => {
      const stages = {
        implement: { iterations: [iter(T(0), T(5000))] },
      };
      const endTime = T(10000);
      const layout = computeTimelineLayout(stages, endTime);
      expect(new Date(layout.runEnd).getTime()).toBe(
        new Date(endTime).getTime(),
      );
    });
  });

  describe('totalMs', () => {
    it('equals runEnd minus runStart in milliseconds', () => {
      const stages = {
        implement: { iterations: [iter(T(1000), T(6000))] },
      };
      const layout = computeTimelineLayout(stages, T(11000));
      expect(layout.totalMs).toBe(10000);
    });
  });

  describe('rows', () => {
    it('includes a row for each non-skipped stage', () => {
      const stages = {
        plan: { iterations: [iter(T(0), T(5000))] },
        implement: { iterations: [iter(T(6000), T(10000))] },
      };
      const layout = computeTimelineLayout(stages, T(10000));
      const keys = layout.rows.map((r) => r.stageKey);
      expect(keys).toContain('plan');
      expect(keys).toContain('implement');
    });

    it('orders rows by STAGE_ORDER', () => {
      const stages = {
        implement: { iterations: [iter(T(6000), T(10000))] },
        plan: { iterations: [iter(T(0), T(5000))] },
      };
      const layout = computeTimelineLayout(stages, T(10000));
      const keys = layout.rows.map((r) => r.stageKey);
      expect(keys.indexOf('plan')).toBeLessThan(keys.indexOf('implement'));
    });

    it('includes stageLabel as Title Case of the stage key', () => {
      const stages = {
        implement: { iterations: [iter(T(0), T(5000))] },
        plan_review: { iterations: [iter(T(0), T(5000))] },
      };
      const layout = computeTimelineLayout(stages, T(5000));
      expect(
        layout.rows.find((r) => r.stageKey === 'implement').stageLabel,
      ).toBe('Implement');
      expect(
        layout.rows.find((r) => r.stageKey === 'plan_review').stageLabel,
      ).toBe('Plan Review');
    });

    it('maps iterations to bars with startMs relative to runStart', () => {
      // plan starts at T(0), establishing runStart = T(0)
      // implement starts at T(2000) → startMs = 2000 (offset from runStart)
      const stages = {
        plan: { iterations: [iter(T(0), T(1500))] },
        implement: { iterations: [iter(T(2000), T(7000))] },
      };
      const layout = computeTimelineLayout(stages, T(10000));
      const row = layout.rows.find((r) => r.stageKey === 'implement');
      expect(row.bars).toHaveLength(1);
      expect(row.bars[0].startMs).toBe(2000);
      expect(row.bars[0].durMs).toBe(5000);
    });

    it('bar carries status, cost, model, agent', () => {
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(5000), {
              status: 'completed',
              cost: 1.23,
              model: 'opus',
              agent: 'implementer',
            }),
          ],
        },
      };
      const layout = computeTimelineLayout(stages, T(5000));
      const bar = layout.rows[0].bars[0];
      expect(bar.status).toBe('completed');
      expect(bar.cost).toBe(1.23);
      expect(bar.model).toBe('opus');
      expect(bar.agent).toBe('implementer');
    });

    it('bar carries beadId and beadTitle when set on the iteration', () => {
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(5000), {
              bead_id: 'bd-abc123',
              bead_title: 'Add user auth',
            }),
          ],
        },
      };
      const layout = computeTimelineLayout(stages, T(5000));
      const bar = layout.rows[0].bars[0];
      expect(bar.beadId).toBe('bd-abc123');
      expect(bar.beadTitle).toBe('Add user auth');
    });

    it('bar beadId and beadTitle are null when absent on the iteration', () => {
      const stages = {
        implement: { iterations: [iter(T(0), T(5000))] },
      };
      const layout = computeTimelineLayout(stages, T(5000));
      const bar = layout.rows[0].bars[0];
      expect(bar.beadId).toBeNull();
      expect(bar.beadTitle).toBeNull();
    });

    it('iterationCount equals the number of bars', () => {
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(5000), { number: 1 }),
            iter(T(6000), T(10000), { number: 2 }),
          ],
        },
      };
      const layout = computeTimelineLayout(stages, T(10000));
      const row = layout.rows.find((r) => r.stageKey === 'implement');
      expect(row.iterationCount).toBe(2);
      expect(row.bars).toHaveLength(2);
    });
  });

  describe('skipped row hiding', () => {
    it('excludes rows where all iterations are skipped', () => {
      const stages = {
        plan_review: {
          iterations: [iter(T(0), T(1000), { status: 'skipped' })],
        },
        implement: { iterations: [iter(T(1000), T(5000))] },
      };
      const layout = computeTimelineLayout(stages, T(5000));
      const keys = layout.rows.map((r) => r.stageKey);
      expect(keys).not.toContain('plan_review');
      expect(keys).toContain('implement');
    });

    it('excludes stages with no iterations', () => {
      const stages = {
        plan_review: { iterations: [] },
        implement: { iterations: [iter(T(0), T(5000))] },
      };
      const layout = computeTimelineLayout(stages, T(5000));
      const keys = layout.rows.map((r) => r.stageKey);
      expect(keys).not.toContain('plan_review');
    });

    it('includes a row where at least one iteration is not skipped', () => {
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(3000), { status: 'skipped' }),
            iter(T(4000), T(8000), { status: 'completed' }),
          ],
        },
      };
      const layout = computeTimelineLayout(stages, T(8000));
      const keys = layout.rows.map((r) => r.stageKey);
      expect(keys).toContain('implement');
    });
  });

  describe('gap derivation', () => {
    it('produces a gap between consecutive iterations on the same row', () => {
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(3000), { number: 1 }),
            iter(T(5000), T(9000), { number: 2 }),
          ],
        },
      };
      const layout = computeTimelineLayout(stages, T(9000));
      const row = layout.rows.find((r) => r.stageKey === 'implement');
      expect(row.gaps).toHaveLength(1);
      expect(row.gaps[0].afterIter).toBe(1);
      expect(row.gaps[0].startMs).toBe(3000);
      expect(row.gaps[0].durMs).toBe(2000);
    });

    it('gap inStage by overlap — attributes to stage overlapping the gap window', () => {
      // implement iter1: T(0)–T(3000)
      // test iter1:      T(3000)–T(5000)  ← overlaps the gap [3000, 5000]
      // implement iter2: T(5000)–T(9000)
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(3000), { number: 1 }),
            iter(T(5000), T(9000), { number: 2 }),
          ],
        },
        test: {
          iterations: [iter(T(3000), T(5000), { number: 1 })],
        },
      };
      const layout = computeTimelineLayout(stages, T(9000));
      const implRow = layout.rows.find((r) => r.stageKey === 'implement');
      expect(implRow.gaps[0].inStage).toBe('test');
    });

    it('gap inStage is null when no other stage overlaps', () => {
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(3000), { number: 1 }),
            iter(T(5000), T(9000), { number: 2 }),
          ],
        },
      };
      const layout = computeTimelineLayout(stages, T(9000));
      const implRow = layout.rows.find((r) => r.stageKey === 'implement');
      expect(implRow.gaps[0].inStage).toBeNull();
    });

    it('attributes gap to the overlapping stage whose iter ended closest to next iter start', () => {
      // Two stages overlap the gap; the one that ended nearer to iter2.start wins
      // implement iter1: T(0)–T(2000), iter2: T(8000)–T(12000)
      // review iter1:    T(2000)–T(5000)  → ends at T(5000), gap is [2000, 8000]
      // test iter1:      T(4000)–T(8000)  → ends at T(8000) — closer to T(8000) → wins
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(2000), { number: 1 }),
            iter(T(8000), T(12000), { number: 2 }),
          ],
        },
        review: {
          iterations: [iter(T(2000), T(5000), { number: 1 })],
        },
        test: {
          iterations: [iter(T(4000), T(8000), { number: 1 })],
        },
      };
      const layout = computeTimelineLayout(stages, T(12000));
      const implRow = layout.rows.find((r) => r.stageKey === 'implement');
      expect(implRow.gaps[0].inStage).toBe('test');
    });

    it('produces no gaps for a row with a single iteration', () => {
      const stages = {
        implement: { iterations: [iter(T(0), T(5000))] },
      };
      const layout = computeTimelineLayout(stages, T(5000));
      const row = layout.rows.find((r) => r.stageKey === 'implement');
      expect(row.gaps).toHaveLength(0);
    });
  });

  describe('loopback building', () => {
    it('builds loopbacks from gap.inStage', () => {
      // implement iter1 → gap inStage=test → implement iter2
      // loopback: { fromStage: 'test', fromIter: 1, toStage: 'implement', toIter: 2 }
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(3000), { number: 1 }),
            iter(T(5000), T(9000), { number: 2 }),
          ],
        },
        test: {
          iterations: [iter(T(3000), T(5000), { number: 1 })],
        },
      };
      const layout = computeTimelineLayout(stages, T(9000));
      expect(layout.loopbacks).toHaveLength(1);
      const lb = layout.loopbacks[0];
      expect(lb.fromStage).toBe('test');
      expect(lb.toStage).toBe('implement');
      expect(lb.toIter).toBe(2);
    });

    it('produces no loopbacks when there are no gaps with inStage', () => {
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(3000), { number: 1 }),
            iter(T(3000), T(6000), { number: 2 }),
          ],
        },
      };
      const layout = computeTimelineLayout(stages, T(6000));
      expect(layout.loopbacks).toHaveLength(0);
    });

    it('builds one loopback per gap that has inStage', () => {
      // implement: 3 iters, test overlaps each gap
      const stages = {
        implement: {
          iterations: [
            iter(T(0), T(3000), { number: 1 }),
            iter(T(5000), T(8000), { number: 2 }),
            iter(T(10000), T(13000), { number: 3 }),
          ],
        },
        test: {
          iterations: [
            iter(T(3000), T(5000), { number: 1 }),
            iter(T(8000), T(10000), { number: 2 }),
          ],
        },
      };
      const layout = computeTimelineLayout(stages, T(13000));
      expect(layout.loopbacks).toHaveLength(2);
    });
  });

  describe('empty / edge cases', () => {
    it('returns empty rows and loopbacks for empty stages', () => {
      const layout = computeTimelineLayout({}, new Date().toISOString());
      expect(layout.rows).toHaveLength(0);
      expect(layout.loopbacks).toHaveLength(0);
    });

    it('handles stages object being null/undefined gracefully', () => {
      const layout = computeTimelineLayout(null, new Date().toISOString());
      expect(layout.rows).toHaveLength(0);
    });
  });
});
