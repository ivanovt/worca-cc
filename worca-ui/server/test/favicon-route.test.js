import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

function startServer(options = {}) {
  const app = createApp(options);
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

describe('GET /favicon.svg', () => {
  it('serves favicon-global.svg with image/svg+xml when projectRoot is null', async () => {
    const { server, base } = await startServer({ projectRoot: null });
    try {
      const res = await fetch(`${base}/favicon.svg`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/image\/svg\+xml/);
      const body = await res.text();
      expect(body).toContain('#00e5a0');
    } finally {
      await stopServer(server);
    }
  });

  it('serves favicon-global.svg when projectRoot is undefined', async () => {
    const { server, base } = await startServer({});
    try {
      const res = await fetch(`${base}/favicon.svg`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/image\/svg\+xml/);
      const body = await res.text();
      expect(body).toContain('#00e5a0');
    } finally {
      await stopServer(server);
    }
  });

  it('serves favicon-project.svg with image/svg+xml when projectRoot is set', async () => {
    const { server, base } = await startServer({
      projectRoot: '/home/user/projects/my-app',
    });
    try {
      const res = await fetch(`${base}/favicon.svg`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/image\/svg\+xml/);
      const body = await res.text();
      expect(body).toContain('#f59e0b');
    } finally {
      await stopServer(server);
    }
  });

  it('favicon route is registered before static middleware', async () => {
    // Verifies the dynamic route takes precedence over express.static
    // (if static served it first, content-type might differ or wrong file served)
    const { server, base } = await startServer({
      projectRoot: '/some/project',
    });
    try {
      const res = await fetch(`${base}/favicon.svg`);
      expect(res.status).toBe(200);
      // Must be dynamic route (project favicon has amber color)
      const body = await res.text();
      expect(body).toContain('#f59e0b');
      expect(body).not.toContain('#00e5a0');
    } finally {
      await stopServer(server);
    }
  });
});
