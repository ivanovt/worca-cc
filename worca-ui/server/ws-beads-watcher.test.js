import { describe, expect, it } from 'vitest';

// Verify that the debounce constant is at least 500ms so WAL writes are
// visible to subsequent bd list subprocess calls before the broadcast fires.
describe('ws-beads-watcher debounce', () => {
  it('uses a debounce of at least 500ms for WAL timing', async () => {
    // Import the module and check that BEADS_DEBOUNCE_MS >= 500.
    // The constant is not exported, so we verify behaviour by observing
    // how long after a scheduleBeadsRefresh call the broadcast fires.
    // We do this indirectly: read the source and assert the literal value.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'ws-beads-watcher.js'),
      'utf8',
    );
    const match = src.match(/BEADS_DEBOUNCE_MS\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(500);
  });
});
