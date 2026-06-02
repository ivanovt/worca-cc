import { describe, expect, it } from 'vitest';
import { buildHash, parseHash } from './router.js';

describe('router', () => {
  it('parseHash extracts section from simple path', () => {
    expect(parseHash('#/active')).toEqual({
      section: 'active',
      runId: null,
      action: null,
      projectId: null,
      tier: null,
    });
    expect(parseHash('#/history')).toEqual({
      section: 'history',
      runId: null,
      action: null,
      projectId: null,
      tier: null,
    });
    expect(parseHash('')).toEqual({
      section: 'active',
      runId: null,
      action: null,
      projectId: null,
      tier: null,
    });
  });

  it('parseHash extracts runId from path segment', () => {
    expect(parseHash('#/active/run-123')).toEqual({
      section: 'active',
      runId: 'run-123',
      action: null,
      projectId: null,
      tier: null,
    });
  });

  it('parseHash extracts projectId and section from path segments', () => {
    expect(parseHash('#/project/my-proj/active')).toEqual({
      section: 'active',
      runId: null,
      action: null,
      projectId: 'my-proj',
      tier: null,
    });
  });

  it('parseHash defaults section to active for bare #/project/<id>', () => {
    expect(parseHash('#/project/my-proj')).toEqual({
      section: 'active',
      runId: null,
      action: null,
      projectId: 'my-proj',
      tier: null,
    });
  });

  it('parseHash extracts projectId, section, and runId', () => {
    expect(parseHash('#/project/proj-a/active/run-1')).toEqual({
      section: 'active',
      runId: 'run-1',
      action: null,
      projectId: 'proj-a',
      tier: null,
    });
  });

  it('parseHash extracts an optional action segment (e.g. /:name/edit)', () => {
    expect(parseHash('#/workspaces/my-ws/edit')).toEqual({
      section: 'workspaces',
      runId: 'my-ws',
      action: 'edit',
      projectId: null,
      tier: null,
    });
  });

  it('parseHash extracts action under project-prefixed path', () => {
    expect(parseHash('#/project/proj-a/workspaces/my-ws/edit')).toEqual({
      section: 'workspaces',
      runId: 'my-ws',
      action: 'edit',
      projectId: 'proj-a',
      tier: null,
    });
  });

  it('buildHash creates simple hash without project', () => {
    expect(buildHash('active', null)).toBe('#/active');
    expect(buildHash('active', 'run-1')).toBe('#/active/run-1');
  });

  it('buildHash includes project as path segment', () => {
    expect(buildHash('active', 'run-1', 'proj-a')).toBe(
      '#/project/proj-a/active/run-1',
    );
    expect(buildHash('active', null, 'proj-a')).toBe('#/project/proj-a/active');
  });

  it('buildHash omits project when null', () => {
    expect(buildHash('active', 'run-1', null)).toBe('#/active/run-1');
    expect(buildHash('active', null, null)).toBe('#/active');
  });

  it('navigate accepts optional projectId (round-trip)', () => {
    const hash = buildHash('history', 'run-2', 'proj-b');
    const parsed = parseHash(hash);
    expect(parsed.projectId).toBe('proj-b');
    expect(parsed.runId).toBe('run-2');
    expect(parsed.section).toBe('history');
  });

  // Backward compatibility with old query-param format
  it('parseHash supports legacy ?run= query param', () => {
    expect(parseHash('#/active?run=abc')).toEqual({
      section: 'active',
      runId: 'abc',
      action: null,
      projectId: null,
      tier: null,
    });
  });

  it('parseHash supports legacy ?project= query param', () => {
    expect(parseHash('#/active?project=my-proj')).toEqual({
      section: 'active',
      runId: null,
      action: null,
      projectId: 'my-proj',
      tier: null,
    });
  });

  it('parseHash returns projectId=null when absent', () => {
    expect(parseHash('#/active')).toEqual({
      section: 'active',
      runId: null,
      action: null,
      projectId: null,
      tier: null,
    });
  });

  it('buildHash includes action as 3rd segment when supplied', () => {
    expect(buildHash('workspaces', 'my-ws', null, 'edit')).toBe(
      '#/workspaces/my-ws/edit',
    );
    expect(buildHash('workspaces', 'my-ws', 'proj-a', 'edit')).toBe(
      '#/project/proj-a/workspaces/my-ws/edit',
    );
  });

  // ─── Templates: tier slot in the URL ──────────────────────────────

  describe('templates section — tier in the URL', () => {
    it('parseHash captures tier from project-prefixed templates URL', () => {
      expect(
        parseHash('#/project/proj-a/templates/project/bugfix/edit'),
      ).toEqual({
        section: 'templates',
        tier: 'project',
        runId: 'bugfix',
        action: 'edit',
        projectId: 'proj-a',
      });
    });

    it('parseHash captures tier from short-format templates URL', () => {
      expect(parseHash('#/templates/builtin/feature/edit')).toEqual({
        section: 'templates',
        tier: 'builtin',
        runId: 'feature',
        action: 'edit',
        projectId: null,
      });
    });

    it('parseHash list view has no tier / runId', () => {
      expect(parseHash('#/project/proj-a/templates')).toEqual({
        section: 'templates',
        runId: null,
        action: null,
        projectId: 'proj-a',
        tier: null,
      });
    });

    it('buildHash emits the tier segment before id', () => {
      expect(
        buildHash('templates', 'bugfix', 'proj-a', 'edit', 'project'),
      ).toBe('#/project/proj-a/templates/project/bugfix/edit');
    });

    it('buildHash omits the tier segment when none supplied (list view)', () => {
      expect(buildHash('templates', null, 'proj-a')).toBe(
        '#/project/proj-a/templates',
      );
    });

    it('round-trips a tier+id+action edit URL', () => {
      const hash = buildHash('templates', 'foo', 'proj-x', 'edit', 'user');
      const parsed = parseHash(hash);
      expect(parsed.section).toBe('templates');
      expect(parsed.tier).toBe('user');
      expect(parsed.runId).toBe('foo');
      expect(parsed.action).toBe('edit');
      expect(parsed.projectId).toBe('proj-x');
    });
  });
});
