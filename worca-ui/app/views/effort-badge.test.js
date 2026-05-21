import { describe, expect, it } from 'vitest';
import { runDetailView } from './run-detail.js';

function renderToString(template) {
  if (!template) return '';
  if (template.overview)
    return renderToString(template.overview) + renderToString(template.stages);
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

function makeRun(effortOverride, stageKey = 'implement') {
  return {
    stages: {
      [stageKey]: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            outcome: 'success',
            effort: effortOverride,
          },
        ],
      },
    },
  };
}

describe('effort level badge variant mapping', () => {
  it('renders low effort with neutral variant', () => {
    const html = renderToString(
      runDetailView(makeRun({ level: 'low', source: 'explicit', base: 'low' })),
    );
    expect(html).toContain('Effort:');
    expect(html).toContain('low');
  });

  it('renders medium effort with neutral variant', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'medium', source: 'explicit', base: 'medium' }),
      ),
    );
    expect(html).toContain('effort-level-badge');
    expect(html).toMatch(/variant="neutral"[^>]*>medium/s);
  });

  it('renders high effort with primary variant', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'high', source: 'adaptive:llm', base: 'high' }),
      ),
    );
    expect(html).toContain('effort-level-badge');
    expect(html).toMatch(/variant="primary"[^>]*>high/s);
  });

  it('renders xhigh effort with warning variant', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'xhigh', source: 'explicit', base: 'xhigh' }),
      ),
    );
    expect(html).toContain('effort-level-badge');
    expect(html).toMatch(/variant="warning"[^>]*>xhigh/s);
  });

  it('renders max effort with danger variant', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'max', source: 'reactive', base: 'high' }),
      ),
    );
    expect(html).toContain('effort-level-badge');
    expect(html).toMatch(/variant="danger"[^>]*>max/s);
  });

  it('renders model default as neutral dash badge', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: null, source: 'model_default', base: null }),
      ),
    );
    expect(html).toContain('Effort:');
    expect(html).toContain('effort-level-badge');
    expect(html).toMatch(/variant="neutral"[^>]*>-/s);
  });
});

describe('effort source qualifier chip', () => {
  it('renders explicit source as neutral chip', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'high', source: 'explicit', base: 'high' }),
      ),
    );
    expect(html).toContain('effort-source-chip');
    expect(html).toContain('explicit');
  });

  it('renders adaptive:llm source as adaptive chip', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'high', source: 'adaptive:llm', base: 'high' }),
      ),
    );
    expect(html).toContain('effort-source-chip');
    expect(html).toContain('adaptive');
  });

  it('renders reactive source chip', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'high', source: 'reactive', base: 'high' }),
      ),
    );
    expect(html).toContain('effort-source-chip');
    expect(html).toContain('reactive');
  });

  it('renders model_default source as "model default" chip', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: null, source: 'model_default', base: null }),
      ),
    );
    expect(html).toContain('effort-source-chip');
    expect(html).toContain('model default');
  });

  it('renders escalation trigger as source chip', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          level: 'max',
          source: 'reactive',
          base: 'high',
          escalations: ['test_failure'],
        }),
      ),
    );
    expect(html).toContain('effort-source-chip');
    expect(html).toContain('+test_failure');
  });

  it('renders capped chip when capped_from is set', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          level: 'high',
          source: 'reactive',
          base: 'medium',
          capped_from: 'max',
        }),
      ),
    );
    expect(html).toContain('effort-source-chip');
    expect(html).toContain('capped');
  });
});

describe('effort bead classified row', () => {
  it('renders bead row when bead_classified exists and applied is false', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          level: 'high',
          source: 'explicit',
          base: 'high',
          bead_classified: {
            level: 'medium',
            applied: false,
            skip_reason: 'explicit_override',
          },
        }),
      ),
    );
    expect(html).toContain('Bead:');
    expect(html).toContain('effort-bead-level');
    expect(html).toContain('medium');
    expect(html).toContain('overridden');
  });

  it('renders ignored divergence chip for mode_reactive skip_reason', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          level: 'high',
          source: 'reactive',
          base: 'high',
          bead_classified: {
            level: 'medium',
            applied: false,
            skip_reason: 'mode_reactive',
          },
        }),
      ),
    );
    expect(html).toContain('Bead:');
    expect(html).toContain('ignored');
    expect(html).toMatch(/variant="warning"/);
  });

  it('renders ignored divergence chip for mode_disabled skip_reason', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          level: 'high',
          source: 'disabled',
          base: 'high',
          bead_classified: {
            level: 'medium',
            applied: false,
            skip_reason: 'mode_disabled',
          },
        }),
      ),
    );
    expect(html).toContain('Bead:');
    expect(html).toContain('ignored');
  });

  it('does not render bead row when bead_classified is absent', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'high', source: 'explicit', base: 'high' }),
      ),
    );
    expect(html).not.toContain('effort-bead-level');
  });

  it('does not render bead row when applied is true and levels match', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          level: 'high',
          source: 'adaptive:llm',
          base: 'high',
          bead_classified: {
            level: 'high',
            applied: true,
            skip_reason: null,
          },
        }),
      ),
    );
    // When applied=true and level matches, no divergence to show
    expect(html).not.toContain('overridden');
    expect(html).not.toContain('ignored');
  });

  it('does not render bead row when bead_classified level is null', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          level: 'high',
          source: 'explicit',
          base: 'high',
          bead_classified: {
            level: null,
            applied: false,
            skip_reason: 'explicit_override',
          },
        }),
      ),
    );
    expect(html).not.toContain('effort-bead-level');
  });
});

describe('effort row absent when no effort data', () => {
  it('does not render effort row when iteration has no effort field', () => {
    const run = {
      stages: {
        implement: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed', outcome: 'success' }],
        },
      },
    };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('effort-level-badge');
    expect(html).not.toContain('effort-source-chip');
  });
});

describe('run-header effort chip', () => {
  it('renders effort mode and cap chip in overview', () => {
    const settings = {
      effort: { auto_mode: 'adaptive', auto_cap: 'xhigh' },
    };
    const run = {
      id: 'r1',
      stages: {
        implement: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
      },
    };
    const result = runDetailView(run, settings);
    const html = renderToString(result.overview);
    expect(html).toContain('effort-header-chip');
    expect(html).toContain('adaptive');
    expect(html).toContain('cap xhigh');
  });

  it('renders disabled mode in header chip', () => {
    const settings = {
      effort: { auto_mode: 'disabled', auto_cap: 'high' },
    };
    const run = {
      id: 'r1',
      stages: {
        implement: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
      },
    };
    const result = runDetailView(run, settings);
    const html = renderToString(result.overview);
    expect(html).toContain('effort-header-chip');
    expect(html).toContain('disabled');
    expect(html).toContain('cap high');
  });

  it('does not render header chip when effort settings are absent', () => {
    const run = {
      id: 'r1',
      stages: {
        implement: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
      },
    };
    const result = runDetailView(run, {});
    const html = renderToString(result.overview);
    expect(html).not.toContain('effort-header-chip');
  });
});
