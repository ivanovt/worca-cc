import { describe, expect, it } from 'vitest';
import { pipelineCardView } from './multi-dashboard.js';

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

describe('pipelineCardView - actionAllowed gating', () => {
  it('shows pause and stop buttons when running', () => {
    const pipeline = {
      run_id: 'r1',
      status: 'running',
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(
      pipelineCardView(pipeline, {
        onPause: () => {},
        onStop: () => {},
      }),
    );
    expect(output).toContain('Pause');
    expect(output).toContain('Stop');
  });

  it('shows resume and cancel buttons when paused', () => {
    const pipeline = {
      run_id: 'r1',
      status: 'paused',
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(
      pipelineCardView(pipeline, {
        onResume: () => {},
        onCancel: () => {},
      }),
    );
    expect(output).toContain('Resume');
    expect(output).toContain('Cancel');
  });

  it('does not show stop button when paused', () => {
    const pipeline = {
      run_id: 'r1',
      status: 'paused',
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(
      pipelineCardView(pipeline, {
        onStop: () => {},
        onResume: () => {},
      }),
    );
    expect(output).not.toContain('Stop');
  });

  it('does not show any action buttons when completed', () => {
    const pipeline = {
      run_id: 'r1',
      status: 'completed',
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(
      pipelineCardView(pipeline, {
        onPause: () => {},
        onStop: () => {},
        onResume: () => {},
        onCancel: () => {},
      }),
    );
    expect(output).not.toContain('Pause');
    expect(output).not.toContain('Stop');
    expect(output).not.toContain('Resume');
    expect(output).not.toContain('Cancel');
  });

  it('shows cancel button when failed', () => {
    const pipeline = {
      run_id: 'r1',
      status: 'failed',
      started_at: '2026-01-01T00:00:00Z',
    };
    const output = renderToString(
      pipelineCardView(pipeline, {
        onCancel: () => {},
      }),
    );
    expect(output).toContain('Cancel');
  });
});
