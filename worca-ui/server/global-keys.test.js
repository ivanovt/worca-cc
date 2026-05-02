import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractAndStripGlobalKeys } from './global-keys.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../tests/fixtures/migration_strip_io.json'),
    'utf-8',
  ),
);

describe('extractAndStripGlobalKeys', () => {
  describe('fixture-driven cases', () => {
    for (const tc of fixture.cases) {
      if (tc.expected_project !== undefined) {
        it(`global-key extraction: ${tc.name}`, () => {
          const blob = structuredClone(tc.input);
          const result = extractAndStripGlobalKeys(blob);
          expect(blob).toEqual(tc.expected_project);
          expect(result.globalExtracted).toEqual(tc.expected_global_extracted);
        });
      }

      if (tc.expected_project_after_milestone_strip !== undefined) {
        it(`milestone strip: ${tc.name}`, () => {
          const blob = structuredClone(tc.input);
          const result = extractAndStripGlobalKeys(blob);
          expect(blob).toEqual(tc.expected_project_after_milestone_strip);
          expect(result.removedMilestones).toEqual(tc.expected_removed_keys);
        });
      }
    }
  });

  it('handles both global-key extraction and milestone strip in one pass', () => {
    const blob = {
      worca: {
        parallel: {
          worktree_base_dir: '.worktrees',
          cleanup_policy: 'on-success',
        },
        milestones: {
          plan_approval: true,
          pr_approval: true,
        },
      },
    };
    const result = extractAndStripGlobalKeys(blob);
    expect(blob).toEqual({
      worca: {
        parallel: { worktree_base_dir: '.worktrees' },
        milestones: { plan_approval: true },
      },
    });
    expect(result.globalExtracted).toEqual({
      parallel: { cleanup_policy: 'on-success' },
    });
    expect(result.removedMilestones).toEqual(['pr_approval']);
  });

  it('returns empty result for an already-clean blob', () => {
    const blob = {
      worca: {
        parallel: { worktree_base_dir: '.worktrees' },
        milestones: { plan_approval: true },
      },
    };
    const original = structuredClone(blob);
    const result = extractAndStripGlobalKeys(blob);
    expect(blob).toEqual(original);
    expect(result.globalExtracted).toEqual({});
    expect(result.removedMilestones).toEqual([]);
  });

  it('is idempotent — second call on same blob is a no-op', () => {
    const blob = {
      worca: {
        ui: { worktree_disk_warning_bytes: 5000000000 },
        milestones: { pr_approval: true, deploy_approval: true },
      },
    };
    extractAndStripGlobalKeys(blob);
    const afterFirst = structuredClone(blob);
    const result2 = extractAndStripGlobalKeys(blob);
    expect(blob).toEqual(afterFirst);
    expect(result2.globalExtracted).toEqual({});
    expect(result2.removedMilestones).toEqual([]);
  });

  it('handles missing worca key gracefully', () => {
    const blob = {};
    const result = extractAndStripGlobalKeys(blob);
    expect(blob).toEqual({});
    expect(result.globalExtracted).toEqual({});
    expect(result.removedMilestones).toEqual([]);
  });

  it('handles empty worca object', () => {
    const blob = { worca: {} };
    const result = extractAndStripGlobalKeys(blob);
    expect(blob).toEqual({ worca: {} });
    expect(result.globalExtracted).toEqual({});
    expect(result.removedMilestones).toEqual([]);
  });
});
