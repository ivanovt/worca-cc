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

describe('runDetailView classification row', () => {
  const classification = {
    category: 'infra_transient',
    retriable: true,
    similar_to_previous: false,
  };

  function makeRunSingleIter(classificationOverride = classification) {
    return {
      stages: {
        implement: {
          status: 'error',
          iterations: [
            {
              number: 1,
              status: 'error',
              outcome: 'error',
              classification: classificationOverride,
            },
          ],
        },
      },
    };
  }

  it('renders Fail Category label and category value', () => {
    const run = makeRunSingleIter();
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Fail Category:');
    expect(html).toContain('infra_transient');
  });

  it('does not render classification when iter has no classification', () => {
    const run = {
      stages: {
        implement: {
          status: 'error',
          iterations: [{ number: 1, status: 'error', outcome: 'error' }],
        },
      },
    };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('Fail Category:');
  });

  it('renders Severity as retriable when retriable is true', () => {
    const run = makeRunSingleIter({
      category: 'infra_transient',
      retriable: true,
      similar_to_previous: false,
    });
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Severity:');
    expect(html).toContain('retriable');
  });

  it('renders Severity as non-retriable when retriable is false', () => {
    const run = makeRunSingleIter({
      category: 'infra_permanent',
      retriable: false,
      similar_to_previous: false,
    });
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Severity:');
    expect(html).toContain('non-retriable');
  });

  it('shows Similar flag when similar_to_previous is true', () => {
    const run = makeRunSingleIter({
      category: 'logic_stuck',
      retriable: false,
      similar_to_previous: true,
    });
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Similar:');
    expect(html).toContain('yes');
  });

  it('omits Similar flag when similar_to_previous is false', () => {
    const run = makeRunSingleIter({
      category: 'infra_transient',
      retriable: true,
      similar_to_previous: false,
    });
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('Similar:');
  });

  it('renders all category values correctly', () => {
    for (const cat of [
      'infra_transient',
      'infra_permanent',
      'logic_stuck',
      'env_missing',
      'unknown',
    ]) {
      const run = makeRunSingleIter({
        category: cat,
        retriable: false,
        similar_to_previous: false,
      });
      const html = renderToString(runDetailView(run));
      expect(html).toContain('Fail Category:');
      expect(html).toContain(cat);
    }
  });

  it('renders classification in multi-iteration stage', () => {
    const run = {
      stages: {
        implement: {
          status: 'error',
          iterations: [
            { number: 1, status: 'completed', outcome: 'success' },
            { number: 2, status: 'error', outcome: 'error', classification },
          ],
        },
      },
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('Fail Category:');
    expect(html).toContain('infra_transient');
  });

  it('does not render classification for iteration without it in multi-iter', () => {
    const run = {
      stages: {
        implement: {
          status: 'error',
          iterations: [
            { number: 1, status: 'completed', outcome: 'success' },
            { number: 2, status: 'error', outcome: 'error' },
          ],
        },
      },
    };
    const html = renderToString(runDetailView(run));
    expect(html).not.toContain('Fail Category:');
  });
});
