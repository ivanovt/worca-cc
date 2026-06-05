/**
 * Tests: Access button routing in run-detail.js (W-068-P2c).
 * TDD: written to drive implementation.
 */

import { describe, expect, it, vi } from 'vitest';
import { runDetailView } from './run-detail.js';

function renderToString(template) {
  if (!template) return '';
  if (template.overview)
    return renderToString(template.overview) + renderToString(template.stages);
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

const BASE_RUN = {
  id: 'run-1',
  status: 'completed',
  active: false,
  stages: {},
  prompt: 'Test prompt',
};

const BASE_SETTINGS = {};

describe('run-detail Access button', () => {
  it('renders Access button when onOpenAccess is provided', () => {
    const onOpenAccess = vi.fn();
    const result = runDetailView(BASE_RUN, BASE_SETTINGS, { onOpenAccess });
    const html = renderToString(result);
    expect(html).toContain('Access');
    expect(html).toContain('action-btn--primary');
  });

  it('does not render Access button when onOpenAccess is not provided', () => {
    const result = runDetailView(BASE_RUN, BASE_SETTINGS, {});
    const html = renderToString(result);
    // The timing bar actions div should not contain 'Access' label
    // (Timeline may or may not be present, but no Access without callback)
    expect(html).not.toContain('>Access<');
  });

  it('renders both Timeline and Access buttons when both callbacks provided', () => {
    const onOpenTimeline = vi.fn();
    const onOpenAccess = vi.fn();
    const result = runDetailView(BASE_RUN, BASE_SETTINGS, {
      onOpenTimeline,
      onOpenAccess,
    });
    const html = renderToString(result);
    expect(html).toContain('Timeline');
    expect(html).toContain('Access');
  });

  it('Access button appears before Timeline button in DOM order', () => {
    const onOpenTimeline = vi.fn();
    const onOpenAccess = vi.fn();
    const result = runDetailView(BASE_RUN, BASE_SETTINGS, {
      onOpenTimeline,
      onOpenAccess,
    });
    const html = renderToString(result);
    const timelineIdx = html.indexOf('Timeline');
    const accessIdx = html.indexOf('Access');
    expect(accessIdx).toBeGreaterThan(-1);
    expect(timelineIdx).toBeGreaterThan(accessIdx);
  });
});
