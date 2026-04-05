import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function runBd(args, dbPath) {
  const fullArgs = [...args, '--json', '--db', dbPath, '--readonly'];
  const stdout = execFileSync('bd', fullArgs, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
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

function enrichWithDeps(issues, dbPath) {
  const needDeps = issues.filter((i) => i.dependency_count > 0);
  if (needDeps.length === 0) {
    return issues.map((i) => transformIssue(i, []));
  }
  const detailed = runBd(['show', ...needDeps.map((i) => i.id)], dbPath);
  const depMap = new Map(detailed.map((d) => [d.id, d.dependencies || []]));
  return issues.map((i) => transformIssue(i, depMap.get(i.id) || []));
}

export function dbExists(beadsDb) {
  return existsSync(beadsDb);
}

export function listIssues(beadsDb) {
  try {
    const issues = runBd(['list', '--limit', '0'], beadsDb);
    return enrichWithDeps(issues, beadsDb);
  } catch {
    return [];
  }
}

export function listIssuesByLabel(beadsDb, label) {
  try {
    const issues = runBd(
      ['list', '--label-any', label, '--all', '--limit', '0'],
      beadsDb,
    );
    return enrichWithDeps(issues, beadsDb);
  } catch {
    return [];
  }
}

export function listUnlinkedIssues(beadsDb) {
  try {
    const issues = runBd(['list', '--limit', '0'], beadsDb);
    if (issues.length === 0) return [];
    // bd list doesn't include labels — use bd show to get them
    const detailed = runBd(['show', ...issues.map((i) => i.id)], beadsDb);
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

export function countIssuesByRunLabel(beadsDb) {
  try {
    const rows = runBd(['label', 'list-all'], beadsDb);
    const counts = {};
    for (const row of rows) {
      if (row.label.startsWith('run:')) {
        counts[row.label.replace('run:', '')] = row.count;
      }
    }
    return counts;
  } catch {
    return {};
  }
}

export function listDistinctRunLabels(beadsDb) {
  try {
    const rows = runBd(['label', 'list-all'], beadsDb);
    return rows.filter((r) => r.label.startsWith('run:')).map((r) => r.label);
  } catch {
    return [];
  }
}

export function getIssue(beadsDb, id) {
  try {
    const results = runBd(['show', id], beadsDb);
    if (!results || results.length === 0) return null;
    const issue = results[0];
    return transformIssue(issue, issue.dependencies || []);
  } catch {
    return null;
  }
}
