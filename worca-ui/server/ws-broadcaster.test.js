import { describe, expect, it, vi } from 'vitest';
import { createBroadcaster } from './ws-broadcaster.js';

function mockWss(clients = []) {
  return { clients: new Set(clients) };
}

function mockWs() {
  return { readyState: 1, OPEN: 1, send: vi.fn() };
}

function parseSent(ws) {
  return JSON.parse(ws.send.mock.calls[0][0]);
}

describe('createBroadcaster — project envelope stamping', () => {
  it('stamps project from sourceProjectId for unscoped proto-2 client', () => {
    // Client is proto-2 but has no projectId (global subscriber).
    // broadcast() is called with sourceProjectId='proj-a'.
    // The project field should come from the source, not the subscription.
    const ws = mockWs();
    const wss = mockWss([ws]);
    const getSubs = () => ({ protocolVersion: 2, projectId: null });
    const { broadcast } = createBroadcaster({ wss, getSubs });

    broadcast('runs-list', {}, 'proj-a');

    expect(ws.send).toHaveBeenCalledOnce();
    const msg = parseSent(ws);
    expect(msg.project).toBe('proj-a');
  });

  it('stamps project for scoped proto-2 client matching sourceProjectId', () => {
    // Client is subscribed to proj-a; source is also proj-a.
    // Client must not be filtered out and must receive project field.
    const ws = mockWs();
    const wss = mockWss([ws]);
    const getSubs = () => ({ protocolVersion: 2, projectId: 'proj-a' });
    const { broadcast } = createBroadcaster({ wss, getSubs });

    broadcast('runs-list', {}, 'proj-a');

    expect(ws.send).toHaveBeenCalledOnce();
    const msg = parseSent(ws);
    expect(msg.project).toBe('proj-a');
  });

  it('filters out proto-2 client scoped to a different project', () => {
    // Client is subscribed to proj-b; source is proj-a.
    // Scoped-to-different-project clients must be skipped entirely.
    const ws = mockWs();
    const wss = mockWss([ws]);
    const getSubs = () => ({ protocolVersion: 2, projectId: 'proj-b' });
    const { broadcast } = createBroadcaster({ wss, getSubs });

    broadcast('runs-list', {}, 'proj-a');

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('falls back to subscription projectId when sourceProjectId is undefined', () => {
    // broadcast() called without a sourceProjectId.
    // The project envelope should fall back to the client's subscription projectId.
    const ws = mockWs();
    const wss = mockWss([ws]);
    const getSubs = () => ({ protocolVersion: 2, projectId: 'proj-x' });
    const { broadcast } = createBroadcaster({ wss, getSubs });

    broadcast('runs-list', {}, undefined);

    expect(ws.send).toHaveBeenCalledOnce();
    const msg = parseSent(ws);
    expect(msg.project).toBe('proj-x');
  });

  it('does not add project field for proto-1 clients', () => {
    // Protocol-1 clients should receive the legacy envelope without a project field.
    const ws = mockWs();
    const wss = mockWss([ws]);
    const getSubs = () => ({ protocolVersion: 1, projectId: null });
    const { broadcast } = createBroadcaster({ wss, getSubs });

    broadcast('runs-list', {}, 'proj-a');

    expect(ws.send).toHaveBeenCalledOnce();
    const msg = parseSent(ws);
    expect(msg.project).toBeUndefined();
  });

  it('broadcastToSubscribers does not add project field', () => {
    // broadcastToSubscribers is topic-scoped (by runId), not project-stamped.
    // Regression guard: no project field should be injected.
    const ws = mockWs();
    const wss = mockWss([ws]);
    const getSubs = () => ({
      protocolVersion: 2,
      projectId: null,
      runId: 'run-1',
    });
    const { broadcastToSubscribers } = createBroadcaster({ wss, getSubs });

    broadcastToSubscribers('run-1', 'status', {});

    expect(ws.send).toHaveBeenCalledOnce();
    const msg = parseSent(ws);
    expect(msg.project).toBeUndefined();
  });
});
