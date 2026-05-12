import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPipelineFromDom } from './settings.js';

describe('Fleet & Guide section', () => {
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

  describe('readPipelineFromDom — guide', () => {
    it('reads guide.max_bytes from the input', () => {
      const elements = {
        'guide-max-bytes': { value: '262144' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.guide).toBeDefined();
      expect(result.guide.max_bytes).toBe(262144);
    });

    it('defaults to 131072 (128 KiB) when the input is missing', () => {
      const result = readPipelineFromDom();
      expect(result.guide.max_bytes).toBe(131072);
    });
  });

  describe('readPipelineFromDom — fleet', () => {
    it('reads fleet.max_parallel from the input', () => {
      const elements = { 'fleet-max-parallel': { value: '10' } };
      globalThis.document.getElementById = (id) => elements[id] || null;
      const result = readPipelineFromDom();
      expect(result.fleet.max_parallel).toBe(10);
    });

    it('reads fleet.failure_threshold as a float', () => {
      const elements = { 'fleet-failure-threshold': { value: '0.5' } };
      globalThis.document.getElementById = (id) => elements[id] || null;
      const result = readPipelineFromDom();
      expect(result.fleet.failure_threshold).toBeCloseTo(0.5);
    });

    it('reads fleet.init_timeout_seconds', () => {
      const elements = { 'fleet-init-timeout': { value: '120' } };
      globalThis.document.getElementById = (id) => elements[id] || null;
      const result = readPipelineFromDom();
      expect(result.fleet.init_timeout_seconds).toBe(120);
    });

    it('defaults: max_parallel=5, failure_threshold=0.30, init_timeout=60', () => {
      const result = readPipelineFromDom();
      expect(result.fleet.max_parallel).toBe(5);
      expect(result.fleet.failure_threshold).toBeCloseTo(0.3);
      expect(result.fleet.init_timeout_seconds).toBe(60);
    });
  });
});
