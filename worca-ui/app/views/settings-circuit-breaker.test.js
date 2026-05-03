import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPipelineFromDom } from './settings.js';

describe('Circuit Breaker section', () => {
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

  describe('readPipelineFromDom — circuit_breaker', () => {
    it('reads enabled switch and max_consecutive_failures', () => {
      const elements = {
        'cb-enabled': { checked: true },
        'cb-max-failures': { value: '5' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.circuit_breaker).toBeDefined();
      expect(result.circuit_breaker.enabled).toBe(true);
      expect(result.circuit_breaker.max_consecutive_failures).toBe(5);
    });

    it('reads enabled false when unchecked', () => {
      const elements = {
        'cb-enabled': { checked: false },
        'cb-max-failures': { value: '3' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.circuit_breaker.enabled).toBe(false);
    });

    it('defaults enabled to true and max_consecutive_failures to 3 when elements missing', () => {
      globalThis.document.getElementById = () => null;

      const result = readPipelineFromDom();
      expect(result.circuit_breaker.enabled).toBe(true);
      expect(result.circuit_breaker.max_consecutive_failures).toBe(3);
    });

    it('parses max_consecutive_failures as integer', () => {
      const elements = {
        'cb-enabled': { checked: true },
        'cb-max-failures': { value: '7' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.circuit_breaker.max_consecutive_failures).toBe(7);
    });

    it('falls back to 3 for non-numeric max_consecutive_failures', () => {
      const elements = {
        'cb-enabled': { checked: true },
        'cb-max-failures': { value: 'abc' },
      };
      globalThis.document.getElementById = (id) => elements[id] || null;

      const result = readPipelineFromDom();
      expect(result.circuit_breaker.max_consecutive_failures).toBe(3);
    });
  });
});
