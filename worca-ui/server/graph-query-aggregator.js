/**
 * Graph-query aggregator — reads pipeline.hook.graph_query events from a run's
 * events.jsonl and turns them into live per-iteration query counts
 * (graphify_invocations / crg_invocations / crg_tool_counts), assigned to the
 * matching iteration in status.json by timestamp range.
 *
 * This is the live counterpart to the runner's completion-time tally: the
 * runner writes the authoritative graphify_invocations / crg_invocations onto
 * each iteration when the stage *completes*. For a still-running iteration that
 * count is absent, so the graphify/CRG badges would otherwise stay blank until
 * completion. This aggregator fills the gap by counting the live hook events —
 * exactly like dispatch-events-aggregator does for skills/subagents — and only
 * for iterations that don't already carry the runner's number (so the
 * authoritative completion count is never clobbered).
 */

import { existsSync, readFileSync } from 'node:fs';

const GRAPH_QUERY_EVENT_TYPE = 'pipeline.hook.graph_query';

/**
 * Classify a single parsed events.jsonl line. Returns the normalised graph-query
 * entry if the line is a graph-query event, or null otherwise. Extracted so a
 * combined single-pass reader (events-jsonl-reader.js) can share the exact same
 * normalisation as the standalone reader below.
 *
 * @param {object} e — a parsed events.jsonl object
 * @returns {{engine, op, timestamp}|null}
 */
export function parseGraphQueryEventLine(e) {
  if (!e || e.event_type !== GRAPH_QUERY_EVENT_TYPE) return null;
  const payload = e.payload || {};
  const engine = payload.engine;
  if (engine !== 'graphify' && engine !== 'crg') return null;
  return { engine, op: payload.op || '', timestamp: e.timestamp };
}

/**
 * Parse events.jsonl and return only the graph-query events.
 * Malformed lines are skipped so a corrupt event doesn't break the run view.
 *
 * @param {string} eventsPath — absolute path to events.jsonl
 * @returns {Array<{engine, op, timestamp}>}
 */
export function readGraphQueryEventsFromJsonl(eventsPath) {
  if (!eventsPath || !existsSync(eventsPath)) return [];
  let content;
  try {
    content = readFileSync(eventsPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = parseGraphQueryEventLine(e);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Given a list of graph-query events and a stages map from status.json, return
 * a new stages map where each iteration that overlaps an event's timestamp gets
 * live query counts — but ONLY when the iteration does not already carry the
 * runner's authoritative count (i.e. the still-running iteration). Completed
 * iterations are left exactly as the runner wrote them.
 *
 * Counts added per matching running iteration:
 *   graphify_invocations: <number>   (graphify-engine events)
 *   crg_invocations:      <number>   (crg-engine events)
 *   crg_tool_counts:      { <op>: <number> }   (crg-engine, by tool — tooltip)
 *
 * Non-destructive: input stages object is shallow-copied; touched iterations
 * get new objects. Existing iteration fields are preserved.
 *
 * @param {Array<{engine, op, timestamp}>} events
 * @param {object} stages — status.stages
 * @returns {object} enriched stages
 */
export function assignGraphQueryCountsToIterations(events, stages) {
  if (!stages || typeof stages !== 'object') return stages;
  if (!events || events.length === 0) return stages;

  // Bucket events into iterations by timestamp. Bucket key: `${stageKey}|${num}`.
  const buckets = new Map();
  for (const ev of events) {
    if (!ev.timestamp) continue;
    const eventTime = Date.parse(ev.timestamp);
    if (Number.isNaN(eventTime)) continue;

    let matched = false;
    for (const [stageKey, stage] of Object.entries(stages)) {
      const iterations = stage?.iterations;
      if (!Array.isArray(iterations)) continue;
      for (const iter of iterations) {
        // Only fill counts for iterations the runner hasn't tallied yet —
        // a present number means the stage completed and is authoritative.
        if (typeof iter.graphify_invocations === 'number') continue;
        if (typeof iter.crg_invocations === 'number') continue;
        const start = iter.started_at ? Date.parse(iter.started_at) : NaN;
        if (Number.isNaN(start)) continue;
        const end = iter.completed_at
          ? Date.parse(iter.completed_at)
          : Number.POSITIVE_INFINITY;
        if (eventTime >= start && eventTime <= end) {
          const key = `${stageKey}|${iter.number}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(ev);
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  if (buckets.size === 0) return stages;

  const enrichedStages = { ...stages };
  for (const [key, bucketEvents] of buckets) {
    const [stageKey, iterNumStr] = key.split('|');
    const iterNum = Number(iterNumStr);
    const stage = enrichedStages[stageKey];
    if (!stage) continue;
    const counts = tally(bucketEvents);
    const newIterations = stage.iterations.map((iter) =>
      iter.number === iterNum ? { ...iter, ...counts } : iter,
    );
    enrichedStages[stageKey] = { ...stage, iterations: newIterations };
  }
  return enrichedStages;
}

/**
 * Tally graph-query events into the count shape the badges read.
 *
 * @param {Array<{engine, op}>} events
 * @returns {{graphify_invocations, crg_invocations, crg_tool_counts}}
 */
function tally(events) {
  let graphify = 0;
  let crg = 0;
  const crgToolCounts = {};
  for (const ev of events) {
    if (ev.engine === 'graphify') {
      graphify += 1;
    } else if (ev.engine === 'crg') {
      crg += 1;
      const op = ev.op || 'unknown';
      crgToolCounts[op] = (crgToolCounts[op] || 0) + 1;
    }
  }
  return {
    graphify_invocations: graphify,
    crg_invocations: crg,
    crg_tool_counts: crgToolCounts,
  };
}
