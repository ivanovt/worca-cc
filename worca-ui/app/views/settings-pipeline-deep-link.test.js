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

describe('Settings → Pipeline tab — post option-B cleanup', () => {
  // The template-driven Pipeline-tab content (stages config, loops,
  // circuit_breaker) moved to the Templates page. The deep-link
  // card at the top of the tab also went away — its message was
  // misleading once the content it was pointing to was no longer
  // adjacent. These tests lock in the new contract.
  function render() {
    const worca = {
      stages: {},
      milestones: {},
      parallel: {},
      guide: {},
      fleet: {},
    };
    return renderToString(pipelineTab(worca, () => {}));
  }

  it('does not render the template-driven deep-link card anymore', () => {
    const htmlString = render();
    expect(htmlString).not.toContain('pipelines-deep-link-card');
    expect(htmlString).not.toContain('href="#/templates"');
  });

  it('does not render the legacy TEMPLATE_DRIVEN_BANNER', () => {
    const htmlString = render();
    expect(htmlString).not.toContain('template-driven-banner');
  });

  it('renders Preflight as the first section', () => {
    const htmlString = render();
    expect(htmlString).toMatch(/Preflight/);
  });
});
