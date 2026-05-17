/**
 * Workspace-scoped chat commands.
 *
 *   /workspaces                       list active workspaces
 *   /workspace [id|last]              show one workspace's summary
 *   /workspace-projects <id|last>     per-project status grid (DAG)
 *   /workspace-tiers <id|last>        tier-by-tier DAG status
 *   /workspace-halt <id>              graceful halt (in-flight finish naturally)
 *   /workspace-resume <id>            re-dispatch failed/halted children
 *   /workspace-prs <id>               list child PRs + umbrella issue
 *
 * Mirrors the fleet command surface, but uses workspace terminology — the
 * unit of work is a named project entry in workspace.json, not an arbitrary
 * project path. /workspace-pause and /workspace-stop are intentionally
 * absent: workspaces don't yet have pause/stop infrastructure (only halt
 * via DELETE). When the lifecycle gains those, add commands here.
 *
 * Authz: every handler runs *after* the inbound allowlist gate in
 * index.js — same gate that already guards /pause, /resume, /stop.
 *
 * @module commands/workspace
 */

import { statusEmoji } from './global.js';

function pickLatest(workspaces) {
  if (!workspaces || workspaces.length === 0) return null;
  return [...workspaces].sort((a, b) => {
    const at = a.created_at || '';
    const bt = b.created_at || '';
    return bt.localeCompare(at);
  })[0];
}

async function fetchWorkspaces(restClient) {
  const resp = await restClient.get('/api/workspace-runs');
  const data = resp.data;
  if (!data || data.ok === false) return [];
  return Array.isArray(data.workspace_runs) ? data.workspace_runs : [];
}

async function fetchWorkspaceById(restClient, id) {
  const resp = await restClient.get(
    `/api/workspace-runs/${encodeURIComponent(id)}`,
  );
  const data = resp.data;
  if (!data || data.ok === false) return null;
  // GET /:id returns { ok, manifest, cost_usd } — flatten to a single object
  // with the shape /workspace-runs list emits, so downstream formatters can
  // be uniform.
  if (data.manifest) {
    return { ...data.manifest, cost_usd: data.cost_usd };
  }
  return null;
}

/**
 * Resolve "last" / short-suffix / full-id into a workspace manifest object.
 * Returns { workspace, disambig } — exactly one of them populated.
 */
async function resolveWorkspace(restClient, idArg, command) {
  if (!idArg || idArg === 'last') {
    const all = await fetchWorkspaces(restClient);
    const latest = pickLatest(all);
    if (!latest) return { disambig: 'No workspaces found.' };
    return { workspace: latest };
  }
  if (idArg.startsWith('ws_')) {
    const workspace = await fetchWorkspaceById(restClient, idArg);
    if (!workspace) return { disambig: `Workspace \`${idArg}\` not found.` };
    return { workspace };
  }
  // Short suffix match — `4318dbf9` matches `ws_..._4318dbf9`.
  const all = await fetchWorkspaces(restClient);
  const matches = all.filter((w) => w.workspace_id?.endsWith(idArg));
  if (matches.length === 0) {
    return { disambig: `No workspace matches \`${idArg}\`.` };
  }
  if (matches.length > 1) {
    const lines = matches.map(
      (w) => `   • \`${w.workspace_id}\` — ${w.status}`,
    );
    return {
      disambig:
        `Multiple workspaces match \`${idArg}\`:\n${lines.join('\n')}\n\n` +
        `Usage: /${command} <workspace_id>`,
    };
  }
  return { workspace: matches[0] };
}

function fmtWorkspaceSummary(ws) {
  const id = ws.workspace_id;
  const name = ws.workspace_name ? ` (${ws.workspace_name})` : '';
  const status = ws.status || 'unknown';
  const reason = ws.halt_reason ? ` (${ws.halt_reason})` : '';
  const children = ws.children || [];
  const childCount = ws.children_count ?? children.length;
  const completed = children.filter((c) => c.status === 'completed').length;
  const failed = children.filter(
    (c) =>
      c.status === 'failed' ||
      c.status === 'blocked' ||
      c.status === 'setup_failed',
  ).length;
  const parts = [`${statusEmoji(status)} **Workspace:** \`${id}\`${name}`];
  parts.push(`   **Status:** ${status}${reason}`);
  parts.push(
    `   **Projects:** ${completed}/${childCount} completed${failed ? `, ${failed} failed` : ''}`,
  );
  const tiers = ws.dag?.tiers || [];
  if (tiers.length > 0) {
    parts.push(`   **Tiers:** ${tiers.length}`);
  }
  if (ws.cost_usd != null) {
    parts.push(`   **Cost:** $${Number(ws.cost_usd).toFixed(2)}`);
  }
  return parts.join('\n');
}

function fmtProjectsTable(ws) {
  const children = ws.children || [];
  if (children.length === 0) return '   (no projects dispatched yet)';
  return children
    .map((c) => {
      const project = c.project || '(?)';
      const st = c.status || 'unknown';
      const rid = c.run_id ? ` \`${c.run_id}\`` : '';
      const tier = c.tier != null ? ` [tier ${c.tier}]` : '';
      return `   ${statusEmoji(st)} **${project}**${tier} — ${st}${rid}`;
    })
    .join('\n');
}

function fmtTiersTable(ws) {
  const tiers = ws.dag?.tiers || [];
  if (tiers.length === 0) return '   (no tiers defined)';
  const childByProject = new Map();
  for (const c of ws.children || []) {
    childByProject.set(c.project, c);
  }
  return tiers
    .map((t) => {
      const projects = t.projects || [];
      const lines = projects.map((p) => {
        const child = childByProject.get(p);
        const st = child?.status || 'pending';
        return `      ${statusEmoji(st)} ${p} — ${st}`;
      });
      const tierStatus = t.status || 'pending';
      return [`   **Tier ${t.tier} (${tierStatus}):**`, ...lines].join('\n');
    })
    .join('\n');
}

function fmtPrsTable(ws) {
  const children = ws.children || [];
  const withPrs = children.filter((c) => c.pr_number || c.pr_url);
  if (withPrs.length === 0 && !ws.umbrella_issue) {
    return '   (no PRs created yet)';
  }
  const lines = [];
  for (const c of withPrs) {
    const ref = c.nwo && c.pr_number ? `${c.nwo}#${c.pr_number}` : c.pr_url;
    lines.push(`   • **${c.project}** — ${ref}`);
  }
  if (ws.umbrella_issue?.url) {
    lines.push('');
    lines.push(`   \u{1F517} **Umbrella issue:** ${ws.umbrella_issue.url}`);
  }
  return lines.join('\n');
}

/**
 * Creates handlers for the /workspace… commands.
 *
 * The chatContext is used to remember an `active_workspace` per chat,
 * symmetrical to the existing `active_project` mechanism — so a user can
 * `/workspace ws_…_abc` once, then `/workspace-halt` (no arg) on the same
 * one. Implementation left for a follow-up if/when the UX warrants it.
 *
 * @param {{ chatContext, restClient }} deps
 */
export function createWorkspaceHandlers({
  chatContext: _chatContext,
  restClient,
}) {
  async function workspaces() {
    const all = await fetchWorkspaces(restClient);
    const active = all.filter((w) => {
      const s = w.status;
      return (
        s === 'running' ||
        s === 'planning' ||
        s === 'integration_testing' ||
        s === 'resuming' ||
        s === 'paused'
      );
    });
    if (active.length === 0) return 'No active workspaces.';
    const lines = active.map((w) => {
      const childCount = w.children_count ?? w.children?.length ?? 0;
      const name = w.workspace_name ? ` (${w.workspace_name})` : '';
      const reason = w.halt_reason ? ` (${w.halt_reason})` : '';
      return [
        `${statusEmoji(w.status)} **Workspace:** \`${w.workspace_id}\`${name}`,
        `   **Status:** ${w.status}${reason} | **Projects:** ${childCount}`,
      ].join('\n');
    });
    return `Active workspaces:\n\n${lines.join('\n')}`;
  }

  async function workspace(_chatKey, args) {
    const resolved = await resolveWorkspace(restClient, args[0], 'workspace');
    if (resolved.disambig) return resolved.disambig;
    return fmtWorkspaceSummary(resolved.workspace);
  }

  async function workspaceProjects(_chatKey, args) {
    const resolved = await resolveWorkspace(
      restClient,
      args[0],
      'workspace-projects',
    );
    if (resolved.disambig) return resolved.disambig;
    const w = resolved.workspace;
    return `Projects in \`${w.workspace_id}\`:\n\n${fmtProjectsTable(w)}`;
  }

  async function workspaceTiers(_chatKey, args) {
    const resolved = await resolveWorkspace(
      restClient,
      args[0],
      'workspace-tiers',
    );
    if (resolved.disambig) return resolved.disambig;
    const w = resolved.workspace;
    return `DAG tiers for \`${w.workspace_id}\`:\n\n${fmtTiersTable(w)}`;
  }

  async function workspaceHalt(_chatKey, args) {
    const resolved = await resolveWorkspace(
      restClient,
      args[0],
      'workspace-halt',
    );
    if (resolved.disambig) return resolved.disambig;
    const id = resolved.workspace.workspace_id;
    const resp = await restClient.delete(
      `/api/workspace-runs/${encodeURIComponent(id)}`,
    );
    if (!resp.data || resp.data.ok === false) {
      return `Failed to halt workspace \`${id}\` (${resp.status}).`;
    }
    return `\u{1F7E1} Halted workspace \`${id}\`.\nIn-flight tier children will finish naturally.`;
  }

  async function workspaceResume(_chatKey, args) {
    const resolved = await resolveWorkspace(
      restClient,
      args[0],
      'workspace-resume',
    );
    if (resolved.disambig) return resolved.disambig;
    const id = resolved.workspace.workspace_id;
    const resp = await restClient.post(
      `/api/workspace-runs/${encodeURIComponent(id)}/resume`,
    );
    if (!resp.data || resp.data.ok === false) {
      return `Failed to resume workspace \`${id}\` (${resp.status}).`;
    }
    return `\u{1F7E2} Resumed workspace \`${id}\`. Re-dispatching pending project(s).`;
  }

  async function workspacePrs(_chatKey, args) {
    const resolved = await resolveWorkspace(
      restClient,
      args[0],
      'workspace-prs',
    );
    if (resolved.disambig) return resolved.disambig;
    const w = resolved.workspace;
    return `PRs for \`${w.workspace_id}\`:\n\n${fmtPrsTable(w)}`;
  }

  return {
    workspaces,
    workspace,
    'workspace-projects': workspaceProjects,
    'workspace-tiers': workspaceTiers,
    'workspace-halt': workspaceHalt,
    'workspace-resume': workspaceResume,
    'workspace-prs': workspacePrs,
  };
}
