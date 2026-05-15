import { statusClass } from '../utils/status-badge.js';

const NODE_W = 140;
const NODE_H = 40;
const H_GAP = 60;
const V_GAP = 24;
const PADDING = 16;

const STATUS_COLOR = {
  'status-pending': 'var(--status-pending)',
  'status-running': 'var(--status-running)',
  'status-completed': 'var(--status-completed)',
  'status-failed': 'var(--status-failed)',
  'status-paused': 'var(--status-paused)',
  'status-blocked': 'var(--status-blocked)',
  'status-planning': 'var(--status-running)',
  'status-integration-testing': 'var(--status-running)',
  'status-integration-failed': 'var(--status-failed)',
};

function statusColor(status) {
  const cls = statusClass(status);
  return STATUS_COLOR[cls] || 'var(--status-pending)';
}

export function dagGraphView(dag, options = {}) {
  if (!dag || !dag.repos || dag.repos.length === 0) {
    return { svg: '', nodes: [] };
  }

  const { mode = 'preview' } = options;
  const repos = dag.repos;
  const repoByName = new Map(repos.map((r) => [r.name, r]));
  const tiers = computeTiers(repos);

  const tierGroups = new Map();
  for (const [name, tier] of tiers) {
    if (!tierGroups.has(tier)) tierGroups.set(tier, []);
    tierGroups.get(tier).push(repoByName.get(name));
  }

  const maxTier = Math.max(...tiers.values(), 0);
  const maxPerTier = Math.max(
    ...[...tierGroups.values()].map((g) => g.length),
    1,
  );
  const svgW = Math.round(PADDING * 2 + (maxTier + 1) * (NODE_W + H_GAP));
  const svgH = Math.round(PADDING * 2 + maxPerTier * (NODE_H + V_GAP));

  const positions = new Map();
  for (const [tier, group] of tierGroups) {
    for (let i = 0; i < group.length; i++) {
      positions.set(group[i].name, {
        x: Math.round(PADDING + tier * (NODE_W + H_GAP)),
        y: Math.round(PADDING + i * (NODE_H + V_GAP)),
      });
    }
  }

  let edges = '';
  for (const repo of repos) {
    const to = positions.get(repo.name);
    if (!to) continue;
    for (const depName of repo.depends_on) {
      const from = positions.get(depName);
      if (!from) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const cx = Math.round((x1 + x2) / 2);
      const dep = repoByName.get(depName);
      const stroke =
        mode === 'navigate' && dep ? statusColor(dep.status) : 'var(--border)';
      edges += `<path class="dag-graph-edge" d="M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}" fill="none" stroke="${stroke}" stroke-width="2"/>`;
    }
  }

  let nodes = '';
  const nodeList = [];
  const interactive = mode === 'navigate' || mode === 'edit';
  const action =
    mode === 'navigate' ? 'navigate' : mode === 'edit' ? 'edit' : null;
  const cursorStyle = interactive ? ' style="cursor:pointer"' : '';
  const actionAttr = action ? ` data-action="${action}"` : '';

  for (const repo of repos) {
    const pos = positions.get(repo.name);
    if (!pos) continue;
    const sc = statusClass(repo.status);
    const fill = statusColor(repo.status);
    const label =
      repo.name.length > 18 ? `${repo.name.slice(0, 18)}...` : repo.name;
    nodes += `<g class="dag-graph-node dag-graph-node--${sc}" transform="translate(${pos.x},${pos.y})"${actionAttr} data-repo="${escapeXml(repo.name)}"${cursorStyle}>`;
    nodes += `<rect width="${NODE_W}" height="${NODE_H}" rx="6" fill="${fill}" fill-opacity="0.15" stroke="${fill}" stroke-width="1.5"/>`;
    nodes += `<text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}" text-anchor="middle" font-size="12" fill="currentColor">${escapeXml(label)}</text>`;
    nodes += '</g>';
    nodeList.push({
      name: repo.name,
      x: pos.x,
      y: pos.y,
      w: NODE_W,
      h: NODE_H,
      tier: tiers.get(repo.name),
    });
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">${edges}${nodes}</svg>`;
  return { svg, nodes: nodeList };
}

function computeTiers(repos) {
  const inDegree = new Map();
  const dependents = new Map();
  for (const r of repos) {
    inDegree.set(r.name, 0);
    dependents.set(r.name, []);
  }
  for (const r of repos) {
    for (const dep of r.depends_on) {
      inDegree.set(r.name, (inDegree.get(r.name) || 0) + 1);
      if (dependents.has(dep)) {
        dependents.get(dep).push(r.name);
      }
    }
  }

  const tiers = new Map();
  let queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([name]) => name)
    .sort();
  let tier = 0;

  while (queue.length > 0) {
    const next = [];
    for (const name of queue) {
      tiers.set(name, tier);
      for (const dep of dependents.get(name) || []) {
        inDegree.set(dep, inDegree.get(dep) - 1);
        if (inDegree.get(dep) === 0) next.push(dep);
      }
    }
    queue = next.sort();
    tier++;
  }

  return tiers;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
