import { describe, expect, it } from 'vitest';
import { beadsDependencyGraph } from './beads-panel.js';

const issue1 = {
  id: 'worca-cc-aaa1',
  title: 'Full Title Of Issue One',
  body: 'This is the body of issue one, which has enough text to be excerpted at one hundred characters total.',
  status: 'open',
  priority: 2,
  depends_on: [],
  blocked_by: [],
};

const issue2 = {
  id: 'worca-cc-bbb2',
  title: 'Second Issue Depends On First',
  body: 'Short body.',
  status: 'in_progress',
  priority: 1,
  depends_on: ['worca-cc-aaa1'],
  blocked_by: [],
};

describe('beadsDependencyGraph - SVG title tooltips', () => {
  it('each graph node has a <title> child element', () => {
    const svg = beadsDependencyGraph([issue1, issue2]);
    // Both nodes should have a <title> element inside their <g> node group
    const titleMatches = svg.match(/<title>/g);
    expect(titleMatches).not.toBeNull();
    expect(titleMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('node title contains the full issue title', () => {
    const svg = beadsDependencyGraph([issue1]);
    expect(svg).toContain('Full Title Of Issue One');
  });

  it('node title contains status and priority', () => {
    const svg = beadsDependencyGraph([issue1]);
    // Should contain "open" (status) and "P2" (priority)
    const titleBlock = svg.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    expect(titleBlock).toContain('open');
    expect(titleBlock).toContain('P2');
  });

  it('node title contains body excerpt (first ~100 chars)', () => {
    const svg = beadsDependencyGraph([issue1]);
    const excerpt = issue1.body.slice(0, 100);
    expect(svg).toContain(excerpt);
  });

  it('node title lists dependency IDs when present', () => {
    const svg = beadsDependencyGraph([issue1, issue2]);
    // issue2 depends on issue1 — its <title> should mention worca-cc-aaa1
    const titleBlocks = [...svg.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(
      (m) => m[1],
    );
    const depTitleBlock = titleBlocks.find((t) =>
      t.includes('Second Issue Depends On First'),
    );
    expect(depTitleBlock).toBeDefined();
    expect(depTitleBlock).toContain('worca-cc-aaa1');
  });

  it('returns empty string when issues array is empty', () => {
    expect(beadsDependencyGraph([])).toBe('');
    expect(beadsDependencyGraph(null)).toBe('');
  });
});
