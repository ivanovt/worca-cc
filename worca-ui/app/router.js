export function parseHash(hash) {
  const clean = (hash || '').replace(/^#\/?/, '');
  const [path, query] = clean.split('?');
  const parts = path.split('/').filter(Boolean);

  // New path-segment format: project/{slug}[/{section}[/{runId}[/{action}]]]
  // A bare `#/project/{slug}` is treated as `#/project/{slug}/active` so the
  // bootstrap can resolve projectId and avoid fanning worktree fetches across
  // every registered project.
  if (parts[0] === 'project' && parts.length >= 2) {
    return {
      section: parts[2] || 'active',
      runId: parts[3] || null,
      action: parts[4] || null,
      projectId: parts[1],
    };
  }

  // Short format: {section}[/{runId}[/{action}]] (single-project / no project in URL)
  const section = parts[0] || 'active';
  const runId = parts[1] || null;
  const action = parts[2] || null;

  // Backward compat: fall back to query params if present
  const params = new URLSearchParams(query || '');
  return {
    section,
    runId: runId || params.get('run') || null,
    action,
    projectId: params.get('project') || null,
  };
}

export function buildHash(section, runId, projectId, action) {
  const segments = [section];
  if (runId) segments.push(runId);
  if (action) segments.push(action);
  if (projectId) {
    return `#/project/${projectId}/${segments.join('/')}`;
  }
  return `#/${segments.join('/')}`;
}

export function onHashChange(callback) {
  const handler = () => callback(parseHash(location.hash));
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}

export function navigate(section, runId, projectId, action) {
  location.hash = buildHash(section, runId, projectId, action);
}
