import { describe, expect, it } from 'vitest';
import { beadsPanelView } from './beads-panel.js';
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
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

const guardianStage = {
  status: 'completed',
  iterations: [{ number: 1, status: 'completed', outcome: 'success' }],
};

const prObject = {
  url: 'https://github.com/owner/repo/pull/42',
  number: 42,
  commit_sha: 'abc1234567890',
  source_branch: 'feature/my-feature',
  target_branch: 'main',
  provider: 'github',
};

const baseRun = {
  pipeline_status: 'completed',
  milestones: { pr_verified: true },
  stages: { pr: guardianStage },
  pr: prObject,
};

const baseOptions = {
  runId: 'test-run-001',
  run: null,
  statusFilter: 'all',
  priorityFilter: 'all',
  onStatusFilter: () => {},
  onPriorityFilter: () => {},
};

describe('_prInfoStripView via runDetailView — pr stage', () => {
  it('renders pr-info-strip when run.pr is set', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-info-strip');
  });

  it('renders PR link with #number and target=_blank', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('PR');
    expect(out).toContain('#42');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('https://github.com/owner/repo/pull/42');
    // (External-link Lucide icon is rendered via unsafeHTML and is not visible
    // through this renderToString test helper. Verified via Playwright e2e.)
  });

  it('renders provider as plain meta-value text (not a pill badge)', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('Provider:');
    expect(out).toContain('github');
    // Old design used a sl-badge with pr-provider-badge class; new design is plain text
    expect(out).not.toContain('pr-provider-badge');
  });

  it('renders short commit SHA (7 chars) in code element', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-commit-sha');
    expect(out).toContain('abc1234');
    expect(out).toContain('abc1234567890'); // full SHA in copy-button value
  });

  it('renders copy button for commit SHA', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('sl-copy-button');
  });

  it('renders source → target branch with GitBranch icon', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('feature/my-feature');
    expect(out).toContain('main');
    expect(out).toContain('→');
  });

  it('renders review_status badge when review_status set', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, review_status: 'approved' },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-review-status-badge');
    expect(out).toContain('approved');
    expect(out).toContain('variant="success"');
  });

  it('renders review_status=changes_requested with warning variant', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, review_status: 'changes_requested' },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-review-status-badge');
    expect(out).toContain('variant="warning"');
  });

  it('renders review_status=rejected with danger variant', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, review_status: 'rejected' },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-review-status-badge');
    expect(out).toContain('variant="danger"');
  });

  it('renders nothing for status row when review_status is absent', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).not.toContain('pr-review-status-badge');
  });

  it('skips Provider item when provider is absent', () => {
    const run = { ...baseRun, pr: { ...prObject, provider: undefined } };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('Provider:');
  });

  it('skips commit item when commit_sha is absent', () => {
    const run = { ...baseRun, pr: { ...prObject, commit_sha: undefined } };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-commit-sha');
  });

  it('skips branch item when source or target branch is absent', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, source_branch: undefined },
    };
    const out = renderToString(runDetailView(run));
    // The arrow appears only inside the branch item; absence of "feature/my-feature → main"
    expect(out).not.toContain('feature/my-feature → main');
  });

  it('does not render pr-info-strip when run.pr is null', () => {
    const run = { ...baseRun, pr: null };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-info-strip');
  });

  it('does not render pr-info-strip when run has neither pr nor pr_url', () => {
    const run = {
      pipeline_status: 'completed',
      stages: { pr: guardianStage },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-info-strip');
  });

  it('renders pr-info-strip using run.pr_url fallback (legacy)', () => {
    const run = {
      pipeline_status: 'completed',
      stages: { pr: guardianStage },
      pr_url: 'https://github.com/owner/repo/pull/7',
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-info-strip');
    expect(out).toContain('https://github.com/owner/repo/pull/7');
  });

  it('renders pr-info-strip only in pr stage, not other stages', () => {
    const run = {
      ...baseRun,
      stages: {
        pr: guardianStage,
        implement: {
          status: 'completed',
          iterations: [{ number: 1, status: 'completed' }],
        },
      },
    };
    const out = renderToString(runDetailView(run));
    const count = (out.match(/pr-info-strip/g) || []).length;
    expect(count).toBe(1);
  });
});

describe('PR stage title badge', () => {
  it('renders pr-title-badge in pr stage header when PR present', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-title-badge');
    expect(out).toContain('PR #42');
  });

  it('does not render pr-title-badge when no PR data', () => {
    const run = {
      pipeline_status: 'completed',
      stages: { pr: guardianStage },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-title-badge');
  });
});

describe('overview PR link uses richer data', () => {
  it('shows pr_url from run.pr.url in overview when branch is set', () => {
    const run = { ...baseRun, branch: 'feature/my-feature' };
    const out = renderToString(runDetailView(run).overview);
    expect(out).toContain('https://github.com/owner/repo/pull/42');
  });

  it('falls back to run.pr_url in overview when run.pr absent', () => {
    const run = {
      pipeline_status: 'completed',
      branch: 'feature/x',
      stages: {},
      pr_url: 'https://github.com/owner/repo/pull/5',
    };
    const out = renderToString(runDetailView(run).overview);
    expect(out).toContain('https://github.com/owner/repo/pull/5');
  });
});

describe('beadsPanelView — PR link uses run.pr.url', () => {
  it('shows PR link using run.pr.url when run.pr is set', () => {
    const run = {
      branch: 'worca/feature',
      pr: {
        url: 'https://github.com/owner/repo/pull/42',
        number: 42,
      },
    };
    const out = renderToString(
      beadsPanelView([], {
        ...baseOptions,
        run,
      }),
    );
    expect(out).toContain('https://github.com/owner/repo/pull/42');
    expect(out).toContain('PR #42');
  });

  it('falls back to run.pr_url when run.pr is absent', () => {
    const run = {
      branch: 'worca/feature',
      pr_url: 'https://github.com/owner/repo/pull/7',
    };
    const out = renderToString(
      beadsPanelView([], {
        ...baseOptions,
        run,
      }),
    );
    expect(out).toContain('https://github.com/owner/repo/pull/7');
    expect(out).toContain('View PR');
  });

  it('hides PR link when neither run.pr nor run.pr_url is set', () => {
    const run = { branch: 'worca/feature' };
    const out = renderToString(
      beadsPanelView([], {
        ...baseOptions,
        run,
      }),
    );
    expect(out).not.toContain('View PR');
    expect(out).not.toContain('PR #');
  });
});
