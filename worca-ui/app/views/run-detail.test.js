import { describe, expect, it } from 'vitest';
import { runBeadsSectionView } from './run-detail.js';

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

describe('runBeadsSectionView - blocked state', () => {
  it('shows warning variant badge for a blocked bead', () => {
    const beads = [
      {
        id: 'worca-cc-abc',
        title: 'Some task',
        status: 'open',
        priority: 2,
        blocked_by: ['worca-cc-dep1'],
        depends_on: [],
      },
    ];
    const out = renderToString(runBeadsSectionView(beads));
    expect(out).toContain('warning');
  });

  it('shows primary variant badge for an in_progress bead that is not blocked', () => {
    const beads = [
      {
        id: 'worca-cc-xyz',
        title: 'Active task',
        status: 'in_progress',
        priority: 2,
        blocked_by: [],
        depends_on: [],
      },
    ];
    const out = renderToString(runBeadsSectionView(beads));
    expect(out).toContain('primary');
  });

  it('shows explicit blocked badge when blocked_by is non-empty', () => {
    const beads = [
      {
        id: 'worca-cc-abc',
        title: 'Blocked task',
        status: 'open',
        priority: 2,
        blocked_by: ['worca-cc-dep1'],
        depends_on: [],
      },
    ];
    const out = renderToString(runBeadsSectionView(beads));
    expect(out).toContain('blocked');
  });

  it('does not show blocked badge when blocked_by is empty', () => {
    const beads = [
      {
        id: 'worca-cc-xyz',
        title: 'Normal task',
        status: 'open',
        priority: 2,
        blocked_by: [],
        depends_on: [],
      },
    ];
    const out = renderToString(runBeadsSectionView(beads));
    // Only "open" badge text, no "blocked" badge text
    const blockedCount = (out.match(/\bblocked\b/g) || []).length;
    expect(blockedCount).toBe(0);
  });
});
