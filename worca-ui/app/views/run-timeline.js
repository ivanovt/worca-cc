import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, RefreshCw, ZoomIn, ZoomOut } from '../utils/icons.js';
import { STAGE_HUES } from '../utils/stage-hues.js';
import { computeTimelineLayout } from '../utils/timeline-layout.js';
import { clampPan, clampScale, wheelZoom } from '../utils/timeline-zoom.js';

const LABEL_WIDTH = 168;
const ROW_HEIGHT = 40;
const ROW_BAR_INSET = 7;
const AXIS_HEIGHT = 32;
const AXIS_TOP_GAP = 6;
const MIN_BAR_PX = 10;
const LABEL_MIN_PX = 44;
const MIN_TICK_PX = 90;
const _LOOPBACK_HIDE_THRESHOLD = 30;

const STATUS_FILL = {
  completed: 'var(--status-completed)',
  in_progress: 'var(--status-in-progress)',
  running: 'var(--status-running)',
  failed: 'var(--status-failed)',
  skipped: 'var(--status-skipped)',
  cancelled: 'var(--status-cancelled)',
  pending: 'var(--status-pending)',
};

function statusFill(status) {
  return STATUS_FILL[status] || 'var(--status-pending)';
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
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remm = m % 60;
  return remm ? `${h}h ${remm}m` : `${h}h`;
}

function formatCost(cost) {
  if (cost == null) return '—';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

// Pick the smallest "nice" tick interval (ms) that is >= minMs.
const NICE_INTERVALS_MS = [
  1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000,
  1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000,
];
function niceTickInterval(minMs) {
  for (const t of NICE_INTERVALS_MS) {
    if (t >= minMs) return t;
  }
  return NICE_INTERVALS_MS[NICE_INTERVALS_MS.length - 1];
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
// Chart-area drag → pan
let _dragging = false;
let _dragStartX = 0;
let _dragStartPanMs = 0;
let _dragMoved = false;
// Axis-ribbon drag → zoom (anchored at click point)
let _axisDragging = false;
let _axisDragStartX = 0;
let _axisDragStartScale = 1.0;
let _axisDragAnchorMs = 0;
let _axisDragAnchorScreenX = 0;
// Track the bar whose drawer is open so it stays raised across re-renders.
let _activeBar = null;

export function _resetZoomStateForTests() {
  _scale = 1.0;
  _panMs = 0;
  _dragging = false;
  _dragStartX = 0;
  _dragStartPanMs = 0;
  _dragMoved = false;
  _axisDragging = false;
  _axisDragStartX = 0;
  _axisDragStartScale = 1.0;
  _axisDragAnchorMs = 0;
  _axisDragAnchorScreenX = 0;
  _activeBar = null;
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

  const visibleMs = totalMs / scale;
  const pxPerMs = swimlaneWidth / visibleMs;
  const minTickMs = MIN_TICK_PX / pxPerMs;
  const tickIntervalMs = niceTickInterval(minTickMs);

  const startMs = panMs;
  const endMs = panMs + visibleMs;
  const firstTickMs = Math.ceil(startMs / tickIntervalMs) * tickIntervalMs;

  let out = `<line x1="${LABEL_WIDTH}" y1="0" x2="${LABEL_WIDTH + swimlaneWidth}" y2="0" class="axis-baseline"/>`;

  for (
    let tickMs = firstTickMs;
    tickMs <= endMs + 1;
    tickMs += tickIntervalMs
  ) {
    const xInSwimlane = ((tickMs - panMs) / visibleMs) * swimlaneWidth;
    const tx = LABEL_WIDTH + xInSwimlane;
    if (tx < LABEL_WIDTH - 1 || tx > LABEL_WIDTH + swimlaneWidth + 1) continue;
    const label = esc(formatAxisLabel(tickMs, totalMs));
    out += `<line x1="${tx}" y1="0" x2="${tx}" y2="5" class="axis-tick"/>`;
    out += `<text x="${tx}" y="20" text-anchor="middle" class="axis-label">${label}</text>`;
  }

  return out;
}

// Grid lines are rendered inside a <g transform="translate(LABEL_WIDTH, 0)">,
// so x coords here are relative to the swimlane origin (0..swimlaneWidth).
function buildGridHtml(totalMs, swimlaneWidth, contentHeight, scale, panMs) {
  if (totalMs <= 0 || swimlaneWidth <= 0) return '';

  const visibleMs = totalMs / scale;
  const pxPerMs = swimlaneWidth / visibleMs;
  const minTickMs = MIN_TICK_PX / pxPerMs;
  const tickIntervalMs = niceTickInterval(minTickMs);

  const endMs = panMs + visibleMs;
  const firstTickMs = Math.ceil(panMs / tickIntervalMs) * tickIntervalMs;

  let out = '';
  for (
    let tickMs = firstTickMs;
    tickMs <= endMs + 1;
    tickMs += tickIntervalMs
  ) {
    const x = ((tickMs - panMs) / visibleMs) * swimlaneWidth;
    if (x < -1 || x > swimlaneWidth + 1) continue;
    out += `<line x1="${x}" y1="0" x2="${x}" y2="${contentHeight}" class="grid-line"/>`;
  }
  return out;
}

// --- Apply zoom/pan directly to DOM (no full re-render) ---

function applyZoomPan(container, layout, swimlaneWidth, contentHeight) {
  const swimG = container.querySelector('.swimlane-content');
  const axisG = container.querySelector('.axis');
  const gridG = container.querySelector('.grid');
  if (!swimG || !axisG) return;

  const { totalMs } = layout;
  // Redraw the swimlane content at the new scale/pan so bar widths and
  // text stay at their natural size (an SVG-transform-scale would visually
  // stretch text and the left-edge accents).
  swimG.innerHTML = buildSwimlaneLayerHtml(
    layout,
    swimlaneWidth,
    _scale,
    _panMs,
  );

  axisG.innerHTML = buildAxisHtml(totalMs, swimlaneWidth, _scale, _panMs);
  if (gridG) {
    gridG.innerHTML = buildGridHtml(
      totalMs,
      swimlaneWidth,
      contentHeight,
      _scale,
      _panMs,
    );
  }
}

// --- SVG builder ---

// Compute the swimlane innerHTML (bars, gaps, bar labels, loopbacks) for the
// given scale + pan. The wrapping <g> uses ONLY translate(LABEL_WIDTH, 0) — no
// SVG scale — so bar widths and text sizes stay correct at every zoom level.
function buildSwimlaneLayerHtml(layout, swimlaneWidth, scale, panMs) {
  const { totalMs, rows, loopbacks } = layout;
  if (rows.length === 0 || totalMs <= 0) return '';

  const visibleMs = totalMs / scale;
  const pxPerMs = swimlaneWidth / visibleMs;

  const highIterStages = new Set(
    rows
      .filter((r) => r.iterationCount > _LOOPBACK_HIDE_THRESHOLD)
      .map((r) => r.stageKey),
  );

  const rowDataMap = new Map();
  let swimlaneRowsStr = '';

  rows.forEach((row, rowIdx) => {
    const y = rowIdx * ROW_HEIGHT;
    const cy = y + ROW_HEIGHT / 2;
    const barY = y + ROW_BAR_INSET;
    const barH = ROW_HEIGHT - ROW_BAR_INSET * 2;
    const barInfos = [];

    let gapsStr = '';
    for (const gap of row.gaps) {
      const rawX = (gap.startMs - panMs) * pxPerMs;
      const rawW = gap.durMs * pxPerMs;
      if (rawX + rawW < 0 || rawX > swimlaneWidth) continue;
      const gapW = Math.max(2, rawW);
      const tooltipText = gap.inStage
        ? `Control in ${gap.inStage} for ${formatDuration(gap.durMs)}`
        : `Idle gap for ${formatDuration(gap.durMs)}`;
      const ariaLabel = `${row.stageLabel} gap: ${tooltipText}`;
      gapsStr += `<rect class="timeline-gap" role="img" tabindex="0" aria-label="${esc(ariaLabel)}" x="${rawX}" y="${barY}" width="${gapW}" height="${barH}" fill="url(#gapDots)" data-tooltip="${esc(tooltipText)}" data-stage-label="${esc(row.stageLabel)}" data-dur-ms="${esc(gap.durMs)}" data-in-stage="${esc(gap.inStage ?? '')}" data-in-stage-count="1" data-returned-at-ms="${esc(gap.startMs + gap.durMs)}"/>`;
    }

    let barsStr = '';
    for (const bar of row.bars) {
      const rawX = (bar.startMs - panMs) * pxPerMs;
      const rawW = bar.durMs * pxPerMs;
      const barW = Math.max(MIN_BAR_PX, rawW);
      // Always record bar info — loopback endpoints may reference off-screen bars
      barInfos.push({ barX: rawX, barW, cy, number: bar.number });
      if (rawX + barW < 0 || rawX > swimlaneWidth) continue;

      const fill = statusFill(bar.status);
      const isActive =
        _activeBar &&
        _activeBar.stageKey === row.stageKey &&
        _activeBar.number === bar.number;
      const ariaLabel = `${row.stageLabel} iteration ${bar.number} of ${row.iterationCount}, ${formatDuration(bar.durMs)}, ${bar.status}`;
      barsStr += `<rect class="timeline-bar${isActive ? ' is-active' : ''}" role="button" aria-label="${esc(ariaLabel)}" tabindex="0" x="${rawX}" y="${barY}" width="${barW}" height="${barH}" fill="${fill}" data-stage-key="${esc(row.stageKey)}" data-bar-number="${esc(bar.number)}" data-stage-label="${esc(row.stageLabel)}" data-iter-total="${esc(row.iterationCount)}" data-start-ms="${esc(bar.startMs)}" data-dur-ms="${esc(bar.durMs)}" data-model="${esc(bar.model ?? '')}" data-status="${esc(bar.status)}" data-cost="${esc(bar.cost ?? 0)}" data-bead-id="${esc(bar.beadId ?? '')}" data-bead-title="${esc(bar.beadTitle ?? '')}"/>`;

      // Center label over the VISIBLE portion of the bar so a bar that's
      // clipped on the left keeps a readable label inside its on-screen area.
      const visibleStart = Math.max(rawX, 0);
      const visibleEnd = Math.min(rawX + barW, swimlaneWidth);
      const visibleW = visibleEnd - visibleStart;
      if (visibleW >= LABEL_MIN_PX) {
        const labelX = (visibleStart + visibleEnd) / 2;
        barsStr += `<text class="bar-label" x="${labelX}" y="${cy + 4}" text-anchor="middle" pointer-events="none">${esc(formatDuration(bar.durMs))}</text>`;
      }
    }

    swimlaneRowsStr += `<g class="timeline-row" data-stage-key="${esc(row.stageKey)}">${gapsStr}${barsStr}</g>`;
    rowDataMap.set(row.stageKey, { bars: barInfos, rowIdx });
  });

  let loopbackStr = '';
  for (const lb of loopbacks) {
    if (highIterStages.has(lb.fromStage) || highIterStages.has(lb.toStage))
      continue;
    const fromData = rowDataMap.get(lb.fromStage);
    const toData = rowDataMap.get(lb.toStage);
    if (!fromData || !toData) continue;

    const fromBarInfo =
      lb.fromIter != null
        ? fromData.bars.find((b) => b.number === lb.fromIter)
        : fromData.bars[fromData.bars.length - 1];
    const toBarInfo =
      lb.toIter != null
        ? toData.bars.find((b) => b.number === lb.toIter)
        : toData.bars[0];
    if (!fromBarInfo || !toBarInfo) continue;

    const x1 = fromBarInfo.barX + fromBarInfo.barW;
    const y1 = fromBarInfo.cy;
    const x2 = toBarInfo.barX;
    const y2 = toBarInfo.cy;
    if ((x1 < 0 && x2 < 0) || (x1 > swimlaneWidth && x2 > swimlaneWidth))
      continue;
    // Cubic-bezier S-curve. Control points pulled HORIZONTALLY only, so:
    //  - the curve leaves the source going right (cp1 is right of source)
    //  - the curve enters the target going right too (cp2 is left of target)
    // — and the arrowhead always lands in the target bar's left edge moving
    // rightward. Bulge scales with |dx| so loopbacks that span a wider time
    // gap still feel proportional.
    const stroke = STAGE_HUES[lb.fromStage] || 'currentColor';
    const bulge = Math.max(30, Math.abs(x2 - x1) * 0.4);
    const cp1x = x1 + bulge;
    const cp1y = y1;
    const cp2x = x2 - bulge;
    const cp2y = y2;
    const path = `M${x1},${y1} C${cp1x},${cp1y} ${cp2x},${cp2y} ${x2},${y2}`;
    // Inline chevron arrowhead, oriented along the incoming tangent at (x2,y2).
    // For our cubic the tangent direction = (x2,y2) - (cp2x,cp2y) = (bulge, 0),
    // i.e. pure-right — but we compute it generically so other geometries work too.
    const tx = x2 - cp2x;
    const ty = y2 - cp2y;
    const tlen = Math.hypot(tx, ty) || 1;
    const ux = tx / tlen;
    const uy = ty / tlen;
    const ahSize = 6;
    // Perpendicular vector (rotate (ux,uy) 90°)
    const px = -uy;
    const py = ux;
    const baseX = x2 - ux * ahSize;
    const baseY = y2 - uy * ahSize;
    const aLx = baseX + px * (ahSize * 0.6);
    const aLy = baseY + py * (ahSize * 0.6);
    const aRx = baseX - px * (ahSize * 0.6);
    const aRy = baseY - py * (ahSize * 0.6);
    const arrowhead = `<path d="M${x2},${y2} L${aLx.toFixed(2)},${aLy.toFixed(2)} L${aRx.toFixed(2)},${aRy.toFixed(2)} Z" fill="${stroke}" aria-hidden="true"/>`;

    loopbackStr += `<path class="loopback" data-from-stage="${esc(lb.fromStage)}" data-from-iter="${esc(lb.fromIter ?? '')}" data-to-stage="${esc(lb.toStage)}" data-to-iter="${esc(lb.toIter ?? '')}" d="${path}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"/>${arrowhead}`;
  }

  return swimlaneRowsStr + loopbackStr;
}

function buildSvg(layout, swimlaneWidth) {
  const { totalMs, rows, runStart } = layout;
  if (rows.length === 0) return null;

  const highIterStages = new Set(
    rows
      .filter((r) => r.iterationCount > _LOOPBACK_HIDE_THRESHOLD)
      .map((r) => r.stageKey),
  );

  const svgWidth = LABEL_WIDTH + swimlaneWidth;
  const contentHeight = ROW_HEIGHT * rows.length;
  const svgHeight = contentHeight + AXIS_TOP_GAP + AXIS_HEIGHT;

  // Fixed layer: row backgrounds, dividers, hue dots, row labels.
  // These do not move with zoom/pan.
  let fixedStr = '';
  rows.forEach((row, rowIdx) => {
    const y = rowIdx * ROW_HEIGHT;
    const cy = y + ROW_HEIGHT / 2;

    if (rowIdx % 2 === 1) {
      fixedStr += `<rect x="0" y="${y}" width="${svgWidth}" height="${ROW_HEIGHT}" class="row-bg-alt"/>`;
    }
    // Draw a divider above the first row so the top of the chart matches the
    // between-row separators (the bottom of the last row is drawn below).
    if (rowIdx === 0) {
      fixedStr += `<line x1="0" y1="${y}" x2="${svgWidth}" y2="${y}" class="row-divider"/>`;
    }
    fixedStr += `<line x1="0" y1="${y + ROW_HEIGHT}" x2="${svgWidth}" y2="${y + ROW_HEIGHT}" class="row-divider"/>`;

    const iterBadge =
      row.iterationCount > 1
        ? ` <tspan class="row-label-count">×${row.iterationCount}</tspan>`
        : '';
    fixedStr += `<text class="row-label" x="14" y="${cy + 4}" text-anchor="start">${esc(row.stageLabel)}${iterBadge}</text>`;

    if (highIterStages.has(row.stageKey)) {
      fixedStr += `<text x="${LABEL_WIDTH + 8}" y="${cy + 4}" class="loopback-hint">loopbacks hidden — hover a bar</text>`;
    }
  });

  const swimlaneLayer = buildSwimlaneLayerHtml(
    layout,
    swimlaneWidth,
    _scale,
    _panMs,
  );

  const defs = `<defs>
    <clipPath id="swimlane-clip">
      <rect x="0" y="-200" width="${swimlaneWidth}" height="${svgHeight + 400}"/>
    </clipPath>
    <pattern id="gapDots" patternUnits="userSpaceOnUse" width="6" height="6">
      <rect width="6" height="6" class="gap-bg"/>
      <circle cx="2" cy="2" r="1" class="gap-dot"/>
    </pattern>
  </defs>`;

  const axisHtml = buildAxisHtml(totalMs, swimlaneWidth, _scale, _panMs);
  const gridHtml = buildGridHtml(
    totalMs,
    swimlaneWidth,
    contentHeight,
    _scale,
    _panMs,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" style="display:block;width:100%;overflow:visible" data-total-ms="${totalMs}" data-swimlane-width="${swimlaneWidth}" data-run-start="${esc(runStart ?? '')}">
  ${defs}
  <g class="fixed-layer">${fixedStr}</g>
  <g class="grid" transform="translate(${LABEL_WIDTH}, 0)">${gridHtml}</g>
  <g class="swimlane-content" clip-path="url(#swimlane-clip)" transform="translate(${LABEL_WIDTH}, 0)">${swimlaneLayer}</g>
  <g class="axis" transform="translate(0, ${contentHeight + AXIS_TOP_GAP})">${axisHtml}</g>
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
  const stageKey = target.getAttribute('data-stage-key') || '';
  const cost = parseFloat(target.getAttribute('data-cost') || '0');
  const beadId = target.getAttribute('data-bead-id') || '';
  const beadTitle = target.getAttribute('data-bead-title') || '';
  const endMs = startMs + durMs;
  const hue = STAGE_HUES[stageKey] || 'var(--muted)';

  const beadSubHeader = beadId
    ? `<div class="tooltip-bead-sub"><code class="tooltip-bead-id">${esc(beadId)}</code>${beadTitle ? ` ${esc(beadTitle)}` : ''}</div>`
    : '';

  return (
    `<div class="tooltip-header"><span class="tooltip-hue-dot" style="background:${esc(hue)}"></span>${esc(stageLabel)} <span class="tooltip-header-sub">Iteration ${esc(iterNum)} of ${esc(iterTotal)}</span></div>` +
    beadSubHeader +
    `<div class="tooltip-row"><span class="tooltip-label">Duration</span><span class="tooltip-value">${esc(formatDuration(durMs))}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Started</span><span class="tooltip-value">${esc(formatTimestamp(startMs))}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Ended</span><span class="tooltip-value">${esc(formatTimestamp(endMs))}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Model</span><span class="tooltip-value">${esc(model)}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Status</span><span class="tooltip-value tooltip-status status-${esc(status)}">${esc(status)}</span></div>` +
    `<div class="tooltip-row"><span class="tooltip-label">Cost</span><span class="tooltip-value">${esc(formatCost(cost))}</span></div>`
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
    ? `${esc(inStage)} (${esc(inStageCount)} iteration${inStageCount === '1' ? '' : 's'})`
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
  // effort may be a string (legacy) or an object like { level, requested }.
  const effortRaw = iteration?.effort ?? null;
  const effort =
    effortRaw && typeof effortRaw === 'object'
      ? (effortRaw.level ?? null)
      : effortRaw;
  const inputTokens = iteration?.input_tokens ?? null;
  const outputTokens = iteration?.output_tokens ?? null;
  const cacheTokens = iteration?.cache_read_input_tokens ?? null;
  const beadId = iteration?.bead_id ?? null;
  const beadTitle = iteration?.bead_title ?? null;
  const hue = STAGE_HUES[stageKey] || 'var(--muted)';
  const stageLabelTitle = stageKey
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');

  // Heading carries tabindex=-1 so we can move focus there when the drawer opens.
  let body = `<div class="drawer-body">`;
  body += `<h3 class="drawer-title" tabindex="-1"><span class="drawer-hue-dot" style="background:${esc(hue)}"></span>${esc(stageLabelTitle)} <span class="drawer-title-sub">Iteration ${esc(barNum)}</span></h3>`;
  body += `<div class="drawer-status-row"><span class="drawer-status-pill" style="background:${esc(statusColor)}"></span><span class="drawer-status-text status-${esc(status)}">${esc(status)}</span></div>`;
  body += `<dl class="drawer-fields">`;
  if (durMs != null) {
    body += `<dt class="drawer-label">Duration</dt><dd class="drawer-value">${esc(formatDuration(durMs))}</dd>`;
  }
  if (cost != null) {
    body += `<dt class="drawer-label">Cost</dt><dd class="drawer-value">${esc(formatCost(cost))}</dd>`;
  }
  if (model) {
    body += `<dt class="drawer-label">Model</dt><dd class="drawer-value">${esc(model)}</dd>`;
  }
  if (agent) {
    body += `<dt class="drawer-label">Agent</dt><dd class="drawer-value">${esc(agent)}</dd>`;
  }
  if (beadId) {
    body += `<dt class="drawer-label">Bead</dt><dd class="drawer-value drawer-bead"><code class="drawer-bead-id">${esc(beadId)}</code>${beadTitle ? ` ${esc(beadTitle)}` : ''}</dd>`;
  }
  if (effort) {
    body += `<dt class="drawer-label">Effort</dt><dd class="drawer-value">${esc(effort)}</dd>`;
  }
  if (inputTokens != null || outputTokens != null) {
    const inp = inputTokens ?? '—';
    const out = outputTokens ?? '—';
    const cache =
      cacheTokens != null ? ` · cache: ${esc(String(cacheTokens))}` : '';
    body += `<dt class="drawer-label">Tokens</dt><dd class="drawer-value">in: ${esc(String(inp))} · out: ${esc(String(out))}${cache}</dd>`;
  }
  body += `</dl>`;
  const rawJson = iteration != null ? JSON.stringify(iteration, null, 2) : '{}';
  body += `<details class="drawer-raw-json"><summary>Raw JSON</summary><pre>${esc(rawJson)}</pre></details>`;
  body += `</div>`;

  if (options?.section && options?.runId) {
    const href = `#/${encodeURIComponent(options.section)}/${encodeURIComponent(options.runId)}`;
    body += `<div slot="footer"><a href="${esc(href)}" class="drawer-run-detail-link">Open in run detail →</a></div>`;
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

  // Mark this bar as active so it stays raised until the drawer closes.
  _activeBar = { stageKey, number: barNum };
  applyActiveBarClass(container);

  // Attach a single sl-after-hide listener so closing the drawer drops the
  // active bar back to its rest state.
  if (!drawer.__timelineCloseListenerAttached) {
    drawer.addEventListener('sl-after-hide', () => {
      _activeBar = null;
      applyActiveBarClass(container);
    });
    drawer.__timelineCloseListenerAttached = true;
  }

  drawer.setAttribute('label', `${stageLabel} · Iteration ${barNum}`);
  drawer.innerHTML = buildDrawerContent(run, stageKey, barNum, options);

  if (typeof drawer.show === 'function') {
    drawer.show();
  } else {
    drawer.setAttribute('open', '');
  }

  // Move focus to the drawer's heading so screen readers announce the iteration.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      const heading = drawer.querySelector('.drawer-title');
      if (heading && typeof heading.focus === 'function') heading.focus();
    });
  }
}

// Reconciles `_activeBar` against the currently-rendered .timeline-bar nodes.
// Called on open/close and (implicitly) after every zoom/pan re-render via the
// is-active class baked into the swimlane HTML.
function applyActiveBarClass(container) {
  for (const bar of container.querySelectorAll('.timeline-bar.is-active')) {
    bar.classList.remove('is-active');
  }
  if (_activeBar) {
    const sel = `.timeline-bar[data-stage-key="${_activeBar.stageKey}"][data-bar-number="${_activeBar.number}"]`;
    container.querySelector(sel)?.classList.add('is-active');
  }
}

// --- Mouseover/out handlers for loopback highlight ---

function onTimelineMouseover(e) {
  const target = e.target;
  if (!target.classList || !target.classList.contains('timeline-bar')) return;
  const stageKey = target.getAttribute('data-stage-key');
  const barNum = target.getAttribute('data-bar-number');
  const svg = e.currentTarget.querySelector('.timeline-svg-wrap svg');
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
  const svg = e.currentTarget.querySelector('.timeline-svg-wrap svg');
  if (!svg) return;
  for (const lb of svg.querySelectorAll('.loopback.highlight')) {
    lb.classList.remove('highlight');
  }
}

function onTimelineMouseleave(e) {
  const tooltip = e.currentTarget.querySelector('.timeline-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

// --- Stats summary ---

function buildStatsSummary(layout) {
  const { totalMs, rows } = layout;
  let totalCost = 0;
  let totalIters = 0;
  for (const row of rows) {
    totalIters += row.iterationCount;
    for (const bar of row.bars) {
      totalCost += bar.cost || 0;
    }
  }
  // Status pill omitted — the page header (contentHeaderView) already shows
  // the run's status badge next to the title.
  return html`
    <div class="timeline-summary">
      <div class="summary-stat">
        <span class="summary-stat-label">Duration</span>
        <span class="summary-stat-value">${formatDuration(totalMs)}</span>
      </div>
      <div class="summary-stat">
        <span class="summary-stat-label">Stages</span>
        <span class="summary-stat-value">${rows.length}</span>
      </div>
      <div class="summary-stat">
        <span class="summary-stat-label">Iterations</span>
        <span class="summary-stat-value">${totalIters}</span>
      </div>
      <div class="summary-stat">
        <span class="summary-stat-label">Cost</span>
        <span class="summary-stat-value">${formatCost(totalCost)}</span>
      </div>
    </div>
  `;
}

// --- Main view ---

export function runTimelineView(run, _settings, options = {}) {
  const layout = getLayout(run);

  if (layout.rows.length === 0) {
    return html`<div class="run-timeline">
      <div class="empty-state" role="status" aria-live="polite">
        Run has not started any stages yet
      </div>
    </div>`;
  }

  // Pick a swimlane width that fits typical desktop content area (sidebar + padding
  // ≈ 320px). Falls back to 800 in non-browser test environments. Tests pass an
  // explicit value to stay deterministic.
  const defaultSwimlaneWidth =
    typeof window !== 'undefined' && window.innerWidth
      ? Math.max(600, window.innerWidth - LABEL_WIDTH - 320)
      : 800;
  const swimlaneWidth = options.swimlaneWidth || defaultSwimlaneWidth;
  const { totalMs } = layout;
  const contentHeight = ROW_HEIGHT * layout.rows.length;
  const svgStr = buildSvg(layout, swimlaneWidth);

  function handleZoomIn(e) {
    const container = e.currentTarget.closest('.run-timeline');
    if (!container) return;
    _scale = clampScale(_scale * 2);
    _panMs = clampPan(_panMs, totalMs, _scale);
    applyZoomPan(container, layout, swimlaneWidth, contentHeight);
  }

  function handleZoomOut(e) {
    const container = e.currentTarget.closest('.run-timeline');
    if (!container) return;
    _scale = clampScale(_scale * 0.5);
    _panMs = clampPan(_panMs, totalMs, _scale);
    applyZoomPan(container, layout, swimlaneWidth, contentHeight);
  }

  function handleReset(e) {
    const container = e.currentTarget.closest('.run-timeline');
    if (!container) return;
    _scale = 1.0;
    _panMs = 0;
    applyZoomPan(container, layout, swimlaneWidth, contentHeight);
  }

  function handleWheel(e) {
    e.preventDefault();
    const container = e.currentTarget;

    if (e.shiftKey) {
      // shift+wheel: zoom anchored at cursor position
      const svg = container.querySelector('.timeline-svg-wrap svg');
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
    } else {
      // Default: horizontal pan. Trackpads emit deltaX on horizontal swipe;
      // vertical-wheel mice emit deltaY. Use whichever is non-zero.
      const wheelDelta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      const panDeltaMs = (wheelDelta / swimlaneWidth) * (totalMs / _scale);
      _panMs = clampPan(_panMs + panDeltaMs, totalMs, _scale);
    }
    applyZoomPan(container, layout, swimlaneWidth, contentHeight);
  }

  function handleMousedown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    const container = e.currentTarget;
    const svg = container.querySelector('.timeline-svg-wrap svg');
    if (!svg) return;

    const rect = svg.getBoundingClientRect();
    const svgH = parseFloat(svg.getAttribute('height') || '0');
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const inAxisZone = mouseY >= svgH - AXIS_HEIGHT;
    const inLabelColumn = mouseX < LABEL_WIDTH;
    if (inLabelColumn) return;

    if (e.button === 0 && inAxisZone) {
      // Drag on the time-axis ribbon → zoom anchored at the click point.
      e.preventDefault();
      _axisDragging = true;
      _axisDragStartX = e.clientX;
      _axisDragStartScale = _scale;
      _axisDragAnchorScreenX = mouseX - LABEL_WIDTH;
      const visibleMs = totalMs / _scale;
      const raw = _panMs + (_axisDragAnchorScreenX / swimlaneWidth) * visibleMs;
      _axisDragAnchorMs = Math.max(0, Math.min(totalMs, raw));
      return;
    }

    // Anywhere else on the chart (including over a bar) → pan.
    e.preventDefault();
    _dragging = true;
    _dragStartX = e.clientX;
    _dragStartPanMs = _panMs;
    _dragMoved = false;
  }

  function handleMousemove(e) {
    const container = e.currentTarget;

    // Tooltip — suppressed while dragging to avoid flicker.
    if (!_dragging && !_axisDragging) {
      const tooltip = container.querySelector('.timeline-tooltip');
      if (tooltip) {
        const target = e.target;
        if (target.classList && target.classList.contains('timeline-bar')) {
          tooltip.innerHTML = buildBarTooltipHtml(target);
          positionTooltip(tooltip, e);
        } else if (
          target.classList &&
          target.classList.contains('timeline-gap')
        ) {
          tooltip.innerHTML = buildGapTooltipHtml(target);
          positionTooltip(tooltip, e);
        } else {
          tooltip.style.display = 'none';
        }
      }
    }

    if (_axisDragging) {
      // 200px of horizontal drag ≈ one doubling (or halving) of scale.
      // Exponential mapping so right-drag-zoom-in and left-drag-zoom-out feel
      // symmetric — and so the anchor time stays glued to its starting x.
      const deltaX = e.clientX - _axisDragStartX;
      const factor = Math.exp(deltaX / 200);
      const newScale = clampScale(_axisDragStartScale * factor);
      _scale = newScale;
      const newVisibleMs = totalMs / newScale;
      _panMs = clampPan(
        _axisDragAnchorMs -
          (_axisDragAnchorScreenX / swimlaneWidth) * newVisibleMs,
        totalMs,
        newScale,
      );
      applyZoomPan(container, layout, swimlaneWidth, contentHeight);
      return;
    }

    if (_dragging) {
      const deltaX = e.clientX - _dragStartX;
      if (Math.abs(deltaX) > 3) _dragMoved = true;
      const deltaMs = -(deltaX / swimlaneWidth) * (totalMs / _scale);
      _panMs = clampPan(_dragStartPanMs + deltaMs, totalMs, _scale);
      applyZoomPan(container, layout, swimlaneWidth, contentHeight);
    }
  }

  function handleClick(e) {
    // Suppress the click that follows a pan-drag — otherwise dragging over a
    // bar would also open its drawer at mouseup time.
    if (_dragMoved) {
      _dragMoved = false;
      return;
    }
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
    // Accept Enter and Space as activation per the WAI-ARIA Button pattern.
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const bar = e.target?.classList?.contains('timeline-bar') ? e.target : null;
    if (!bar) return;
    // Space scrolls the page by default; suppress it when activating a bar.
    e.preventDefault();
    const stageKey = bar.getAttribute('data-stage-key');
    const barNum = parseInt(bar.getAttribute('data-bar-number'), 10);
    const stageLabel = bar.getAttribute('data-stage-label') || stageKey || '';
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

  function handleMouseup() {
    if (_dragging) _dragging = false;
    if (_axisDragging) _axisDragging = false;
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
    ${buildStatsSummary(layout)}
    <div class="timeline-toolbar" role="toolbar" aria-label="Timeline zoom">
      <div class="timeline-toolbar-group">
        <button class="timeline-zoom-btn" type="button" aria-label="Zoom out" title="Zoom out" @click=${handleZoomOut}>
          ${unsafeHTML(iconSvg(ZoomOut, 14))}
        </button>
        <button class="timeline-zoom-btn" type="button" aria-label="Reset zoom" title="Reset zoom" @click=${handleReset}>
          ${unsafeHTML(iconSvg(RefreshCw, 14))}
        </button>
        <button class="timeline-zoom-btn" type="button" aria-label="Zoom in" title="Zoom in" @click=${handleZoomIn}>
          ${unsafeHTML(iconSvg(ZoomIn, 14))}
        </button>
      </div>
      <span class="timeline-toolbar-hint">Drag chart to pan · Drag axis to zoom · Shift+wheel to zoom</span>
    </div>
    <div class="timeline-svg-wrap">${svgStr ? unsafeHTML(svgStr) : nothing}</div>
    <div class="timeline-legend" aria-hidden="true">
      <span class="legend-item"><span class="legend-swatch" style="background:var(--status-completed)"></span>Completed</span>
      <span class="legend-item"><span class="legend-swatch" style="background:var(--status-running)"></span>Running</span>
      <span class="legend-item"><span class="legend-swatch" style="background:var(--status-failed)"></span>Failed</span>
      <span class="legend-item"><span class="legend-swatch legend-swatch--gap"></span>Gap</span>
      <span class="legend-item">${unsafeHTML(
        `<svg class="legend-loopback" width="22" height="14" viewBox="0 0 22 14">
          <path d="M2,11 Q11,1 20,11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M20,11 L17,8 L17.5,12 Z" fill="currentColor"/>
        </svg>`,
      )}Loopback</span>
    </div>
    <div class="timeline-tooltip" style="display:none" role="tooltip"></div>
    <sl-drawer class="iteration-drawer" placement="end"></sl-drawer>
  </div>`;
}
