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

describe('beadsDependencyGraph - returns svg and node positions', () => {
  it('returns an object with svg string and nodes array', () => {
    const result = beadsDependencyGraph([issue1, issue2]);
    expect(result).toHaveProperty('svg');
    expect(result).toHaveProperty('nodes');
    expect(typeof result.svg).toBe('string');
    expect(Array.isArray(result.nodes)).toBe(true);
  });

  it('returns one node entry per issue', () => {
    const { nodes } = beadsDependencyGraph([issue1, issue2]);
    expect(nodes).toHaveLength(2);
  });

  it('each node has issue, x, y, w, h properties', () => {
    const { nodes } = beadsDependencyGraph([issue1]);
    const node = nodes[0];
    expect(node).toHaveProperty('issue');
    expect(node).toHaveProperty('x');
    expect(node).toHaveProperty('y');
    expect(node).toHaveProperty('w');
    expect(node).toHaveProperty('h');
    expect(node.issue.id).toBe('worca-cc-aaa1');
  });

  it('svg contains node labels (truncated titles)', () => {
    const { svg } = beadsDependencyGraph([issue1]);
    // Title "Full Title Of Issue One" is > 18 chars, so truncated
    expect(svg).toContain('Full Title Of Issu...');
  });

  it('svg contains issue IDs', () => {
    const { svg } = beadsDependencyGraph([issue1, issue2]);
    expect(svg).toContain('#worca-cc-aaa1');
    expect(svg).toContain('#worca-cc-bbb2');
  });

  it('svg contains edge paths for dependencies', () => {
    const { svg } = beadsDependencyGraph([issue1, issue2]);
    // issue2 depends on issue1, so there should be a path
    expect(svg).toContain('<path');
    expect(svg).toContain('beads-graph-edge');
  });

  it('returns empty svg and nodes for empty input', () => {
    expect(beadsDependencyGraph([])).toEqual({ svg: '', nodes: [] });
    expect(beadsDependencyGraph(null)).toEqual({ svg: '', nodes: [] });
  });
});
