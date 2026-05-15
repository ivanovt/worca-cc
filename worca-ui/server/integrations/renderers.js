/**
 * Tier 1 event renderers — map pipeline event envelopes to NormalizedMessage.
 * Uses markdown segments so each adapter converts to its native format.
 * @module renderers
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {string} value @returns {import('./adapter.js').MessageSegment} */
const md = (value) => ({ kind: 'markdown', value });

function fmtMs(ms) {
  if (ms == null) return null;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function fmtUsd(usd) {
  if (usd == null) return null;
  return `$${Number(usd).toFixed(2)}`;
}

function runId(envelope) {
  return envelope.run_id ?? 'run';
}

function mdMsg(text, severity) {
  return { title: null, body: [md(text)], severity };
}

// ---------------------------------------------------------------------------
// Per-event renderers
// ---------------------------------------------------------------------------

function renderRunStarted(envelope) {
  const p = envelope.payload;
  const title = p.title ?? p.prompt ?? '';
  const label = title.length > 60 ? `${title.slice(0, 60)}\u2026` : title;
  const parts = [`\u{1F7E2} **Run:** \`${runId(envelope)}\``];
  if (label) parts.push(`   **Title:** ${label}`);
  parts.push('   **Status:** started');
  return mdMsg(parts.join('\n'), 'info');
}

function renderRunCompleted(envelope) {
  const p = envelope.payload;
  const parts = [`\u2705 **Run:** \`${runId(envelope)}\``];
  if (p.title) parts.push(`   **Title:** ${p.title}`);
  parts.push('   **Status:** completed');
  const dur = fmtMs(p.duration_ms);
  if (dur) parts.push(`   **Duration:** ${dur}`);
  const cost = fmtUsd(p.total_cost_usd);
  if (cost) parts.push(`   **Cost:** ${cost}`);
  return mdMsg(parts.join('\n'), 'success');
}

function renderRunFailed(envelope) {
  const p = envelope.payload;
  const errLabel = p.error_type ?? p.error ?? 'error';
  const stage = p.failed_stage ?? 'unknown';
  const parts = [`\u{1F534} **Run:** \`${runId(envelope)}\``];
  if (p.title) parts.push(`   **Title:** ${p.title}`);
  parts.push(`   **Status:** failed at ${stage}`);
  parts.push(`   **Error:** ${errLabel}`);
  return mdMsg(parts.join('\n'), 'error');
}

function renderRunInterrupted(envelope) {
  const p = envelope.payload;
  const stage = p.interrupted_stage ?? 'unknown';
  const parts = [`\u{1F534} **Run:** \`${runId(envelope)}\``];
  parts.push(`   **Status:** interrupted at ${stage}`);
  const dur = fmtMs(p.elapsed_ms);
  if (dur) parts.push(`   **Duration:** ${dur}`);
  return mdMsg(parts.join('\n'), 'warning');
}

function renderRunPaused(envelope) {
  const p = envelope.payload;
  const stage = p.stage ?? '';
  const parts = [`\u{1F7E1} **Run:** \`${runId(envelope)}\``];
  const statusLine = stage ? `paused at ${stage}` : 'paused';
  parts.push(`   **Status:** ${statusLine}`);
  return mdMsg(parts.join('\n'), 'warning');
}

function renderRunResumed(envelope) {
  const parts = [`\u{1F7E2} **Run:** \`${runId(envelope)}\``];
  parts.push('   **Status:** resumed');
  return mdMsg(parts.join('\n'), 'info');
}

function renderRunResumedFromPause(envelope) {
  const parts = [`\u{1F7E2} **Run:** \`${runId(envelope)}\``];
  parts.push('   **Status:** resumed from pause');
  return mdMsg(parts.join('\n'), 'info');
}

function renderStageStarted(envelope) {
  const p = envelope.payload;
  const iterPart = p.iteration ? ` (iteration ${p.iteration})` : '';
  const parts = [`\u2699 **Run:** \`${runId(envelope)}\``];
  parts.push(`   **Stage:** ${p.stage ?? 'unknown'}${iterPart}`);
  return mdMsg(parts.join('\n'), 'info');
}

function renderStageCompleted(envelope) {
  const p = envelope.payload;
  const parts = [`\u2705 **Run:** \`${runId(envelope)}\``];
  parts.push(`   **Stage:** ${p.stage ?? 'unknown'} completed`);
  const dur = fmtMs(p.duration_ms);
  if (dur) parts.push(`   **Duration:** ${dur}`);
  return mdMsg(parts.join('\n'), 'success');
}

function renderStageInterrupted(envelope) {
  const p = envelope.payload;
  const parts = [`\u23F8 **Run:** \`${runId(envelope)}\``];
  parts.push(`   **Stage:** ${p.stage ?? 'unknown'} interrupted`);
  return mdMsg(parts.join('\n'), 'warning');
}

function renderGitPrCreated(envelope) {
  const p = envelope.payload;
  const parts = [`\u{1F500} **Run:** \`${runId(envelope)}\``];
  parts.push(`   **PR:** [#${p.pr_number}](${p.pr_url}) \u2014 ${p.title}`);
  return mdMsg(parts.join('\n'), 'info');
}

function renderGitPrMerged(envelope) {
  const p = envelope.payload;
  const parts = [`\u2705 **PR merged:** [#${p.pr_number}](${p.pr_url})`];
  return mdMsg(parts.join('\n'), 'success');
}

function renderCbTripped(envelope) {
  const p = envelope.payload;
  const parts = [`\u26A0 **Run:** \`${runId(envelope)}\``];
  parts.push(
    `   **Circuit breaker:** ${p.consecutive_failures}\u00D7 ${p.category} \u2014 run halted`,
  );
  return mdMsg(parts.join('\n'), 'error');
}

function renderCostBudgetWarning(envelope) {
  const p = envelope.payload;
  const pct = Math.round(p.pct_used * 100);
  const parts = [`\u{1F4B8} **Run:** \`${runId(envelope)}\``];
  parts.push(`   **Budget:** ${pct}% of ${fmtUsd(p.budget_usd)} used`);
  return mdMsg(parts.join('\n'), 'warning');
}

// ---------------------------------------------------------------------------
// Fleet event renderers
// ---------------------------------------------------------------------------
// Mirror the run-event renderers' shape: short title line + indented meta
// rows. fleet_id replaces run_id as the primary key; envelopes are
// fleet-shaped (top-level fleet_id, no `pipeline` wrapper). See
// src/worca/events/fleet_emitter.py for the envelope schema.

function fleetId(envelope) {
  return envelope.fleet_id ?? 'fleet';
}

function projectBasename(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

function renderFleetLaunched(envelope) {
  const p = envelope.payload ?? {};
  const projects = Array.isArray(p.projects) ? p.projects : [];
  const projectsLabel = projects.length
    ? projects.slice(0, 5).map(projectBasename).join(', ') +
      (projects.length > 5 ? `, +${projects.length - 5} more` : '')
    : '(none)';
  const parts = [`\u{1F680} **Fleet launched:** \`${fleetId(envelope)}\``];
  parts.push(`   **Projects:** ${projects.length} — ${projectsLabel}`);
  if (p.plan_mode && p.plan_mode !== 'none') {
    parts.push(`   **Plan mode:** ${p.plan_mode}`);
  }
  if (p.guide_attached) parts.push('   **Guide:** attached');
  if (p.base_branch) parts.push(`   **Base:** ${p.base_branch}`);
  return mdMsg(parts.join('\n'), 'info');
}

function renderFleetHalted(envelope) {
  const p = envelope.payload ?? {};
  const reason = p.halt_reason || 'unknown';
  // Severity matches the reason: circuit_breaker is an error, user/stopped is
  // a warning. Keeps Slack/Discord colour coding consistent with the per-run
  // pipeline.run.interrupted vs pipeline.circuit_breaker.tripped split.
  const sev = reason === 'circuit_breaker' ? 'error' : 'warning';
  const parts = [`\u{1F6D1} **Fleet halted:** \`${fleetId(envelope)}\``];
  parts.push(`   **Reason:** ${reason}`);
  if (p.in_flight_count != null) {
    parts.push(`   **In-flight at halt:** ${p.in_flight_count}`);
  }
  if (p.pending_count != null && p.pending_count > 0) {
    parts.push(`   **Pending (not dispatched):** ${p.pending_count}`);
  }
  return mdMsg(parts.join('\n'), sev);
}

function renderFleetCompleted(envelope) {
  const p = envelope.payload ?? {};
  const parts = [`✅ **Fleet completed:** \`${fleetId(envelope)}\``];
  if (p.child_count != null) {
    parts.push(
      `   **Children:** ${p.completed_count ?? p.child_count}/${p.child_count} completed`,
    );
  }
  if (p.duration_ms != null) {
    parts.push(`   **Duration:** ${fmtMs(p.duration_ms)}`);
  }
  return mdMsg(parts.join('\n'), 'success');
}

function renderFleetFailed(envelope) {
  const p = envelope.payload ?? {};
  const parts = [`❌ **Fleet failed:** \`${fleetId(envelope)}\``];
  if (p.child_count != null) {
    const failed = p.failed_count ?? 0;
    const interrupted = p.interrupted_count ?? 0;
    const completed = p.completed_count ?? 0;
    parts.push(
      `   **Children:** ${completed}/${p.child_count} completed, ${failed} failed, ${interrupted} interrupted`,
    );
  }
  if (p.duration_ms != null) {
    parts.push(`   **Duration:** ${fmtMs(p.duration_ms)}`);
  }
  return mdMsg(parts.join('\n'), 'error');
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const EVENT_RENDERERS = {
  'pipeline.run.started': renderRunStarted,
  'pipeline.run.completed': renderRunCompleted,
  'pipeline.run.failed': renderRunFailed,
  'pipeline.run.interrupted': renderRunInterrupted,
  'pipeline.run.paused': renderRunPaused,
  'pipeline.run.resumed': renderRunResumed,
  'pipeline.run.resumed_from_pause': renderRunResumedFromPause,
  'pipeline.stage.started': renderStageStarted,
  'pipeline.stage.completed': renderStageCompleted,
  'pipeline.stage.interrupted': renderStageInterrupted,
  'pipeline.git.pr_created': renderGitPrCreated,
  'pipeline.git.pr_merged': renderGitPrMerged,
  'pipeline.circuit_breaker.tripped': renderCbTripped,
  'pipeline.cost.budget_warning': renderCostBudgetWarning,
  // fleet.launched is intentionally NOT in this map by default — projects
  // that launch many fleets per day would find it noisy. Opt-in callers
  // can register it themselves via renderEvent's renderer override (or
  // by extending TIER1_EVENTS in a future per-project config).
  'fleet.halted': renderFleetHalted,
  'fleet.completed': renderFleetCompleted,
  'fleet.failed': renderFleetFailed,
};

// fleet.launched ships as an opt-in renderer rather than a Tier-1 default —
// see comment above. Callers that want it can pull it from this export and
// register it in their own pipeline.
export const OPT_IN_RENDERERS = {
  'fleet.launched': renderFleetLaunched,
};

export const TIER1_EVENTS = Object.keys(EVENT_RENDERERS);

/**
 * Map a pipeline event envelope to a NormalizedMessage.
 * Returns null for unrecognised event types.
 *
 * @param {object|null|undefined} envelope - event envelope (event_type, run_id, payload)
 * @returns {import('./adapter.js').NormalizedMessage|null}
 */
export function renderEvent(envelope) {
  const renderer = EVENT_RENDERERS[envelope?.event_type];
  if (!renderer) return null;
  return renderer(envelope);
}
