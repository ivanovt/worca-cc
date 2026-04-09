import { describe, expect, it } from 'vitest';
import { hasActivePipeline, newRunView, resetNewRunState } from './new-run.js';

function renderToString(template) {
  if (!template) return '';
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

describe('hasActivePipeline', () => {
  it('returns false when no runs', () => {
    expect(hasActivePipeline({})).toBe(false);
    expect(hasActivePipeline({ runs: {} })).toBe(false);
    expect(hasActivePipeline(null)).toBe(false);
  });

  it('returns false when all runs are inactive', () => {
    const state = {
      runs: {
        'run-1': { active: false, pipeline_status: 'completed' },
        'run-2': { active: false, pipeline_status: 'failed' },
      },
    };
    expect(hasActivePipeline(state)).toBe(false);
  });

  it('returns true when a run is active', () => {
    const state = {
      runs: {
        'run-1': { active: true, pipeline_status: 'running' },
        'run-2': { active: false, pipeline_status: 'completed' },
      },
    };
    expect(hasActivePipeline(state)).toBe(true);
  });
});

describe('newRunView parallel block', () => {
  const rerender = () => {};

  it('renders info banner when a pipeline is running', () => {
    resetNewRunState();
    const state = {
      runs: { 'run-1': { active: true, pipeline_status: 'running' } },
    };
    const out = renderToString(newRunView(state, { rerender }));
    expect(out).toContain('new-run-info');
    expect(out).toContain('Pipeline already running');
    expect(out).toContain('new-run-form-disabled');
  });

  it('does not render info banner when no pipeline is running', () => {
    resetNewRunState();
    const state = {
      runs: { 'run-1': { active: false, pipeline_status: 'completed' } },
    };
    const out = renderToString(newRunView(state, { rerender }));
    expect(out).not.toContain('new-run-info');
    expect(out).not.toContain('Pipeline already running');
    expect(out).not.toContain('new-run-form-disabled');
  });
});
