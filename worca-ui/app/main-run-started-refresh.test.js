/**
 * The `run-started` WS handler must call `fetchAndUpdateRuns()` so the new
 * run lands in the store immediately. Without this, sidebar counts
 * (Worktrees, Beads) and run lists stay stale until the user navigates.
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

describe('run-started handler', () => {
  const source = readFileSync(join(__dirname, 'main.js'), 'utf8');
  const handler = extractHandler(source, 'run-started');

  it('handler exists', () => {
    expect(handler).not.toBeNull();
  });

  it('calls fetchAndUpdateRuns so the new run enters the store', () => {
    expect(handler).toContain('fetchAndUpdateRuns()');
  });

  it('does not reference removed pipelineAction', () => {
    expect(handler).not.toContain('pipelineAction');
  });

  it('still rerenders', () => {
    expect(handler).toContain('rerender()');
  });
});
