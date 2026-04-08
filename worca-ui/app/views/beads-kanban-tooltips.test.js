import { describe, expect, it } from 'vitest';
import { beadsPanelView } from './beads-panel.js';

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

const baseOptions = {
  statusFilter: 'all',
  priorityFilter: 'all',
  starting: null,
  startError: null,
  onStatusFilter: () => {},
  onPriorityFilter: () => {},
  onStartIssue: () => {},
  onDismissError: () => {},
};

describe('beadsKanbanView - sl-tooltip wrapping', () => {
  const issue = {
    id: 'worca-cc-abc1',
    title: 'My Full Issue Title',
    body: 'This is the body text for the issue, describing what needs to be done in detail.',
    status: 'open',
    priority: 2,
    depends_on: [],
    blocked_by: [],
  };

  it('wraps each kanban card in sl-tooltip with bead-tooltip class', () => {
    const out = renderToString(beadsPanelView([issue], baseOptions));
    expect(out).toContain('<sl-tooltip');
    expect(out).toContain('bead-tooltip');
    // sl-tooltip should appear before the card element
    expect(out.indexOf('<sl-tooltip')).toBeLessThan(
      out.indexOf('beads-kanban-card'),
    );
  });

  it('tooltip content slot contains full title and body excerpt', () => {
    const out = renderToString(beadsPanelView([issue], baseOptions));
    expect(out).toContain('slot="content"');
    expect(out).toContain('My Full Issue Title');
    expect(out).toContain('This is the body text for the issue');
  });

  it('tooltip content slot shows status and priority badges', () => {
    const out = renderToString(beadsPanelView([issue], baseOptions));
    // bead-tooltip-header with badges rendered inside tooltip
    expect(out).toContain('bead-tooltip-header');
    expect(out).toContain('P2');
    expect(out).toContain('open');
  });

  it('dep chips in blocked cards are plain spans (no nested tooltip — card tooltip covers deps)', () => {
    const depIssue = {
      id: 'worca-cc-dep1',
      title: 'Dep One Title',
      status: 'open',
      priority: 3,
      depends_on: [],
      blocked_by: [],
    };
    const blockedIssue = {
      id: 'worca-cc-abc2',
      title: 'Blocked Issue',
      status: 'open',
      priority: 2,
      depends_on: ['worca-cc-dep1'],
      blocked_by: ['worca-cc-dep1'],
    };
    const out = renderToString(
      beadsPanelView([blockedIssue, depIssue], baseOptions),
    );
    // Dep chip rendered as plain span, not wrapped in its own sl-tooltip
    expect(out).toContain('beads-dep-chip');
    // The card-level sl-tooltip (hoist) covers all dep info — no inner tooltip around each chip
    // Verify that the dep chip span does not appear inside a second sl-tooltip tag
    const depChipIdx = out.indexOf('beads-dep-chip');
    const cardTooltipIdx = out.indexOf('<sl-tooltip');
    // Only one sl-tooltip wraps the whole card (the card-level one)
    const secondTooltipIdx = out.indexOf('<sl-tooltip', cardTooltipIdx + 1);
    // Any second sl-tooltip (if present) must come AFTER the dep chip
    if (secondTooltipIdx !== -1) {
      expect(secondTooltipIdx).toBeGreaterThan(depChipIdx);
    }
  });
});
