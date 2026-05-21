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

function makeRun(effortOverride) {
  return {
    stages: {
      implement: {
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

describe('effort tooltip content', () => {
  it('shows "template value" tooltip for explicit source', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: 'high', source: 'explicit', base: 'high' }),
      ),
    );
    expect(html).toMatch(/title="template value"/);
  });

  it('shows "Claude Code default for this model" for model_default source', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ level: null, source: 'model_default', base: null }),
      ),
    );
    expect(html).toMatch(/title="Claude Code default for this model"/);
  });

  it('shows "coordinator label: <level>" for adaptive:llm source', () => {
    const html = renderToString(
      runDetailView(
        makeRun({
          level: 'high',
          source: 'adaptive:llm',
          base: 'high',
          bead_classified: { level: 'high', applied: true, skip_reason: null },
        }),
      ),
    );
    expect(html).toMatch(/title="coordinator label: high"/);
  });

  it('shows not-applied tooltip for reactive mode with bead', () => {
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
    expect(html).toMatch(
      /coordinator labeled medium; not applied under reactive/,
    );
  });

  it('shows not-applied tooltip for disabled mode with bead', () => {
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
    expect(html).toMatch(
      /coordinator labeled medium; not applied under disabled/,
    );
  });

  it('appends capped-from info to tooltip', () => {
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
    expect(html).toContain('capped from max');
  });

  it('appends escalation info to tooltip', () => {
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
    expect(html).toContain('escalated from high');
  });
});
