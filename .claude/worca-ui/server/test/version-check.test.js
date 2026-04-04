import { describe, expect, it } from 'vitest';
import {
  MIN_WORCA_CC,
  meetsMinimum,
  parseWorcaVersion,
} from '../version-check.js';

describe('parseWorcaVersion', () => {
  it('parses standard output', () => {
    expect(parseWorcaVersion('worca-cc 0.6.0\n')).toBe('0.6.0');
  });

  it('parses pre-release version', () => {
    expect(parseWorcaVersion('worca-cc 0.6.0rc3\n')).toBe('0.6.0rc3');
  });

  it('parses without trailing newline', () => {
    expect(parseWorcaVersion('worca-cc 1.2.3')).toBe('1.2.3');
  });

  it('returns null for empty string', () => {
    expect(parseWorcaVersion('')).toBeNull();
  });

  it('returns null for unexpected format', () => {
    expect(parseWorcaVersion('some other tool 1.0.0')).toBeNull();
  });

  it('returns null for just "worca-cc"', () => {
    expect(parseWorcaVersion('worca-cc')).toBeNull();
  });
});

describe('meetsMinimum', () => {
  it('equal versions pass', () => {
    expect(meetsMinimum('0.6.0', '0.6.0')).toBe(true);
  });

  it('newer major passes', () => {
    expect(meetsMinimum('1.0.0', '0.6.0')).toBe(true);
  });

  it('newer minor passes', () => {
    expect(meetsMinimum('0.7.0', '0.6.0')).toBe(true);
  });

  it('newer patch passes', () => {
    expect(meetsMinimum('0.6.1', '0.6.0')).toBe(true);
  });

  it('older version fails', () => {
    expect(meetsMinimum('0.5.0', '0.6.0')).toBe(false);
  });

  it('older minor fails', () => {
    expect(meetsMinimum('0.5.9', '0.6.0')).toBe(false);
  });

  it('pre-release suffix is ignored (rc satisfies base)', () => {
    // "0.6.0rc3" -> parseInt("0"), parseInt("6"), parseInt("0rc3") = 0
    // This means 0.6.0rc3 parses as (0, 6, 0) which equals (0, 6, 0)
    expect(meetsMinimum('0.6.0rc3', '0.6.0')).toBe(true);
  });

  it('pre-release of older version still fails', () => {
    expect(meetsMinimum('0.5.0rc1', '0.6.0')).toBe(false);
  });

  it('handles two-segment versions', () => {
    expect(meetsMinimum('1.0', '0.6.0')).toBe(true);
  });

  it('handles mismatched segment counts', () => {
    expect(meetsMinimum('0.6', '0.6.0')).toBe(true);
  });
});

describe('MIN_WORCA_CC', () => {
  it('is a valid semver-ish string', () => {
    expect(MIN_WORCA_CC).toMatch(/^\d+\.\d+\.\d+/);
  });
});
