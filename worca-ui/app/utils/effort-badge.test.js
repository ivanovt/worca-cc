import { describe, expect, it } from 'vitest';
import { effortLevelBadge, effortLevelVariant } from './effort-badge.js';

describe('effortLevelVariant', () => {
  it('returns neutral for low', () => {
    expect(effortLevelVariant('low')).toBe('neutral');
  });
  it('returns neutral for medium', () => {
    expect(effortLevelVariant('medium')).toBe('neutral');
  });
  it('returns primary for high', () => {
    expect(effortLevelVariant('high')).toBe('primary');
  });
  it('returns warning for xhigh', () => {
    expect(effortLevelVariant('xhigh')).toBe('warning');
  });
  it('returns danger for max', () => {
    expect(effortLevelVariant('max')).toBe('danger');
  });
  it('returns neutral for null', () => {
    expect(effortLevelVariant(null)).toBe('neutral');
  });
  it('returns neutral for undefined', () => {
    expect(effortLevelVariant(undefined)).toBe('neutral');
  });
  it('returns neutral for unknown string', () => {
    expect(effortLevelVariant('turbo')).toBe('neutral');
  });
});

describe('effortLevelBadge', () => {
  it('renders Zap SVG icon', () => {
    const result = effortLevelBadge('high');
    expect(result).toContain('<svg');
    expect(result).toContain('class="effort-zap-icon"');
  });
  it('renders the level text for a known level', () => {
    expect(effortLevelBadge('high')).toContain('high');
  });
  it('renders dash when level is null', () => {
    expect(effortLevelBadge(null)).toContain('-');
  });
  it('renders dash when level is undefined', () => {
    expect(effortLevelBadge(undefined)).toContain('-');
  });
  it('uses correct variant for high', () => {
    expect(effortLevelBadge('high')).toContain('variant="primary"');
  });
  it('uses neutral variant for null', () => {
    expect(effortLevelBadge(null)).toContain('variant="neutral"');
  });
  it('uses danger variant for max', () => {
    expect(effortLevelBadge('max')).toContain('variant="danger"');
  });
  it('renders each known level text', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(effortLevelBadge(level)).toContain(level);
    }
  });
});
