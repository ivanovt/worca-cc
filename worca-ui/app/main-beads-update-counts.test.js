/**
 * Tests that the beads-update WS handler reads counts from the broadcast
 * payload instead of re-fetching them, and only refreshes run-specific beads
 * when the viewed run's counts actually changed.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

function extractHandler(src, eventName) {
  const marker = `ws.on('${eventName}'`;
  const start = src.indexOf(marker);
  if (start === -1) return null;
  let i = src.indexOf('{', start);
  if (i === -1) return null;
  const startBrace = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') depth--;
    if (depth === 0) break;
  }
  return src.slice(startBrace, i + 1);
}

describe('beads-update handler: counts from payload', () => {
  const source = readFileSync(join(__dirname, 'main.js'), 'utf8');
  const handler = extractHandler(source, 'beads-update');

  it('beads-update handler exists', () => {
    expect(handler).not.toBeNull();
  });

  it('reads counts from payload.counts', () => {
    expect(handler).toContain('payload.counts');
  });

  it('assigns payload.counts to beadsCounts', () => {
    expect(handler).toMatch(/beadsCounts\s*=\s*payload\.counts/);
  });

  it('does NOT call fetchBeadsCounts()', () => {
    expect(handler).not.toContain('fetchBeadsCounts()');
  });

  it('fetchBeadsCounts is still used for initial load / project switch', () => {
    const fnStart = source.indexOf('function fetchProjectScopedData');
    expect(fnStart).toBeGreaterThan(-1);
    let i = source.indexOf('{', fnStart);
    let depth = 0;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}') depth--;
      if (depth === 0) break;
    }
    const fnBody = source.slice(fnStart, i + 1);
    expect(fnBody).toContain('fetchBeadsCounts()');
  });
});

describe('beads-update handler: selective refresh', () => {
  const source = readFileSync(join(__dirname, 'main.js'), 'utf8');
  const handler = extractHandler(source, 'beads-update');

  it('compares previous counts before calling fetchRunBeads', () => {
    const fetchRunBeadsPos = handler.indexOf('fetchRunBeads');
    expect(fetchRunBeadsPos).toBeGreaterThan(-1);
    const beforeFetch = handler.slice(0, fetchRunBeadsPos);
    expect(beforeFetch).toMatch(/prev|changed|runCountChanged/i);
  });

  it('compares previous counts before calling fetchBeadsRunIssues', () => {
    const fetchIssuesPos = handler.indexOf('fetchBeadsRunIssues');
    expect(fetchIssuesPos).toBeGreaterThan(-1);
    const beforeFetch = handler.slice(0, fetchIssuesPos);
    expect(beforeFetch).toMatch(/prev|changed|runCountChanged/i);
  });

  it('stores previous counts for comparison', () => {
    expect(handler).toMatch(/prev|old/i);
  });
});
