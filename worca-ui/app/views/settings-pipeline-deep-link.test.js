// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { pipelineTab } from './settings.js';

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

beforeEach(() => {
  // Setup DOM for sl-button rendering (Shoelace component registration)
  if (typeof customElements.get('sl-button') === 'undefined') {
    // Mock sl-button registration
    customElements.define(
      'sl-button',
      class extends HTMLElement {
        connectedCallback() {
          this.innerHTML = this.getAttribute('label') || 'Button';
        }
      },
    );
  }
});

describe('Settings → Pipeline tab deep-link card', () => {
  describe('pipelineTab — Template-driven sub-panel', () => {
    it('renders link card pointing to #pipelines', () => {
      const worca = {
        stages: {},
        loops: {},
        milestones: {},
        circuit_breaker: {},
        parallel: {},
        guide: {},
        fleet: {},
      };
      const rerender = () => {};

      const template = pipelineTab(worca, rerender);
      const htmlString = renderToString(template);

      // Should contain deep-link card pointing at the renamed route.
      expect(htmlString).toContain('href="#/templates"');
      expect(htmlString).toContain('pipelines-deep-link-card');

      // Link text was updated alongside the rename.
      expect(htmlString).toMatch(/edit/i);
      expect(htmlString).toMatch(/templates/i);
    });

    it('does not render TEMPLATE_DRIVEN_BANNER', () => {
      const worca = {
        stages: {},
        loops: {},
        milestones: {},
        circuit_breaker: {},
        parallel: {},
        guide: {},
        fleet: {},
      };
      const rerender = () => {};

      const template = pipelineTab(worca, rerender);
      const htmlString = renderToString(template);

      // TEMPLATE_DRIVEN_BANNER should NOT be present in the main pipeline tab
      // It should be replaced by the deep-link card
      expect(htmlString).not.toContain('template-driven-banner');
    });

    it('renders Preflight section after deep-link card', () => {
      const worca = {
        stages: {},
        loops: {},
        milestones: {},
        circuit_breaker: {},
        parallel: {},
        guide: {},
        fleet: {},
      };
      const rerender = () => {};

      const template = pipelineTab(worca, rerender);
      const htmlString = renderToString(template);

      // Deep-link card should appear before Preflight
      const deepLinkIndex = htmlString.indexOf('pipelines-deep-link-card');
      const preflightIndex = htmlString.indexOf('Preflight');

      expect(deepLinkIndex).toBeGreaterThanOrEqual(0);
      expect(preflightIndex).toBeGreaterThanOrEqual(0);
      expect(deepLinkIndex).toBeLessThan(preflightIndex);
    });
  });
});
