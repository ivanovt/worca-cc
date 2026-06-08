/**
 * Combined single-pass reader for a run's events.jsonl.
 *
 * Previously enrichment read the same file TWICE — once for dispatch events
 * (dispatch-events-aggregator) and once for graph-query events
 * (graph-query-aggregator) — each its own readFileSync + split + per-line
 * JSON.parse. This module reads + parses the file ONCE and dispatches each line
 * to both classifiers, halving the cost wherever enrichment still runs
 * (findRun, the detailed-view live-update path). See issue #296.
 *
 * Results are cached by file mtime+size so an unchanged events.jsonl is parsed
 * at most once across repeated enrichment (multiple subscribe-run calls, the
 * status watcher's debounced refresh). A live run appends to the file, changing
 * mtime+size on every flush, so it always re-reads — exactly what we want for
 * fresh per-iteration counts. The cache is bounded to avoid unbounded growth on
 * a long-lived global-mode server.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseDispatchEventLine } from './dispatch-events-aggregator.js';
import { parseGraphQueryEventLine } from './graph-query-aggregator.js';

const _parsedEventsCache = new Map(); // cacheKey → { dispatchEvents, graphEvents }
const _MAX_CACHE_ENTRIES = 256;

const EMPTY = Object.freeze({
  dispatchEvents: Object.freeze([]),
  graphEvents: Object.freeze([]),
});

/** Clear the events.jsonl parse cache (tests, or explicit invalidation). */
export function _clearEventsJsonlCache() {
  _parsedEventsCache.clear();
}

/**
 * Read a run's events.jsonl ONCE and return both dispatch and graph-query
 * events. No-op (empty arrays) when the file is missing or unreadable.
 *
 * @param {string} eventsPath — absolute path to events.jsonl
 * @returns {{dispatchEvents: Array, graphEvents: Array}}
 */
export function readEventsForEnrichment(eventsPath) {
  if (!eventsPath || !existsSync(eventsPath)) return EMPTY;

  let stat;
  try {
    stat = statSync(eventsPath);
  } catch {
    return EMPTY;
  }

  const cacheKey = `${eventsPath}:${stat.mtimeMs}:${stat.size}`;
  const cached = _parsedEventsCache.get(cacheKey);
  if (cached) return cached;

  let content;
  try {
    content = readFileSync(eventsPath, 'utf8');
  } catch {
    return EMPTY;
  }

  const dispatchEvents = [];
  const graphEvents = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // A line is at most one of these (distinct event_types) — classify once.
    const d = parseDispatchEventLine(e);
    if (d) {
      dispatchEvents.push(d);
      continue;
    }
    const g = parseGraphQueryEventLine(e);
    if (g) graphEvents.push(g);
  }

  const result = { dispatchEvents, graphEvents };

  // Bound cache growth — evict the oldest entry (insertion order) when full.
  if (_parsedEventsCache.size >= _MAX_CACHE_ENTRIES) {
    const oldest = _parsedEventsCache.keys().next().value;
    _parsedEventsCache.delete(oldest);
  }
  _parsedEventsCache.set(cacheKey, result);
  return result;
}
