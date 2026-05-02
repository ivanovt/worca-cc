import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPipelineFromDom } from './settings.js';

describe('Execution & Parallelism section', () => {
  let origDocument;

  beforeEach(() => {
    origDocument = globalThis.document;
    globalThis.document = {
      querySelectorAll: () => [],
      getElementById: () => null,
    };
  });

  afterEach(() => {
    globalThis.document = origDocument;
  });

  describe('readPipelineFromDom — parallel', () => {
    it('reads worktree_base_dir and default_base_branch', () => {
      const elements = {
        'parallel-worktree-base-dir': { value: '/tmp/wt' },
        'parallel-default-base-branch': { value: 'develop' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.parallel).toBeDefined();
      expect(result.parallel.worktree_base_dir).toBe('/tmp/wt');
      expect(result.parallel.default_base_branch).toBe('develop');
    });

    it('defaults worktree_base_dir to .worktrees and default_base_branch to main', () => {
      globalThis.document.getElementById = () => null;

      const result = readPipelineFromDom();
      expect(result.parallel.worktree_base_dir).toBe('.worktrees');
      expect(result.parallel.default_base_branch).toBe('main');
    });

    it('trims whitespace from input values', () => {
      const elements = {
        'parallel-worktree-base-dir': { value: '  .worktrees  ' },
        'parallel-default-base-branch': { value: '  main  ' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.parallel.worktree_base_dir).toBe('.worktrees');
      expect(result.parallel.default_base_branch).toBe('main');
    });

    it('falls back to defaults for empty strings', () => {
      const elements = {
        'parallel-worktree-base-dir': { value: '' },
        'parallel-default-base-branch': { value: '' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.parallel.worktree_base_dir).toBe('.worktrees');
      expect(result.parallel.default_base_branch).toBe('main');
    });
  });
});
