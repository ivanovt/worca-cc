import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

let httpServer;
let port;

async function startApp(options = {}) {
  const app = createApp(options);
  httpServer = createServer(app);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  port = httpServer.address().port;
}

beforeEach(async () => {
  await startApp({});
});

afterEach(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
  }
});

describe('GET /api/tools', () => {
  it('returns ok true with a tools array', async () => {
    const res = await fetch(`http://localhost:${port}/api/tools`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it('includes core Claude Code tools', async () => {
    const res = await fetch(`http://localhost:${port}/api/tools`);
    const body = await res.json();
    const names = body.tools.map((t) => t.name);
    expect(names).toContain('Bash');
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('Edit');
    expect(names).toContain('Grep');
    expect(names).toContain('Glob');
    expect(names).toContain('Agent');
    expect(names).toContain('Skill');
  });

  it('tools that are in always_disallowed are still listed', async () => {
    const res = await fetch(`http://localhost:${port}/api/tools`);
    const body = await res.json();
    const names = body.tools.map((t) => t.name);
    expect(names).toContain('EnterPlanMode');
    expect(names).toContain('EnterWorktree');
    expect(names).toContain('TodoWrite');
  });

  it('each tool has name and group fields', async () => {
    const res = await fetch(`http://localhost:${port}/api/tools`);
    const body = await res.json();
    for (const tool of body.tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.group).toBe('string');
    }
  });
});

describe('GET /api/skills', () => {
  it('returns ok true with a skills array (fallback)', async () => {
    const res = await fetch(`http://localhost:${port}/api/skills`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.skills.length).toBeGreaterThan(0);
  });

  it('fallback includes governance-relevant skills', async () => {
    const res = await fetch(`http://localhost:${port}/api/skills`);
    const body = await res.json();
    const names = body.skills.map((s) => s.name);
    expect(names).toContain('init');
    expect(names).toContain('review');
    expect(names).toContain('loop');
  });

  it('each skill has name and group fields', async () => {
    const res = await fetch(`http://localhost:${port}/api/skills`);
    const body = await res.json();
    for (const skill of body.skills) {
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.group).toBe('string');
    }
  });

  it('indicates source as fallback or live', async () => {
    const res = await fetch(`http://localhost:${port}/api/skills`);
    const body = await res.json();
    expect(['fallback', 'live']).toContain(body.source);
  });
});
