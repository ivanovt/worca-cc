// @vitest-environment jsdom

import { render } from 'lit-html';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetZoomStateForTests, runTimelineView } from './run-timeline.js';

// jsdom container helper
function renderToString(templateResult) {
  const el = document.createElement('div');
  render(templateResult, el);
  return el;
}

const T0 = '2024-01-01T00:00:00.000Z';
const T = (ms) => new Date(new Date(T0).getTime() + ms).toISOString();

function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    status: 'completed',
    updated_at: T0,
    stages: {
      implement: {
        iterations: [
          {
            number: 1,
            started_at: T(0),
            completed_at: T(60000),
            status: 'completed',
            cost_usd: 0.1,
            model: 'sonnet',
            agent: 'implementer',
          },
          {
            number: 2,
            started_at: T(90000),
            completed_at: T(180000),
            status: 'completed',
            cost_usd: 0.2,
            model: 'sonnet',
            agent: 'implementer',
          },
        ],
      },
      test: {
        iterations: [
          {
            number: 1,
            started_at: T(60000),
            completed_at: T(90000),
            status: 'completed',
            cost_usd: 0.05,
            model: 'sonnet',
            agent: 'tester',
          },
        ],
      },
    },
    ...overrides,
  };
}

describe('runTimelineView', () => {
  it('renders an SVG element', () => {
    const el = renderToString(runTimelineView(makeRun(), {}, {}));
    const svg = el.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('renders one row per non-skipped stage', () => {
    const el = renderToString(runTimelineView(makeRun(), {}, {}));
    const rows = el.querySelectorAll('.timeline-row');
    expect(rows.length).toBe(2);
  });

  it('renders bars with status fill rects', () => {
    const el = renderToString(runTimelineView(makeRun(), {}, {}));
    const bars = el.querySelectorAll('.timeline-bar');
    expect(bars.length).toBeGreaterThanOrEqual(2);
  });

  it('renders duration badge text when bar is wide enough', () => {
    // With 180s total and swimlaneWidth=800, implement iter 1 (60s = 1/3 * 800 = ~267px) should show label
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const labels = el.querySelectorAll('.bar-label');
    expect(labels.length).toBeGreaterThanOrEqual(1);
  });

  it('formats duration as "1m" for 60000ms', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const labels = Array.from(el.querySelectorAll('.bar-label'));
    const texts = labels.map((l) => l.textContent.trim());
    expect(texts.some((t) => t === '1m')).toBe(true);
  });

  it('renders row labels with stage name', () => {
    const el = renderToString(runTimelineView(makeRun(), {}, {}));
    const labelTexts = Array.from(el.querySelectorAll('.row-label')).map(
      (t) => t.textContent,
    );
    expect(labelTexts.some((t) => t.includes('Implement'))).toBe(true);
  });

  it('renders row label with iteration badge when count > 1', () => {
    const el = renderToString(runTimelineView(makeRun(), {}, {}));
    const labelTexts = Array.from(el.querySelectorAll('.row-label')).map(
      (t) => t.textContent,
    );
    expect(labelTexts.some((t) => t.includes('×2') || t.includes('↻'))).toBe(
      true,
    );
  });

  it('renders empty-state when run has no stages', () => {
    const run = makeRun({ stages: null });
    const el = renderToString(runTimelineView(run, {}, {}));
    expect(el.querySelector('.empty-state')).not.toBeNull();
  });

  it('renders gap hatch rects', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const gaps = el.querySelectorAll('.timeline-gap');
    expect(gaps.length).toBeGreaterThanOrEqual(1);
  });

  it('memoizes layout — returns same SVG when updated_at unchanged', () => {
    const run = makeRun();
    const el1 = renderToString(
      runTimelineView(run, {}, { swimlaneWidth: 800 }),
    );
    const el2 = renderToString(
      runTimelineView(run, {}, { swimlaneWidth: 800 }),
    );
    const bars1 = el1.querySelectorAll('.timeline-bar').length;
    const bars2 = el2.querySelectorAll('.timeline-bar').length;
    expect(bars1).toBe(bars2);
  });

  it('renders loopback path when test retry precedes implement retry', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const loopbacks = el.querySelectorAll('.loopback');
    // test ran between implement iter 1 and iter 2 — one loopback expected
    expect(loopbacks.length).toBeGreaterThanOrEqual(1);
  });

  it('gap rects carry data-tooltip attribute for hoverable gap bands', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const gaps = el.querySelectorAll('.timeline-gap');
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    for (const gap of gaps) {
      const tooltip =
        gap.getAttribute('data-tooltip') || gap.getAttribute('title');
      expect(tooltip).toBeTruthy();
    }
  });

  it('timeline bars have data-stage-key and data-bar-number attributes', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const bars = el.querySelectorAll('.timeline-bar');
    expect(bars.length).toBeGreaterThanOrEqual(1);
    for (const bar of bars) {
      expect(bar.getAttribute('data-stage-key')).toBeTruthy();
      expect(bar.getAttribute('data-bar-number')).toBeTruthy();
    }
  });

  it('loopback paths have from/to stage and iter data attributes', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const lbs = el.querySelectorAll('.loopback');
    expect(lbs.length).toBeGreaterThanOrEqual(1);
    for (const lb of lbs) {
      expect(lb.getAttribute('data-from-stage')).toBeTruthy();
      expect(lb.getAttribute('data-to-stage')).toBeTruthy();
    }
  });

  it('mouseover on implement bar 2 highlights matching loopback arrows', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const impl2 = container.querySelector(
      '[data-stage-key="implement"][data-bar-number="2"]',
    );
    expect(impl2).not.toBeNull();

    impl2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(
      container.querySelectorAll('.loopback.highlight').length,
    ).toBeGreaterThanOrEqual(1);

    impl2.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(container.querySelectorAll('.loopback.highlight').length).toBe(0);

    document.body.removeChild(container);
  });
});

describe('runTimelineView Phase 3: toolbar and zoom state', () => {
  beforeEach(() => {
    _resetZoomStateForTests();
  });

  it('renders .timeline-toolbar with zoom-in, zoom-out, and reset buttons', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const toolbar = el.querySelector('.timeline-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
    expect(toolbar.querySelector('[aria-label="Reset zoom"]')).not.toBeNull();
  });

  // Bars are now redrawn (with new pixel widths) on every zoom change instead of
  // being visually scaled by an SVG transform — so zoom assertions check bar
  // widths rather than a `scale(N, 1)` transform attribute.
  function bar1Width(container) {
    const bar = container.querySelector(
      '.timeline-bar[data-stage-key="implement"][data-bar-number="1"]',
    );
    return bar ? parseFloat(bar.getAttribute('width')) : null;
  }

  it('swimlane-content <g> exists with translate-only transform at scale=1', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const swimG = el.querySelector('.swimlane-content');
    expect(swimG).not.toBeNull();
    expect(swimG.getAttribute('transform')).not.toContain('scale');
    expect(swimG.getAttribute('transform')).toContain('translate(168');
  });

  it('zoom-in button roughly doubles bar widths', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const before = bar1Width(container);
    container.querySelector('[aria-label="Zoom in"]').click();
    const after = bar1Width(container);
    expect(after / before).toBeCloseTo(2, 1);

    document.body.removeChild(container);
  });

  it('zoom-out at scale=1 stays clamped at scale=1', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const before = bar1Width(container);
    container.querySelector('[aria-label="Zoom out"]').click();
    const after = bar1Width(container);
    expect(after).toBe(before);

    document.body.removeChild(container);
  });

  it('zoom-in twice then reset restores fit-to-run bar widths', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const initial = bar1Width(container);
    container.querySelector('[aria-label="Zoom in"]').click();
    container.querySelector('[aria-label="Zoom in"]').click();
    container.querySelector('[aria-label="Reset zoom"]').click();
    const after = bar1Width(container);
    expect(after).toBe(initial);

    document.body.removeChild(container);
  });

  it('zoom-in caps at scale=32 (bar width grows ~32x from fit-to-run)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const initial = bar1Width(container);
    const btn = container.querySelector('[aria-label="Zoom in"]');
    btn.click();
    btn.click();
    btn.click();
    btn.click();
    btn.click();
    btn.click();
    const after = bar1Width(container);
    // 6 doublings would be 64×, but clamped to 32×.
    expect(after / initial).toBeCloseTo(32, 0);

    document.body.removeChild(container);
  });
});

describe('runTimelineView Phase 3: adaptive axis', () => {
  beforeEach(() => {
    _resetZoomStateForTests();
  });

  it('axis <g class="axis"> renders tick lines at scale=1', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const axisG = el.querySelector('.axis');
    expect(axisG).not.toBeNull();
    expect(axisG.querySelectorAll('line').length).toBeGreaterThan(0);
  });

  it('axis tick interval gets finer as scale increases', () => {
    // With pixel-density-based tick selection, total tick count stays roughly
    // similar across zoom levels — what changes is the *interval*. Verify the
    // tick-interval shrinks (in ms) as scale grows, which is what prevents
    // label overlap regardless of zoom.
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    function tickIntervalMs() {
      const axisG = container.querySelector('.axis');
      const labels = Array.from(axisG.querySelectorAll('text.axis-label'));
      if (labels.length < 2) return Infinity;
      // Labels are formatted m:ss or h:mm:ss — parse to seconds.
      const toSec = (t) => {
        const parts = t.split(':').map(Number);
        return parts.length === 2
          ? parts[0] * 60 + parts[1]
          : parts[0] * 3600 + parts[1] * 60 + parts[2];
      };
      const secs = labels.map((l) => toSec(l.textContent.trim()));
      return (secs[1] - secs[0]) * 1000;
    }

    const intervalAt1 = tickIntervalMs();
    const zoomIn = container.querySelector('[aria-label="Zoom in"]');
    zoomIn.click();
    zoomIn.click();
    zoomIn.click();
    zoomIn.click();
    const intervalAt16 = tickIntervalMs();
    expect(intervalAt16).toBeLessThan(intervalAt1);

    document.body.removeChild(container);
  });
});

describe('runTimelineView Phase 3: wheel zoom', () => {
  beforeEach(() => {
    _resetZoomStateForTests();
  });

  function bar1Width(container) {
    const bar = container.querySelector(
      '.timeline-bar[data-stage-key="implement"][data-bar-number="1"]',
    );
    return bar ? parseFloat(bar.getAttribute('width')) : null;
  }

  it('shift+wheel with deltaY<0 (zoom-in) roughly doubles bar widths', () => {
    // Wheel default is now horizontal-pan (matches Mac trackpad two-finger
    // swipe). Zoom requires the shift modifier.
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const before = bar1Width(container);
    const timeline = container.querySelector('.run-timeline');
    timeline.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -100,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const after = bar1Width(container);
    expect(after / before).toBeCloseTo(2, 1);

    document.body.removeChild(container);
  });

  it('shift+wheel with deltaY>0 (zoom-out) at scale=1 stays at scale=1', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const before = bar1Width(container);
    const timeline = container.querySelector('.run-timeline');
    timeline.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const after = bar1Width(container);
    expect(after).toBe(before);

    document.body.removeChild(container);
  });

  it('plain wheel (no shift) pans, does not change scale', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const before = bar1Width(container);
    const timeline = container.querySelector('.run-timeline');
    timeline.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      }),
    );
    const after = bar1Width(container);
    // No scale change → bar width is identical.
    expect(after).toBe(before);

    document.body.removeChild(container);
  });
});

describe('runTimelineView Phase 4: tooltips', () => {
  beforeEach(() => {
    _resetZoomStateForTests();
  });

  it('renders a .timeline-tooltip div', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    expect(el.querySelector('.timeline-tooltip')).not.toBeNull();
  });

  it('tooltip is initially hidden via style="display:none"', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const tooltip = el.querySelector('.timeline-tooltip');
    expect(tooltip.style.display).toBe('none');
  });

  it('bars carry tooltip data attributes (stage-label, iter-total, start-ms, dur-ms, model, status, cost)', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const bar = el.querySelector('.timeline-bar');
    expect(bar.getAttribute('data-stage-label')).toBeTruthy();
    expect(bar.getAttribute('data-iter-total')).toBeTruthy();
    expect(bar.getAttribute('data-start-ms')).not.toBeNull();
    expect(bar.getAttribute('data-dur-ms')).not.toBeNull();
    expect(bar.getAttribute('data-status')).toBeTruthy();
    expect(bar.getAttribute('data-cost')).not.toBeNull();
  });

  it('gaps carry tooltip data attributes (stage-label, dur-ms, in-stage, returned-at-ms)', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const gap = el.querySelector('.timeline-gap');
    expect(gap.getAttribute('data-stage-label')).toBeTruthy();
    expect(gap.getAttribute('data-dur-ms')).not.toBeNull();
    expect(gap.getAttribute('data-returned-at-ms')).not.toBeNull();
  });

  it('mousemove over a bar shows tooltip (not display:none)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector('.timeline-bar');
    bar.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 50 }),
    );

    const tooltip = container.querySelector('.timeline-tooltip');
    expect(tooltip.style.display).not.toBe('none');
    document.body.removeChild(container);
  });

  it('bar tooltip header contains stage label and "Iteration N of TOTAL"', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector(
      '[data-stage-key="implement"][data-bar-number="1"]',
    );
    bar.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 50 }),
    );

    const tooltip = container.querySelector('.timeline-tooltip');
    expect(tooltip.innerHTML).toContain('Implement');
    expect(tooltip.innerHTML).toContain('Iteration 1 of');
    document.body.removeChild(container);
  });

  it('bar tooltip contains Duration, Started, Ended, Model, Status, Cost rows', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector('.timeline-bar');
    bar.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 50 }),
    );

    const html = container.querySelector('.timeline-tooltip').innerHTML;
    expect(html).toContain('Duration');
    expect(html).toContain('Started');
    expect(html).toContain('Ended');
    expect(html).toContain('Status');
    expect(html).toContain('Cost');
    document.body.removeChild(container);
  });

  it('mousemove over a gap shows tooltip with "Gap on" header', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const gap = container.querySelector('.timeline-gap');
    gap.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 50 }),
    );

    const tooltip = container.querySelector('.timeline-tooltip');
    expect(tooltip.style.display).not.toBe('none');
    expect(tooltip.innerHTML).toContain('Gap on');
    document.body.removeChild(container);
  });

  it('gap tooltip contains Duration, Control, Returned at rows', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const gap = container.querySelector('.timeline-gap');
    gap.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 50 }),
    );

    const html = container.querySelector('.timeline-tooltip').innerHTML;
    expect(html).toContain('Duration');
    expect(html).toContain('Control');
    expect(html).toContain('Returned at');
    document.body.removeChild(container);
  });

  it('mousemove over non-bar non-gap element hides tooltip', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    // First show the tooltip by hovering a bar
    const bar = container.querySelector('.timeline-bar');
    bar.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 50 }),
    );
    expect(container.querySelector('.timeline-tooltip').style.display).not.toBe(
      'none',
    );

    // Then move to a non-bar element (the svg itself)
    const svg = container.querySelector('svg');
    svg.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 5 }),
    );
    expect(container.querySelector('.timeline-tooltip').style.display).toBe(
      'none',
    );
    document.body.removeChild(container);
  });

  it('mouseleave on container hides tooltip', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    // Show tooltip
    const bar = container.querySelector('.timeline-bar');
    bar.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 50 }),
    );

    // Trigger mouseleave on the container
    container
      .querySelector('.run-timeline')
      .dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    expect(container.querySelector('.timeline-tooltip').style.display).toBe(
      'none',
    );
    document.body.removeChild(container);
  });

  it('mousemove over loopback arrow does NOT show tooltip', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const loopback = container.querySelector('.loopback');
    if (loopback) {
      loopback.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          clientX: 300,
          clientY: 50,
        }),
      );
      expect(container.querySelector('.timeline-tooltip').style.display).toBe(
        'none',
      );
    }
    document.body.removeChild(container);
  });
});

describe('runTimelineView Phase 3: axis-drag zoom', () => {
  beforeEach(() => {
    _resetZoomStateForTests();
  });

  it('mousedown + mousemove on the time-axis ribbon changes scale', () => {
    // Drag-to-zoom region select was replaced by continuous axis-drag zoom:
    // horizontal drag on the axis ribbon scales the chart in place.
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    function bar1Width() {
      const bar = container.querySelector(
        '.timeline-bar[data-stage-key="implement"][data-bar-number="1"]',
      );
      return bar ? parseFloat(bar.getAttribute('width')) : null;
    }
    const before = bar1Width();

    const timeline = container.querySelector('.run-timeline');
    const svg = container.querySelector('.timeline-svg-wrap svg');
    const svgH = parseFloat(svg.getAttribute('height') || '0');

    // Mousedown in the axis ribbon (bottom AXIS_HEIGHT band of the SVG)
    timeline.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 300,
        clientY: svgH - 5,
      }),
    );
    // Drag right by 140px → scale grows by ~exp(140/200) ≈ 2.01×
    timeline.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 440,
        clientY: svgH - 5,
      }),
    );
    timeline.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0 }),
    );

    const after = bar1Width();
    expect(after / before).toBeGreaterThan(1.5);

    document.body.removeChild(container);
  });
});

describe('runTimelineView Phase 4: click-to-drill drawer', () => {
  beforeEach(() => {
    _resetZoomStateForTests();
  });

  it('renders an sl-drawer element', () => {
    const el = renderToString(runTimelineView(makeRun(), {}, {}));
    expect(el.querySelector('sl-drawer')).not.toBeNull();
  });

  it('sl-drawer is initially closed (no open attribute)', () => {
    const el = renderToString(runTimelineView(makeRun(), {}, {}));
    const drawer = el.querySelector('sl-drawer');
    expect(drawer.hasAttribute('open')).toBe(false);
  });

  it('clicking a bar opens the drawer', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector('.timeline-bar');
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const drawer = container.querySelector('sl-drawer');
    expect(drawer.hasAttribute('open')).toBe(true);

    document.body.removeChild(container);
  });

  it('drawer label contains stage label and iteration number', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector(
      '[data-stage-key="implement"][data-bar-number="1"]',
    );
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const drawer = container.querySelector('sl-drawer');
    expect(drawer.getAttribute('label')).toContain('Implement');
    expect(drawer.getAttribute('label')).toContain('Iteration 1');

    document.body.removeChild(container);
  });

  it('drawer body contains status pill, Duration, Model, Agent rows', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector(
      '[data-stage-key="implement"][data-bar-number="1"]',
    );
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const drawer = container.querySelector('sl-drawer');
    expect(drawer.innerHTML).toContain('drawer-status-pill');
    expect(drawer.innerHTML).toContain('Duration');
    expect(drawer.innerHTML).toContain('Model');
    expect(drawer.innerHTML).toContain('Agent');

    document.body.removeChild(container);
  });

  it('drawer body contains a collapsed <details> block for raw JSON', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector('.timeline-bar');
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const drawer = container.querySelector('sl-drawer');
    const details = drawer.querySelector('details');
    expect(details).not.toBeNull();
    expect(details.querySelector('summary')).not.toBeNull();

    document.body.removeChild(container);
  });

  it('raw JSON details block contains the iteration number', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector(
      '[data-stage-key="implement"][data-bar-number="1"]',
    );
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const drawer = container.querySelector('sl-drawer');
    const details = drawer.querySelector('details');
    // The raw JSON should contain the iteration's number field
    expect(details.textContent).toContain('"number"');

    document.body.removeChild(container);
  });

  it('drawer footer contains "Open in run detail" link when section and runId provided', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(
      runTimelineView(
        makeRun(),
        {},
        {
          swimlaneWidth: 800,
          section: 'active',
          runId: 'run-1',
        },
      ),
      container,
    );

    const bar = container.querySelector('.timeline-bar');
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const drawer = container.querySelector('sl-drawer');
    const footer = drawer.querySelector('[slot="footer"]');
    expect(footer).not.toBeNull();
    expect(footer.textContent).toContain('Open in run detail');
    const link = footer.querySelector('a');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toContain('active');
    expect(link.getAttribute('href')).toContain('run-1');

    document.body.removeChild(container);
  });

  it('clicking a gap does not open the drawer', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const gap = container.querySelector('.timeline-gap');
    if (gap) {
      gap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    const drawer = container.querySelector('sl-drawer');
    expect(drawer.hasAttribute('open')).toBe(false);

    document.body.removeChild(container);
  });

  it('drawer shows cost formatted as $X.XX', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector(
      '[data-stage-key="implement"][data-bar-number="1"]',
    );
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const drawer = container.querySelector('sl-drawer');
    expect(drawer.innerHTML).toContain('$0.10');

    document.body.removeChild(container);
  });
});

describe('runTimelineView Phase 5: loopback hide threshold', () => {
  beforeEach(() => {
    _resetZoomStateForTests();
  });

  it('shows loopbacks normally when iterationCount <= 30', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const lbs = el.querySelectorAll('.loopback');
    expect(lbs.length).toBeGreaterThanOrEqual(1);
  });

  it('suppresses loopback arrows when a row has iterationCount > 30', () => {
    const iterations = Array.from({ length: 31 }, (_, i) => ({
      number: i + 1,
      started_at: T(i * 2000),
      completed_at: T(i * 2000 + 1000),
      status: 'completed',
    }));
    const run = makeRun({ stages: { implement: { iterations } } });
    const el = renderToString(runTimelineView(run, {}, { swimlaneWidth: 800 }));
    const lbs = el.querySelectorAll('.loopback');
    expect(lbs.length).toBe(0);
  });

  it('renders hint text when loopbacks are suppressed', () => {
    const iterations = Array.from({ length: 31 }, (_, i) => ({
      number: i + 1,
      started_at: T(i * 2000),
      completed_at: T(i * 2000 + 1000),
      status: 'completed',
    }));
    const run = makeRun({ stages: { implement: { iterations } } });
    const el = renderToString(runTimelineView(run, {}, { swimlaneWidth: 800 }));
    expect(el.querySelector('.timeline-svg-wrap svg').innerHTML).toContain(
      'loopbacks hidden',
    );
  });
});

describe('runTimelineView Phase 5: accessibility', () => {
  it('timeline bars have role="button" attribute', () => {
    // Bars are interactive (Enter/Space opens the drawer). They are announced
    // as buttons, not images, per the WAI-ARIA Button pattern.
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const bars = el.querySelectorAll('.timeline-bar');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.getAttribute('role')).toBe('button');
    }
  });

  it('Space key on a focused bar also opens the drawer', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector(
      '[data-stage-key="implement"][data-bar-number="1"]',
    );
    bar.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
    );

    const drawer = container.querySelector('sl-drawer');
    expect(drawer.hasAttribute('open')).toBe(true);

    document.body.removeChild(container);
  });

  it('timeline gaps are focusable and carry an aria-label', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const gaps = el.querySelectorAll('.timeline-gap');
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap.getAttribute('tabindex')).toBe('0');
      expect(gap.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('timeline bars have aria-label attribute', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const bars = el.querySelectorAll('.timeline-bar');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('timeline bars have tabindex="0" for keyboard navigation', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const bars = el.querySelectorAll('.timeline-bar');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.getAttribute('tabindex')).toBe('0');
    }
  });

  it('Enter key on a focused bar opens the drawer', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }), container);

    const bar = container.querySelector(
      '[data-stage-key="implement"][data-bar-number="1"]',
    );
    bar.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );

    const drawer = container.querySelector('sl-drawer');
    expect(drawer.hasAttribute('open')).toBe(true);

    document.body.removeChild(container);
  });

  it('loopback arrows have aria-hidden="true"', () => {
    const el = renderToString(
      runTimelineView(makeRun(), {}, { swimlaneWidth: 800 }),
    );
    const lbs = el.querySelectorAll('.loopback');
    expect(lbs.length).toBeGreaterThan(0);
    for (const lb of lbs) {
      expect(lb.getAttribute('aria-hidden')).toBe('true');
    }
  });
});

describe('runTimelineView Phase 5: live update for active runs', () => {
  it('active run uses now() as runEnd so totalMs exceeds updated_at gap', () => {
    // T0 = 2024-01-01; updated_at is 60s after start; now() in test env is years later
    const activeRun = {
      id: 'run-1',
      status: 'in_progress',
      updated_at: T(60000),
      stages: {
        implement: {
          iterations: [
            {
              number: 1,
              started_at: T(0),
              status: 'in_progress',
            },
          ],
        },
      },
    };
    const el = renderToString(
      runTimelineView(activeRun, {}, { swimlaneWidth: 800 }),
    );
    const svg = el.querySelector('.timeline-svg-wrap svg');
    expect(svg).not.toBeNull();
    const totalMs = parseFloat(svg.getAttribute('data-total-ms') || '0');
    // Without now(): totalMs = 60000 (updated_at gap). With now(): totalMs >> 60000
    expect(totalMs).toBeGreaterThan(60000);
  });

  it('active run layout recomputes on new run object (WS update adds a bar)', () => {
    const run1 = makeRun({
      status: 'completed',
      stages: {
        implement: {
          iterations: [
            {
              number: 1,
              started_at: T(0),
              completed_at: T(60000),
              status: 'completed',
            },
          ],
        },
      },
    });
    const run2 = {
      ...run1,
      stages: {
        implement: {
          iterations: [
            {
              number: 1,
              started_at: T(0),
              completed_at: T(60000),
              status: 'completed',
            },
            {
              number: 2,
              started_at: T(70000),
              completed_at: T(130000),
              status: 'completed',
            },
          ],
        },
      },
    };
    const el1 = renderToString(
      runTimelineView(run1, {}, { swimlaneWidth: 800 }),
    );
    const el2 = renderToString(
      runTimelineView(run2, {}, { swimlaneWidth: 800 }),
    );
    const bars1 = el1.querySelectorAll('.timeline-bar').length;
    const bars2 = el2.querySelectorAll('.timeline-bar').length;
    expect(bars2).toBeGreaterThan(bars1);
  });
});
