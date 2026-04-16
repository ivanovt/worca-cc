import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

let root;
let httpServer;
let port;

function write(path, content = '# agent\n') {
  writeFileSync(path, content);
}

async function startApp({
  userDir,
  pluginCacheDir,
  projectAgentsDir,
  projectRoot,
} = {}) {
  const app = createApp({
    projectRoot,
    subagentDirs: { userDir, pluginCacheDir, projectAgentsDir },
  });
  httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  port = httpServer.address().port;
}

beforeEach(() => {
  root = join(
    tmpdir(),
    `worca-subagents-api-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterEach(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/subagents', () => {
  it('returns builtins when no discovery sources exist', async () => {
    await startApp({
      userDir: join(root, 'no-user'),
      pluginCacheDir: join(root, 'no-cache'),
    });
    const res = await fetch(`http://localhost:${port}/api/subagents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const names = body.subagents.map((t) => t.name);
    // All five built-in Claude Code subagents should be present by default.
    expect(names).toContain('Explore');
    expect(names).toContain('general-purpose');
    expect(names).toContain('Plan');
    expect(names).toContain('statusline-setup');
    expect(names).toContain('claude-code-guide');
  });

  it('returns user-global agents alongside builtins', async () => {
    const userDir = join(root, 'user');
    mkdirSync(userDir);
    write(join(userDir, 'doc-sync-analyzer.md'));

    await startApp({ userDir, pluginCacheDir: join(root, 'no-cache') });
    const res = await fetch(`http://localhost:${port}/api/subagents`);
    const body = await res.json();
    const userEntry = body.subagents.find(
      (t) => t.name === 'doc-sync-analyzer',
    );
    expect(userEntry).toEqual({
      name: 'doc-sync-analyzer',
      label: '(user)',
      group: 'User',
    });
  });

  it('returns plugin agents with plugin:agent qualified names', async () => {
    const cache = join(root, 'cache');
    const agentsDir = join(cache, 'mkt', 'feature-dev', '1.0.0', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    write(join(agentsDir, 'code-reviewer.md'));

    await startApp({ userDir: join(root, 'no-user'), pluginCacheDir: cache });
    const res = await fetch(`http://localhost:${port}/api/subagents`);
    const body = await res.json();
    const pluginEntry = body.subagents.find(
      (t) => t.name === 'feature-dev:code-reviewer',
    );
    expect(pluginEntry).toEqual({
      name: 'feature-dev:code-reviewer',
      label: '(plugin)',
      group: 'Plugin',
    });
  });

  it('includes project-local agents when projectRoot is set', async () => {
    const projectRoot = join(root, 'proj');
    const projectAgents = join(projectRoot, '.claude', 'agents');
    mkdirSync(projectAgents, { recursive: true });
    write(join(projectAgents, 'local-helper.md'));

    await startApp({
      userDir: join(root, 'no-user'),
      pluginCacheDir: join(root, 'no-cache'),
      projectAgentsDir: projectAgents,
      projectRoot,
    });
    const res = await fetch(`http://localhost:${port}/api/subagents`);
    const body = await res.json();
    const projectEntry = body.subagents.find((t) => t.name === 'local-helper');
    expect(projectEntry).toEqual({
      name: 'local-helper',
      label: '(project)',
      group: 'Project',
    });
  });

  it('groups subagents by source in a single flat list', async () => {
    const userDir = join(root, 'user');
    const cache = join(root, 'cache');
    const pluginAgents = join(cache, 'mkt', 'feature-dev', '1.0.0', 'agents');
    mkdirSync(userDir);
    mkdirSync(pluginAgents, { recursive: true });
    write(join(userDir, 'user-one.md'));
    write(join(pluginAgents, 'plug-one.md'));

    await startApp({ userDir, pluginCacheDir: cache });
    const res = await fetch(`http://localhost:${port}/api/subagents`);
    const body = await res.json();
    const groups = new Set(body.subagents.map((t) => t.group));
    expect(groups.has('Built-in')).toBe(true);
    expect(groups.has('User')).toBe(true);
    expect(groups.has('Plugin')).toBe(true);
  });
});
