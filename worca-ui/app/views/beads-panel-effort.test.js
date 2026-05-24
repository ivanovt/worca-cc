import { nothing } from 'lit-html';
import { describe, expect, it } from 'vitest';
import { effortLevelVariant } from '../utils/effort-badge.js';
import {
  beadEffortBadgeView,
  beadIterationMiniTable,
  beadNotesView,
  effortSourceLabel,
  extractEffortLabel,
} from './beads-panel.js';

function renderToString(template) {
  if (!template || template === nothing) return '';
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

describe('extractEffortLabel', () => {
  it('extracts effort level from labels array', () => {
    expect(extractEffortLabel(['area:cc', 'worca-effort:high', 'P2'])).toBe(
      'high',
    );
  });

  it('returns first effort label when multiple exist', () => {
    expect(extractEffortLabel(['worca-effort:low', 'worca-effort:high'])).toBe(
      'low',
    );
  });

  it('returns null when no effort label', () => {
    expect(extractEffortLabel(['area:cc', 'P2'])).toBeNull();
  });

  it('returns null for empty labels', () => {
    expect(extractEffortLabel([])).toBeNull();
  });

  it('returns null for undefined labels', () => {
    expect(extractEffortLabel(undefined)).toBeNull();
  });
});

describe('effortLevelVariant — §7.1 color scale', () => {
  it('maps low to neutral', () => {
    expect(effortLevelVariant('low')).toBe('neutral');
  });

  it('maps medium to neutral', () => {
    expect(effortLevelVariant('medium')).toBe('neutral');
  });

  it('maps high to primary', () => {
    expect(effortLevelVariant('high')).toBe('primary');
  });

  it('maps xhigh to warning', () => {
    expect(effortLevelVariant('xhigh')).toBe('warning');
  });

  it('maps max to danger', () => {
    expect(effortLevelVariant('max')).toBe('danger');
  });

  it('defaults to neutral for unknown levels', () => {
    expect(effortLevelVariant('unknown')).toBe('neutral');
  });
});

describe('effortSourceLabel', () => {
  it('maps adaptive:llm to adaptive', () => {
    expect(effortSourceLabel('adaptive:llm')).toBe('adaptive');
  });

  it('maps model_default to model default', () => {
    expect(effortSourceLabel('model_default')).toBe('model default');
  });

  it('passes through explicit', () => {
    expect(effortSourceLabel('explicit')).toBe('explicit');
  });

  it('passes through reactive', () => {
    expect(effortSourceLabel('reactive')).toBe('reactive');
  });

  it('returns empty string for falsy source', () => {
    expect(effortSourceLabel(undefined)).toBe('');
  });
});

describe('beadEffortBadgeView — effort label badge', () => {
  it('renders badge with effort level from labels', () => {
    const issue = { labels: ['worca-effort:high'] };
    const html = renderToString(beadEffortBadgeView(issue, 'adaptive'));
    expect(html).toContain('bead-effort-badge');
    expect(html).toContain('high');
  });

  it('renders Zap icon via shared effortLevelBadge', () => {
    const issue = { labels: ['worca-effort:high'] };
    const html = renderToString(beadEffortBadgeView(issue, 'adaptive'));
    expect(html).toContain('effort-zap-icon');
  });

  it('renders low with neutral variant', () => {
    const issue = { labels: ['worca-effort:low'] };
    const html = renderToString(beadEffortBadgeView(issue, 'adaptive'));
    expect(html).toContain('variant="neutral"');
    expect(html).toContain('low</sl-badge>');
  });

  it('renders high with primary variant', () => {
    const issue = { labels: ['worca-effort:high'] };
    const html = renderToString(beadEffortBadgeView(issue, 'adaptive'));
    expect(html).toContain('variant="primary"');
    expect(html).toContain('high</sl-badge>');
  });

  it('renders xhigh with warning variant', () => {
    const issue = { labels: ['worca-effort:xhigh'] };
    const html = renderToString(beadEffortBadgeView(issue, 'adaptive'));
    expect(html).toContain('variant="warning"');
    expect(html).toContain('xhigh</sl-badge>');
  });

  it('renders max with danger variant', () => {
    const issue = { labels: ['worca-effort:max'] };
    const html = renderToString(beadEffortBadgeView(issue, 'adaptive'));
    expect(html).toContain('variant="danger"');
    expect(html).toContain('max</sl-badge>');
  });

  it('renders "ignored: reactive" chip when auto_mode is reactive', () => {
    const issue = { labels: ['worca-effort:high'] };
    const html = renderToString(beadEffortBadgeView(issue, 'reactive'));
    expect(html).toContain('ignored: reactive');
    expect(html).toContain('bead-effort-ignored');
  });

  it('renders "ignored: disabled" chip when auto_mode is disabled', () => {
    const issue = { labels: ['worca-effort:high'] };
    const html = renderToString(beadEffortBadgeView(issue, 'disabled'));
    expect(html).toContain('ignored: disabled');
    expect(html).toContain('bead-effort-ignored');
  });

  it('does not render ignored chip when auto_mode is adaptive', () => {
    const issue = { labels: ['worca-effort:high'] };
    const html = renderToString(beadEffortBadgeView(issue, 'adaptive'));
    expect(html).not.toContain('ignored');
  });

  it('returns nothing when no effort label present', () => {
    const issue = { labels: ['area:cc'] };
    const result = beadEffortBadgeView(issue, 'adaptive');
    expect(result).toBe(nothing);
  });

  it('returns nothing when labels are undefined', () => {
    const issue = {};
    const result = beadEffortBadgeView(issue, 'adaptive');
    expect(result).toBe(nothing);
  });
});

describe('beadNotesView — coordinator reasoning notes', () => {
  it('renders notes content in a dedicated section', () => {
    const issue = {
      notes: 'Coordinator reasoning: straightforward CRUD, low complexity',
    };
    const html = renderToString(beadNotesView(issue));
    expect(html).toContain('bead-notes-section');
    expect(html).toContain('straightforward CRUD, low complexity');
  });

  it('renders "Notes" label', () => {
    const issue = { notes: 'Some reasoning note' };
    const html = renderToString(beadNotesView(issue));
    expect(html).toContain('Notes');
  });

  it('returns nothing when notes is empty', () => {
    expect(beadNotesView({ notes: '' })).toBe(nothing);
  });

  it('returns nothing when notes is undefined', () => {
    expect(beadNotesView({})).toBe(nothing);
  });

  it('returns nothing when issue is null', () => {
    expect(beadNotesView(null)).toBe(nothing);
  });
});

describe('beadIterationMiniTable — per-iteration effort rows', () => {
  const iterations = [
    {
      number: 1,
      effort: {
        level: 'high',
        source: 'explicit',
        base: 'high',
      },
    },
    {
      number: 2,
      effort: {
        level: 'max',
        source: 'reactive',
        base: 'high',
        escalations: ['test_failure'],
        capped_from: 'max',
      },
    },
    {
      number: 3,
      effort: {
        level: 'high',
        source: 'adaptive:llm',
        base: 'high',
      },
    },
  ];

  it('renders a row per iteration with effort data', () => {
    const html = renderToString(beadIterationMiniTable(iterations));
    expect(html).toContain('iter 1');
    expect(html).toContain('iter 2');
    expect(html).toContain('iter 3');
  });

  it('uses bead-iter-table CSS class', () => {
    const html = renderToString(beadIterationMiniTable(iterations));
    expect(html).toContain('bead-iter-table');
  });

  it('renders level badge with correct variant per §7.1', () => {
    const html = renderToString(beadIterationMiniTable(iterations));
    expect(html).toMatch(/variant="primary"[^>]*>high/s);
    expect(html).toMatch(/variant="danger"[^>]*>max/s);
  });

  it('renders source qualifier for each iteration', () => {
    const html = renderToString(beadIterationMiniTable(iterations));
    expect(html).toContain('explicit');
    expect(html).toContain('reactive');
    expect(html).toContain('adaptive');
  });

  it('renders escalation chips', () => {
    const html = renderToString(beadIterationMiniTable(iterations));
    expect(html).toContain('+test_failure');
  });

  it('renders capped chip when capped_from is set', () => {
    const html = renderToString(beadIterationMiniTable(iterations));
    expect(html).toContain('capped');
  });

  it('skips iterations without effort data', () => {
    const mixed = [
      { number: 1 },
      {
        number: 2,
        effort: { level: 'high', source: 'explicit', base: 'high' },
      },
    ];
    const html = renderToString(beadIterationMiniTable(mixed));
    expect(html).not.toContain('iter 1');
    expect(html).toContain('iter 2');
  });

  it('returns nothing when no iterations provided', () => {
    expect(beadIterationMiniTable([])).toBe(nothing);
  });

  it('returns nothing when undefined', () => {
    expect(beadIterationMiniTable(undefined)).toBe(nothing);
  });

  it('returns nothing when all iterations lack effort', () => {
    const noEffort = [{ number: 1 }, { number: 2 }];
    expect(beadIterationMiniTable(noEffort)).toBe(nothing);
  });

  it('renders model default as dash badge with neutral variant', () => {
    const iters = [
      {
        number: 1,
        effort: { level: null, source: 'model_default', base: null },
      },
    ];
    const html = renderToString(beadIterationMiniTable(iters));
    expect(html).toContain('iter 1');
    expect(html).toMatch(/variant="neutral"[^>]*>-/s);
    expect(html).toContain('model default');
  });
});
