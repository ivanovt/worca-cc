/**
 * Dispatch-event aggregator — reads pipeline.hook.dispatch_{allowed,blocked}
 * events from a run's events.jsonl and assigns them to the matching iteration
 * in status.json by timestamp range.
 *
 * Works for both live and completed runs because it reads only persisted data
 * (events.jsonl is append-only and survives the pipeline process exiting).
 *
 * Aggregation: events are deduplicated per iteration by (type, subagent_type).
 * A `count` field tracks how many times the same (type, subagent_type) fired
 * in that iteration. The `reason` from the first occurrence is kept (reasons
 * for the same key are deterministic — derived from the denylist/rule check).
 *
 * Output shape per iteration:
 *   dispatch_events: [
 *     { type, subagent_type, reason?, count }
 *   ]
 */

import { existsSync, readFileSync } from 'node:fs';

const DISPATCH_EVENT_TYPES = new Set([
  'pipeline.hook.dispatch_allowed',
  'pipeline.hook.dispatch_blocked',
]);

/**
 * Parse events.jsonl and return only the dispatch events, with normalised shape.
 * Malformed lines are silently skipped so a corrupt event doesn't break the run view.
 *
 * @param {string} eventsPath — absolute path to events.jsonl
 * @returns {Array<{type, subagent_type, reason?, timestamp}>}
 */
export function readDispatchEventsFromJsonl(eventsPath) {
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
    if (!DISPATCH_EVENT_TYPES.has(e.event_type)) continue;
    const payload = e.payload || {};
    if (!payload.subagent_type) continue;
    out.push({
      type: e.event_type,
      subagent_type: payload.subagent_type,
      reason: payload.reason,
      timestamp: e.timestamp,
    });
  }
  return out;
}

/**
 * Given a list of dispatch events and a stages map from status.json, return
 * a new stages map where each iteration that overlaps an event's timestamp
 * is enriched with a `dispatch_events` array (deduplicated by type+subagent_type
 * with a count).
 *
 * Non-destructive: input stages object is shallow-copied; iterations get new
 * objects with the extra field. Existing iteration fields are preserved.
 *
 * @param {Array<{type, subagent_type, reason?, timestamp}>} events
 * @param {object} stages — status.stages
 * @returns {object} enriched stages
 */
export function assignEventsToIterations(events, stages) {
  if (!stages || typeof stages !== 'object') return stages;
  if (!events || events.length === 0) {
    // Nothing to add — return input unchanged to avoid unnecessary allocation.
    return stages;
  }

  // Bucket events into iterations first, then aggregate per bucket.
  // Bucket key: `${stageKey}|${iterationNumber}`.
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
        const start = iter.started_at ? Date.parse(iter.started_at) : NaN;
        if (Number.isNaN(start)) continue;
        // If the iteration hasn't completed, treat end as +infinity so live events land here.
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
    // If no iteration matched, the event is silently dropped — it falls
    // outside any recorded iteration window (e.g. during stage transitions).
  }

  if (buckets.size === 0) return stages;

  // Aggregate each bucket and build the enriched stages map.
  const enrichedStages = { ...stages };
  for (const [key, bucketEvents] of buckets) {
    const [stageKey, iterNumStr] = key.split('|');
    const iterNum = Number(iterNumStr);
    const stage = enrichedStages[stageKey];
    if (!stage) continue;
    const aggregated = aggregate(bucketEvents);
    const newIterations = stage.iterations.map((iter) =>
      iter.number === iterNum ? { ...iter, dispatch_events: aggregated } : iter,
    );
    enrichedStages[stageKey] = { ...stage, iterations: newIterations };
  }
  return enrichedStages;
}

/**
 * Deduplicate an array of dispatch events by (type, subagent_type) and count
 * occurrences. First reason wins for blocked events.
 *
 * @param {Array<{type, subagent_type, reason?}>} events
 * @returns {Array<{type, subagent_type, reason?, count}>}
 */
function aggregate(events) {
  const map = new Map();
  for (const ev of events) {
    const key = `${ev.type}|${ev.subagent_type}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const entry = {
        type: ev.type,
        subagent_type: ev.subagent_type,
        count: 1,
      };
      if (ev.reason) entry.reason = ev.reason;
      map.set(key, entry);
    }
  }
  return [...map.values()];
}
