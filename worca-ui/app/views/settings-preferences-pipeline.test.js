import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGlobalsFromDom } from './settings.js';

describe('Global Preferences — Pipeline Execution', () => {
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

  describe('readGlobalsFromDom — pipeline fields', () => {
    it('reads classifier_model from select', () => {
      const elements = {
        'global-disk-threshold-value': { value: '2' },
        'global-disk-threshold-unit': { value: 'GB' },
        'global-cleanup-policy': { value: 'never' },
        'global-classifier-model': { value: 'sonnet' },
        'global-max-concurrent': { value: '10' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readGlobalsFromDom();
      expect(result.worca.circuit_breaker.classifier_model).toBe('sonnet');
    });

    it('reads max_concurrent_pipelines from number input', () => {
      const elements = {
        'global-disk-threshold-value': { value: '2' },
        'global-disk-threshold-unit': { value: 'GB' },
        'global-cleanup-policy': { value: 'never' },
        'global-classifier-model': { value: 'haiku' },
        'global-max-concurrent': { value: '5' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readGlobalsFromDom();
      expect(result.worca.parallel.max_concurrent_pipelines).toBe(5);
    });

    it('defaults classifier_model to haiku when element missing', () => {
      globalThis.document.getElementById = () => null;

      const result = readGlobalsFromDom();
      expect(result.worca.circuit_breaker.classifier_model).toBe('haiku');
    });

    it('defaults max_concurrent_pipelines to 10 when element missing', () => {
      globalThis.document.getElementById = () => null;

      const result = readGlobalsFromDom();
      expect(result.worca.parallel.max_concurrent_pipelines).toBe(10);
    });

    it('parses max_concurrent_pipelines as integer', () => {
      const elements = {
        'global-disk-threshold-value': { value: '2' },
        'global-disk-threshold-unit': { value: 'GB' },
        'global-cleanup-policy': { value: 'never' },
        'global-classifier-model': { value: 'haiku' },
        'global-max-concurrent': { value: '7' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readGlobalsFromDom();
      expect(result.worca.parallel.max_concurrent_pipelines).toBe(7);
    });

    it('falls back to 10 for non-numeric max_concurrent_pipelines', () => {
      const elements = {
        'global-disk-threshold-value': { value: '2' },
        'global-disk-threshold-unit': { value: 'GB' },
        'global-cleanup-policy': { value: 'never' },
        'global-classifier-model': { value: 'haiku' },
        'global-max-concurrent': { value: 'abc' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readGlobalsFromDom();
      expect(result.worca.parallel.max_concurrent_pipelines).toBe(10);
    });

    it('returns full payload shape matching PUT /api/preferences', () => {
      const elements = {
        'global-disk-threshold-value': { value: '3' },
        'global-disk-threshold-unit': { value: 'GB' },
        'global-cleanup-policy': { value: 'on-success' },
        'global-classifier-model': { value: 'opus' },
        'global-max-concurrent': { value: '4' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readGlobalsFromDom();
      expect(result).toEqual({
        worca: {
          ui: { worktree_disk_warning_bytes: 3_000_000_000 },
          parallel: {
            cleanup_policy: 'on-success',
            max_concurrent_pipelines: 4,
          },
          circuit_breaker: { classifier_model: 'opus' },
        },
      });
    });
  });
});
