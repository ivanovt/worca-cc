import { STAGE_ORDER } from './stage-order.js';

// "pr" → "PR" (acronym); "plan_review" → "Plan Review"; etc.
const ACRONYM_KEYS = new Set(['pr']);
function toDisplayLabel(key) {
  if (ACRONYM_KEYS.has(key)) return key.toUpperCase();
  return key
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

/**
 * Projects run.stages into the swimlane layout model used by the timeline view.
 *
 * @param {object|null} stages - run.stages from status.json
 * @param {string} runEndTime - ISO timestamp for the right edge (pass now() for active runs)
 * @returns {{ runStart, runEnd, totalMs, rows, loopbacks }}
 */
export function computeTimelineLayout(stages, runEndTime) {
  if (!stages) {
    return {
      runStart: runEndTime,
      runEnd: runEndTime,
      totalMs: 0,
      rows: [],
      loopbacks: [],
    };
  }

  // Collect all non-empty, non-all-skipped stage entries in pipeline order
  const stageEntries = STAGE_ORDER.map((key) => [key, stages[key]]).filter(
    ([, stage]) => {
      if (!stage || !stage.iterations || stage.iterations.length === 0)
        return false;
      return stage.iterations.some((it) => it.status !== 'skipped');
    },
  );

  if (stageEntries.length === 0) {
    return {
      runStart: runEndTime,
      runEnd: runEndTime,
      totalMs: 0,
      rows: [],
      loopbacks: [],
    };
  }

  // Determine runStart: earliest started_at across all iterations
  let runStartMs = Infinity;
  for (const [, stage] of stageEntries) {
    for (const it of stage.iterations) {
      if (it.started_at) {
        const t = new Date(it.started_at).getTime();
        if (t < runStartMs) runStartMs = t;
      }
    }
  }

  const runEndMs = new Date(runEndTime).getTime();
  const runStartIso = new Date(runStartMs).toISOString();
  const totalMs = runEndMs - runStartMs;

  // Build flat iteration lookup keyed by stageKey for gap/overlap queries
  // itersByStage: Map<stageKey, [{startMs, endMs, number}]>
  const itersByStage = new Map();
  for (const [key, stage] of stageEntries) {
    const list = stage.iterations
      .filter((it) => it.started_at)
      .map((it, idx) => ({
        startMs: new Date(it.started_at).getTime() - runStartMs,
        endMs: it.completed_at
          ? new Date(it.completed_at).getTime() - runStartMs
          : totalMs,
        number: it.number ?? idx + 1,
      }));
    itersByStage.set(key, list);
  }

  // Build rows
  const rows = stageEntries
    .map(([key, stage]) => {
      const bars = stage.iterations
        .filter((it) => it.started_at)
        .map((it, idx) => {
          const startMs = new Date(it.started_at).getTime() - runStartMs;
          const endMs = it.completed_at
            ? new Date(it.completed_at).getTime() - runStartMs
            : totalMs;
          return {
            number: it.number ?? idx + 1,
            startMs,
            durMs: endMs - startMs,
            status: it.status,
            cost: it.cost_usd ?? 0,
            model: it.model ?? null,
            agent: it.agent ?? null,
          };
        });

      // Compute gaps between consecutive bars
      const gaps = [];
      for (let i = 0; i < bars.length - 1; i++) {
        const gapStart = bars[i].startMs + bars[i].durMs;
        const gapEnd = bars[i + 1].startMs;
        if (gapEnd <= gapStart) continue;

        const inStage = findInStage(key, gapStart, gapEnd, itersByStage);
        gaps.push({
          afterIter: bars[i].number,
          startMs: gapStart,
          durMs: gapEnd - gapStart,
          inStage,
        });
      }

      return {
        stageKey: key,
        stageLabel: toDisplayLabel(key),
        iterationCount: bars.length,
        bars,
        gaps,
      };
    })
    .filter((row) => row.bars.length > 0);

  // Build loopbacks from gaps that have inStage — only backward arcs:
  // inStage must be later in STAGE_ORDER than the row's stage, meaning a downstream
  // stage ran and triggered this earlier stage to retry.
  const loopbacks = [];
  for (const row of rows) {
    const rowIdx = STAGE_ORDER.indexOf(row.stageKey);
    for (let g = 0; g < row.gaps.length; g++) {
      const gap = row.gaps[g];
      if (!gap.inStage) continue;
      if (STAGE_ORDER.indexOf(gap.inStage) <= rowIdx) continue;

      // Find which iteration of inStage overlapped this gap
      const inStageIters = itersByStage.get(gap.inStage) ?? [];
      const overlapping = inStageIters.filter(
        (it) => it.startMs < gap.startMs + gap.durMs && it.endMs > gap.startMs,
      );
      const fromIter =
        overlapping.length > 0
          ? overlapping[overlapping.length - 1].number
          : null;

      loopbacks.push({
        fromStage: gap.inStage,
        fromIter,
        toStage: row.stageKey,
        toIter: row.bars[g + 1]?.number ?? null,
      });
    }
  }

  return {
    runStart: runStartIso,
    runEnd: runEndTime,
    totalMs,
    rows,
    loopbacks,
  };
}

/**
 * Find which stage (other than excludeKey) occupied the gap window [gapStart, gapEnd].
 * If multiple stages overlap, returns the one whose overlapping iteration ended closest to gapEnd.
 * Returns null if no stage overlaps.
 */
function findInStage(excludeKey, gapStart, gapEnd, itersByStage) {
  let bestKey = null;
  let bestEndDelta = Infinity;

  for (const [key, iters] of itersByStage) {
    if (key === excludeKey) continue;
    for (const it of iters) {
      if (it.startMs < gapEnd && it.endMs > gapStart) {
        const delta = Math.abs(it.endMs - gapEnd);
        if (delta < bestEndDelta) {
          bestEndDelta = delta;
          bestKey = key;
        }
      }
    }
  }

  return bestKey;
}
