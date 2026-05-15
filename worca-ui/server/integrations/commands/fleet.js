/**
 * Fleet-scoped chat commands.
 *
 *   /fleets                      list active fleets (running + paused)
 *   /fleet [id|last]             show one fleet's status
 *   /fleet-children <id|last>    per-child status table
 *   /fleet-halt <id>             graceful halt (in-flight finish naturally)
 *   /fleet-stop <id> [--force]   hard stop (SIGTERM + control file), with confirmation
 *   /fleet-pause <id>            pause every in-flight child
 *   /fleet-resume <id>           resume paused/interrupted children, re-dispatch failed
 *
 * Authz: every handler runs *after* the inbound allowlist gate in
 * index.js — same gate that already guards /pause, /resume, /stop.
 *
 * Destructive actions (/fleet-stop) require a confirmation token written
 * into chat_context with a 60s expiry. The token mechanism is local to
 * this module so we don't bloat chat_context.js's public API for what is
 * really a per-command UX concern.
 *
 * @module commands/fleet
 */

import { statusEmoji } from './global.js';

const CONFIRM_TTL_MS = 60_000;

/** Pick the most recent fleet from a list (created_at desc). */
function pickLatest(fleets) {
  if (!fleets || fleets.length === 0) return null;
  return [...fleets].sort((a, b) => {
    const at = a.created_at || '';
    const bt = b.created_at || '';
    return bt.localeCompare(at);
  })[0];
}

async function fetchFleets(restClient) {
  const resp = await restClient.get('/api/fleet-runs');
  const data = resp.data;
  if (!data || data.ok === false) return [];
  return Array.isArray(data.fleets) ? data.fleets : [];
}

async function fetchFleetById(restClient, id) {
  const resp = await restClient.get(
    `/api/fleet-runs/${encodeURIComponent(id)}`,
  );
  const data = resp.data;
  if (!data || data.ok === false) return null;
  return data.fleet ?? null;
}

/**
 * Resolve "last" / short-suffix / full-id into a fleet manifest object.
 * Returns { fleet, disambig } — exactly one of them populated.
 */
async function resolveFleet(restClient, idArg, command) {
  if (!idArg || idArg === 'last') {
    const all = await fetchFleets(restClient);
    const latest = pickLatest(all);
    if (!latest) return { disambig: 'No fleets found.' };
    return { fleet: latest };
  }
  if (idArg.startsWith('f_')) {
    const fleet = await fetchFleetById(restClient, idArg);
    if (!fleet) return { disambig: `Fleet \`${idArg}\` not found.` };
    return { fleet };
  }
  // Short suffix match — `4318dbf9` matches `f_..._4318dbf9`.
  const all = await fetchFleets(restClient);
  const matches = all.filter((f) => f.fleet_id?.endsWith(idArg));
  if (matches.length === 0) {
    return { disambig: `No fleet matches \`${idArg}\`.` };
  }
  if (matches.length > 1) {
    const lines = matches.map((f) => `   • \`${f.fleet_id}\` — ${f.status}`);
    return {
      disambig:
        `Multiple fleets match \`${idArg}\`:\n${lines.join('\n')}\n\n` +
        `Usage: /${command} <fleet_id>`,
    };
  }
  return { fleet: matches[0] };
}

function fmtFleetSummary(fleet) {
  const id = fleet.fleet_id;
  const title = fleet.work_request?.title || '(no title)';
  const status = fleet.status || 'unknown';
  const reason = fleet.halt_reason ? ` (${fleet.halt_reason})` : '';
  const childCount = fleet.children_count ?? fleet.children?.length ?? 0;
  const completed = (fleet.children || []).filter(
    (c) => c.status === 'completed',
  ).length;
  const failed = (fleet.children || []).filter(
    (c) => c.status === 'failed' || c.status === 'setup_failed',
  ).length;
  const parts = [`${statusEmoji(status)} **Fleet:** \`${id}\``];
  parts.push(`   **Title:** ${title}`);
  parts.push(`   **Status:** ${status}${reason}`);
  parts.push(
    `   **Children:** ${completed}/${childCount} completed${failed ? `, ${failed} failed` : ''}`,
  );
  if (fleet.cost_usd != null) {
    parts.push(`   **Cost:** $${Number(fleet.cost_usd).toFixed(2)}`);
  }
  return parts.join('\n');
}

function fmtChildrenTable(fleet) {
  const children = fleet.children || [];
  if (children.length === 0) return '   (no children dispatched yet)';
  return children
    .map((c) => {
      const project =
        (c.project_path || '').split('/').filter(Boolean).pop() || '(?)';
      const st = c.status || 'unknown';
      const rid = c.run_id ? ` \`${c.run_id}\`` : '';
      return `   ${statusEmoji(st)} **${project}** — ${st}${rid}`;
    })
    .join('\n');
}

/**
 * Creates handlers for the /fleet… commands.
 *
 * The chatContext is used for /fleet-stop confirmation tokens — we store
 * a `pending_fleet_stop = { fleet_id, expires_at }` shape on the chat key
 * and clear it after the confirming message comes in.
 *
 * @param {{ chatContext, restClient }} deps
 */
export function createFleetHandlers({ chatContext, restClient }) {
  async function fleets() {
    const all = await fetchFleets(restClient);
    const active = all.filter((f) => {
      const s = f.status;
      return s === 'running' || s === 'paused' || s === 'resuming';
    });
    if (active.length === 0) return 'No active fleets.';
    const lines = active.map((f) => {
      const childCount = f.children_count ?? f.children?.length ?? 0;
      const title = f.work_request?.title || '(no title)';
      const reason = f.halt_reason ? ` (${f.halt_reason})` : '';
      return [
        `${statusEmoji(f.status)} **Fleet:** \`${f.fleet_id}\``,
        `   **Title:** ${title}`,
        `   **Status:** ${f.status}${reason} | **Children:** ${childCount}`,
      ].join('\n');
    });
    return `Active fleets:\n\n${lines.join('\n')}`;
  }

  async function fleet(_chatKey, args) {
    const resolved = await resolveFleet(restClient, args[0], 'fleet');
    if (resolved.disambig) return resolved.disambig;
    return fmtFleetSummary(resolved.fleet);
  }

  async function fleetChildren(_chatKey, args) {
    const resolved = await resolveFleet(restClient, args[0], 'fleet-children');
    if (resolved.disambig) return resolved.disambig;
    const f = resolved.fleet;
    return `Children of \`${f.fleet_id}\`:\n\n` + fmtChildrenTable(f);
  }

  async function fleetHalt(_chatKey, args) {
    const resolved = await resolveFleet(restClient, args[0], 'fleet-halt');
    if (resolved.disambig) return resolved.disambig;
    const id = resolved.fleet.fleet_id;
    const resp = await restClient.delete(
      `/api/fleet-runs/${encodeURIComponent(id)}`,
    );
    if (!resp.data || resp.data.ok === false) {
      return `Failed to halt fleet \`${id}\` (${resp.status}).`;
    }
    return `\u{1F7E1} Halted fleet \`${id}\`.\nIn-flight children will finish naturally.`;
  }

  async function fleetStop(chatKey, args) {
    const isForce = args.includes('--force') || args.includes('YES');
    const cleanArgs = args.filter((a) => a !== '--force' && a !== 'YES');
    const resolved = await resolveFleet(restClient, cleanArgs[0], 'fleet-stop');
    if (resolved.disambig) return resolved.disambig;
    const id = resolved.fleet.fleet_id;

    const ctx = chatContext.get(chatKey) || {};
    const pending = ctx.pending_fleet_stop;

    if (!isForce) {
      // Issue / refresh a confirmation token.
      chatContext.set(chatKey, {
        pending_fleet_stop: {
          fleet_id: id,
          expires_at: new Date(Date.now() + CONFIRM_TTL_MS).toISOString(),
        },
      });
      const child_count =
        resolved.fleet.children_count ?? (resolved.fleet.children || []).length;
      return (
        `⚠ \`/fleet-stop\` will SIGTERM every in-flight child of fleet \`${id}\` (${child_count} children).\n` +
        `Confirm with \`/fleet-stop ${id} YES\` within 60s, or pass \`--force\`.`
      );
    }

    // --force or YES path. Either matches a fresh confirmation token, or
    // the caller is bypassing the gate entirely with --force.
    if (
      args.includes('YES') &&
      (!pending ||
        pending.fleet_id !== id ||
        new Date(pending.expires_at).getTime() < Date.now())
    ) {
      return `Confirmation expired or never issued for fleet \`${id}\`. Re-run \`/fleet-stop ${id}\` to get a fresh token.`;
    }

    chatContext.set(chatKey, { pending_fleet_stop: null });
    const resp = await restClient.post(
      `/api/fleet-runs/${encodeURIComponent(id)}/stop`,
    );
    if (!resp.data || resp.data.ok === false) {
      return `Failed to stop fleet \`${id}\` (${resp.status}).`;
    }
    const count = resp.data.stopped_count ?? '?';
    return `\u{1F534} Stopped fleet \`${id}\`. SIGTERM sent to ${count} child(ren).`;
  }

  async function fleetPause(_chatKey, args) {
    const resolved = await resolveFleet(restClient, args[0], 'fleet-pause');
    if (resolved.disambig) return resolved.disambig;
    const id = resolved.fleet.fleet_id;
    const resp = await restClient.post(
      `/api/fleet-runs/${encodeURIComponent(id)}/pause`,
    );
    if (!resp.data || resp.data.ok === false) {
      return `Failed to pause fleet \`${id}\` (${resp.status}).`;
    }
    const count = resp.data.paused_count ?? '?';
    return `\u{1F7E1} Paused fleet \`${id}\`. ${count} child(ren) will pause at their next iteration boundary.`;
  }

  async function fleetResume(_chatKey, args) {
    const resolved = await resolveFleet(restClient, args[0], 'fleet-resume');
    if (resolved.disambig) return resolved.disambig;
    const id = resolved.fleet.fleet_id;
    const resp = await restClient.post(
      `/api/fleet-runs/${encodeURIComponent(id)}/resume`,
    );
    if (!resp.data || resp.data.ok === false) {
      return `Failed to resume fleet \`${id}\` (${resp.status}).`;
    }
    const continued = resp.data.continued_count ?? 0;
    const redispatched = resp.data.redispatched_count ?? 0;
    return `\u{1F7E2} Resumed fleet \`${id}\`. ${continued} continued in-place, ${redispatched} re-dispatched.`;
  }

  return {
    fleets,
    fleet,
    'fleet-children': fleetChildren,
    'fleet-halt': fleetHalt,
    'fleet-stop': fleetStop,
    'fleet-pause': fleetPause,
    'fleet-resume': fleetResume,
  };
}
