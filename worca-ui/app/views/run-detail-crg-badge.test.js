import { describe, expect, it } from 'vitest';
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

function makeRun({ crgEnabled, invocations, withEffort = true } = {}) {
  const iter = {
    number: 1,
    status: 'completed',
    outcome: 'success',
  };
  if (withEffort) iter.effort = { level: 'high', source: 'explicit' };
  if (invocations !== undefined) iter.crg_invocations = invocations;
  const run = {
    stages: { plan: { status: 'completed', iterations: [iter] } },
  };
  if (crgEnabled !== undefined) run.crg_enabled = crgEnabled;
  return run;
}

describe('runDetailView CRG invocation badge', () => {
  it('shows an integer count badge when enabled and the agent used CRG tools', () => {
    const html = renderToString(
      runDetailView(makeRun({ crgEnabled: true, invocations: 5 })),
    );
    expect(html).toContain('CRG:');
    expect(html).toContain('crg-invocations-badge');
    expect(html).toContain('5');
    expect(html).toContain('variant="primary"');
    expect(html).not.toContain('(disabled)');
  });

  it('shows a grey 0 badge when enabled but the agent never used CRG tools', () => {
    const html = renderToString(
      runDetailView(makeRun({ crgEnabled: true, invocations: 0 })),
    );
    expect(html).toContain('CRG:');
    expect(html).toContain('crg-invocations-badge');
    expect(html).toContain('variant="neutral"');
    expect(html).not.toContain('(disabled)');
  });

  it('shows a plain "(disabled)" value (no badge) when CRG is off', () => {
    const html = renderToString(
      runDetailView(makeRun({ crgEnabled: false, invocations: 0 })),
    );
    expect(html).toContain('CRG:');
    expect(html).toContain('(disabled)');
    expect(html).not.toContain('crg-invocations-badge');
  });

  it('treats a missing crg_enabled flag as disabled', () => {
    const html = renderToString(runDetailView(makeRun({ invocations: 0 })));
    expect(html).toContain('CRG:');
    expect(html).toContain('(disabled)');
  });

  it('omits the CRG badge entirely on iterations without the field (pre-feature / non-agent)', () => {
    const html = renderToString(runDetailView(makeRun({ crgEnabled: true })));
    expect(html).not.toContain('CRG:');
  });

  it('still shows the badge when effort is absent (own row)', () => {
    const html = renderToString(
      runDetailView(
        makeRun({ crgEnabled: true, invocations: 2, withEffort: false }),
      ),
    );
    expect(html).toContain('CRG:');
    expect(html).toContain('2');
  });

  it('renders the badge in a multi-iteration stage (tabbed path)', () => {
    const run = {
      stages: {
        implement: {
          status: 'completed',
          iterations: [
            {
              number: 1,
              status: 'completed',
              outcome: 'error',
              effort: { level: 'high', source: 'explicit' },
              crg_invocations: 1,
            },
            {
              number: 2,
              status: 'completed',
              outcome: 'success',
              effort: { level: 'max', source: 'reactive' },
              crg_invocations: 7,
            },
          ],
        },
      },
      crg_enabled: true,
    };
    const html = renderToString(runDetailView(run));
    expect(html).toContain('CRG:');
    expect(html).toContain('crg-invocations-badge');
  });
});
