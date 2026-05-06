import { describe, expect, it } from 'vitest';
import { prVerificationBannerView, runDetailView } from './run-detail.js';

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
  status: 'error',
  iterations: [{ number: 1, status: 'error', outcome: 'reject' }],
};

const baseRun = {
  pipeline_status: 'failed',
  milestones: { pr_verified: false },
  stages: { pr: guardianStage },
};

describe('prVerificationBannerView', () => {
  it('renders danger sl-alert when pr_verified=false and pipeline_status=failed', () => {
    const out = renderToString(prVerificationBannerView(baseRun));
    expect(out).toContain('pr-verification-banner');
    expect(out).toContain('variant="danger"');
  });

  it('has class pr-verification-banner', () => {
    const out = renderToString(prVerificationBannerView(baseRun));
    expect(out).toContain('pr-verification-banner');
  });

  it('does not render when pr_verified is null', () => {
    const run = { ...baseRun, milestones: { pr_verified: null } };
    const out = renderToString(prVerificationBannerView(run));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('does not render when pr_verified is undefined', () => {
    const run = { ...baseRun, milestones: {} };
    const out = renderToString(prVerificationBannerView(run));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('does not render when pr_verified=true', () => {
    const run = { ...baseRun, milestones: { pr_verified: true } };
    const out = renderToString(prVerificationBannerView(run));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('does not render when pr_verified=false but pipeline_status=completed', () => {
    const run = { ...baseRun, pipeline_status: 'completed' };
    const out = renderToString(prVerificationBannerView(run));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('does not render when pr_verified=false but pipeline_status=running', () => {
    const run = { ...baseRun, pipeline_status: 'running' };
    const out = renderToString(prVerificationBannerView(run));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('does not render when pr_verified=false but pipeline_status=paused', () => {
    const run = { ...baseRun, pipeline_status: 'paused' };
    const out = renderToString(prVerificationBannerView(run));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('does not render when run is null', () => {
    const out = renderToString(prVerificationBannerView(null));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('does not render when milestones is absent', () => {
    const run = { pipeline_status: 'failed', stages: {} };
    const out = renderToString(prVerificationBannerView(run));
    expect(out).not.toContain('pr-verification-banner');
  });
});

describe('runDetailView pr-verification-banner integration', () => {
  it('banner appears in overview when pr_verified=false and pipeline_status=failed', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-verification-banner');
    expect(out).toContain('variant="danger"');
  });

  it('banner absent when pr_verified=true', () => {
    const run = { ...baseRun, milestones: { pr_verified: true } };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('banner absent when pr_verified=null', () => {
    const run = { ...baseRun, milestones: { pr_verified: null } };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-verification-banner');
  });

  it('banner absent when pipeline_status is not failed', () => {
    const run = {
      ...baseRun,
      pipeline_status: 'completed',
      milestones: { pr_verified: false },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-verification-banner');
  });
});

describe('runDetailView pr-verified badge in guardian stage', () => {
  it('renders pr-verified-badge with danger variant when pr_verified=false', () => {
    const out = renderToString(runDetailView(baseRun));
    expect(out).toContain('pr-verified-badge');
    expect(out).toContain('Not Verified');
  });

  it('renders pr-verified-badge with success variant when pr_verified=true', () => {
    const run = {
      pipeline_status: 'completed',
      milestones: { pr_verified: true },
      stages: { pr: guardianStage },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-verified-badge');
    expect(out).toContain('Verified');
  });

  it('does not render pr-verified-badge when pr_verified is null', () => {
    const run = {
      ...baseRun,
      milestones: { pr_verified: null },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-verified-badge');
  });

  it('does not render pr-verified-badge when guardian stage is absent', () => {
    const run = {
      pipeline_status: 'failed',
      milestones: { pr_verified: false },
      stages: {
        implement: {
          status: 'error',
          iterations: [{ number: 1, status: 'error' }],
        },
      },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-verified-badge');
  });

  it('does not render pr-verified-badge when milestones is absent', () => {
    const run = {
      pipeline_status: 'failed',
      stages: { pr: guardianStage },
    };
    const out = renderToString(runDetailView(run));
    expect(out).not.toContain('pr-verified-badge');
  });

  it('renders pr-verified-badge when guardian has multiple iterations (retry path)', () => {
    const multiIterGuardian = {
      status: 'completed',
      iterations: [
        { number: 1, status: 'error', outcome: 'reject' },
        { number: 2, status: 'completed', outcome: 'success' },
      ],
    };
    const run = {
      pipeline_status: 'completed',
      milestones: { pr_verified: true },
      stages: { pr: multiIterGuardian },
    };
    const out = renderToString(runDetailView(run));
    expect(out).toContain('pr-verified-badge');
    expect(out).toContain('Verified');
  });
});
