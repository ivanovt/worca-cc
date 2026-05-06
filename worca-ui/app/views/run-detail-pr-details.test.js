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
  is_draft: false,
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

describe('_prDetailsView via runDetailView — pr stage', () => {
  it('renders pr-details-section when run.pr is set', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-details-section');
  });

  it('renders PR link as "#42 ↗" with target=_blank', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('#42');
    expect(out).toContain('↗');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('https://github.com/owner/repo/pull/42');
  });

  it('renders provider badge with neutral variant', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-provider-badge');
    expect(out).toContain('github');
  });

  it('renders short commit SHA (7 chars) in code element', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-commit-sha');
    expect(out).toContain('abc1234');
    // full SHA in sl-copy-button value; short SHA in code display
    expect(out).toContain('abc1234567890');
  });

  it('renders copy button for commit SHA', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('sl-copy-button');
  });

  it('renders source → target branch', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('feature/my-feature');
    expect(out).toContain('main');
    expect(out).toContain('→');
    expect(out).toContain('pr-branch-flow');
  });

  it('does not render Draft badge when is_draft=false', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).not.toContain('pr-draft-badge');
    expect(out).not.toContain('Draft');
  });

  it('renders Draft badge with warning variant when is_draft=true', () => {
    const run = { ...baseRun, pr: { ...prObject, is_draft: true } };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-draft-badge');
    expect(out).toContain('Draft');
    expect(out).toContain('variant="warning"');
  });

  it('renders review_status badge when is_draft=false and review_status set', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, is_draft: false, review_status: 'approved' },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-review-status-badge');
    expect(out).toContain('approved');
    expect(out).toContain('variant="success"');
  });

  it('renders review_status=changes_requested with warning variant', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, is_draft: false, review_status: 'changes_requested' },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-review-status-badge');
    expect(out).toContain('variant="warning"');
  });

  it('renders review_status=rejected with danger variant', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, is_draft: false, review_status: 'rejected' },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-review-status-badge');
    expect(out).toContain('variant="danger"');
  });

  it('prefers is_draft=true over review_status', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, is_draft: true, review_status: 'approved' },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-draft-badge');
    expect(out).not.toContain('pr-review-status-badge');
  });

  it('renders nothing for status row when is_draft=false and no review_status', () => {
    const run = { ...baseRun, pr: { ...prObject, is_draft: false } };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-draft-badge');
    expect(out).not.toContain('pr-review-status-badge');
  });

  it('skips provider row when provider is absent', () => {
    const run = { ...baseRun, pr: { ...prObject, provider: undefined } };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-provider-badge');
  });

  it('skips commit row when commit_sha is absent', () => {
    const run = { ...baseRun, pr: { ...prObject, commit_sha: undefined } };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-commit-sha');
  });

  it('skips branch row when source or target branch is absent', () => {
    const run = {
      ...baseRun,
      pr: { ...prObject, source_branch: undefined },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-branch-flow');
  });

  it('does not render pr-details-section when run.pr is null', () => {
    const run = { ...baseRun, pr: null };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-details-section');
  });

  it('does not render pr-details-section when run has neither pr nor pr_url', () => {
    const run = {
      pipeline_status: 'completed',
      stages: { pr: guardianStage },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-details-section');
  });

  it('renders pr-details-section using run.pr_url fallback (legacy)', () => {
    const run = {
      pipeline_status: 'completed',
      stages: { pr: guardianStage },
      pr_url: 'https://github.com/owner/repo/pull/7',
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-details-section');
    expect(out).toContain('https://github.com/owner/repo/pull/7');
  });

  it('renders pr-details-section only in pr stage, not other stages', () => {
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
    const count = (out.match(/pr-details-section/g) || []).length;
    expect(count).toBe(1);
  });
});

describe('PR stage title badge', () => {
  it('renders pr-title-badge in pr stage header when PR present', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-title-badge');
    expect(out).toContain('PR #42');
  });

  it('shows "· draft" suffix in title badge when is_draft=true', () => {
    const run = { ...baseRun, pr: { ...prObject, is_draft: true } };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('PR #42');
    expect(out).toContain('draft');
  });

  it('uses warning variant for draft title badge', () => {
    const run = { ...baseRun, pr: { ...prObject, is_draft: true } };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-title-badge');
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
