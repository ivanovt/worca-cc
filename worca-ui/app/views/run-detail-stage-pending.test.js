// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { _stageTimingRow } from './run-detail.js';

// Walk the lit-html template tree to a string (mirrors run-detail.test.js).
function renderToString(template) {
  if (!template) return '';
  if (typeof template === 'string') return template;
  if (template._$litDirective$ && template.values)
    return template.values[0] || '';
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
      else if (v?._$litDirective$ && v?.values) result += v.values[0] || '';
    }
  });
  return result;
}

describe('_stageTimingRow — expanded stage timing line', () => {
  it('shows a "not started" placeholder for a pending stage (no started_at)', () => {
    const out = renderToString(_stageTimingRow({ status: 'pending' }));
    expect(out).toContain("This stage hasn't started yet");
    expect(out).toContain('timing-strip--pending');
    // Keeps the .timing-strip class so the panel divider line stays intact.
    expect(out).toContain('timing-strip');
  });

  it('shows the real Started/Finished strip once the stage has run', () => {
    const out = renderToString(
      _stageTimingRow({
        status: 'completed',
        started_at: '2026-05-23T10:00:00Z',
        completed_at: '2026-05-23T10:05:00Z',
      }),
    );
    expect(out).toContain('Started:');
    expect(out).toContain('Finished:');
    expect(out).not.toContain("This stage hasn't started yet");
  });

  it('shows Started (no Finished) for a running stage', () => {
    const out = renderToString(
      _stageTimingRow({
        status: 'running',
        started_at: '2026-05-23T10:00:00Z',
      }),
    );
    expect(out).toContain('Started:');
    expect(out).not.toContain("This stage hasn't started yet");
  });
});
