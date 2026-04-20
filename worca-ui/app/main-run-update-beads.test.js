/**
 * Tests that the run-update WS handler calls fetchRunBeads when the updated
 * run matches the currently viewed run. This ensures the beads panel refreshes
 * live during pipeline runs (piggybacks on the reliable status.json-triggered
 * run-update event instead of the broken macOS FSEvents path).
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

describe('run-update handler: beads refresh', () => {
  const source = readFileSync(join(__dirname, 'main.js'), 'utf8');
  const handler = extractHandler(source, 'run-update');

  it('run-update handler exists', () => {
    expect(handler).not.toBeNull();
  });

  it('calls fetchRunBeads inside the route.runId === payload.id block', () => {
    expect(handler).toContain('fetchRunBeads(payload.id)');
  });

  it('fetchRunBeads is called after updateActiveStage within the matching-run block', () => {
    const updateActiveStagePos = handler.indexOf('updateActiveStage(payload)');
    const fetchRunBeadsPos = handler.indexOf('fetchRunBeads(payload.id)');
    expect(updateActiveStagePos).toBeGreaterThan(-1);
    expect(fetchRunBeadsPos).toBeGreaterThan(updateActiveStagePos);
  });

  it('fetchRunBeads is guarded by route.runId === payload.id condition', () => {
    expect(handler).toContain('route.runId === payload.id');
  });

  it('fetchRunBeads is not called outside the matching-run block', () => {
    const conditionPos = handler.indexOf('route.runId === payload.id');
    const fetchPos = handler.indexOf('fetchRunBeads(payload.id)');
    expect(conditionPos).toBeGreaterThan(-1);
    expect(fetchPos).toBeGreaterThan(conditionPos);
    const beforeCondition = handler.slice(0, conditionPos);
    expect(beforeCondition).not.toContain('fetchRunBeads(');
  });

  it('outer guard uses optional chaining so null route.runId causes no error', () => {
    expect(handler).toContain('payload?.id');
  });
});
