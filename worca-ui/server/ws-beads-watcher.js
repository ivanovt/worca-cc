/**
 * Beads database watcher — monitors .beads/beads.db for changes.
 * Uses both fs.watch (directory events) and fs.watchFile (stat-based polling)
 * because fs.watch on macOS misses SQLite WAL writes done via mmap.
 */

import { existsSync, statSync, unwatchFile, watch, watchFile } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  countIssuesByRunLabel,
  enrichIssuesWithDeps,
  listIssuesShallow,
} from './beads-reader.js';

const BEADS_DEBOUNCE_MS = 500;
const BEADS_POLL_MS = 2000;

/**
 * Resolve the beads.db path for a project's worcaDir, independent of any
 * watcher instance. Used by tier-independent count lookups (chat-only mode,
 * where no beadsWatcher exists because the WatcherSet is in TIER_POLLING).
 * @param {string} worcaDir
 * @returns {string}
 */
export function beadsDbPathFor(worcaDir) {
  return resolve(join(worcaDir, '..', '.beads', 'beads.db'));
}

/**
 * @param {{ worcaDir: string, broadcaster: { broadcast: Function }, projectId?: string }} deps
 */
export function createBeadsWatcher({ worcaDir, broadcaster, projectId }) {
  const beadsDbPath = beadsDbPathFor(worcaDir);
  const beadsDir = resolve(join(worcaDir, '..', '.beads'));
  const beadsWalPath = `${beadsDbPath}-wal`;
  let fsWatcher = null;
  let BEADS_REFRESH_TIMER = null;
  let lastPayloadJson = null;
  let lastSelfReadWalStat = null;
  let latestCounts = {};
  // In-flight guard + trailing coalesce. The refresh body spawns several `bd`
  // subprocesses (listIssues + countIssuesByRunLabel) that, on a large beads db,
  // take seconds. The debounce only collapses scheduling — once the async body
  // is awaiting, a fresh db/WAL event would otherwise start an overlapping
  // refresh and pile up bd processes unbounded. Allow at most one refresh in
  // flight; events arriving mid-refresh collapse into a single trailing pass.
  let refreshing = false;
  let refreshPending = false;
  let lastListFingerprint = null;

  function computeFingerprint(issues) {
    const sorted = [...issues].sort((a, b) => (a.id < b.id ? -1 : 1));
    return JSON.stringify(
      sorted.map((i) => ({
        id: i.id,
        status: i.status,
        priority: i.priority,
        title: i.title,
        updated_at: i.updated_at,
      })),
    );
  }

  function recordWalStat() {
    try {
      const s = statSync(beadsWalPath);
      lastSelfReadWalStat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      lastSelfReadWalStat = null;
    }
  }

  function scheduleBeadsRefresh() {
    if (BEADS_REFRESH_TIMER) clearTimeout(BEADS_REFRESH_TIMER);
    BEADS_REFRESH_TIMER = setTimeout(runBeadsRefresh, BEADS_DEBOUNCE_MS);
  }

  async function runBeadsRefresh() {
    BEADS_REFRESH_TIMER = null;
    if (refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;
    try {
      const shallowIssues = await listIssuesShallow(beadsDbPath);
      const fingerprint = computeFingerprint(shallowIssues);
      if (fingerprint === lastListFingerprint) {
        recordWalStat();
        return;
      }
      lastListFingerprint = fingerprint;

      const [issues, counts] = await Promise.all([
        enrichIssuesWithDeps(shallowIssues, beadsDbPath),
        countIssuesByRunLabel(beadsDbPath).catch(() => ({})),
      ]);
      latestCounts = counts;
      const payloadJson = JSON.stringify({ issues, counts });
      if (payloadJson !== lastPayloadJson) {
        lastPayloadJson = payloadJson;
        broadcaster.broadcast(
          'beads-update',
          {
            issues,
            counts,
            dbExists: true,
            dbPath: beadsDbPath,
          },
          projectId,
        );
      }
      recordWalStat();
    } catch {
      /* ignore */
    } finally {
      refreshing = false;
      if (refreshPending) {
        refreshPending = false;
        scheduleBeadsRefresh();
      }
    }
  }

  if (existsSync(beadsDir)) {
    // fs.watch for directory-level events (checkpoint writes to main db)
    try {
      fsWatcher = watch(beadsDir, (_event, filename) => {
        if (filename?.startsWith('beads.db')) scheduleBeadsRefresh();
      });
    } catch {
      /* ignore */
    }

    // fs.watchFile (stat-based polling) for WAL — fs.watch misses mmap writes
    // on macOS. watchFile tolerates a missing file; it starts firing once created.
    watchFile(beadsWalPath, { interval: BEADS_POLL_MS }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) {
        if (
          lastSelfReadWalStat &&
          curr.mtimeMs === lastSelfReadWalStat.mtimeMs &&
          curr.size === lastSelfReadWalStat.size
        ) {
          return;
        }
        scheduleBeadsRefresh();
      }
    });
  }

  function getBeadsDbPath() {
    return beadsDbPath;
  }

  function destroy() {
    if (fsWatcher) fsWatcher.close();
    try {
      unwatchFile(beadsWalPath);
    } catch {
      /* */
    }
  }

  function getLatestCounts() {
    return latestCounts;
  }

  return { getBeadsDbPath, getLatestCounts, destroy };
}

// Throttle window for the cold-path bead-count read (used by REST /runs and chat
// when no live watcher is warm). The read costs seconds on a large db, so a short
// TTL lets repeated /runs across many projects re-spawn `bd` too often. Counts are
// advisory and the live watcher keeps a viewed project fresh, so 30s is ample.
const FALLBACK_TTL_MS = 30000;
/** @type {Map<string, { ts: number, counts: object }>} */
const fallbackCache = new Map();
/** @type {Map<string, Promise<object>>} */
const fallbackInflight = new Map();

/**
 * Resolve per-run bead counts for a WatcherSet, independent of its tier.
 *
 * Fast path: the live watcher cache, populated only while a UI client is
 * subscribed (TIER_FULL). Fallback: an on-demand DB read for callers that
 * have no active watcher — e.g. chat integrations hitting REST with no
 * browser open, where the WatcherSet sits in TIER_POLLING and `beadsWatcher`
 * is null. The fallback is TTL-cached and in-flight-deduplicated so repeated
 * chat polling does not spawn a `bd` subprocess per request.
 *
 * @param {{ projectId?: string, worcaDir?: string, beadsWatcher?: { getLatestCounts: () => object } | null }} [wset]
 * @returns {Promise<Record<string, { total: number, done: number }>>}
 */
export async function resolveBeadsCounts(wset) {
  if (!wset || !wset.worcaDir) return {};

  const live = wset.beadsWatcher?.getLatestCounts();
  if (live && Object.keys(live).length > 0) return live;

  const key = wset.projectId ?? wset.worcaDir;
  const cached = fallbackCache.get(key);
  if (cached && Date.now() - cached.ts < FALLBACK_TTL_MS) return cached.counts;
  if (fallbackInflight.has(key)) return fallbackInflight.get(key);

  const dbPath = beadsDbPathFor(wset.worcaDir);
  if (!existsSync(dbPath)) return {};

  const promise = (async () => {
    try {
      const counts = await countIssuesByRunLabel(dbPath);
      fallbackCache.set(key, { ts: Date.now(), counts });
      return counts;
    } catch {
      return {};
    } finally {
      fallbackInflight.delete(key);
    }
  })();
  fallbackInflight.set(key, promise);
  return promise;
}

/**
 * Non-blocking variant of {@link resolveBeadsCounts}: returns whatever counts
 * are already available (the live watcher cache, or a fresh TTL-cached fallback)
 * WITHOUT ever awaiting the cold `bd` query. When nothing is cached it kicks off
 * a background refresh (reusing the same TTL cache + in-flight dedup) so a later
 * caller gets real data, and returns {} immediately.
 *
 * Used by the REST `/runs` endpoint: a cold `bd show` on a large beads db
 * (worca-cc has hundreds of issues — the cold read takes ~10s) would otherwise
 * block the run list and, fanned out across every project, stall the whole UI.
 * Bead counts on run cards are advisory and arrive via the `beads-update`
 * broadcast once warm; the web run-detail does not use them at all.
 *
 * @param {{ projectId?: string, worcaDir?: string, beadsWatcher?: { getLatestCounts: () => object } | null }} [wset]
 * @returns {Record<string, { total: number, done: number }>}
 */
export function peekBeadsCounts(wset) {
  if (!wset || !wset.worcaDir) return {};

  const live = wset.beadsWatcher?.getLatestCounts();
  if (live && Object.keys(live).length > 0) return live;

  const key = wset.projectId ?? wset.worcaDir;
  const cached = fallbackCache.get(key);
  if (cached && Date.now() - cached.ts < FALLBACK_TTL_MS) return cached.counts;

  // Cold cache: warm it in the background (dedup'd), but never block the caller.
  if (!fallbackInflight.has(key)) {
    const dbPath = beadsDbPathFor(wset.worcaDir);
    if (existsSync(dbPath)) {
      const promise = (async () => {
        try {
          const counts = await countIssuesByRunLabel(dbPath);
          fallbackCache.set(key, { ts: Date.now(), counts });
          return counts;
        } catch {
          return {};
        } finally {
          fallbackInflight.delete(key);
        }
      })();
      fallbackInflight.set(key, promise);
    }
  }
  return {};
}
