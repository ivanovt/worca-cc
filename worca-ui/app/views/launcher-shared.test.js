import { describe, expect, it } from 'vitest';
import {
  guideUploadWidget,
  headTemplateInput,
  initProgressStrip,
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

// ── tokenOverheadGate ──────────────────────────────────────────────────────

describe('tokenOverheadGate', () => {
  it('renders the gate container', () => {
    const out = renderToString(tokenOverheadGate({ estimated: false }, {}));
    expect(out).toContain('token-overhead-gate');
  });

  it('shows "Estimate cost" prompt before estimation', () => {
    const out = renderToString(tokenOverheadGate({ estimated: false }, {}));
    expect(out).toContain('Estimate cost');
    expect(out).not.toContain('token-overhead-result');
  });

  it('shows estimate result after estimation', () => {
    const state = { estimated: true, tokenEstimate: 500_000 };
    const out = renderToString(tokenOverheadGate(state, {}));
    expect(out).toContain('token-overhead-result');
    expect(out).toContain('500');
  });

  it('uses estimateFn to compute display when provided', () => {
    const state = { estimated: true, tokenEstimate: 750_000 };
    const out = renderToString(
      tokenOverheadGate(state, {
        estimateFn: (s) => s.tokenEstimate * 2,
      }),
    );
    expect(out).toContain('1,500,000');
  });

  it('does not require acknowledgement below threshold', () => {
    const state = { estimated: true, tokenEstimate: 500_000 };
    const out = renderToString(
      tokenOverheadGate(state, { threshold: 1_000_000 }),
    );
    expect(out).not.toContain('token-overhead-ack');
    expect(out).toContain('token-overhead-ok');
  });

  it('requires acknowledgement above threshold', () => {
    const state = { estimated: true, tokenEstimate: 1_500_000 };
    const out = renderToString(
      tokenOverheadGate(state, { threshold: 1_000_000 }),
    );
    expect(out).toContain('token-overhead-ack');
    expect(out).toContain('I understand the cost');
  });

  it('defaults threshold to 1M tokens', () => {
    const state = { estimated: true, tokenEstimate: 1_500_000 };
    const out = renderToString(tokenOverheadGate(state, {}));
    expect(out).toContain('token-overhead-ack');
  });

  it('shows ok class when below default threshold', () => {
    const state = { estimated: true, tokenEstimate: 800_000 };
    const out = renderToString(tokenOverheadGate(state, {}));
    expect(out).toContain('token-overhead-ok');
    expect(out).not.toContain('token-overhead-ack');
  });

  it('shows warning variant for the cost alert when over threshold', () => {
    const state = { estimated: true, tokenEstimate: 2_000_000 };
    const out = renderToString(tokenOverheadGate(state, {}));
    expect(out).toContain('variant="warning"');
  });

  it('formats token count with thousands separators', () => {
    const state = { estimated: true, tokenEstimate: 1_234_567 };
    const out = renderToString(tokenOverheadGate(state, {}));
    expect(out).toContain('1,234,567');
  });

  it('fires onChange with estimate-request when estimate button clicked', () => {
    const out = renderToString(
      tokenOverheadGate({ estimated: false }, { onChange: () => {} }),
    );
    expect(out).toContain('btn-estimate-cost');
  });

  it('fires onChange with ack-toggle when checkbox toggled', () => {
    const state = { estimated: true, tokenEstimate: 2_000_000 };
    const out = renderToString(
      tokenOverheadGate(state, { onChange: () => {} }),
    );
    expect(out).toContain('checkbox-ack-cost');
  });
});

// ── initProgressStrip ──────────────────────────────────────────────────────

describe('initProgressStrip', () => {
  it('renders a row for each target', () => {
    const state = {
      targets: [
        { name: 'lib', status: 'queued' },
        { name: 'backend', status: 'queued' },
        { name: 'frontend', status: 'queued' },
      ],
    };
    const out = renderToString(initProgressStrip(state));
    expect(out).toContain('init-progress-strip');
    expect(out).toContain('lib');
    expect(out).toContain('backend');
    expect(out).toContain('frontend');
  });

  it('shows queued status for queued targets', () => {
    const state = { targets: [{ name: 'repo', status: 'queued' }] };
    const out = renderToString(initProgressStrip(state));
    expect(out).toContain('init-target-queued');
  });

  it('shows initializing status with progress bar', () => {
    const state = { targets: [{ name: 'repo', status: 'initializing' }] };
    const out = renderToString(initProgressStrip(state));
    expect(out).toContain('init-target-initializing');
    expect(out).toContain('sl-progress-bar');
  });

  it('shows ready status for completed targets', () => {
    const state = { targets: [{ name: 'repo', status: 'ready' }] };
    const out = renderToString(initProgressStrip(state));
    expect(out).toContain('init-target-ready');
  });

  it('shows setup_failed status for failed targets', () => {
    const state = { targets: [{ name: 'repo', status: 'setup_failed' }] };
    const out = renderToString(initProgressStrip(state));
    expect(out).toContain('init-target-setup_failed');
  });

  it('shows cancel button when onCancel is provided', () => {
    const state = { targets: [{ name: 'repo', status: 'initializing' }] };
    const out = renderToString(
      initProgressStrip(state, { onCancel: () => {} }),
    );
    expect(out).toContain('btn-cancel-init');
    expect(out).toContain('Cancel');
  });

  it('hides cancel button when onCancel is not provided', () => {
    const state = { targets: [{ name: 'repo', status: 'initializing' }] };
    const out = renderToString(initProgressStrip(state));
    expect(out).not.toContain('btn-cancel-init');
  });

  it('shows "Cancel launch" label by default', () => {
    const state = { targets: [{ name: 'repo', status: 'initializing' }] };
    const out = renderToString(
      initProgressStrip(state, { onCancel: () => {} }),
    );
    expect(out).toContain('Cancel launch');
  });

  it('shows "Halt workspace" label when dispatched is true', () => {
    const state = { targets: [{ name: 'repo', status: 'ready' }] };
    const out = renderToString(
      initProgressStrip(state, { onCancel: () => {}, dispatched: true }),
    );
    expect(out).toContain('Halt workspace');
  });

  it('returns nothing when targets array is empty', () => {
    const state = { targets: [] };
    const out = renderToString(initProgressStrip(state));
    expect(out).not.toContain('init-progress-strip');
  });

  it('shows cancelled status for cancelled targets', () => {
    const state = { targets: [{ name: 'repo', status: 'cancelled' }] };
    const out = renderToString(initProgressStrip(state));
    expect(out).toContain('init-target-cancelled');
  });
});
