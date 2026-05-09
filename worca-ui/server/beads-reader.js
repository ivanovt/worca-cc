import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runBd(args, dbPath) {
  const fullArgs = [...args, '--json', '--db', dbPath];
  const { stdout } = await execFileAsync('bd', fullArgs, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function transformIssue(issue, deps) {
  const depends_on = (deps || []).map((d) => d.id);
  const blocked_by = (deps || [])
    .filter((d) => d.status !== 'closed' && d.status !== 'tombstone')
    .map((d) => d.id);
  return {
    id: issue.id,
    title: issue.title,
    body: issue.description || '',
    status: issue.status,
    priority: issue.priority,
    created_at: issue.created_at || '',
    external_ref: issue.external_ref || null,
    depends_on,
    blocked_by,
  };
}

async function enrichWithDeps(issues, dbPath) {
  const needDeps = issues.filter((i) => i.dependency_count > 0);
  if (needDeps.length === 0) {
    return issues.map((i) => transformIssue(i, []));
  }
  const detailed = await runBd(['show', ...needDeps.map((i) => i.id)], dbPath);
  const depMap = new Map(detailed.map((d) => [d.id, d.dependencies || []]));
  return issues.map((i) => transformIssue(i, depMap.get(i.id) || []));
}

export function dbExists(beadsDb) {
  return existsSync(beadsDb);
}

export async function listIssues(beadsDb) {
  try {
    const issues = await runBd(['list', '--limit', '0'], beadsDb);
    return enrichWithDeps(issues, beadsDb);
  } catch {
    return [];
  }
}

export async function listIssuesByLabel(beadsDb, label) {
  try {
    const issues = await runBd(
      ['list', '--label-any', label, '--all', '--limit', '0'],
      beadsDb,
    );
    return enrichWithDeps(issues, beadsDb);
  } catch {
    return [];
  }
}

export async function listUnlinkedIssues(beadsDb) {
  try {
    const issues = await runBd(['list', '--limit', '0'], beadsDb);
    if (issues.length === 0) return [];
    // bd list doesn't include labels — use bd show to get them
    const detailed = await runBd(['show', ...issues.map((i) => i.id)], beadsDb);
    const detailMap = new Map(detailed.map((d) => [d.id, d]));
    const unlinked = issues.filter((i) => {
      const d = detailMap.get(i.id);
      const labels = d?.labels || [];
      return !labels.some((l) => l.startsWith('run:'));
    });
    // detailed already has dependencies, use them directly
    return unlinked.map((i) => {
      const d = detailMap.get(i.id);
      return transformIssue(i, d?.dependencies || []);
    });
  } catch {
    return [];
  }
}

/**
 * Returns { runId: { total, done } } for every run:<id> label in the beads db.
 *
 * Single-pass: bd label list-all (totals) + bd list --all (ids) +
 * bd show <all-ids> (labels + statuses), then group by run labels in JS.
 * Always 3 bd calls regardless of run-label count.
 *
 * Called by the beads watcher on every db change (counts are included in the
 * broadcast payload) and by the list-beads-counts endpoint for initial load
 * and project switch.
 */
export async function countIssuesByRunLabel(beadsDb) {
  try {
    const rows = await runBd(['label', 'list-all'], beadsDb);
    const counts = {};
    const runLabels = rows.filter((r) => r.label.startsWith('run:'));
    if (runLabels.length === 0) return counts;
    for (const row of runLabels) {
      counts[row.label.replace('run:', '')] = { total: row.count, done: 0 };
    }
    try {
      const issues = await runBd(['list', '--all', '--limit', '0'], beadsDb);
      if (issues.length === 0) return counts;
      const detailed = await runBd(
        ['show', ...issues.map((i) => i.id)],
        beadsDb,
      );
      for (const issue of detailed) {
        if (issue.status !== 'closed') continue;
        for (const label of issue.labels || []) {
          if (label.startsWith('run:')) {
            const runId = label.replace('run:', '');
            if (counts[runId]) counts[runId].done++;
          }
        }
      }
    } catch {
      /* leave done at 0 for all runs on list/show failure */
    }
    return counts;
  } catch {
    return {};
  }
}

export async function listDistinctRunLabels(beadsDb) {
  try {
    const rows = await runBd(['label', 'list-all'], beadsDb);
    return rows.filter((r) => r.label.startsWith('run:')).map((r) => r.label);
  } catch {
    return [];
  }
}

export async function getIssue(beadsDb, id) {
  try {
    const results = await runBd(['show', id], beadsDb);
    if (!results || results.length === 0) return null;
    const issue = results[0];
    return transformIssue(issue, issue.dependencies || []);
  } catch {
    return null;
  }
}
