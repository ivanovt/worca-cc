/**
 * Tests that the app.js dispatchWorkspace callback forwards
 * workspace_plan_path and project_plans manifest fields as
 * --workspace-plan and --project-plan CLI flags to run_workspace.py.
 */

import { describe, expect, it } from 'vitest';
import { buildWorkspaceArgs } from './app.js';

describe('buildWorkspaceArgs — plan flag forwarding', () => {
  const baseManifest = {
    work_request: { description: 'test prompt' },
  };

  it('includes --workspace-plan when workspace_plan_path is set', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', {
      ...baseManifest,
      workspace_plan_path: '/tmp/workspace-plan.json',
    });
    const idx = args.indexOf('--workspace-plan');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/tmp/workspace-plan.json');
  });

  it('omits --workspace-plan when workspace_plan_path is null', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', {
      ...baseManifest,
      workspace_plan_path: null,
    });
    expect(args).not.toContain('--workspace-plan');
  });

  it('omits --workspace-plan when workspace_plan_path is absent', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', baseManifest);
    expect(args).not.toContain('--workspace-plan');
  });

  it('includes --project-plan for each entry in project_plans', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', {
      ...baseManifest,
      project_plans: {
        api: '/tmp/api-plan.md',
        web: '/tmp/web-plan.md',
      },
    });
    const indices = args.reduce((acc, v, i) => {
      if (v === '--project-plan') acc.push(i);
      return acc;
    }, []);
    expect(indices).toHaveLength(2);
    const values = indices.map((i) => args[i + 1]);
    expect(values).toContain('api=/tmp/api-plan.md');
    expect(values).toContain('web=/tmp/web-plan.md');
  });

  it('omits --project-plan when project_plans is null', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', {
      ...baseManifest,
      project_plans: null,
    });
    expect(args).not.toContain('--project-plan');
  });

  it('omits --project-plan when project_plans is empty object', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', {
      ...baseManifest,
      project_plans: {},
    });
    expect(args).not.toContain('--project-plan');
  });

  it('forwards both workspace-plan and project-plan together', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', {
      ...baseManifest,
      workspace_plan_path: '/tmp/workspace-plan.json',
      project_plans: { api: '/tmp/api-plan.md' },
    });
    expect(args).toContain('--workspace-plan');
    expect(args).toContain('--project-plan');
  });

  it('still includes base args (prompt, workspace-id, workspace_root)', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', baseManifest);
    expect(args).toContain('-m');
    expect(args).toContain('worca.scripts.run_workspace');
    expect(args).toContain('/ws/root');
    expect(args).toContain('--workspace-id');
    expect(args).toContain('ws_123');
    expect(args).toContain('--prompt');
    expect(args).toContain('test prompt');
  });

  it('forwards --skip-planning', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', {
      ...baseManifest,
      skip_planning: true,
    });
    expect(args).toContain('--skip-planning');
  });

  it('forwards --guide paths', () => {
    const args = buildWorkspaceArgs('/ws/root', 'ws_123', {
      ...baseManifest,
      guide: { paths: ['/tmp/g1.md', '/tmp/g2.md'] },
    });
    const indices = args.reduce((acc, v, i) => {
      if (v === '--guide') acc.push(i);
      return acc;
    }, []);
    expect(indices).toHaveLength(2);
    expect(args[indices[0] + 1]).toBe('/tmp/g1.md');
    expect(args[indices[1] + 1]).toBe('/tmp/g2.md');
  });
});
