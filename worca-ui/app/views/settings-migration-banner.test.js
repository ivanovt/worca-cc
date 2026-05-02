import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _getMigrationNeeded,
  countMigrated,
  detectMigrationNeeded,
  loadSettings,
} from './settings.js';

describe('Migration banner (§11c)', () => {
  describe('detectMigrationNeeded', () => {
    it('returns false for clean project settings', () => {
      const worca = {
        parallel: {
          worktree_base_dir: '.worktrees',
          default_base_branch: 'main',
        },
        circuit_breaker: { enabled: true, max_consecutive_failures: 3 },
        milestones: { plan_approval: true },
      };
      expect(detectMigrationNeeded(worca)).toBe(false);
    });

    it('returns false for null/undefined worca', () => {
      expect(detectMigrationNeeded(null)).toBe(false);
      expect(detectMigrationNeeded(undefined)).toBe(false);
    });

    it('detects parallel.cleanup_policy as misplaced', () => {
      const worca = { parallel: { cleanup_policy: 'on-success' } };
      expect(detectMigrationNeeded(worca)).toBe(true);
    });

    it('detects parallel.max_concurrent_pipelines as misplaced', () => {
      const worca = { parallel: { max_concurrent_pipelines: 3 } };
      expect(detectMigrationNeeded(worca)).toBe(true);
    });

    it('detects ui.worktree_disk_warning_bytes as misplaced', () => {
      const worca = { ui: { worktree_disk_warning_bytes: 2_000_000_000 } };
      expect(detectMigrationNeeded(worca)).toBe(true);
    });

    it('detects circuit_breaker.classifier_model as misplaced', () => {
      const worca = {
        circuit_breaker: { enabled: true, classifier_model: 'opus' },
      };
      expect(detectMigrationNeeded(worca)).toBe(true);
    });

    it('detects milestones.pr_approval === true', () => {
      const worca = { milestones: { plan_approval: true, pr_approval: true } };
      expect(detectMigrationNeeded(worca)).toBe(true);
    });

    it('ignores milestones.pr_approval === false', () => {
      const worca = { milestones: { plan_approval: true, pr_approval: false } };
      expect(detectMigrationNeeded(worca)).toBe(false);
    });

    it('detects milestones.deploy_approval === true', () => {
      const worca = { milestones: { deploy_approval: true } };
      expect(detectMigrationNeeded(worca)).toBe(true);
    });

    it('ignores milestones.deploy_approval === false', () => {
      const worca = { milestones: { deploy_approval: false } };
      expect(detectMigrationNeeded(worca)).toBe(false);
    });

    it('detects multiple misplaced keys at once', () => {
      const worca = {
        parallel: { cleanup_policy: 'never', max_concurrent_pipelines: 5 },
        milestones: { pr_approval: true },
      };
      expect(detectMigrationNeeded(worca)).toBe(true);
    });
  });

  describe('countMigrated', () => {
    it('returns 0 for empty autoMigrated', () => {
      expect(
        countMigrated({ globalExtracted: {}, removedMilestones: [] }),
      ).toBe(0);
    });

    it('returns 0 for null/undefined', () => {
      expect(countMigrated(null)).toBe(0);
      expect(countMigrated(undefined)).toBe(0);
    });

    it('counts global extracted keys across sections', () => {
      const autoMigrated = {
        globalExtracted: {
          parallel: {
            cleanup_policy: 'on-success',
            max_concurrent_pipelines: 3,
          },
          circuit_breaker: { classifier_model: 'opus' },
        },
        removedMilestones: [],
      };
      expect(countMigrated(autoMigrated)).toBe(3);
    });

    it('counts removed milestones', () => {
      const autoMigrated = {
        globalExtracted: {},
        removedMilestones: ['pr_approval', 'deploy_approval'],
      };
      expect(countMigrated(autoMigrated)).toBe(2);
    });

    it('sums global keys and removed milestones', () => {
      const autoMigrated = {
        globalExtracted: {
          parallel: { cleanup_policy: 'on-success' },
        },
        removedMilestones: ['pr_approval'],
      };
      expect(countMigrated(autoMigrated)).toBe(2);
    });
  });

  describe('loadSettings sets _migrationNeeded', () => {
    let origFetch;
    let origDocument;

    beforeEach(() => {
      origFetch = globalThis.fetch;
      origDocument = globalThis.document;
      globalThis.document = {
        querySelectorAll: () => [],
        getElementById: () => null,
      };
    });

    afterEach(() => {
      globalThis.fetch = origFetch;
      globalThis.document = origDocument;
    });

    it('sets migration needed when project has misplaced global keys', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes('/api/subagents')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, subagents: [] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              worca: {
                parallel: {
                  cleanup_policy: 'on-success',
                  worktree_base_dir: '.worktrees',
                },
              },
            }),
        });
      });

      await loadSettings('test-project');
      expect(_getMigrationNeeded()).toBe(true);
    });

    it('sets migration needed when pr_approval is true', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes('/api/subagents')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, subagents: [] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              worca: {
                milestones: { plan_approval: true, pr_approval: true },
              },
            }),
        });
      });

      await loadSettings('test-project');
      expect(_getMigrationNeeded()).toBe(true);
    });

    it('clears migration flag for clean project', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes('/api/subagents')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ok: true, subagents: [] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              worca: {
                milestones: { plan_approval: true },
              },
            }),
        });
      });

      await loadSettings('test-project');
      expect(_getMigrationNeeded()).toBe(false);
    });
  });
});
