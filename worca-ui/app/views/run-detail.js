import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { elapsed, formatDuration, formatTimestamp } from '../utils/duration.js';
import { effortLevelBadge } from '../utils/effort-badge.js';
import {
  AlertTriangle,
  CircleCheck,
  ClipboardCopy,
  Clock,
  Coins,
  ExternalLink,
  FileText,
  GitBranch,
  GitPullRequest,
  iconSvg,
  List,
  RefreshCw,
  RotateCcw,
  Timer,
  X,
} from '../utils/icons.js';
import { renderMarkdown } from '../utils/markdown.js';
import { scrollOnExpand } from '../utils/scroll.js';
import { sortByStageOrder } from '../utils/stage-order.js';
import {
  resolveStatus,
  statusClass,
  statusIcon,
} from '../utils/status-badge.js';
import {
  beadsDependencyGraph,
  beadTooltipContent,
  priorityVariant,
  statusVariant,
} from './beads-panel.js';
import { resolveIterationTab } from './stage-tab-memory.js';
import { stageTimelineView } from './stage-timeline.js';

// ── plan artifact: lazy fetch + dialog state ─────────────────────────────
// The PLAN stage's plan_file (or {worktree}/MASTER_PLAN.md) is fetched from
// GET /api/projects/:project/runs/:run_id/plan on first dialog open and
// cached per-run. Same UX shape as the workspace-detail plan dialog: marked
// renders the markdown, .markdown-dialog widens the panel, Copy footer
// hands the raw source back to the user.
const _runPlanCache = new Map(); // run_id -> markdown text | null (404)
const _runPlanFetching = new Set();
let _planDialogRunId = null; // null when closed; run_id when open

function _ensureRunPlanFetched(run, rerender) {
  const runId = run?.id;
  if (!runId) return;
  if (_runPlanCache.has(runId)) return;
  if (_runPlanFetching.has(runId)) return;
  // The run's project name is needed because the endpoint is mounted under
  // /api/projects/:projectId. Run objects carry it as `project` or
  // `_project`; fall back to the legacy /api/runs path for single-project
  // mode where projectId isn't set.
  const project = run.project || run._project || null;
  const url = project
    ? `/api/projects/${encodeURIComponent(project)}/runs/${encodeURIComponent(runId)}/plan`
    : `/api/runs/${encodeURIComponent(runId)}/plan`;
  _runPlanFetching.add(runId);
  fetch(url, { headers: { Accept: 'text/markdown' } })
    .then(async (r) => {
      _runPlanFetching.delete(runId);
      if (!r.ok) {
        _runPlanCache.set(runId, null);
        rerender?.();
        return;
      }
      _runPlanCache.set(runId, await r.text());
      rerender?.();
    })
    .catch(() => {
      _runPlanFetching.delete(runId);
      _runPlanCache.set(runId, null);
      rerender?.();
    });
}

function _copyToClipboardSimple(text) {
  if (!text) return;
  navigator.clipboard?.writeText(text).catch(() => {});
}

// Plan-stage extension: small chip strip + View plan button that opens
// the shared markdown dialog. Wired into the stage panel for key==='plan'.
function _planArtifactView(stage, run, rerender) {
  if (!run?.id) return nothing;
  const planFile = stage?.plan_file || null;
  const skipped = stage?.skipped === true;
  // Show the strip whenever the stage has a plan file path OR a worktree
  // (which lets the server fall back to MASTER_PLAN.md). Hiding it
  // entirely on a stage with no path at all matches the "nothing to
  // show" intent for stages where planning never ran.
  if (!planFile && !run.worktree_path) return nothing;
  return html`
    <div class="plan-artifact-strip">
      ${
        skipped
          ? html`<sl-tag size="small" pill variant="neutral" class="plan-skipped-tag">Skipped — plan supplied by workspace</sl-tag>`
          : nothing
      }
      ${
        planFile
          ? html`<code class="plan-file-chip" title="${planFile}">${planFile.split('/').pop()}</code>`
          : nothing
      }
      <sl-button
        size="small"
        class="btn-view-run-plan"
        @click=${
          rerender
            ? () => {
                _planDialogRunId = run.id;
                _ensureRunPlanFetched(run, rerender);
                rerender();
              }
            : null
        }
      >View plan</sl-button>
    </div>
  `;
}

function _planArtifactDialog(run, rerender) {
  if (!run?.id) return nothing;
  const isOpen = _planDialogRunId === run.id;
  const planText = _runPlanCache.get(run.id) ?? null;
  const fetching = _runPlanFetching.has(run.id);
  const body = (() => {
    if (fetching || (isOpen && planText === undefined)) {
      return html`<div class="plan-loading"><sl-spinner></sl-spinner> Loading plan…</div>`;
    }
    if (planText === null) {
      return html`<div class="plan-error">No plan file found for this run.</div>`;
    }
    return html`<div class="markdown-body">${unsafeHTML(renderMarkdown(planText || ''))}</div>`;
  })();
  return html`
    <sl-dialog
      label="Plan"
      class="run-plan-dialog markdown-dialog"
      ?open=${isOpen}
      @sl-after-hide=${
        rerender
          ? () => {
              _planDialogRunId = null;
              rerender();
            }
          : null
      }
    >
      ${body}
      <div slot="footer">
        ${
          planText
            ? html`
              <sl-button
                class="btn-copy-run-plan"
                @click=${() => _copyToClipboardSimple(planText)}
              >
                <span slot="prefix">${unsafeHTML(iconSvg(ClipboardCopy, 14))}</span>
                Copy
              </sl-button>
            `
            : nothing
        }
        <sl-button
          variant="primary"
          class="btn-close-run-plan"
          @click=${
            rerender
              ? () => {
                  _planDialogRunId = null;
                  rerender();
                }
              : null
          }
        >Close</sl-button>
      </div>
    </sl-dialog>
  `;
}

function _sortedEntries(stages) {
  return sortByStageOrder(Object.entries(stages));
}

/**
 * Format a pipeline_template value for display.
 * Maps "builtin:xxx" to "worca:xxx" for legacy compatibility.
 * Returns null for empty/null/undefined input.
 */
export function formatPipelineTemplate(value) {
  if (!value) return null;
  if (value.startsWith('builtin:'))
    return `worca:${value.slice('builtin:'.length)}`;
  return value;
}

/**
 * Render a stacked horizontal timing bar at the pipeline level.
 * Segments: Thinking (Agent) | Tools (Agent) | Rest of Pipeline
 * 100% = pipeline wall time (started_at → last stage end).
 */
function _pipelineTimingBar(allIters, pipelineWallMs) {
  if (!pipelineWallMs || pipelineWallMs <= 0) return nothing;

  const thinkingMs = allIters.reduce(
    (sum, it) => sum + (it.duration_api_ms || 0),
    0,
  );
  // duration_session_ms = CLI session time. Only fall back to duration_ms for legacy runs
  // where duration_session_ms is undefined. When explicitly 0 (e.g. preflight), don't fall back.
  const sessionMs = allIters.reduce((sum, it) => {
    if (it.duration_session_ms != null) return sum + it.duration_session_ms;
    return sum + (it.duration_ms || 0); // legacy fallback
  }, 0);
  const toolsMs = Math.max(0, sessionMs - thinkingMs);
  const restMs = Math.max(0, pipelineWallMs - sessionMs);

  if (thinkingMs <= 0 && toolsMs <= 0) return nothing;

  const thinkingPct = Math.round((thinkingMs / pipelineWallMs) * 100);
  const toolsPct = Math.round((toolsMs / pipelineWallMs) * 100);
  const restPct = Math.max(0, 100 - thinkingPct - toolsPct);

  const segments = [
    {
      key: 'thinking',
      pct: thinkingPct,
      ms: thinkingMs,
      label: 'Thinking (Agent)',
      desc: 'Time spent on model inference (API round-trips)',
      cls: 'timing-bar-thinking',
    },
    {
      key: 'tools',
      pct: toolsPct,
      ms: toolsMs,
      label: 'Tools (Agent)',
      desc: 'Time spent executing tools (bash, file I/O, subprocesses)',
      cls: 'timing-bar-tools',
    },
    {
      key: 'rest',
      pct: restPct,
      ms: restMs,
      label: 'Rest of Pipeline',
      desc: 'Orchestration, status writes, stage transitions, retry delays',
      cls: 'timing-bar-rest',
    },
  ].filter((s) => s.pct > 0);

  return html`
    <div class="pipeline-timing-bar-container">
      <div class="pipeline-timing-bar">
        ${segments.map(
          (s) => html`
          <sl-tooltip>
            <div slot="content">
              <strong>${s.label}</strong><br>
              ${formatDuration(s.ms)} of ${formatDuration(pipelineWallMs)}<br>
              <span style="opacity:0.7">${s.desc}</span>
            </div>
            <div class="timing-bar-segment ${s.cls}" style="width:${s.pct}%">
              ${
                s.pct >= 15
                  ? html`<span class="timing-bar-segment-text">${s.label} ${s.pct}%</span>`
                  : s.pct >= 8
                    ? html`<span class="timing-bar-segment-text">${s.pct}%</span>`
                    : nothing
              }
            </div>
          </sl-tooltip>
        `,
        )}
      </div>
      <div class="pipeline-timing-bar-legend">
        ${segments.map(
          (s) => html`
          <span class="timing-bar-legend-item">
            <span class="timing-bar-legend-swatch ${s.cls}"></span>
            <span class="timing-bar-legend-label">${s.label}</span>
            <span class="timing-bar-legend-value">${formatDuration(s.ms)} (${s.pct}%)</span>
          </span>
        `,
        )}
      </div>
    </div>
  `;
}

function _lastStageEnd(stages) {
  if (!stages) return null;
  let latest = null;
  for (const s of Object.values(stages)) {
    if (s.completed_at && (!latest || s.completed_at > latest))
      latest = s.completed_at;
  }
  return latest;
}

function _badgeVariant(status) {
  if (status === 'completed') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'in_progress') return 'primary';
  if (status === 'interrupted') return 'warning';
  if (status === 'cancelled') return 'neutral';
  return 'neutral';
}

function _iterStatusIcon(iter) {
  const s = iter.status || 'pending';
  if (s === 'completed' && iter.outcome === 'success')
    return html`<span class="iter-status-icon success">${unsafeHTML(statusIcon('completed', 12))}</span>`;
  if (s === 'completed')
    return html`<span class="iter-status-icon">${unsafeHTML(statusIcon('completed', 12))}</span>`;
  if (s === 'error')
    return html`<span class="iter-status-icon failure">${unsafeHTML(statusIcon('error', 12))}</span>`;
  if (s === 'in_progress')
    return html`<span class="iter-status-icon in-progress">${unsafeHTML(statusIcon('in_progress', 12))}</span>`;
  return nothing;
}

function _triggerBadge(trigger) {
  if (!trigger) return nothing;
  const labels = {
    initial: 'Initial run',
    test_failure: 'Test failure',
    review_changes: 'Review changes',
    restart_planning: 'Restart planning',
    plan_review_revise: 'Plan revision',
    next_bead: 'Next bead',
  };
  return html`<sl-badge variant="neutral" pill>${labels[trigger] || trigger.replace(/_/g, ' ')}</sl-badge>`;
}

function _outcomeVariant(outcome) {
  if (outcome === 'success' || outcome === 'approve') return 'success';
  if (outcome === 'revise' || outcome === 'request_changes') return 'warning';
  if (outcome === 'rejected' || outcome === 'restart_planning') return 'danger';
  return 'neutral';
}

function _outcomeBadge(outcome) {
  if (!outcome) return nothing;
  return html`<sl-badge variant="${_outcomeVariant(outcome)}" pill>${outcome.replace(/_/g, ' ')}</sl-badge>`;
}

function _effortSourceLabel(source) {
  if (source === 'adaptive:llm') return 'adaptive';
  if (source === 'model_default') return 'model default';
  return source || '';
}

function _effortTooltip(effort) {
  const parts = [];
  if (effort.source === 'explicit') {
    parts.push('template value');
  } else if (effort.source === 'model_default') {
    parts.push('Claude Code default for this model');
  } else if (effort.source === 'adaptive:llm') {
    const beadLevel = effort.bead_classified?.level;
    parts.push(`coordinator label: ${beadLevel || effort.base}`);
  } else if (
    (effort.source === 'reactive' || effort.source === 'disabled') &&
    effort.bead_classified &&
    !effort.bead_classified.applied &&
    effort.bead_classified.level
  ) {
    parts.push(
      `coordinator labeled ${effort.bead_classified.level}; not applied under ${effort.source}`,
    );
  }
  if (effort.capped_from) {
    parts.push(`capped from ${effort.capped_from}`);
  }
  if (effort.escalations?.length && effort.base) {
    parts.push(`escalated from ${effort.base}`);
  }
  return parts.join(' · ');
}

// Per-iteration read-only graphify query count, shown on the effort row.
// Only agent iterations carry `graphify_invocations` (preflight never does).
// When graphify is off for the project, show a plain "(disabled)" value
// matching the skills/subagents empty style — not a badge. When enabled, an
// integer badge: blue (primary) when the agent actually queried, grey for 0.
function _graphifyBadge(iter, graphifyEnabled) {
  if (iter.graphify_invocations == null) return nothing;
  if (graphifyEnabled !== true) {
    return html`<span class="meta-label">Graphify:</span> <span class="dispatch-events-empty">(disabled)</span>`;
  }
  const count = iter.graphify_invocations;
  const variant = count > 0 ? 'primary' : 'neutral';
  return html`<span class="meta-label">Graphify:</span> <sl-badge class="graphify-invocations-badge" variant="${variant}" pill>${count}</sl-badge>`;
}

function _effortRowView(iter, graphifyEnabled) {
  const gfx = _graphifyBadge(iter, graphifyEnabled);
  const e = iter.effort;
  if (!e) {
    // No effort recorded (e.g. effort disabled) — still surface the graphify
    // badge on its own row so agent iterations consistently show it.
    return gfx === nothing
      ? nothing
      : html`<div class="iteration-tags-row">${gfx}</div>`;
  }
  const sourceLabel = _effortSourceLabel(e.source);
  const tooltip = _effortTooltip(e);

  const escalationChips = e.escalations?.length
    ? e.escalations.map(
        (esc) =>
          html`<sl-badge class="effort-source-chip" variant="neutral" pill>+${esc}</sl-badge>`,
      )
    : nothing;

  const cappedChip = e.capped_from
    ? html`<sl-badge class="effort-source-chip" variant="neutral" pill>capped</sl-badge>`
    : nothing;

  const bc = e.bead_classified;
  const showBeadRow = bc && bc.level != null && bc.applied === false;
  const divergenceLabel =
    bc?.skip_reason === 'explicit_override' ? 'overridden' : 'ignored';

  return html`
    <div class="iteration-tags-row" title="${tooltip}">
      <span class="meta-label">Effort:</span>
      ${unsafeHTML(effortLevelBadge(e.level))}
      <sl-badge class="effort-source-chip" variant="neutral" pill>${sourceLabel}</sl-badge>
      ${escalationChips}
      ${cappedChip}
      ${gfx}
    </div>
    ${
      showBeadRow
        ? html`
      <div class="iteration-tags-row">
        <span class="meta-label">Bead:</span>
        ${unsafeHTML(effortLevelBadge(bc.level))}
        <sl-badge class="effort-divergence-chip" variant="warning" pill>${divergenceLabel}</sl-badge>
      </div>
    `
        : nothing
    }
  `;
}

function _classificationVariant(category) {
  if (category === 'infra_transient') return 'warning';
  if (
    category === 'infra_permanent' ||
    category === 'logic_stuck' ||
    category === 'env_missing'
  )
    return 'danger';
  return 'neutral';
}

function _classificationRowView(iter) {
  const c = iter.classification;
  if (!c) return nothing;
  return html`
    <div class="iteration-tags-row">
      <span class="meta-label">Fail Category:</span>
      <span class="meta-value">${c.category}</span>
      <span class="iteration-tags-sep">·</span>
      <span class="meta-label">Severity:</span>
      <span class="meta-value">${c.retriable ? 'retriable' : 'non-retriable'}</span>
      ${
        c.similar_to_previous
          ? html`
        <span class="iteration-tags-sep">·</span>
        <span class="meta-label">Similar:</span>
        <span class="meta-value">yes</span>
      `
          : nothing
      }
    </div>
  `;
}

function _dispatchEventCandidate(ev) {
  // Back-compat: accept the legacy `subagent_type` payload key during the
  // event-shape rollout. Tests fed status snapshots written before W-054 PR D
  // landed still use the old field name.
  return ev.candidate || ev.subagent_type || '';
}

// PR D / B / follow-up: each iteration shows one row per dispatch section
// ("Subagents:" + "Skills:") rather than a single mixed-bag "Dispatch:" line.
// This restores the original per-section label semantics that PR D's unified
// event family had blurred — and replaces the redundant hero-level
// "Dispatch activity" counter that previously sat above the stage timeline.
const _DISPATCH_VISIBLE_LIMIT = 6;
const _DISPATCH_SECTIONS = [
  { section: 'subagents', label: 'Subagents:' },
  { section: 'skills', label: 'Skills:' },
];

function _dispatchBadgeView(ev) {
  const isAllowed = ev.type === 'pipeline.hook.dispatch_allowed';
  const isWildcard = isAllowed && ev.via === 'wildcard';
  // Dispatched → green (success); blocked → red (danger). Wildcard still
  // counts as dispatched — the via/section is conveyed via tooltip, not
  // via a separate variant.
  const variant = isAllowed ? 'success' : 'danger';
  const count = Number.isInteger(ev.count) && ev.count > 1 ? ev.count : 0;
  const suffix = count ? ` (×${count})` : '';
  const candidate = _dispatchEventCandidate(ev);
  // Drop the "blocked" suffix — the colour + icon now carry that signal.
  const label = `${candidate}${suffix}`;
  // Tooltip leads with a plain-language verdict so a reader hovering
  // a single chip understands instantly why it's red or green, even
  // without reading the section/via/reason details after the dash.
  const lede = isAllowed
    ? 'Allowed by project dispatch policy'
    : 'Blocked by project dispatch policy';
  const detailParts = [];
  if (ev.section) detailParts.push(`section: ${ev.section}`);
  if (ev.via) detailParts.push(`via: ${ev.via}`);
  if (ev.reason) detailParts.push(`reason: ${ev.reason}`);
  const tooltip = detailParts.length
    ? `${lede} — ${detailParts.join(' · ')}`
    : lede;
  const cls = isWildcard
    ? 'dispatch-badge dispatch-badge-wildcard'
    : 'dispatch-badge';
  const iconSvgString = iconSvg(isAllowed ? CircleCheck : X, 12);
  // Wrap in <sl-tooltip> so hovers show a styled, fast-appearing tooltip
  // (Shoelace default show-delay is ~150ms) rather than the browser-native
  // `title` (500ms+). The badge itself stays on one line — the existing
  // renderToString test helper matches against /Explore<\/sl-badge>/.
  return html`<sl-tooltip content="${tooltip}"><sl-badge class="${cls}" variant="${variant}" pill><span class="dispatch-badge-icon">${unsafeHTML(iconSvgString)}</span>${label}</sl-badge></sl-tooltip>`;
}

function _dispatchSectionInlineView(label, sectionKey, events) {
  const overflow = events.length > _DISPATCH_VISIBLE_LIMIT;
  const inline = overflow ? events.slice(0, _DISPATCH_VISIBLE_LIMIT) : events;
  const hidden = overflow ? events.slice(_DISPATCH_VISIBLE_LIMIT) : [];
  // Empty-section placeholder so the row keeps its shape even when one
  // dispatch family produced nothing this iteration — the user complaint
  // was that the previous "Dispatch: No subagent or skill activity"
  // collapse made the layout flicker between iterations.
  const body =
    events.length === 0
      ? html`<span class="dispatch-events-empty">(none)</span>`
      : html`${inline.map(_dispatchBadgeView)}${
          overflow
            ? html`<sl-details class="dispatch-events-overflow">
              <span slot="summary" class="dispatch-events-overflow-summary"
                >${`+${hidden.length} more`}</span
              >
              <div class="dispatch-events-overflow-content">
                ${hidden.map(_dispatchBadgeView)}
              </div>
            </sl-details>`
            : nothing
        }`;
  return html`<span
    class="dispatch-events-section"
    data-dispatch-section="${sectionKey}"
    ><span class="meta-label">${label}</span>${body}</span
  >`;
}

function _dispatchEventsRowsView(iter) {
  const events = iter.dispatch_events || [];
  const buckets = { subagents: [], skills: [] };
  for (const ev of events) {
    // Back-compat: pre-PR-D events carry no `section`. Treat them as subagents
    // since that was the only emitter before the unification.
    const s = ev.section || 'subagents';
    if (buckets[s]) buckets[s].push(ev);
  }
  // Skip the row entirely on in-progress iterations with no events yet
  // so empty placeholders don't flicker into view before the first hook
  // fires. Once the iteration completes (or any dispatch lands), the
  // row is always shown with both sections present — empty sections
  // render a muted "(none)" inline rather than disappearing.
  const anyEvents = buckets.subagents.length > 0 || buckets.skills.length > 0;
  const iterDone = iter.status === 'completed' || iter.completed_at;
  if (!anyEvents && !iterDone) return nothing;
  return html`
    <div class="iteration-tags-row dispatch-events-row">
      ${_DISPATCH_SECTIONS.map(({ section, label }) =>
        _dispatchSectionInlineView(label, section, buckets[section]),
      )}
    </div>
  `;
}

function _circuitBreakerBannerView(run, settings) {
  const cb = run.circuit_breaker;
  if (!cb) return nothing;
  if (cb.tripped) {
    return html`
      <sl-alert class="circuit-breaker-banner" variant="danger" open>
        <strong>Circuit breaker tripped:</strong> ${cb.tripped_reason || 'Pipeline halted due to repeated errors.'}
      </sl-alert>
    `;
  }
  const failures = cb.consecutive_failures || 0;
  if (failures > 0) {
    const threshold = settings.circuit_breaker?.max_consecutive_failures ?? 3;
    return html`
      <sl-alert class="circuit-breaker-banner" variant="warning" open>
        <strong>Circuit breaker warning:</strong> ${String(failures)}/${String(threshold)} consecutive failures.
      </sl-alert>
    `;
  }
  return nothing;
}

export function prVerificationBannerView(run) {
  if (
    !(
      run?.milestones?.pr_verified === false &&
      run?.pipeline_status === 'failed'
    )
  ) {
    return nothing;
  }
  return html`
    <sl-alert class="pr-verification-banner" variant="danger" open>
      <strong>PR verification failed:</strong> Guardian reported success but no new commit or PR was detected.
    </sl-alert>
  `;
}

function _prVerifiedBadgeView(run) {
  const verified = run?.milestones?.pr_verified;
  if (verified === null || verified === undefined) return nothing;
  return html`
    <div class="pr-verified-row">
      <span class="meta-label">PR Verification:</span>
      <sl-badge class="pr-verified-badge" variant="${verified ? 'success' : 'danger'}" pill>
        ${verified ? 'Verified' : 'Not Verified'}
      </sl-badge>
    </div>
  `;
}

function _prReviewStatusVariant(status) {
  if (status === 'approved') return 'success';
  if (status === 'changes_requested') return 'warning';
  if (status === 'rejected') return 'danger';
  return 'neutral';
}

function _prInfoStripView(run) {
  const pr = run?.pr;
  const prUrl = pr?.url || run?.pr_url;
  if (!prUrl) return nothing;

  const number = pr?.number;
  const commitSha = pr?.commit_sha;
  const shortSha = commitSha ? commitSha.slice(0, 7) : null;
  const source = pr?.source_branch;
  const target = pr?.target_branch;
  const provider = pr?.provider;
  const reviewStatus = pr?.review_status;

  return html`
    <div class="pr-info-strip">
      <span class="pr-info-item">
        ${unsafeHTML(iconSvg(GitPullRequest, 14))}
        <a class="run-pr-link" href="${prUrl}" target="_blank" rel="noopener noreferrer">
          PR${number != null ? html` #${number}` : nothing} ${unsafeHTML(iconSvg(ExternalLink, 11))}
        </a>
      </span>
      ${
        provider
          ? html`<span class="pr-info-item">
        <span class="meta-label">Provider:</span>
        <span class="meta-value">${provider.replace(/_/g, ' ')}</span>
      </span>`
          : nothing
      }
      ${
        shortSha
          ? html`<span class="pr-info-item">
        <span class="meta-label">Commit:</span>
        <code class="pr-commit-sha">${shortSha}</code>
        <sl-copy-button value="${commitSha}"></sl-copy-button>
      </span>`
          : nothing
      }
      ${
        source && target
          ? html`<span class="pr-info-item">
        ${unsafeHTML(iconSvg(GitBranch, 13))}
        <span class="meta-value">${source} → ${target}</span>
      </span>`
          : nothing
      }
      ${
        reviewStatus
          ? html`<span class="pr-info-item">
        <sl-badge class="pr-review-status-badge" variant="${_prReviewStatusVariant(reviewStatus)}" pill>${reviewStatus.replace(/_/g, ' ')}</sl-badge>
      </span>`
          : nothing
      }
    </div>
  `;
}

function _prTitleBadge(run) {
  const pr = run?.pr;
  const prUrl = pr?.url || run?.pr_url;
  if (!prUrl) return nothing;
  const number = pr?.number;
  const label = `PR #${number}`;
  return html`<sl-badge class="pr-title-badge" variant="success" pill>${label}</sl-badge>`;
}

function _preflightCheckBadgeVariant(status) {
  if (status === 'pass') return 'success';
  if (status === 'warn') return 'warning';
  if (status === 'fail') return 'danger';
  return 'neutral';
}

// One-line explanation of the graphify build mode, appended to the ready-state
// tooltips. structural = fully local; full = docs/diagrams sent to the provider.
function _graphifyModeHint(mode) {
  if (mode === 'structural')
    return 'structural mode: local AST + clustering, no LLM calls';
  if (mode === 'full')
    return 'full mode: docs/diagrams sent to the configured provider (source code never sent)';
  return '';
}

function _preflightGraphifyBadge(stage, run) {
  const enabled = run.graphify_enabled;
  const status = stage.graphify_status;
  const outcome = stage.graphify_outcome;
  const mode = stage.graphify_mode;
  const reason = stage.graphify_reason;

  // Render as a labeled meta row so the badge aligns with the other stage
  // rows (Effort, Iteration Trigger/Outcome, …) instead of floating. Reuses
  // the "Graphify:" label already established by _graphifyBadge.
  const row = (badge) => html`
    <div class="iteration-tags-row">
      <span class="meta-label">Graphify:</span> ${badge}
    </div>`;
  // Every state carries a tooltip explaining what it means. Use <sl-tooltip>
  // (styled, ~150ms) for consistency with the dispatch badges, not native title.
  const badge = (variant, text, tip) =>
    html`<sl-tooltip content="${tip}"><sl-badge class="preflight-graphify-badge" variant="${variant}" pill>${text}</sl-badge></sl-tooltip>`;

  if (enabled === false) {
    return row(
      badge(
        'neutral',
        'off',
        'Graphify is disabled for this project — no code knowledge graph is built or queried.',
      ),
    );
  }
  if (enabled == null && status == null) return nothing;

  if (status === 'skipped') {
    return row(
      badge(
        'neutral',
        'skipped',
        'Graphify is enabled, but no graph was available this run (preflight build off and no cached graph for this commit).',
      ),
    );
  }
  if (status === 'degraded') {
    // Show the underlying reason only — the install/fix command lives centrally
    // in Project Settings → Graphify, not in this tooltip.
    const tip = reason
      ? `Graphify couldn't provide a graph: ${reason}. See Project Settings → Graphify.`
      : "Graphify couldn't provide a graph. See Project Settings → Graphify.";
    return row(badge('danger', 'unavailable', tip));
  }

  const hint = _graphifyModeHint(mode);
  const withHint = (base) => (hint ? `${base} · ${hint}.` : `${base}.`);
  if (outcome === 'cached') {
    return row(
      badge(
        'success',
        html`cached · ${mode}`,
        withHint(
          'Reused the knowledge graph already cached for this commit — no rebuild needed',
        ),
      ),
    );
  }
  if (outcome === 'built') {
    return row(
      badge(
        'success',
        html`rebuilt · ${mode}`,
        withHint(
          'No cached graph for this commit, so a fresh one was built during preflight and cached',
        ),
      ),
    );
  }
  if (outcome === 'throwaway') {
    return row(
      badge(
        'warning',
        html`built (uncommitted) · ${mode}`,
        withHint(
          'Working tree had uncommitted changes, so a throwaway graph was built for this run only (not cached)',
        ),
      ),
    );
  }
  return nothing;
}

function _preflightChecksView(stage, iter) {
  const isSkipped = stage.skipped || iter.outcome === 'skipped';
  if (isSkipped) {
    return html`<div class="preflight-checks-view"><sl-badge variant="neutral" pill>Skipped</sl-badge></div>`;
  }
  const output = iter.output || {};
  const checks = output.checks || [];
  const summary = output.summary || '';
  if (!checks.length && !summary) return nothing;
  return html`
    <div class="preflight-checks-view">
      ${summary ? html`<div class="preflight-summary markdown-body">${unsafeHTML(renderMarkdown(summary))}</div>` : nothing}
      ${
        checks.length > 0
          ? html`
        <table class="preflight-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Check</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            ${checks.map(
              (check) => html`
              <tr>
                <td><sl-badge variant="${_preflightCheckBadgeVariant(check.status)}" pill>${check.status}</sl-badge></td>
                <td class="preflight-check-name">${check.name}</td>
                <td class="preflight-check-message markdown-body markdown-inline">${unsafeHTML(renderMarkdown(check.message || ''))}</td>
              </tr>
            `,
            )}
          </tbody>
        </table>
      `
          : nothing
      }
    </div>
  `;
}

function _stageCost(iterations) {
  return iterations.reduce((sum, it) => sum + (it.cost_usd || 0), 0);
}

// Serialize a stage (and its iterations) to the JSON the "Copy" button hands
// the user. Keep this in sync with everything the stage section *renders* —
// effort, graphify invocations, dispatch (skills/subagents), classification,
// token usage, structured output, and the preflight graphify fields — so the
// copied data is the full stage record, not a stale subset.
export function _stageToJson(key, stage, stageAgent, stageModel, promptData) {
  const iterations = stage.iterations || [];
  const wallMs = _stageWallMs(stage);
  return {
    stage: key,
    status: stage.status,
    agent: stageAgent || undefined,
    model: stageModel || undefined,
    cost_usd: _stageCost(iterations),
    token_usage: stage.token_usage || undefined,
    duration: wallMs > 0 ? formatDuration(wallMs) : undefined,
    duration_ms: wallMs > 0 ? wallMs : undefined,
    started_at: stage.started_at || undefined,
    completed_at: stage.completed_at || undefined,
    skipped: stage.skipped || undefined,
    task_progress: stage.task_progress || undefined,
    error: stage.error || undefined,
    plan_file: stage.plan_file || undefined,
    graphify_status: stage.graphify_status || undefined,
    graphify_report_path: stage.graphify_report_path || undefined,
    graphify_outcome: stage.graphify_outcome || undefined,
    graphify_mode: stage.graphify_mode || undefined,
    graphify_reason: stage.graphify_reason || undefined,
    iterations: iterations.map((it) => ({
      number: it.number,
      status: it.status,
      outcome: it.outcome || undefined,
      trigger: it.trigger || undefined,
      agent: it.agent || undefined,
      model: it.model || undefined,
      turns: it.turns || undefined,
      cost_usd: it.cost_usd || undefined,
      duration_ms: it.duration_ms || undefined,
      duration_session_ms: it.duration_session_ms || undefined,
      duration_api_ms: it.duration_api_ms || undefined,
      started_at: it.started_at || undefined,
      completed_at: it.completed_at || undefined,
      effort: it.effort || undefined,
      graphify_invocations:
        it.graphify_invocations != null ? it.graphify_invocations : undefined,
      token_usage: it.token_usage || undefined,
      classification: it.classification || undefined,
      dispatch_events: it.dispatch_events?.length
        ? it.dispatch_events
        : undefined,
      output: it.output || undefined,
    })),
    prompts: promptData
      ? {
          agent_instructions: promptData.agentInstructions || undefined,
          user_prompt: promptData.userPrompt || undefined,
        }
      : undefined,
  };
}

/** Total ms the stage actually ran — sum of all iteration durations. */
function _stageWallMs(stage) {
  const iters = stage.iterations || [];
  if (iters.length === 0) {
    if (!stage.started_at || !stage.completed_at) return 0;
    return elapsed(stage.started_at, stage.completed_at);
  }
  let total = 0;
  for (const it of iters) {
    if (it.started_at && it.completed_at) {
      total += elapsed(it.started_at, it.completed_at);
    }
  }
  return total;
}

function timingStripView(startedAt, completedAt, extra = nothing) {
  const dur = startedAt ? formatDuration(elapsed(startedAt, completedAt)) : '';
  return html`
    <div class="timing-strip">
      ${startedAt ? html`<span class="timing-strip-item"><span class="meta-label">Started:</span> <span class="meta-value">${formatTimestamp(startedAt)}</span></span>` : nothing}
      ${completedAt ? html`<span class="timing-strip-item"><span class="meta-label">Finished:</span> <span class="meta-value">${formatTimestamp(completedAt)}</span></span>` : nothing}
      ${dur ? html`<span class="timing-strip-item"><span class="meta-label">Duration:</span> <span class="meta-value">${dur}</span></span>` : nothing}
      ${extra}
    </div>
  `;
}

function _iterationDetailView(
  iter,
  stageKey,
  stageAgent,
  promptData,
  graphifyEnabled,
) {
  const agentName = iter.agent || stageAgent || stageKey;
  const model = iter.model || '';
  const iterNum = iter.number ?? 0;
  // Find the prompt for this iteration
  const iterPrompts = promptData?.iterationPrompts || [];
  const iterPrompt = iterPrompts.find((ip) => ip.iteration === iterNum);
  const userPrompt = iterPrompt?.prompt || promptData?.userPrompt || null;
  const iterPromptData = userPrompt
    ? { agentInstructions: promptData?.agentInstructions, userPrompt }
    : promptData;
  const iterDur = iter.started_at
    ? formatDuration(elapsed(iter.started_at, iter.completed_at || null))
    : '';
  return html`
    <div class="iteration-detail">
      ${timingStripView(iter.started_at, iter.completed_at)}
      <div class="stage-info-strip">
        ${agentName ? html`<span class="stage-info-item"><span class="meta-label">Agent:</span> <span class="meta-value">${agentName}</span></span>` : nothing}
        ${model ? html`<span class="stage-info-item"><span class="meta-label">Model:</span> <span class="meta-value">${model}</span></span>` : nothing}
        ${iter.turns ? html`<span class="stage-info-item"><span class="meta-label">Turns:</span> <span class="meta-value">${iter.turns}</span></span>` : nothing}
        ${iter.duration_api_ms ? html`<span class="stage-info-item"><span class="meta-label">API:</span> <span class="meta-value">${formatDuration(iter.duration_api_ms)}${iter.started_at && iter.completed_at ? ` (${Math.round((iter.duration_api_ms / elapsed(iter.started_at, iter.completed_at)) * 100)}%)` : ''}</span></span>` : nothing}
        ${iter.cost_usd != null ? html`<span class="stage-info-item"><span class="meta-label">Cost:</span> <span class="meta-value">$${Number(iter.cost_usd).toFixed(2)}</span></span>` : nothing}
        ${iterDur ? html`<span class="stage-info-item"><span class="meta-label">Duration:</span> <span class="meta-value">${iterDur}</span></span>` : nothing}
      </div>
      ${
        iter.trigger || iter.outcome
          ? html`
        <div class="iteration-tags-row">
          ${iter.trigger ? html`<span class="meta-label">Iteration Trigger:</span> ${_triggerBadge(iter.trigger)}` : nothing}
          ${iter.outcome ? html`<span class="meta-label">Iteration Outcome:</span> ${_outcomeBadge(iter.outcome)}` : nothing}
        </div>
      `
          : nothing
      }
      ${_effortRowView(iter, graphifyEnabled)}
      ${_classificationRowView(iter)}
      ${_dispatchEventsRowsView(iter)}
      ${_agentPromptSection(stageKey, iterPromptData)}
    </div>
  `;
}

function _copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = 'Copy';
    }, 1500);
  });
}

function _agentPromptSection(_stageKey, promptData) {
  if (!promptData) return nothing;
  const { agentInstructions, userPrompt } = promptData;
  if (!agentInstructions && !userPrompt) return nothing;
  return html`
    <sl-details class="agent-prompt-section" @sl-after-show=${scrollOnExpand}>
      <div slot="summary" class="agent-prompt-header">
        <span class="stage-meta-icon">${unsafeHTML(iconSvg(FileText, 12))}</span>
        Agent Instructions
      </div>
      ${
        agentInstructions
          ? html`
        <div class="agent-prompt-block">
          <div class="agent-prompt-label-row">
            <span class="agent-prompt-label">Agent Prompt (resolved)</span>
            <button class="copy-btn" @click=${(e) => _copyToClipboard(agentInstructions, e.currentTarget)}>
              ${unsafeHTML(iconSvg(ClipboardCopy, 11))} Copy
            </button>
          </div>
          <div class="markdown-body">${unsafeHTML(renderMarkdown(agentInstructions))}</div>
        </div>
      `
          : nothing
      }
      ${
        userPrompt
          ? html`
        <div class="agent-prompt-block">
          <div class="agent-prompt-label-row">
            <span class="agent-prompt-label">User Message (-p)</span>
            <button class="copy-btn" @click=${(e) => _copyToClipboard(userPrompt, e.currentTarget)}>
              ${unsafeHTML(iconSvg(ClipboardCopy, 11))} Copy
            </button>
          </div>
          <div class="markdown-body">${unsafeHTML(renderMarkdown(userPrompt))}</div>
        </div>
      `
          : nothing
      }
    </sl-details>
  `;
}

function _graphWithTooltips(beads) {
  const { svg, nodes } = beadsDependencyGraph(beads);
  return html`
    <div class="run-beads-graph">
      ${unsafeHTML(svg)}
      ${nodes.map(
        ({ issue, x, y, w, h }) => html`
        <sl-tooltip class="bead-tooltip" hoist placement="bottom" distance="4">
          <div slot="content">${beadTooltipContent(issue)}</div>
          <div class="graph-tooltip-trigger" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>
        </sl-tooltip>
      `,
      )}
    </div>
  `;
}

export function guideConflictsPanelView(conflicts, options = {}) {
  if (!conflicts || conflicts.length === 0) return nothing;
  return html`
    <sl-details open class="guide-conflicts-panel" @sl-after-show=${scrollOnExpand}>
      <div slot="summary" class="guide-conflicts-header">
        <span class="guide-conflicts-icon">${unsafeHTML(iconSvg(AlertTriangle, 16))}</span>
        <span class="guide-conflicts-title">Guide Conflicts</span>
        <sl-badge variant="warning" pill>${conflicts.length}</sl-badge>
      </div>
      <div class="guide-conflicts-list">
        ${conflicts.map(
          (c) => html`
          <div class="guide-conflict-row">
            <span class="guide-conflict-stage">${c.stage}</span>
            <span class="guide-conflict-message">${c.message}</span>
            <sl-badge variant="neutral" pill class="guide-conflict-source">${c.source}</sl-badge>
            <button class="guide-conflict-view-source" @click=${() => options.onViewSource?.(c.stage)}>View source</button>
          </div>
        `,
        )}
      </div>
    </sl-details>
  `;
}

export function prApprovalPanelView(run, options = {}) {
  if (
    !(
      run?.milestones?.pr_approved === false &&
      run?.pipeline_status === 'paused'
    )
  ) {
    return nothing;
  }
  const { onApprove, onReject } = options;
  return html`
    <sl-card class="approval-panel" data-testid="pr-approval-panel">
      <div slot="header">
        <strong>PR creation paused — approval required</strong>
      </div>
      <p>The pipeline is ready to create a pull request for this run. Approve to proceed, or reject to stop the pipeline.</p>
      <div class="approval-actions">
        <sl-button variant="success" id="pr-approve-btn" @click=${() => onApprove?.(run.id)}>Approve &amp; create PR</sl-button>
        <sl-button variant="danger" outline id="pr-reject-btn" @click=${() => onReject?.(run.id)}>Reject</sl-button>
      </div>
    </sl-card>
  `;
}

export function runBeadsSectionView(beads, options = {}) {
  // `loaded` defaults to "a value was passed" so existing callers that pass just
  // the issues array keep rendering data; main.js passes it explicitly to drive
  // the not-loaded (spinner) state.
  const { loaded = beads !== undefined, showSpinner = false } = options;

  // Summary-right (badge / spinner / nothing) and body, resolved per state:
  //   not loaded            → panel appears immediately; spinner only after the
  //                           150ms gate (showSpinner), else an empty summary.
  //   loaded, beads === null → load failed (don't claim "no beads").
  //   loaded, []            → no linked beads.
  //   loaded, [...]         → count badge + list (+ graph).
  let summaryRight = nothing;
  let body = nothing;

  if (!loaded) {
    summaryRight = showSpinner
      ? html`<sl-spinner
          class="run-beads-loading"
          data-testid="run-beads-loading"
        ></sl-spinner>`
      : nothing;
    body = showSpinner
      ? html`<div class="run-beads-empty">Loading Beads…</div>`
      : nothing;
  } else if (beads === null) {
    summaryRight = html`<sl-badge variant="warning" pill>—</sl-badge>`;
    body = html`<div class="run-beads-empty">Couldn't load Beads issues</div>`;
  } else if (beads.length === 0) {
    body = html`<div class="run-beads-empty">No linked Beads issues</div>`;
  } else {
    const closed = beads.filter((b) => b.status === 'closed').length;
    const total = beads.length;
    const variant = closed === total ? 'success' : 'primary';
    summaryRight = html`<sl-badge variant="${variant}" pill>${closed}/${total}</sl-badge>`;
    body = html`
      <div class="run-beads-list">
        ${beads.map(
          (issue) => html`
          <sl-tooltip class="bead-tooltip" hoist placement="bottom" distance="4">
            <div slot="content">${beadTooltipContent(issue)}</div>
            <div class="run-bead-row">
              <sl-badge variant="${priorityVariant(issue.priority)}" pill>P${issue.priority}</sl-badge>
              ${
                issue.blocked_by?.length
                  ? html`<sl-badge variant="warning" pill>blocked</sl-badge>`
                  : html`<sl-badge variant="${statusVariant(issue.status, issue)}" pill>${issue.status}</sl-badge>`
              }
              <span class="run-bead-id">#${issue.id}</span>
              <span class="run-bead-title">${issue.title}</span>
            </div>
          </sl-tooltip>
        `,
        )}
      </div>
      ${beads.length > 1 ? _graphWithTooltips(beads) : nothing}
    `;
  }

  return html`
    <div class="run-beads-section">
      <sl-details class="run-beads-panel" @sl-after-show=${scrollOnExpand}>
        <div slot="summary" class="run-beads-header">
          <span class="run-beads-icon">${unsafeHTML(iconSvg(List, 16))}</span>
          <span class="run-beads-title">Beads</span>
          ${summaryRight}
        </div>
        ${body}
      </sl-details>
    </div>
  `;
}

export function runDetailView(run, settings = {}, options = {}) {
  if (!run) {
    const empty = html`<div class="empty-state">Select a run to view details</div>`;
    return { overview: empty, stages: empty };
  }

  const sourceBranch =
    run.head_branch || run.branch || run.work_request?.branch || '';
  const targetBranch = run.target_branch || '';
  const defaultBranch = run._default_branch || '';
  const showTargetBranch = targetBranch && targetBranch !== defaultBranch;
  const pipelineTemplate = formatPipelineTemplate(run.pipeline_template);
  const pr = run.pr?.url || run.pr_url || null;
  const endTime =
    run.completed_at || (run.active ? null : _lastStageEnd(run.stages));
  const rawStages = run.stages || {};
  // Ensure preflight and learn exist (may be absent in old runs)
  let stages = rawStages;
  if (!rawStages.preflight)
    stages = { preflight: { status: 'skipped' }, ...stages };
  if (!rawStages.learn) stages = { ...stages, learn: { status: 'skipped' } };
  const stageUi = settings.stageUi || {};
  const agents = settings.agents || {};

  const overview = html`
    <div class="run-detail-overview">
      ${stageTimelineView(stages, stageUi, run.active)}
      ${_circuitBreakerBannerView(run, settings)}
      ${prVerificationBannerView(run)}
      ${guideConflictsPanelView(run.guide_conflicts, options)}

      <div class="run-info-section">
        ${
          run.project || run._project
            ? html`
          <div class="run-project">
            <span class="meta-label">Project:</span>
            <span class="meta-value run-project-name">${run.project || run._project}</span>
          </div>
        `
            : nothing
        }
        ${
          run.fleet_id && run.group_type === 'fleet'
            ? html`
          <div class="run-group">
            <span class="meta-label">Fleet:</span>
            <a
              class="meta-value run-group-link"
              href="#/fleet-runs/${run.fleet_id}"
              title="Open fleet detail"
            >${run.fleet_id}</a>
          </div>
        `
            : nothing
        }
        ${
          run.workspace_id && run.group_type === 'workspace'
            ? html`
          <div class="run-group">
            <span class="meta-label">Workspace:</span>
            <a
              class="meta-value run-group-link"
              href="#/workspace-runs/${run.workspace_id}"
              title="Open workspace detail"
            >${run.workspace_id}</a>
          </div>
          <div class="run-plan-mode">
            <span class="meta-label">Planning:</span>
            <sl-badge class="plan-mode-badge" variant="neutral" pill>${run.manifest?.plan_mode || 'master'}</sl-badge>
          </div>
        `
            : nothing
        }
        ${
          sourceBranch
            ? html`
          <div class="run-branch">
            <span class="meta-label">Source Branch:</span>
            <span class="meta-value">${sourceBranch}</span>
            ${pr ? html`<a class="run-pr-link" href="${pr}" target="_blank">View PR</a>` : nothing}
          </div>
        `
            : nothing
        }
        ${
          showTargetBranch
            ? html`
          <div class="run-target-branch">
            <span class="meta-label">Target Branch:</span>
            <span class="meta-value">${targetBranch}</span>
          </div>
        `
            : nothing
        }
        ${
          pipelineTemplate
            ? html`
          <div class="run-template">
            <span class="meta-label">Pipeline Template:</span>
            <span class="meta-value">${pipelineTemplate}</span>
          </div>
        `
            : nothing
        }
        ${
          run.is_worktree_run && run.worktree_path
            ? html`
          <div class="run-worktree">
            <span class="meta-label">Worktree:</span>
            <span class="meta-value run-worktree-path">${run.worktree_path}</span>
            <sl-copy-button value=${run.worktree_path}></sl-copy-button>
          </div>
        `
            : nothing
        }
        ${(() => {
          const effortCfg = settings.effort;
          if (!effortCfg?.auto_mode) return nothing;
          return html`
          <div class="run-effort-header">
            <sl-badge class="effort-header-chip" variant="neutral" pill>Effort: ${effortCfg.auto_mode} · cap ${effortCfg.auto_cap || 'xhigh'}</sl-badge>
          </div>
        `;
        })()}
        ${timingStripView(run.started_at, endTime)}
        ${(() => {
          const allIters = Object.values(stages).flatMap(
            (s) => s.iterations || [],
          );
          const pipelineCost = allIters.reduce(
            (sum, it) => sum + (it.cost_usd || 0),
            0,
          );
          const pipelineTurns = allIters.reduce(
            (sum, it) => sum + (it.turns || 0),
            0,
          );
          const pipelineWallMs = run.started_at
            ? elapsed(run.started_at, endTime || null)
            : 0;
          return html`
            ${
              pipelineCost > 0 || pipelineTurns > 0
                ? html`
              <div class="pipeline-cost-strip">
                ${pipelineCost > 0 ? html`<span class="pipeline-cost-item"><span class="meta-label">Cost:</span> <span class="meta-value">$${pipelineCost.toFixed(2)}</span></span>` : nothing}
                ${pipelineTurns > 0 ? html`<span class="pipeline-cost-item"><span class="meta-label">Total Turns:</span> <span class="meta-value">${pipelineTurns}</span></span>` : nothing}
              </div>
            `
                : nothing
            }
            ${_pipelineTimingBar(allIters, pipelineWallMs)}
          `;
        })()}
      </div>
    </div>
  `;

  const stagePanels = html`
      <div class="stage-panels">
        ${_sortedEntries(stages).map(([key, stage]) => {
          const label =
            stageUi[key]?.label || key.replace(/_/g, ' ').toUpperCase();
          const stageStatus = resolveStatus(
            stage.status || 'pending',
            run.active,
          );
          const stageAgent = stage.agent || agents[key]?.agent || key;
          const stageModel = stage.model || agents[key]?.model || '';
          const stageMs = _stageWallMs(stage);
          const stageDuration = stageMs > 0 ? formatDuration(stageMs) : '';
          const iterations = stage.iterations || [];
          const hasMultipleIterations = iterations.length > 1;
          const stageCost = _stageCost(iterations);

          return html`
            <sl-details ?open=${stageStatus === 'in_progress'} class="stage-panel"
              @sl-after-show=${(e) => {
                scrollOnExpand(e);
                if (!hasMultipleIterations) return;
                const tabGroup = e.target.querySelector('sl-tab-group');
                if (!tabGroup) return;
                const targetIter = resolveIterationTab(
                  options.stageIterationTab,
                  key,
                  iterations,
                );
                const panelName = `iter-${key}-${targetIter}`;
                requestAnimationFrame(() => tabGroup.show(panelName));
              }}>
              <div slot="summary" class="stage-panel-header">
                <span class="stage-panel-icon ${statusClass(stageStatus)}">${unsafeHTML(statusIcon(stageStatus))}</span>
                <span class="stage-panel-label">${label}</span>
                <span class="stage-panel-meta">
                  ${
                    hasMultipleIterations
                      ? html`
                    <span class="stage-meta-item stage-meta-iteration">
                      <span class="stage-meta-icon">${unsafeHTML(iconSvg(RefreshCw, 11))}</span>
                      <span class="meta-value">${iterations.length} iterations</span>
                    </span>
                  `
                      : nothing
                  }
                  ${(() => {
                    const t = iterations.reduce(
                      (s, it) => s + (it.turns || 0),
                      0,
                    );
                    return t > 0
                      ? html`
                    <span class="stage-meta-item">
                      <span class="stage-meta-icon">${unsafeHTML(iconSvg(RefreshCw, 11))}</span>
                      <span class="meta-value">${t} turns</span>
                    </span>
                  `
                      : nothing;
                  })()}
                  ${
                    stageCost > 0
                      ? html`
                    <span class="stage-meta-item">
                      <span class="stage-meta-icon">${unsafeHTML(iconSvg(Coins, 11))}</span>
                      <span class="meta-value">$${stageCost.toFixed(2)}</span>
                    </span>
                  `
                      : nothing
                  }
                  ${
                    stage.completed_at
                      ? html`
                    <span class="stage-meta-item">
                      <span class="stage-meta-icon">${unsafeHTML(iconSvg(Clock, 11))}</span>
                      <span class="meta-value">${formatTimestamp(stage.completed_at)}</span>
                    </span>
                  `
                      : nothing
                  }
                  ${
                    stageDuration
                      ? html`
                    <span class="stage-meta-item">
                      <span class="stage-meta-icon">${unsafeHTML(iconSvg(Timer, 11))}</span>
                      <span class="meta-value">${stageDuration}</span>
                    </span>
                  `
                      : nothing
                  }
                </span>
                ${key === 'pr' ? _prTitleBadge(run) : nothing}
                <sl-badge variant="${_badgeVariant(stageStatus)}" pill>
                  ${stageStatus.replace(/_/g, ' ')}
                </sl-badge>
              </div>
              ${(() => {
                const promptData =
                  stageStatus !== 'pending' ? options.promptCache?.[key] : null;
                const copyBtn = html`
                  <button class="stage-copy-btn" title="Copy stage data as JSON" @click=${(
                    e,
                  ) => {
                    const json = _stageToJson(
                      key,
                      stage,
                      stageAgent,
                      stageModel,
                      promptData,
                    );
                    _copyToClipboard(
                      JSON.stringify(json, null, 2),
                      e.currentTarget,
                    );
                  }}>
                    ${unsafeHTML(iconSvg(ClipboardCopy, 12))} Copy
                  </button>
                `;
                if (hasMultipleIterations) {
                  const stageTotalDur =
                    stageMs > 0 ? formatDuration(stageMs) : '';
                  return html`
                    <div class="stage-content-wrapper">
                      ${copyBtn}
                      ${(() => {
                        const stageApiMs = iterations.reduce(
                          (sum, it) => sum + (it.duration_api_ms || 0),
                          0,
                        );
                        const stageTurns = iterations.reduce(
                          (sum, it) => sum + (it.turns || 0),
                          0,
                        );
                        const stageApiPct =
                          stageMs > 0 && stageApiMs > 0
                            ? Math.round((stageApiMs / stageMs) * 100)
                            : 0;
                        return html`
                          <div class="stage-totals-strip">
                            <span class="stage-totals-item"><span class="meta-label">Cost:</span> <span class="meta-value">$${stageCost.toFixed(2)}</span></span>
                            <span class="stage-totals-item"><span class="meta-label">Duration:</span> <span class="meta-value">${stageTotalDur}</span></span>
                            ${stageApiMs > 0 ? html`<span class="stage-totals-item"><span class="meta-label">API Duration:</span> <span class="meta-value">${formatDuration(stageApiMs)}${stageApiPct > 0 ? ` (${stageApiPct}%)` : ''}</span></span>` : nothing}
                            ${stageTurns > 0 ? html`<span class="stage-totals-item"><span class="meta-label">Turns:</span> <span class="meta-value">${stageTurns}</span></span>` : nothing}
                          </div>`;
                      })()}
                      ${key === 'pr' ? _prVerifiedBadgeView(run) : nothing}
                      ${key === 'pr' ? _prInfoStripView(run) : nothing}
                      ${key === 'preflight' ? _preflightGraphifyBadge(stage, run) : nothing}
                      ${key === 'plan' ? _planArtifactView(stage, run, options.rerender) : nothing}
                      ${key === 'plan' ? _planArtifactDialog(run, options.rerender) : nothing}
                      <sl-tab-group @sl-tab-show=${(e) => {
                        const panel = e.detail.name;
                        const num = parseInt(panel.split('-').pop(), 10);
                        if (!Number.isNaN(num))
                          options.onStageTabChange?.(key, num);
                      }}>
                        ${iterations.map(
                          (iter) => html`
                          <sl-tab slot="nav" panel="iter-${key}-${iter.number}">
                            Iter ${iter.number} ${_iterStatusIcon(iter)}
                          </sl-tab>
                        `,
                        )}
                        ${iterations.map(
                          (iter) => html`
                          <sl-tab-panel name="iter-${key}-${iter.number}">
                            ${_iterationDetailView(iter, key, stageAgent, promptData, run.graphify_enabled)}
                          </sl-tab-panel>
                        `,
                        )}
                      </sl-tab-group>
                    </div>
                  `;
                }
                return html`
                  <div class="stage-content-wrapper">
                    ${copyBtn}
                    <div class="stage-detail">
                      ${timingStripView(stage.started_at, stage.completed_at)}
                      <div class="stage-info-strip">
                        ${stageAgent ? html`<span class="stage-info-item"><span class="meta-label">Agent:</span> <span class="meta-value">${stageAgent}</span></span>` : nothing}
                        ${stageModel ? html`<span class="stage-info-item"><span class="meta-label">Model:</span> <span class="meta-value">${stageModel}</span></span>` : nothing}
                        ${iterations.length === 1 && iterations[0].turns ? html`<span class="stage-info-item"><span class="meta-label">Turns:</span> <span class="meta-value">${iterations[0].turns}</span></span>` : nothing}
                        ${iterations.length === 1 && iterations[0].duration_api_ms ? html`<span class="stage-info-item"><span class="meta-label">API:</span> <span class="meta-value">${formatDuration(iterations[0].duration_api_ms)}${stageMs > 0 ? ` (${Math.round((iterations[0].duration_api_ms / stageMs) * 100)}%)` : ''}</span></span>` : nothing}
                        ${iterations.length === 1 && iterations[0].cost_usd != null ? html`<span class="stage-info-item"><span class="meta-label">Cost:</span> <span class="meta-value">$${Number(iterations[0].cost_usd).toFixed(2)}</span></span>` : nothing}
                      </div>
                      ${
                        iterations.length === 1 &&
                        (iterations[0].trigger || iterations[0].outcome)
                          ? html`
                        <div class="iteration-tags-row">
                          ${iterations[0].trigger ? html`<span class="meta-label">Iteration Trigger:</span> ${_triggerBadge(iterations[0].trigger)}` : nothing}
                          ${iterations[0].outcome ? html`<span class="meta-label">Iteration Outcome:</span> ${_outcomeBadge(iterations[0].outcome)}` : nothing}
                        </div>
                      `
                          : nothing
                      }
                      ${stage.task_progress ? html`<div class="detail-row"><span class="detail-label">Progress:</span> ${stage.task_progress}</div>` : nothing}
                      ${stage.error ? html`<div class="detail-row detail-error"><span class="detail-label">Error:</span> ${stage.error}</div>` : nothing}
                      ${iterations.length === 1 ? _effortRowView(iterations[0], run.graphify_enabled) : nothing}
                      ${iterations.length === 1 ? _classificationRowView(iterations[0]) : nothing}
                      ${iterations.length === 1 ? _dispatchEventsRowsView(iterations[0]) : nothing}
                      ${key === 'pr' ? _prVerifiedBadgeView(run) : nothing}
                      ${key === 'pr' ? _prInfoStripView(run) : nothing}
                      ${key === 'preflight' ? _preflightGraphifyBadge(stage, run) : nothing}
                      ${key === 'preflight' && iterations.length === 1 ? _preflightChecksView(stage, iterations[0]) : nothing}
                      ${key === 'plan' ? _planArtifactView(stage, run, options.rerender) : nothing}
                      ${key === 'plan' ? _planArtifactDialog(run, options.rerender) : nothing}
                      ${promptData ? _agentPromptSection(key, promptData) : nothing}
                    </div>
                  </div>
                `;
              })()}
              ${
                stageStatus === 'error' && !run.active && options.onRestartStage
                  ? html`
                <div class="stage-restart-btn">
                  <sl-button variant="warning" size="small" @click=${() => options.onRestartStage(key)}>
                    ${unsafeHTML(iconSvg(RotateCcw, 14))}
                    Restart Stage
                  </sl-button>
                </div>
              `
                  : nothing
              }
            </sl-details>
          `;
        })}
      </div>
  `;

  return { overview, stages: stagePanels };
}
