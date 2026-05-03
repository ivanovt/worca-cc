import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDiskThreshold, readGlobalsFromDom } from './settings.js';

describe('Global Preferences — Worktrees', () => {
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

  describe('formatDiskThreshold', () => {
    it('formats bytes as GB when >= 1 GB', () => {
      expect(formatDiskThreshold(2_000_000_000)).toEqual({
        value: 2,
        unit: 'GB',
      });
    });

    it('formats bytes as MB when < 1 GB', () => {
      expect(formatDiskThreshold(500_000_000)).toEqual({
        value: 500,
        unit: 'MB',
      });
    });

    it('handles fractional GB values', () => {
      expect(formatDiskThreshold(1_500_000_000)).toEqual({
        value: 1.5,
        unit: 'GB',
      });
    });

    it('returns 2 GB for default 2 billion bytes', () => {
      expect(formatDiskThreshold(2_000_000_000)).toEqual({
        value: 2,
        unit: 'GB',
      });
    });
  });

  describe('readGlobalsFromDom — worktree fields', () => {
    it('reads disk threshold in GB and converts to bytes', () => {
      const elements = {
        'global-disk-threshold-value': { value: '5' },
        'global-disk-threshold-unit': { value: 'GB' },
        'global-cleanup-policy': { value: 'never' },
        'global-classifier-model': { value: 'haiku' },
        'global-max-concurrent': { value: '10' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readGlobalsFromDom();
      expect(result.worca.ui.worktree_disk_warning_bytes).toBe(5_000_000_000);
    });

    it('reads disk threshold in MB and converts to bytes', () => {
      const elements = {
        'global-disk-threshold-value': { value: '500' },
        'global-disk-threshold-unit': { value: 'MB' },
        'global-cleanup-policy': { value: 'never' },
        'global-classifier-model': { value: 'haiku' },
        'global-max-concurrent': { value: '10' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readGlobalsFromDom();
      expect(result.worca.ui.worktree_disk_warning_bytes).toBe(500_000_000);
    });

    it('reads cleanup_policy from select', () => {
      const elements = {
        'global-disk-threshold-value': { value: '2' },
        'global-disk-threshold-unit': { value: 'GB' },
        'global-cleanup-policy': { value: 'on-success' },
        'global-classifier-model': { value: 'haiku' },
        'global-max-concurrent': { value: '10' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readGlobalsFromDom();
      expect(result.worca.parallel.cleanup_policy).toBe('on-success');
    });

    it('defaults cleanup_policy to never when element missing', () => {
      globalThis.document.getElementById = () => null;

      const result = readGlobalsFromDom();
      expect(result.worca.parallel.cleanup_policy).toBe('never');
    });

    it('defaults disk threshold to 2 GB when elements missing', () => {
      globalThis.document.getElementById = () => null;

      const result = readGlobalsFromDom();
      expect(result.worca.ui.worktree_disk_warning_bytes).toBe(2_000_000_000);
    });
  });
});
