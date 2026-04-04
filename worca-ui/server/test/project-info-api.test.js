import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

function startServer(projectRoot) {
  const app = createApp({ projectRoot });
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({ server, base });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('GET /api/project-info', () => {
  it('returns the project directory name', async () => {
    const { server, base } = await startServer('/home/user/projects/my-app');
    try {
      const res = await fetch(`${base}/api/project-info`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ name: 'my-app' });
    } finally {
      await stopServer(server);
    }
  });

  it('returns basename when projectRoot has trailing slash', async () => {
    const { server, base } = await startServer('/home/user/projects/my-app/');
    try {
      const res = await fetch(`${base}/api/project-info`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ name: 'my-app' });
    } finally {
      await stopServer(server);
    }
  });

  it('returns empty name when projectRoot is not configured', async () => {
    const { server, base } = await startServer(undefined);
    try {
      const res = await fetch(`${base}/api/project-info`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ name: '' });
    } finally {
      await stopServer(server);
    }
  });
});
