import { describe, expect, it } from 'vitest';
import {
  guideUploadWidget,
  headTemplateInput,
  planModeRadio,
  tokenOverheadGate,
} from './launcher-shared.js';

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

// ── guideUploadWidget ───────────────────────────────────────────────────────

describe('guideUploadWidget', () => {
  it('renders drop zone and Browse button', () => {
    const out = renderToString(guideUploadWidget({ guides: [] }));
    expect(out).toContain('guide-drop-zone');
    expect(out).toContain('Browse');
  });

  it('shows uploaded files as removable tags', () => {
    const state = {
      guides: [
        { name: 'migration.md', size: 1024 },
        { name: 'spec.md', size: 2048 },
      ],
    };
    const out = renderToString(guideUploadWidget(state));
    expect(out).toContain('migration.md');
    expect(out).toContain('spec.md');
    expect(out).toContain('removable');
  });

  it('shows size readout', () => {
    const state = { guides: [{ name: 'f.md', size: 1024 }] };
    const out = renderToString(guideUploadWidget(state, { maxBytes: 65536 }));
    expect(out).toContain('guide-size-readout');
    expect(out).toContain('Total guide size');
  });

  it('adds warning class when within 80% of cap', () => {
    const state = { guides: [{ name: 'f.md', size: 53000 }] };
    const out = renderToString(guideUploadWidget(state, { maxBytes: 65536 }));
    expect(out).toContain('guide-size-warning');
  });

  it('adds danger class and error message over cap', () => {
    const state = { guides: [{ name: 'f.md', size: 70000 }] };
    const out = renderToString(guideUploadWidget(state, { maxBytes: 65536 }));
    expect(out).toContain('guide-size-danger');
    expect(out).toContain('exceeds cap');
  });

  it('shows ok class below 80% of cap', () => {
    const state = { guides: [{ name: 'f.md', size: 1000 }] };
    const out = renderToString(guideUploadWidget(state, { maxBytes: 65536 }));
    expect(out).toContain('guide-size-ok');
    expect(out).not.toContain('guide-size-warning');
    expect(out).not.toContain('guide-size-danger');
  });
});

// ── headTemplateInput ───────────────────────────────────────────────────────

describe('headTemplateInput', () => {
  it('renders template input with placeholder listing supported vars', () => {
    const out = renderToString(headTemplateInput({ headTemplate: '' }, {}));
    expect(out).toContain('input-head-template');
    expect(out).toContain('{project}');
  });

  it('shows live preview for each selected project', () => {
    const state = { headTemplate: 'migration/{project}' };
    const out = renderToString(
      headTemplateInput(state, {
        selectedProjects: ['/path/to/repo-a', '/path/to/repo-b'],
      }),
    );
    expect(out).toContain('head-template-preview');
    expect(out).toContain('repo-a');
    expect(out).toContain('repo-b');
  });

  it('no preview section when no projects selected', () => {
    const out = renderToString(
      headTemplateInput(
        { headTemplate: 'x/{project}' },
        { selectedProjects: [] },
      ),
    );
    expect(out).not.toContain('head-template-preview-row');
  });

  it('flags collision when two projects resolve to same branch name', () => {
    const state = { headTemplate: 'migration/fixed-name' };
    const out = renderToString(
      headTemplateInput(state, {
        selectedProjects: ['/path/repo-a', '/path/repo-b'],
      }),
    );
    expect(out).toContain('collision');
  });

  it('no collision alert when template uses {project}', () => {
    const state = { headTemplate: 'migration/{project}' };
    const out = renderToString(
      headTemplateInput(state, {
        selectedProjects: ['/path/repo-a', '/path/repo-b'],
      }),
    );
    expect(out).not.toContain('head-template-collision-alert');
  });

  it('shows resolved branch names in preview', () => {
    const state = { headTemplate: 'feat/{project}' };
    const out = renderToString(
      headTemplateInput(state, {
        selectedProjects: ['/repos/my-app'],
      }),
    );
    expect(out).toContain('feat/my-app');
  });
});

// ── planModeRadio ───────────────────────────────────────────────────────────

describe('planModeRadio', () => {
  it('renders all three default options', () => {
    const out = renderToString(planModeRadio({ planMode: 'none' }));
    expect(out).toContain('plan-mode-option-explicit');
    expect(out).toContain('plan-mode-option-plan-first');
    expect(out).toContain('plan-mode-option-none');
  });

  it('shows path input when mode is explicit', () => {
    const out = renderToString(
      planModeRadio({ planMode: 'explicit', planPath: '' }),
    );
    expect(out).toContain('input-plan-path');
  });

  it('does not show path input when mode is none', () => {
    const out = renderToString(planModeRadio({ planMode: 'none' }));
    expect(out).not.toContain('input-plan-path');
  });

  it('shows project select when mode is plan-first', () => {
    const state = {
      planMode: 'plan-first',
      selectedProjects: ['/path/repo-a', '/path/repo-b'],
    };
    const out = renderToString(planModeRadio(state));
    expect(out).toContain('select-plan-first-project');
    expect(out).toContain('repo-a');
    expect(out).toContain('repo-b');
  });

  it('shows divergence warning when mode is none', () => {
    const out = renderToString(planModeRadio({ planMode: 'none' }));
    expect(out).toContain('plan-mode-independent-warning');
    expect(out).toContain('diverge');
  });

  it('does not show divergence warning when mode is explicit', () => {
    const out = renderToString(planModeRadio({ planMode: 'explicit' }));
    expect(out).not.toContain('plan-mode-independent-warning');
  });
});

// ── tokenOverheadGate ───────────────────────────────────────────────────────

describe('tokenOverheadGate', () => {
  it('renders estimate button when no estimate available', () => {
    const out = renderToString(tokenOverheadGate({ tokenEstimate: null }));
    expect(out).toContain('token-overhead-gate');
    expect(out).toContain('btn-estimate');
    expect(out).toContain('Estimate cost');
  });

  it('shows token counts after estimate', () => {
    const state = {
      tokenEstimate: {
        guide_tokens_est: 1000,
        total_overhead_est: 7000,
        fleet_size: 3,
        prompt_stages: 7,
      },
    };
    const out = renderToString(tokenOverheadGate(state));
    expect(out).toContain('1,000');
    expect(out).toContain('7,000');
    expect(out).toContain('token-estimate-panel');
  });

  it('shows launch button after estimate', () => {
    const state = {
      tokenEstimate: {
        guide_tokens_est: 100,
        total_overhead_est: 700,
        fleet_size: 1,
        prompt_stages: 7,
      },
    };
    const out = renderToString(tokenOverheadGate(state));
    expect(out).toContain('btn-launch');
    expect(out).toContain('Launch fleet');
  });

  it('shows I-understand checkbox when estimate exceeds threshold', () => {
    const state = {
      tokenEstimate: {
        guide_tokens_est: 200_000,
        total_overhead_est: 1_400_000,
        fleet_size: 10,
        prompt_stages: 7,
      },
      tokenConfirmed: false,
    };
    const out = renderToString(
      tokenOverheadGate(state, { threshold: 1_000_000 }),
    );
    expect(out).toContain('token-confirm-checkbox');
    expect(out).toContain('I understand the cost');
  });

  it('does not show checkbox below threshold', () => {
    const state = {
      tokenEstimate: {
        guide_tokens_est: 10_000,
        total_overhead_est: 70_000,
        fleet_size: 2,
        prompt_stages: 7,
      },
    };
    const out = renderToString(
      tokenOverheadGate(state, { threshold: 1_000_000 }),
    );
    expect(out).not.toContain('token-confirm-checkbox');
  });

  it('marks launch button disabled when above threshold and not confirmed', () => {
    const state = {
      tokenEstimate: {
        guide_tokens_est: 200_000,
        total_overhead_est: 1_400_000,
        fleet_size: 10,
        prompt_stages: 7,
      },
      tokenConfirmed: false,
    };
    const out = renderToString(
      tokenOverheadGate(state, { threshold: 1_000_000 }),
    );
    expect(out).toContain('btn-launch-disabled');
  });

  it('does not mark launch button disabled when confirmed', () => {
    const state = {
      tokenEstimate: {
        guide_tokens_est: 200_000,
        total_overhead_est: 1_400_000,
        fleet_size: 10,
        prompt_stages: 7,
      },
      tokenConfirmed: true,
    };
    const out = renderToString(
      tokenOverheadGate(state, { threshold: 1_000_000 }),
    );
    expect(out).not.toContain('btn-launch-disabled');
  });

  it('marks launch button disabled when external canLaunch is false', () => {
    const state = {
      tokenEstimate: {
        guide_tokens_est: 100,
        total_overhead_est: 700,
        fleet_size: 1,
        prompt_stages: 7,
      },
    };
    const out = renderToString(tokenOverheadGate(state, { canLaunch: false }));
    expect(out).toContain('btn-launch-disabled');
  });
});
