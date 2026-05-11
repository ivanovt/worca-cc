/**
 * Tests for the bulk worktree cleanup path in main.js.
 *
 * Uses source-text inspection to verify structural contracts without
 * importing main.js (which has browser-side side effects and DOM deps).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, 'main.js'), 'utf8');

// Extract the confirmWorktreeCleanup function body from source
function extractFunctionBody(source, fnName) {
  const marker = `function ${fnName}(`;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  let i = source.indexOf('{', start);
  if (i === -1) return null;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) break;
  }
  return source.slice(start, i + 1);
}

const fnBody = extractFunctionBody(src, 'confirmWorktreeCleanup');

describe('confirmWorktreeCleanup — bulk path structure', () => {
  it('function exists in main.js', () => {
    expect(fnBody).not.toBeNull();
  });

  it('bulk path fires a single POST to /worktrees/cleanup (not N DELETEs)', () => {
    // Must contain exactly one POST call to the cleanup endpoint
    expect(fnBody).toContain('POST');
    expect(fnBody).toContain('/worktrees/cleanup');
    // Must NOT use a for-of loop that calls deleteWorktree per iteration
    // (the old loop used "await deleteWorktree" inside a for...of)
    expect(fnBody).not.toMatch(
      /for\s*\(.*of\s+completed\b[\s\S]*?deleteWorktree/,
    );
  });

  it('bulk path sends force: true in the request body', () => {
    expect(fnBody).toContain('force: true');
  });

  it('bulk path does NOT optimistically remove cards (server-side cleanup_state drives UX)', () => {
    // The previous behaviour cleared the local worktrees list before the
    // POST returned. That caused a UX glitch where a page reload mid-
    // cleanup showed partial state. The server now stamps `cleanup_state`
    // per registry entry, so the bulk branch should NOT touch local state
    // before the POST — the only state-write in the bulk branch should
    // be the closeWorktreeCleanupDialog call (which sets dialog-only state).
    const bulkBranchStart = fnBody.indexOf('runId === null');
    expect(bulkBranchStart).toBeGreaterThan(-1);
    const fetchIdx = fnBody.indexOf('await fetch');
    const bulkBranch = fnBody.slice(bulkBranchStart, fetchIdx);
    expect(bulkBranch).not.toContain('store.setState');
    expect(bulkBranch).not.toContain('worktrees: (store.getState');
  });

  it('bulk path starts cleanup polling after kicking off the POST', () => {
    expect(fnBody).toContain('startCleanupPolling');
  });

  it('bulk path includes run_ids array in the POST body', () => {
    expect(fnBody).toContain('run_ids');
  });

  it('bulk path maps per-id server failures to showActionError toast', () => {
    expect(fnBody).toContain('showActionError');
  });
});
