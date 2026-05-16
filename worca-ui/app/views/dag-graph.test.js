import { describe, expect, it } from 'vitest';
import { dagGraphView } from './dag-graph.js';

const linearChain = {
  projects: [
    { name: 'shared-lib', status: 'completed', depends_on: [] },
    { name: 'backend', status: 'running', depends_on: ['shared-lib'] },
    { name: 'frontend', status: 'pending', depends_on: ['backend'] },
  ],
};

const diamondDag = {
  projects: [
    { name: 'core', status: 'completed', depends_on: [] },
    { name: 'api', status: 'running', depends_on: ['core'] },
    { name: 'web', status: 'running', depends_on: ['core'] },
    { name: 'app', status: 'pending', depends_on: ['api', 'web'] },
  ],
};

describe('dagGraphView', () => {
  it('returns empty svg for empty repos', () => {
    const result = dagGraphView({ projects: [] }, { mode: 'navigate' });
    expect(result.svg).toBe('');
    expect(result.nodes).toEqual([]);
  });

  it('returns empty svg for null input', () => {
    const result = dagGraphView(null, { mode: 'navigate' });
    expect(result.svg).toBe('');
    expect(result.nodes).toEqual([]);
  });

  describe('layout — 3-tier linear chain', () => {
    it('renders 3 nodes in separate tier columns', () => {
      const { nodes } = dagGraphView(linearChain, {
        mode: 'navigate',
      });
      expect(nodes).toHaveLength(3);
      const xs = nodes.map((n) => n.x);
      expect(xs[0]).toBeLessThan(xs[1]);
      expect(xs[1]).toBeLessThan(xs[2]);
    });

    it('renders 2 edges for 3-tier chain', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      const edgeCount = (svg.match(/<path class="dag-graph-edge/g) || [])
        .length;
      expect(edgeCount).toBe(2);
    });

    it('includes repo names as text labels', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      expect(svg).toContain('shared-lib');
      expect(svg).toContain('backend');
      expect(svg).toContain('frontend');
    });

    it('renders nodes with status-derived CSS classes', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      expect(svg).toContain('dag-graph-node--status-completed');
      expect(svg).toContain('dag-graph-node--status-running');
      expect(svg).toContain('dag-graph-node--status-pending');
    });
  });

  describe('layout — diamond DAG', () => {
    it('places 4 nodes across 3 tiers', () => {
      const { nodes } = dagGraphView(diamondDag, { mode: 'navigate' });
      expect(nodes).toHaveLength(4);
      const coreNode = nodes.find((n) => n.name === 'core');
      const apiNode = nodes.find((n) => n.name === 'api');
      const webNode = nodes.find((n) => n.name === 'web');
      const appNode = nodes.find((n) => n.name === 'app');
      expect(coreNode.x).toBeLessThan(apiNode.x);
      expect(apiNode.x).toBe(webNode.x);
      expect(apiNode.x).toBeLessThan(appNode.x);
    });

    it('places api and web in same tier column at different y', () => {
      const { nodes } = dagGraphView(diamondDag, { mode: 'navigate' });
      const apiNode = nodes.find((n) => n.name === 'api');
      const webNode = nodes.find((n) => n.name === 'web');
      expect(apiNode.x).toBe(webNode.x);
      expect(apiNode.y).not.toBe(webNode.y);
    });

    it('renders 4 edges for diamond shape', () => {
      const { svg } = dagGraphView(diamondDag, { mode: 'navigate' });
      const edgeCount = (svg.match(/<path class="dag-graph-edge/g) || [])
        .length;
      expect(edgeCount).toBe(4);
    });
  });

  describe('mode — navigate', () => {
    it('attaches data-action="navigate" to nodes', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      expect(svg).toContain('data-action="navigate"');
    });

    it('uses status-derived edge stroke colors', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      expect(svg).toContain('var(--status-completed)');
      expect(svg).toContain('var(--status-running)');
    });

    it('sets cursor:pointer on nodes', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      expect(svg).toContain('cursor:pointer');
    });
  });

  describe('mode — edit', () => {
    it('attaches data-action="edit" to nodes', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'edit' });
      expect(svg).toContain('data-action="edit"');
    });

    it('uses neutral grey edge stroke for all edges', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'edit' });
      const edges = svg.match(/<path class="dag-graph-edge[^"]*"[^/]*/g) || [];
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge).toContain('var(--border)');
        expect(edge).not.toContain('var(--status-');
      }
    });

    it('sets cursor:pointer on nodes', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'edit' });
      expect(svg).toContain('cursor:pointer');
    });
  });

  describe('mode — preview', () => {
    it('does not attach data-action to nodes', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'preview' });
      expect(svg).not.toContain('data-action=');
    });

    it('uses neutral grey edge stroke for all edges', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'preview' });
      const edges = svg.match(/<path class="dag-graph-edge[^"]*"[^/]*/g) || [];
      for (const edge of edges) {
        expect(edge).toContain('var(--border)');
      }
    });

    it('does not set cursor:pointer on nodes', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'preview' });
      expect(svg).not.toContain('cursor:pointer');
    });
  });

  describe('edge rendering', () => {
    it('renders Bezier curves (C command in path d)', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      const paths =
        svg.match(/<path class="dag-graph-edge[^"]*" d="[^"]*"/g) || [];
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p).toMatch(/d="M\d+,\d+ C/);
      }
    });

    it('draws edges from source right edge to target left edge', () => {
      const { svg, nodes } = dagGraphView(
        {
          projects: [
            { name: 'a', status: 'completed', depends_on: [] },
            { name: 'b', status: 'pending', depends_on: ['a'] },
          ],
        },
        { mode: 'navigate' },
      );
      const aNode = nodes.find((n) => n.name === 'a');
      const pathMatch = svg.match(/d="M(\d+),(\d+) C/);
      expect(pathMatch).not.toBeNull();
      const startX = Number.parseInt(pathMatch[1], 10);
      expect(startX).toBe(aNode.x + aNode.w);
    });
  });

  describe('node metadata', () => {
    it('includes name, x, y, w, h, tier in node list', () => {
      const { nodes } = dagGraphView(linearChain, { mode: 'navigate' });
      for (const node of nodes) {
        expect(node).toHaveProperty('name');
        expect(node).toHaveProperty('x');
        expect(node).toHaveProperty('y');
        expect(node).toHaveProperty('w');
        expect(node).toHaveProperty('h');
        expect(node).toHaveProperty('tier');
      }
    });

    it('assigns correct tier indices', () => {
      const { nodes } = dagGraphView(linearChain, { mode: 'navigate' });
      const lib = nodes.find((n) => n.name === 'shared-lib');
      const be = nodes.find((n) => n.name === 'backend');
      const fe = nodes.find((n) => n.name === 'frontend');
      expect(lib.tier).toBe(0);
      expect(be.tier).toBe(1);
      expect(fe.tier).toBe(2);
    });
  });

  describe('SVG structure', () => {
    it('wraps output in svg element with viewBox', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      expect(svg).toMatch(/^<svg xmlns=/);
      expect(svg).toContain('viewBox=');
    });

    it('renders nodes with rounded rect', () => {
      const { svg } = dagGraphView(linearChain, { mode: 'navigate' });
      expect(svg).toContain('rx="6"');
    });

    it('escapes special characters in repo names', () => {
      const { svg } = dagGraphView(
        {
          projects: [
            { name: 'lib<script>', status: 'pending', depends_on: [] },
          ],
        },
        { mode: 'preview' },
      );
      expect(svg).toContain('lib&lt;script&gt;');
      expect(svg).not.toContain('lib<script>');
    });
  });

  describe('single repo (no edges)', () => {
    it('renders one node with no edges', () => {
      const { svg, nodes } = dagGraphView(
        { projects: [{ name: 'solo', status: 'completed', depends_on: [] }] },
        { mode: 'navigate' },
      );
      expect(nodes).toHaveLength(1);
      const edgeCount = (svg.match(/<path class="dag-graph-edge/g) || [])
        .length;
      expect(edgeCount).toBe(0);
    });
  });
});
