/**
 * Tests that the beads-update WS handler deduplicates unchanged payloads,
 * skipping rerender + refetch when the incoming data is identical to the
 * last broadcast, and resets that dedup state on project switch.
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

function extractFunctionBody(src, funcName) {
  const marker = `function ${funcName}`;
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

describe('beads-update handler: client-side dedup', () => {
  const source = readFileSync(join(__dirname, 'main.js'), 'utf8');
  const handler = extractHandler(source, 'beads-update');

  it('skips rerender when beads-update payload is unchanged', () => {
    // The handler must compare the incoming payload against a stored previous
    // value (via JSON.stringify or similar) and return early — skipping
    // rerender() — when unchanged.
    expect(handler).not.toBeNull();

    // There should be a serialization/comparison of the payload
    expect(handler).toMatch(/JSON\.stringify\(payload\)/);

    // There should be an early return when the payload matches the previous
    const hasEarlyReturn = handler.match(
      /if\s*\(\s*.*lastBeadsPayload.*\)\s*return/,
    );
    expect(hasEarlyReturn).not.toBeNull();
  });

  it('rerenders when payload changes', () => {
    // After the dedup check passes (payload is new), the handler must
    // update the stored previous payload and call rerender().
    expect(handler).not.toBeNull();

    // The handler must store the new serialized payload for the next comparison
    expect(handler).toMatch(/lastBeadsPayload\s*=/);

    // A render must still be triggered after a changed payload. The handler
    // routes through scheduleRerender() so a burst of beads WAL ticks coalesces
    // into one render instead of one synchronous full render per tick.
    expect(handler).toMatch(/scheduleRerender\(\)|[^e]rerender\(\)/);
  });

  it('resets dedup state on project switch', () => {
    // resetProjectState() must clear the lastBeadsPayload so that the first
    // beads-update after switching projects always renders.
    const resetBody = extractFunctionBody(source, 'resetProjectState');
    expect(resetBody).not.toBeNull();
    expect(resetBody).toMatch(/lastBeadsPayload\s*=/);
  });
});
