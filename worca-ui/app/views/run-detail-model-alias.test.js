import { describe, expect, it } from 'vitest';
import { runDetailView } from './run-detail.js';

// Minimal renderToString — captures static prefixes, nested templates, and
// array-of-templates, which is enough to assert label/value text and class
// names. Mirrors the helper used by the other run-detail tests so we stay
// consistent with how they pin behavior.
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
      else if (typeof v === 'number') result += String(v);
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

// Build a minimal run with a single iteration and customizable model fields.
// Used to pin exactly what the stage-info strip renders for the four
// model/alias combinations the runner can produce.
function makeRun({
  stageModel,
  stageModelAlias,
  iterModel,
  iterModelAlias,
} = {}) {
  const stage = {
    status: 'completed',
    agent: 'planner',
    iterations: [{ number: 1, status: 'completed' }],
  };
  if (stageModel !== undefined) stage.model = stageModel;
  if (stageModelAlias !== undefined) stage.model_alias = stageModelAlias;
  if (iterModel !== undefined) stage.iterations[0].model = iterModel;
  if (iterModelAlias !== undefined)
    stage.iterations[0].model_alias = iterModelAlias;
  return { stages: { plan: stage } };
}

describe('stage-level Model / ID rendering', () => {
  it('renders a single "Model:" label when no alias is recorded (backward-compatible)', () => {
    const html = renderToString(runDetailView(makeRun({ stageModel: 'opus' })));
    // Single Model: label, the resolved id appears next to it, no ID: label
    // is added — old runs and plain-model configs are untouched.
    const modelCount = (
      html.match(/<span class="meta-label">Model:<\/span>/g) || []
    ).length;
    const idCount = (html.match(/<span class="meta-label">ID:<\/span>/g) || [])
      .length;
    expect(modelCount).toBe(1);
    expect(idCount).toBe(0);
    expect(html).toContain('>opus<');
  });

  it('renders Model: <alias> + ID: <id> when alias differs from the resolved id', () => {
    const html = renderToString(
      runDetailView(makeRun({ stageModel: 'opus', stageModelAlias: 'glm-ds' })),
    );
    expect(html).toContain('<span class="meta-label">Model:</span>');
    expect(html).toContain('<span class="meta-label">ID:</span>');
    expect(html).toContain('>glm-ds<');
    expect(html).toContain('>opus<');
    // The alias is what's surfaced as the primary value, not the resolved id.
    const aliasIdx = html.indexOf('>glm-ds<');
    const idIdx = html.indexOf('>opus<');
    expect(aliasIdx).toBeLessThan(idIdx);
  });

  it('collapses to a single label when alias equals the resolved id (no churn)', () => {
    // Defensive: even if the runner ever writes model_alias == model, the UI
    // should NOT produce a redundant "Model: opus  ID: opus" pair.
    const html = renderToString(
      runDetailView(makeRun({ stageModel: 'opus', stageModelAlias: 'opus' })),
    );
    const idCount = (html.match(/<span class="meta-label">ID:<\/span>/g) || [])
      .length;
    expect(idCount).toBe(0);
  });

  it('does not render any Model row when no model is recorded', () => {
    const html = renderToString(runDetailView(makeRun({})));
    expect(html).not.toContain('<span class="meta-label">Model:</span>');
    expect(html).not.toContain('<span class="meta-label">ID:</span>');
  });
});

describe('iteration-level Model / ID rendering (multi-iteration tab panel)', () => {
  // The single-iteration path delegates to stageModel + stage.model_alias
  // (covered above). Multi-iteration runs render per-iteration model info
  // from iter.model + iter.model_alias — confirm the same alias/id semantics
  // apply on that path.
  function makeMultiIterRun(iters) {
    return {
      stages: {
        plan: { status: 'completed', agent: 'planner', iterations: iters },
      },
    };
  }

  it('renders Model: <alias> + ID: <id> on a per-iteration row when alias is set', () => {
    const html = renderToString(
      runDetailView(
        makeMultiIterRun([
          {
            number: 1,
            status: 'completed',
            model: 'opus',
            model_alias: 'glm-ds',
          },
          { number: 2, status: 'completed', model: 'sonnet' },
        ]),
      ),
    );
    expect(html).toContain('<span class="meta-label">ID:</span>');
    expect(html).toContain('>glm-ds<');
    // The second iter has no alias — only a single Model row for it.
    // Count is at least 2 Model rows total (one per iter).
    const modelCount = (
      html.match(/<span class="meta-label">Model:<\/span>/g) || []
    ).length;
    expect(modelCount).toBeGreaterThanOrEqual(2);
  });
});
