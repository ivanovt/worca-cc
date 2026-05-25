// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { runBeadsSectionView } from './run-detail.js';

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

describe('runBeadsSectionView - sl-tooltip wrapping', () => {
  const issue = {
    id: 'worca-cc-abc1',
    title: 'My Full Bead Title',
    body: 'This is the body text describing what the bead is about.',
    status: 'open',
    priority: 2,
    depends_on: [],
    blocked_by: [],
  };

  it('wraps each run-bead-row in sl-tooltip with hoist', () => {
    const out = renderToString(runBeadsSectionView([issue]));
    const rowIdx = out.indexOf('run-bead-row');
    expect(rowIdx).toBeGreaterThan(-1);
    // sl-tooltip should appear before the row
    const tooltipIdx = out.lastIndexOf('<sl-tooltip', rowIdx);
    expect(tooltipIdx).toBeGreaterThanOrEqual(0);
    expect(tooltipIdx).toBeLessThan(rowIdx);
    expect(out).toContain('hoist');
  });

  it('tooltip content slot shows full title and body excerpt', () => {
    const out = renderToString(runBeadsSectionView([issue]));
    expect(out).toContain('slot="content"');
    expect(out).toContain('My Full Bead Title');
    expect(out).toContain('This is the body text describing');
  });

  it('tooltip content omits body section when issue has no body', () => {
    const noBodyIssue = { ...issue, body: null };
    const out = renderToString(runBeadsSectionView([noBodyIssue]));
    expect(out).toContain('My Full Bead Title');
    expect(out).not.toContain('bead-tooltip-excerpt');
  });
});
