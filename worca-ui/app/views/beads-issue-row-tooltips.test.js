import { describe, expect, it } from 'vitest';
import { beadsIssueRow } from './beads-panel.js';

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

describe('_beadsIssueRow - dep chip sl-tooltip wrapping', () => {
  const depIssue = {
    id: 'worca-cc-dep1',
    title: 'Dependency Full Title',
    status: 'open',
    priority: 3,
    depends_on: [],
    blocked_by: [],
  };
  const issue = {
    id: 'worca-cc-abc1',
    title: 'Main Issue',
    body: '',
    status: 'open',
    priority: 2,
    depends_on: ['worca-cc-dep1'],
    blocked_by: [],
  };
  const issuesById = new Map([['worca-cc-dep1', depIssue]]);
  const options = {
    starting: null,
    onStartIssue: () => {},
    issuesById,
  };

  it('wraps each dep chip in sl-tooltip', () => {
    const out = renderToString(beadsIssueRow(issue, options));
    const depChipIdx = out.indexOf('beads-dep-chip');
    expect(depChipIdx).toBeGreaterThan(-1);
    const slTooltipIdx = out.lastIndexOf('<sl-tooltip', depChipIdx);
    expect(slTooltipIdx).toBeGreaterThanOrEqual(0);
    expect(slTooltipIdx).toBeLessThan(depChipIdx);
  });

  it('tooltip content shows dependency full title and status', () => {
    const out = renderToString(beadsIssueRow(issue, options));
    expect(out).toContain('bead-chip-tooltip');
    expect(out).toContain('Dependency Full Title');
    expect(out).toContain('open');
  });
});
