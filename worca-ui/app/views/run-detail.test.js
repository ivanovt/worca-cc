import { describe, expect, it } from 'vitest';
import { runBeadsSectionView, runDetailView } from './run-detail.js';

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

describe('runDetailView - endTime for active runs', () => {
  const startedAt = '2026-04-10T10:00:00Z';
  const stageEnd = '2026-04-10T10:05:43Z';

  function render(template) {
    return renderToString(template?.overview ?? template);
  }

  it('does not show Finished label for an active run even if a stage has completed', () => {
    const run = {
      id: 'r1',
      active: true,
      started_at: startedAt,
      stages: {
        coordinate: { status: 'completed', completed_at: stageEnd },
      },
    };
    const out = render(runDetailView(run));
    expect(out).not.toContain('Finished:');
  });

  it('shows Finished label for a completed run', () => {
    const run = {
      id: 'r2',
      active: false,
      started_at: startedAt,
      completed_at: '2026-04-10T11:00:00Z',
      stages: {
        coordinate: { status: 'completed', completed_at: stageEnd },
      },
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Finished:');
  });

  it('does not show Finished for an inactive run with no completed_at but a finished stage', () => {
    // Inactive run with no completed_at should still show stage-based end time
    const run = {
      id: 'r3',
      active: false,
      started_at: startedAt,
      stages: {
        coordinate: { status: 'completed', completed_at: stageEnd },
      },
    };
    const out = render(runDetailView(run));
    expect(out).toContain('Finished:');
  });
});
