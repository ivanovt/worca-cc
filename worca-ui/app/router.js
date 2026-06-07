export function parseHash(hash) {
  const clean = (hash || '').replace(/^#\/?/, '');
  const [path, query] = clean.split('?');
  const parts = path.split('/').filter(Boolean);

  // New path-segment format: project/{slug}[/{section}[/{runId}[/{action}]]]
  // The templates section gets one extra segment so the URL captures
  // the tier as well: project/{slug}/templates/{tier}/{id}/{action}
  // — see CLAUDE.md "Pipeline Templates" for the (tier, id) model.
  // Models follow the same tier-bearing shape so URLs like
  // project/{slug}/models/{alias}/edit/{tier} survive refresh / back-button.
  // A bare `#/project/{slug}` is treated as `#/project/{slug}/active` so
  // the bootstrap can resolve projectId without fanning worktree fetches
  // across every registered project.
  if (parts[0] === 'project' && parts.length >= 2) {
    if (parts[2] === 'templates' && parts.length >= 4) {
      return {
        section: 'templates',
        tier: parts[3] || null,
        runId: parts[4] || null, // template id, mapped to runId for shared store code
        action: parts[5] || null,
        projectId: parts[1],
      };
    }
    if (parts[2] === 'models' && parts.length >= 3) {
      // Models tier lives at the END of the path so the URL reads
      // .../models/<alias>/edit/<tier> — closer to how the user thinks
      // of it ("edit the alias, with this tier as storage").
      return {
        section: 'models',
        runId: parts[3] || null, // alias
        action: parts[4] || null,
        tier: parts[5] || null,
        projectId: parts[1],
      };
    }
    return {
      section: parts[2] || 'active',
      runId: parts[3] || null,
      action: parts[4] || null,
      projectId: parts[1],
      tier: null,
    };
  }

  // Short format: {section}[/{runId}[/{action}]] (single-project / no project in URL)
  // Templates here too gain the tier slot: templates/{tier}/{id}/{action}
  if (parts[0] === 'templates' && parts.length >= 2) {
    const params0 = new URLSearchParams(query || '');
    return {
      section: 'templates',
      tier: parts[1] || null,
      runId: parts[2] || null,
      action: parts[3] || null,
      projectId: params0.get('project') || null,
    };
  }

  // Short-format models: models/<alias>/edit/<tier>
  if (parts[0] === 'models' && parts.length >= 2) {
    const params0 = new URLSearchParams(query || '');
    return {
      section: 'models',
      runId: parts[1] || null, // alias
      action: parts[2] || null,
      tier: parts[3] || null,
      projectId: params0.get('project') || null,
    };
  }

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
    tier: null,
  };
}

export function buildHash(section, runId, projectId, action, tier) {
  let segments;
  if (section === 'templates' && tier) {
    // Templates URL carries the tier as a path segment, before the id.
    segments = ['templates', tier];
    if (runId) segments.push(runId);
    if (action) segments.push(action);
  } else if (section === 'models') {
    // Models URL appends tier last: models/<alias>/<action>/<tier>.
    // tier-at-the-end keeps the leading segments compatible with the
    // generic short format while still carrying it through hash changes.
    segments = ['models'];
    if (runId) segments.push(runId);
    if (action) segments.push(action);
    if (tier) segments.push(tier);
  } else {
    segments = [section];
    if (runId) segments.push(runId);
    if (action) segments.push(action);
  }
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

export function navigate(section, runId, projectId, action, tier) {
  location.hash = buildHash(section, runId, projectId, action, tier);
}
