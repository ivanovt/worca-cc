/**
 * Beads database watcher — monitors .beads/beads.db for changes.
 * Uses both fs.watch (directory events) and fs.watchFile (stat-based polling)
 * because fs.watch on macOS misses SQLite WAL writes done via mmap.
 */

import { existsSync, statSync, unwatchFile, watch, watchFile } from 'node:fs';
import { join, resolve } from 'node:path';
import { countIssuesByRunLabel, listIssues } from './beads-reader.js';

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

  function scheduleBeadsRefresh() {
    if (BEADS_REFRESH_TIMER) clearTimeout(BEADS_REFRESH_TIMER);
    BEADS_REFRESH_TIMER = setTimeout(async () => {
      BEADS_REFRESH_TIMER = null;
      try {
        const [issues, counts] = await Promise.all([
          listIssues(beadsDbPath),
          countIssuesByRunLabel(beadsDbPath).catch(() => ({})),
        ]);
        latestCounts = counts;
        const payloadJson = JSON.stringify({ issues, counts });
        if (payloadJson === lastPayloadJson) return;
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
        try {
          const s = statSync(beadsWalPath);
          lastSelfReadWalStat = { mtimeMs: s.mtimeMs, size: s.size };
        } catch {
          lastSelfReadWalStat = null;
        }
      } catch {
        /* ignore */
      }
    }, BEADS_DEBOUNCE_MS);
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

const FALLBACK_TTL_MS = 5000;
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
