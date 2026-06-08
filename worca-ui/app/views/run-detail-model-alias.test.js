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

describe('stage-level Model Alias / Model ID rendering', () => {
  it('renders a single "Model ID:" label when no alias is recorded (backward-compatible)', () => {
    const html = renderToString(runDetailView(makeRun({ stageModel: 'opus' })));
    const modelIdCount = (
      html.match(/<span class="meta-label">Model ID:<\/span>/g) || []
    ).length;
    const aliasCount = (
      html.match(/<span class="meta-label">Model Alias:<\/span>/g) || []
    ).length;
    expect(modelIdCount).toBe(1);
    expect(aliasCount).toBe(0);
    expect(html).toContain('>opus<');
  });

  it('renders Model Alias: <alias> + Model ID: <id> when alias differs from the resolved id', () => {
    const html = renderToString(
      runDetailView(makeRun({ stageModel: 'opus', stageModelAlias: 'glm-ds' })),
    );
    expect(html).toContain('<span class="meta-label">Model Alias:</span>');
    expect(html).toContain('<span class="meta-label">Model ID:</span>');
    expect(html).toContain('>glm-ds<');
    expect(html).toContain('>opus<');
    const aliasIdx = html.indexOf('>glm-ds<');
    const idIdx = html.indexOf('>opus<');
    expect(aliasIdx).toBeLessThan(idIdx);
  });

  it('renders Model Alias: + Model ID: for built-in shorthand aliases', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ stageModel: 'claude-opus-4-6', stageModelAlias: 'opus' }),
      ),
    );
    expect(html).toContain('<span class="meta-label">Model Alias:</span>');
    expect(html).toContain('<span class="meta-label">Model ID:</span>');
    expect(html).toContain('>opus<');
    expect(html).toContain('>claude-opus-4-6<');
  });

  it('collapses to a single "Model ID:" label when alias equals the resolved id', () => {
    const html = renderToString(
      runDetailView(makeRun({ stageModel: 'opus', stageModelAlias: 'opus' })),
    );
    const aliasCount = (
      html.match(/<span class="meta-label">Model Alias:<\/span>/g) || []
    ).length;
    expect(aliasCount).toBe(0);
    expect(html).toContain('<span class="meta-label">Model ID:</span>');
  });

  it('does not render any model row when no model is recorded', () => {
    const html = renderToString(runDetailView(makeRun({})));
    expect(html).not.toContain('<span class="meta-label">Model ID:</span>');
    expect(html).not.toContain('<span class="meta-label">Model Alias:</span>');
  });
});

describe('iteration-level Model Alias / Model ID rendering (multi-iteration tab panel)', () => {
  function makeMultiIterRun(iters) {
    return {
      stages: {
        plan: { status: 'completed', agent: 'planner', iterations: iters },
      },
    };
  }

  it('renders Model Alias: <alias> + Model ID: <id> on a per-iteration row when alias is set', () => {
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
    expect(html).toContain('<span class="meta-label">Model ID:</span>');
    expect(html).toContain('>glm-ds<');
    expect(html).toContain('<span class="meta-label">Model Alias:</span>');
    const modelIdCount = (
      html.match(/<span class="meta-label">Model ID:<\/span>/g) || []
    ).length;
    expect(modelIdCount).toBeGreaterThanOrEqual(2);
  });
});
