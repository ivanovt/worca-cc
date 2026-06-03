import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { STAGE_HUES } from '../utils/stage-hues.js';
import { computeTimelineLayout } from '../utils/timeline-layout.js';
import {
  clampPan,
  clampScale,
  dragToZoom,
  wheelZoom,
} from '../utils/timeline-zoom.js';

const LABEL_WIDTH = 160;
const ROW_HEIGHT = 32;
const AXIS_HEIGHT = 24;
const MIN_BAR_PX = 12;
const LABEL_MIN_PX = 36;
const _LOOPBACK_HIDE_THRESHOLD = 30;

const STATUS_FILL = {
  completed: '#22c55e',
  in_progress: '#3b82f6',
  running: '#3b82f6',
  failed: '#ef4444',
  skipped: '#6b7280',
  cancelled: '#6b7280',
  pending: '#94a3b8',
};

function statusFill(status) {
  return STATUS_FILL[status] || '#94a3b8';
}

// Escape values interpolated into the unsafeHTML SVG string to prevent attribute/text injection.
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

// Format a run-relative ms offset as mm:ss (or hh:mm:ss when hours > 0)
function formatTimestamp(ms) {
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Format a run-relative ms offset as m:ss (or h:mm:ss for runs > 1h)
function formatAxisLabel(ms, totalMs) {
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (totalMs > 3600000 || hours > 0) {
    return `${hours}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${min}:${String(sec).padStart(2, '0')}`;
}

// --- Module-level zoom/pan state ---
let _scale = 1.0;
let _panMs = 0;
let _dragging = false;
let _dragStartX = 0;
let _dragStartPanMs = 0;
let _selecting = false;
let _selectStartMs = 0;

export function _resetZoomStateForTests() {
  _scale = 1.0;
  _panMs = 0;
  _dragging = false;
  _dragStartX = 0;
  _dragStartPanMs = 0;
  _selecting = false;
  _selectStartMs = 0;
}

// Memoize layout per run object (WeakMap avoids stale cache on same id/updated_at with different stages)
const _layoutCache = new WeakMap();

function getLayout(run) {
  if (_layoutCache.has(run)) return _layoutCache.get(run);

  const isActive =
    !run.completed_at &&
    (run.status === 'in_progress' || run.status === 'running');

  // Derive runEnd: prefer run.completed_at, then scan iteration ends, then updated_at
  let runEnd = run.completed_at;
  if (!runEnd && run.stages) {
    let latestMs = 0;
    for (const stage of Object.values(run.stages)) {
      if (!stage?.iterations) continue;
      for (const it of stage.iterations) {
        if (it.completed_at) {
          const t = new Date(it.completed_at).getTime();
          if (t > latestMs) latestMs = t;
        }
      }
    }
    if (latestMs > 0) runEnd = new Date(latestMs).toISOString();
  }

  // Active runs use now() as right edge so it advances on each WS refresh.
  // Don't cache active runs — they must recompute to keep the right edge current.
  if (isActive) {
    runEnd = new Date().toISOString();
    return computeTimelineLayout(run.stages, runEnd);
  }

  runEnd = runEnd || run.updated_at || new Date().toISOString();
  const layout = computeTimelineLayout(run.stages, runEnd);
  _layoutCache.set(run, layout);
  return layout;
}

// --- Adaptive time axis ---

function buildAxisHtml(totalMs, swimlaneWidth, scale, panMs) {
  if (totalMs <= 0 || swimlaneWidth <= 0) return '';

  let tickIntervalMs;
  if (scale >= 16) {
    tickIntervalMs = 1000;
  } else if (scale >= 4) {
    tickIntervalMs = 10000;
  } else {
    tickIntervalMs = 60000;
  }

  // Prevent runaway tick generation for very long visible ranges (e.g. active runs).
  // Double the interval until the visible range would produce at most 200 ticks.
  const visibleMsForTick = totalMs / scale;
  while (visibleMsForTick / tickIntervalMs > 200) {
    tickIntervalMs *= 10;
  }

  const visibleMs = totalMs / scale;
  const startMs = panMs;
  const endMs = panMs + visibleMs;
  const firstTickMs = Math.ceil(startMs / tickIntervalMs) * tickIntervalMs;

  let out = `<line x1="${LABEL_WIDTH}" y1="0" x2="${LABEL_WIDTH + swimlaneWidth}" y2="0" stroke="currentColor" stroke-opacity="0.2"/>`;

  for (let tickMs = firstTickMs; tickMs <= endMs; tickMs += tickIntervalMs) {
    const xInSwimlane = ((tickMs - panMs) / visibleMs) * swimlaneWidth;
    const tx = LABEL_WIDTH + xInSwimlane;
    if (tx < LABEL_WIDTH - 1 || tx > LABEL_WIDTH + swimlaneWidth + 1) continue;
    const label = esc(formatAxisLabel(tickMs, totalMs));
    out += `<line x1="${tx}" y1="0" x2="${tx}" y2="5" stroke="currentColor" stroke-opacity="0.3"/>`;
    out += `<text x="${tx}" y="16" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.5">${label}</text>`;
  }

  return out;
}

// --- Apply zoom/pan directly to DOM (no full re-render) ---

function applyZoomPan(container, totalMs, swimlaneWidth) {
  const swimG = container.querySelector('.swimlane-content');
  const axisG = container.querySelector('.axis');
  if (!swimG || !axisG) return;

  const panPx = totalMs > 0 ? (_panMs / totalMs) * swimlaneWidth : 0;
  swimG.setAttribute(
    'transform',
    `translate(${LABEL_WIDTH}, 0) scale(${_scale}, 1) translate(${-panPx}, 0)`,
  );

  axisG.innerHTML = buildAxisHtml(totalMs, swimlaneWidth, _scale, _panMs);
}

// --- SVG builder ---

function buildSvg(layout, swimlaneWidth) {
  const { totalMs, rows, loopbacks, runStart } = layout;
  if (rows.length === 0) return null;

  // Rows exceeding this threshold get loopbacks suppressed and a hint shown instead
  const highIterStages = new Set(
    rows
      .filter((r) => r.iterationCount > _LOOPBACK_HIDE_THRESHOLD)
      .map((r) => r.stageKey),
  );

  const svgWidth = LABEL_WIDTH + swimlaneWidth;
  const contentHeight = ROW_HEIGHT * rows.length;
  const svgHeight = contentHeight + AXIS_HEIGHT;

  // Map ms offset to x pixel within swimlane at scale=1
  function msToX(ms) {
    if (totalMs <= 0) return 0;
    return (ms / totalMs) * swimlaneWidth;
  }

  const panPx = totalMs > 0 ? (_panMs / totalMs) * swimlaneWidth : 0;

  let fixedStr = '';
  let swimlaneRowsStr = '';
  const rowDataMap = new Map();

  rows.forEach((row, rowIdx) => {
    const y = rowIdx * ROW_HEIGHT;
    const cy = y + ROW_HEIGHT / 2;
    const stageHue = STAGE_HUES[row.stageKey] || '#94a3b8';
    const barInfos = [];

    // Fixed layer: row background stripe
    const bgFill = rowIdx % 2 === 0 ? 'rgba(0,0,0,0.02)' : 'transparent';
    fixedStr += `<rect x="0" y="${y}" width="${svgWidth}" height="${ROW_HEIGHT}" fill="${bgFill}"/>`;

    // Fixed layer: row label
    const iterBadge = row.iterationCount > 1 ? ` ↻×${row.iterationCount}` : '';
    fixedStr += `<text class="row-label" x="${LABEL_WIDTH - 8}" y="${cy + 4}" text-anchor="end" font-size="11" fill="currentColor">${esc(row.stageLabel)}${iterBadge}</text>`;

    // Swimlane bars — x coords relative to swimlane start (no LABEL_WIDTH offset)
    let barsStr = '';
    for (const bar of row.bars) {
      const rawW = msToX(bar.durMs);
      const barW = Math.max(MIN_BAR_PX, rawW);
      const barX = msToX(bar.startMs);
      const fill = statusFill(bar.status);

      const ariaLabel = `${row.stageLabel} iteration ${bar.number} of ${row.iterationCount}, ${formatDuration(bar.durMs)}, ${bar.status}`;
      barsStr += `<rect class="timeline-bar" role="img" aria-label="${esc(ariaLabel)}" tabindex="0" x="${barX}" y="${y + 4}" width="${barW}" height="${ROW_HEIGHT - 8}" rx="2" fill="${fill}" data-stage-key="${esc(row.stageKey)}" data-bar-number="${esc(bar.number)}" data-stage-label="${esc(row.stageLabel)}" data-iter-total="${esc(row.iterationCount)}" data-start-ms="${esc(bar.startMs)}" data-dur-ms="${esc(bar.durMs)}" data-model="${esc(bar.model ?? '')}" data-status="${esc(bar.status)}" data-cost="${esc(bar.cost ?? 0)}"/>`;
      // 3px left-edge accent — pointer-events:none so hover always hits the bar rect
      barsStr += `<rect class="bar-accent" x="${barX}" y="${y + 4}" width="3" height="${ROW_HEIGHT - 8}" rx="1" fill="${stageHue}" pointer-events="none"/>`;

      if (barW >= LABEL_MIN_PX) {
        barsStr += `<text class="bar-label" x="${barX + barW / 2}" y="${cy + 4}" text-anchor="middle" font-size="10" fill="white" pointer-events="none">${esc(formatDuration(bar.durMs))}</text>`;
      }

      barInfos.push({ barX, barW, cy });
    }

    // Swimlane gaps — hoverable via data-tooltip
    let gapsStr = '';
    for (const gap of row.gaps) {
      const gapX = msToX(gap.startMs);
      const gapW = Math.max(1, msToX(gap.durMs));
      const tooltipText = gap.inStage
        ? `Control in ${gap.inStage.toUpperCase()} for ${formatDuration(gap.durMs)}`
        : `Idle gap for ${formatDuration(gap.durMs)}`;
      gapsStr += `<rect class="timeline-gap" x="${gapX}" y="${y + 4}" width="${gapW}" height="${ROW_HEIGHT - 8}" fill="url(#gapHatch)" opacity="0.5" data-tooltip="${esc(tooltipText)}" data-stage-label="${esc(row.stageLabel)}" data-dur-ms="${esc(gap.durMs)}" data-in-stage="${esc(gap.inStage ?? '')}" data-in-stage-count="1" data-returned-at-ms="${esc(gap.startMs + gap.durMs)}" style="cursor:default"/>`;
    }

    swimlaneRowsStr += `<g class="timeline-row">${gapsStr}${barsStr}</g>`;
    rowDataMap.set(row.stageKey, { bars: barInfos, rowIdx });

    // Hint text for rows where loopbacks are suppressed due to high iteration count
    if (highIterStages.has(row.stageKey)) {
      fixedStr += `<text x="${LABEL_WIDTH + 8}" y="${cy + 4}" font-size="9" fill="currentColor" opacity="0.4" pointer-events="none">(loopbacks hidden — hover an iteration to highlight)</text>`;
    }
  });

  // Loopback arrows (inside swimlane-content, same coordinate space as bars)
  let loopbackStr = '';
  for (const lb of loopbacks) {
    // Skip arrows involving rows that exceeded the loopback hide threshold
    if (highIterStages.has(lb.fromStage) || highIterStages.has(lb.toStage))
      continue;
    const fromData = rowDataMap.get(lb.fromStage);
    const toData = rowDataMap.get(lb.toStage);
    if (!fromData || !toData) continue;

    const fromRow = rows.find((r) => r.stageKey === lb.fromStage);
    const toRow = rows.find((r) => r.stageKey === lb.toStage);
    if (!fromRow || !toRow) continue;

    const fromBarIdx =
      lb.fromIter != null
        ? fromRow.bars.findIndex((b) => b.number === lb.fromIter)
        : fromRow.bars.length - 1;
    const toBarIdx =
      lb.toIter != null
        ? toRow.bars.findIndex((b) => b.number === lb.toIter)
        : 0;

    if (fromBarIdx < 0 || toBarIdx < 0) continue;

    const fromBarInfo = fromData.bars[fromBarIdx];
    const toBarInfo = toData.bars[toBarIdx];
    if (!fromBarInfo || !toBarInfo) continue;

    const x1 = fromBarInfo.barX + fromBarInfo.barW;
    const y1 = fromBarInfo.cy;
    const x2 = toBarInfo.barX;
    const y2 = toBarInfo.cy;
    const lift = 1.5 * ROW_HEIGHT;
    const cpY = Math.min(y1, y2) - lift;

    loopbackStr += `<path class="loopback" data-from-stage="${esc(lb.fromStage)}" data-from-iter="${esc(lb.fromIter ?? '')}" data-to-stage="${esc(lb.toStage)}" data-to-iter="${esc(lb.toIter ?? '')}" d="M${x1},${y1} C${x1},${cpY} ${x2},${cpY} ${x2},${y2}" fill="none" stroke="currentColor" stroke-opacity="0.15" stroke-width="1.5" marker-end="url(#arrowhead)" aria-hidden="true"/>`;
  }

  const defs = `<defs>
    <clipPath id="swimlane-clip">
      <rect x="${LABEL_WIDTH}" y="-200" width="${swimlaneWidth}" height="${svgHeight + 400}"/>
    </clipPath>
    <pattern id="gapHatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#94a3b8" stroke-width="2"/>
    </pattern>
    <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" opacity="0.3"/>
    </marker>
  </defs>`;

  const axisHtml = buildAxisHtml(totalMs, swimlaneWidth, _scale, _panMs);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="display:block;width:100%;overflow:visible" data-total-ms="${totalMs}" data-swimlane-width="${swimlaneWidth}" data-run-start="${esc(runStart ?? '')}">
  ${defs}
  <g class="fixed-layer">${fixedStr}</g>
  <g class="swimlane-content" clip-path="url(#swimlane-clip)" transform="translate(${LABEL_WIDTH}, 0) scale(${_scale}, 1) translate(${-panPx}, 0)">
    ${swimlaneRowsStr}
    ${loopbackStr}
  </g>
  <g class="axis" transform="translate(0, ${contentHeight})">${axisHtml}</g>
  <rect class="zoom-selection" x="${LABEL_WIDTH}" y="0" width="0" height="${contentHeight}" fill="rgba(59,130,246,0.15)" stroke="#3b82f6" stroke-width="1" display="none" pointer-events="none"/>
</svg>`;
}

// --- Tooltip helpers ---

function buildBarTooltipHtml(target) {
  const stageLabel = target.getAttribute('data-stage-label') || '';
  const iterNum = target.getAttribute('data-bar-number') || '';
  const iterTotal = target.getAttribute('data-iter-total') || '';
  const startMs = parseFloat(target.getAttribute('data-start-ms') || '0');
  const durMs = parseFloat(target.getAttribute('data-dur-ms') || '0');
  const model = target.getAttribute('data-model') || '—';
  const status = target.getAttribute('data-status') || '—';
  const cost = parseFloat(target.getAttribute('data-cost') || '0');
  const endMs = startMs + durMs;
  const costStr = `$${cost.toFixed(2)}`;

  return (
    `<div class="tooltip-header">${esc(stageLabel)} · Iteration ${esc(iterNum)} of ${esc(iterTotal)}</div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Duration</span><span class="tooltip-value">${esc(formatDuration(durMs))}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Started</span><span class="tooltip-value">${esc(formatTimestamp(startMs))}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Ended</span><span class="tooltip-value">${esc(formatTimestamp(endMs))}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Model</span><span class="tooltip-value">${esc(model)}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Status</span><span class="tooltip-value">${esc(status)}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Cost</span><span class="tooltip-value">${esc(costStr)}</span></div>`
  );
}

function buildGapTooltipHtml(target) {
  const stageLabel = target.getAttribute('data-stage-label') || '';
  const durMs = parseFloat(target.getAttribute('data-dur-ms') || '0');
  const inStage = target.getAttribute('data-in-stage') || '';
  const inStageCount = target.getAttribute('data-in-stage-count') || '1';
  const returnedAtMs = parseFloat(
    target.getAttribute('data-returned-at-ms') || '0',
  );
  const controlStr = inStage
    ? `${esc(inStage.toUpperCase())} (${esc(inStageCount)} iteration${inStageCount === '1' ? '' : 's'})`
    : '&mdash;';

  return (
    `<div class="tooltip-header">Gap on ${esc(stageLabel)}</div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Duration</span><span class="tooltip-value">${esc(formatDuration(durMs))}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Control</span><span class="tooltip-value">${controlStr}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Returned at</span><span class="tooltip-value">${esc(formatTimestamp(returnedAtMs))}</span></div>`
  );
}

function positionTooltip(tooltip, e) {
  tooltip.style.display = '';
  const offset = 14;
  let left = e.clientX + offset;
  let top = e.clientY - offset;
  const w = tooltip.offsetWidth || 200;
  const h = tooltip.offsetHeight || 120;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
  if (vw > 0 && left + w > vw - 8) left = e.clientX - w - 4;
  if (vh > 0 && top + h > vh - 8) top = e.clientY - h - 4;
  if (top < 8) top = 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

// --- Iteration drawer (click-to-drill) ---

function buildDrawerContent(run, stageKey, barNum, options) {
  const stage = run.stages?.[stageKey];
  const iteration =
    stage?.iterations?.find((it, idx) => (it.number ?? idx + 1) === barNum) ??
    null;

  const status = iteration?.status || 'unknown';
  const statusColor = statusFill(status);
  const durMs =
    iteration?.started_at && iteration?.completed_at
      ? new Date(iteration.completed_at).getTime() -
        new Date(iteration.started_at).getTime()
      : null;
  const cost = iteration?.cost_usd ?? null;
  const model = iteration?.model ?? null;
  const agent = iteration?.agent ?? null;
  const effort = iteration?.effort ?? null;
  const inputTokens = iteration?.input_tokens ?? null;
  const outputTokens = iteration?.output_tokens ?? null;
  const cacheTokens = iteration?.cache_read_input_tokens ?? null;

  // Safe: all dynamic values are passed through esc() before insertion into innerHTML.
  let body = `<div class="drawer-body">`;
  body += `<div class="drawer-row"><span class="status-pip" style="background:${esc(statusColor)};width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px"></span><span>${esc(status)}</span></div>`;
  if (durMs != null) {
    body += `<div class="drawer-row"><span class="drawer-label">Duration</span><span>${esc(formatDuration(durMs))}</span></div>`;
  }
  if (cost != null) {
    body += `<div class="drawer-row"><span class="drawer-label">Cost</span><span>$${esc(cost.toFixed(2))}</span></div>`;
  }
  if (model) {
    body += `<div class="drawer-row"><span class="drawer-label">Model</span><span>${esc(model)}</span></div>`;
  }
  if (agent) {
    body += `<div class="drawer-row"><span class="drawer-label">Agent</span><span>${esc(agent)}</span></div>`;
  }
  if (effort) {
    body += `<div class="drawer-row"><span class="drawer-label">Effort</span><span>${esc(effort)}</span></div>`;
  }
  if (inputTokens != null || outputTokens != null) {
    const inp = inputTokens ?? '—';
    const out = outputTokens ?? '—';
    const cache =
      cacheTokens != null ? ` cache: ${esc(String(cacheTokens))}` : '';
    body += `<div class="drawer-row"><span class="drawer-label">Tokens</span><span>in: ${esc(String(inp))} out: ${esc(String(out))}${cache}</span></div>`;
  }
  const rawJson = iteration != null ? JSON.stringify(iteration, null, 2) : '{}';
  body += `<details class="drawer-raw-json"><summary>Raw JSON</summary><pre>${esc(rawJson)}</pre></details>`;
  body += `</div>`;

  if (options?.section && options?.runId) {
    const href = `#/${encodeURIComponent(options.section)}/${encodeURIComponent(options.runId)}`;
    body += `<div slot="footer"><a href="${esc(href)}" class="drawer-run-detail-link">Open in run detail</a></div>`;
  }

  return body;
}

function openIterationDrawer(
  container,
  run,
  stageKey,
  barNum,
  stageLabel,
  options,
) {
  const drawer = container.querySelector('sl-drawer');
  if (!drawer) return;

  drawer.setAttribute('label', `${stageLabel} · Iteration ${barNum}`);
  drawer.innerHTML = buildDrawerContent(run, stageKey, barNum, options);

  if (typeof drawer.show === 'function') {
    drawer.show();
  } else {
    drawer.setAttribute('open', '');
  }
}

// --- Mouseover/out handlers for loopback highlight ---

function onTimelineMouseover(e) {
  const target = e.target;
  if (!target.classList || !target.classList.contains('timeline-bar')) return;
  const stageKey = target.getAttribute('data-stage-key');
  const barNum = target.getAttribute('data-bar-number');
  const svg = e.currentTarget.querySelector('svg');
  if (!svg || !stageKey || !barNum) return;
  for (const lb of svg.querySelectorAll('.loopback')) {
    if (
      (lb.getAttribute('data-from-stage') === stageKey &&
        lb.getAttribute('data-from-iter') === barNum) ||
      (lb.getAttribute('data-to-stage') === stageKey &&
        lb.getAttribute('data-to-iter') === barNum)
    ) {
      lb.classList.add('highlight');
    }
  }
}

function onTimelineMouseout(e) {
  const target = e.target;
  if (!target.classList || !target.classList.contains('timeline-bar')) return;
  const svg = e.currentTarget.querySelector('svg');
  if (!svg) return;
  for (const lb of svg.querySelectorAll('.loopback.highlight')) {
    lb.classList.remove('highlight');
  }
}

function onTimelineMouseleave(e) {
  const tooltip = e.currentTarget.querySelector('.timeline-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

// --- Main view ---

export function runTimelineView(run, _settings, options = {}) {
  const layout = getLayout(run);

  if (layout.rows.length === 0) {
    return html`<div class="run-timeline">
      <div class="empty-state">Run has not started any stages yet</div>
    </div>`;
  }

  const swimlaneWidth = options.swimlaneWidth || 640;
  const { totalMs } = layout;
  const svgStr = buildSvg(layout, swimlaneWidth);

  function handleZoomIn(e) {
    const container = e.currentTarget.closest('.run-timeline');
    if (!container) return;
    _scale = clampScale(_scale * 2);
    _panMs = clampPan(_panMs, totalMs, _scale);
    applyZoomPan(container, totalMs, swimlaneWidth);
  }

  function handleZoomOut(e) {
    const container = e.currentTarget.closest('.run-timeline');
    if (!container) return;
    _scale = clampScale(_scale * 0.5);
    _panMs = clampPan(_panMs, totalMs, _scale);
    applyZoomPan(container, totalMs, swimlaneWidth);
  }

  function handleReset(e) {
    const container = e.currentTarget.closest('.run-timeline');
    if (!container) return;
    _scale = 1.0;
    _panMs = 0;
    applyZoomPan(container, totalMs, swimlaneWidth);
  }

  function handleWheel(e) {
    e.preventDefault();
    const container = e.currentTarget;

    if (e.shiftKey) {
      // shift+wheel: horizontal pan
      const panDeltaMs = (e.deltaY / swimlaneWidth) * (totalMs / _scale);
      _panMs = clampPan(_panMs + panDeltaMs, totalMs, _scale);
    } else {
      // zoom anchored at cursor position
      const svg = container.querySelector('svg');
      let cursorMs = _panMs;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const mouseX = e.clientX - rect.left - LABEL_WIDTH;
        const visibleMs = totalMs / _scale;
        const raw = _panMs + (mouseX / swimlaneWidth) * visibleMs;
        cursorMs = Math.max(0, Math.min(totalMs, raw));
      }
      const next = wheelZoom(
        { scale: _scale, panMs: _panMs },
        e.deltaY,
        cursorMs,
        totalMs,
      );
      _scale = next.scale;
      _panMs = next.panMs;
    }
    applyZoomPan(container, totalMs, swimlaneWidth);
  }

  function handleMousedown(e) {
    const container = e.currentTarget;
    const svg = container.querySelector('svg');
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const svgH = parseFloat(svg.getAttribute('height') || '0');
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const axisZoneY = svgH - AXIS_HEIGHT;
    const inAxisZone = mouseY >= axisZoneY;
    const isShiftCanvas = e.shiftKey && e.button === 0 && !inAxisZone;

    if (e.button === 1) {
      e.preventDefault();
      _dragging = true;
      _dragStartX = e.clientX;
      _dragStartPanMs = _panMs;
      return;
    }

    if (e.button === 0 && (inAxisZone || isShiftCanvas)) {
      e.preventDefault();
      _selecting = true;
      const swimX = mouseX - LABEL_WIDTH;
      const visibleMs = totalMs / _scale;
      const raw = _panMs + (swimX / swimlaneWidth) * visibleMs;
      _selectStartMs = Math.max(0, Math.min(totalMs, raw));

      const selRect = svg.querySelector('.zoom-selection');
      if (selRect) {
        const startX =
          LABEL_WIDTH + ((_selectStartMs - _panMs) / visibleMs) * swimlaneWidth;
        selRect.setAttribute('x', String(startX));
        selRect.setAttribute('width', '0');
        selRect.removeAttribute('display');
      }
    }
  }

  function handleMousemove(e) {
    const container = e.currentTarget;

    // Tooltip: show/reposition when over a bar or gap, hide otherwise
    const tooltip = container.querySelector('.timeline-tooltip');
    if (tooltip) {
      const target = e.target;
      if (target.classList && target.classList.contains('timeline-bar')) {
        // Safe: all values passed through esc() — stage keys, model names, status, cost from local server
        tooltip.innerHTML = buildBarTooltipHtml(target);
        positionTooltip(tooltip, e);
      } else if (
        target.classList &&
        target.classList.contains('timeline-gap')
      ) {
        // Safe: same escaping guarantee as bar tooltip
        tooltip.innerHTML = buildGapTooltipHtml(target);
        positionTooltip(tooltip, e);
      } else {
        tooltip.style.display = 'none';
      }
    }

    if (!_dragging && !_selecting) return;
    const svg = container.querySelector('svg');
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    if (_dragging) {
      const deltaX = e.clientX - _dragStartX;
      const deltaMs = -(deltaX / swimlaneWidth) * (totalMs / _scale);
      _panMs = clampPan(_dragStartPanMs + deltaMs, totalMs, _scale);
      applyZoomPan(container, totalMs, swimlaneWidth);
      return;
    }

    const swimX = mouseX - LABEL_WIDTH;
    const visibleMs = totalMs / _scale;
    const currentMs = Math.max(
      0,
      Math.min(totalMs, _panMs + (swimX / swimlaneWidth) * visibleMs),
    );
    const selRect = svg.querySelector('.zoom-selection');
    if (selRect) {
      const startX =
        LABEL_WIDTH + ((_selectStartMs - _panMs) / visibleMs) * swimlaneWidth;
      const endX =
        LABEL_WIDTH + ((currentMs - _panMs) / visibleMs) * swimlaneWidth;
      selRect.setAttribute('x', String(Math.min(startX, endX)));
      selRect.setAttribute('width', String(Math.abs(endX - startX)));
    }
  }

  function handleClick(e) {
    const bar =
      e.target.closest?.('.timeline-bar') ||
      (e.target.classList?.contains('timeline-bar') ? e.target : null);
    if (!bar) return;
    const stageKey = bar.getAttribute('data-stage-key');
    const barNum = parseInt(bar.getAttribute('data-bar-number'), 10);
    const stageLabel =
      bar.getAttribute('data-stage-label') || stageKey?.toUpperCase() || '';
    if (!stageKey || Number.isNaN(barNum)) return;
    openIterationDrawer(
      e.currentTarget,
      run,
      stageKey,
      barNum,
      stageLabel,
      options,
    );
  }

  function handleKeydown(e) {
    if (e.key !== 'Enter') return;
    const bar = e.target?.classList?.contains('timeline-bar') ? e.target : null;
    if (!bar) return;
    const stageKey = bar.getAttribute('data-stage-key');
    const barNum = parseInt(bar.getAttribute('data-bar-number'), 10);
    const stageLabel =
      bar.getAttribute('data-stage-label') || stageKey?.toUpperCase() || '';
    if (!stageKey || Number.isNaN(barNum)) return;
    openIterationDrawer(
      e.currentTarget,
      run,
      stageKey,
      barNum,
      stageLabel,
      options,
    );
  }

  function handleMouseup(e) {
    const container = e.currentTarget;

    if (_dragging) {
      _dragging = false;
      return;
    }

    if (_selecting) {
      _selecting = false;
      const svg = container.querySelector('svg');
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const swimX = mouseX - LABEL_WIDTH;
        const visibleMs = totalMs / _scale;
        const endMs = Math.max(
          0,
          Math.min(totalMs, _panMs + (swimX / swimlaneWidth) * visibleMs),
        );

        // Only commit if selection is large enough to be intentional
        if (Math.abs(endMs - _selectStartMs) > 100) {
          const next = dragToZoom(
            { scale: _scale, panMs: _panMs },
            _selectStartMs,
            endMs,
            totalMs,
          );
          _scale = next.scale;
          _panMs = next.panMs;
          applyZoomPan(container, totalMs, swimlaneWidth);
        }

        const selRect = svg.querySelector('.zoom-selection');
        if (selRect) selRect.setAttribute('display', 'none');
      }
    }
  }

  return html`<div
    class="run-timeline"
    @mouseover=${onTimelineMouseover}
    @mouseout=${onTimelineMouseout}
    @mouseleave=${onTimelineMouseleave}
    @wheel=${handleWheel}
    @mousedown=${handleMousedown}
    @mousemove=${handleMousemove}
    @mouseup=${handleMouseup}
    @click=${handleClick}
    @keydown=${handleKeydown}
  >
    <div class="timeline-toolbar">
      <button class="timeline-zoom-btn" aria-label="Zoom out" @click=${handleZoomOut}>−</button>
      <button class="timeline-zoom-btn" aria-label="Reset zoom" @click=${handleReset}>⤺</button>
      <button class="timeline-zoom-btn" aria-label="Zoom in" @click=${handleZoomIn}>+</button>
    </div>
    ${svgStr ? unsafeHTML(svgStr) : nothing}
    <div class="timeline-tooltip" style="display:none"></div>
    <sl-drawer class="iteration-drawer" placement="end"></sl-drawer>
  </div>`;
}
