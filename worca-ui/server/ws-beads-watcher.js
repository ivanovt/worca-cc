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
 * @param {{ worcaDir: string, broadcaster: { broadcast: Function }, projectId?: string }} deps
 */
export function createBeadsWatcher({ worcaDir, broadcaster, projectId }) {
  const beadsDbPath = resolve(join(worcaDir, '..', '.beads', 'beads.db'));
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
