import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MESSAGE_TYPES, isMessageType } from '../app/protocol.js';
import { createWorkspaceManifestWatcher } from '../server/ws-workspace-manifest-watcher.js';

// ─── Protocol allowlist tests ──────────────────────────────────────────────

describe('protocol — workspace event types', () => {
  it('includes workspace-update in MESSAGE_TYPES', () => {
    expect(MESSAGE_TYPES).toContain('workspace-update');
  });

  it('includes workspace-tier-update in MESSAGE_TYPES', () => {
    expect(MESSAGE_TYPES).toContain('workspace-tier-update');
  });

  it('includes guide-conflict in MESSAGE_TYPES', () => {
    expect(MESSAGE_TYPES).toContain('guide-conflict');
  });

  it('isMessageType accepts workspace-update', () => {
    expect(isMessageType('workspace-update')).toBe(true);
  });

  it('isMessageType accepts workspace-tier-update', () => {
    expect(isMessageType('workspace-tier-update')).toBe(true);
  });

  it('isMessageType accepts guide-conflict', () => {
    expect(isMessageType('guide-conflict')).toBe(true);
  });
});

// ─── Workspace manifest watcher tests ──────────────────────────────────────

describe('workspace manifest watcher', () => {
  let dir;
  let wsRunsDir;
  let broadcasts;
  let broadcaster;

  beforeEach(() => {
    dir = join(tmpdir(), `worca-ws-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    wsRunsDir = join(dir, 'workspace-runs');
    mkdirSync(wsRunsDir, { recursive: true });
    broadcasts = [];
    broadcaster = {
      broadcast: (type, payload) => {
        broadcasts.push({ type, payload });
      },
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports createWorkspaceManifestWatcher', () => {
    expect(typeof createWorkspaceManifestWatcher).toBe('function');
  });

  it('returns an object with destroy method', () => {
    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });
    expect(typeof watcher.destroy).toBe('function');
    watcher.destroy();
  });

  it('destroy can be called multiple times without error', () => {
    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });
    watcher.destroy();
    watcher.destroy();
  });

  it('does not throw when directory does not exist', () => {
    const nonexistent = join(dir, 'does-not-exist');
    expect(() => {
      const watcher = createWorkspaceManifestWatcher({
        broadcaster,
        workspaceRunsDir: nonexistent,
      });
      watcher.destroy();
    }).not.toThrow();
  });

  it('broadcastWorkspaceUpdate reads pointer and manifest then broadcasts', () => {
    const wsId = 'ws_202605151034_a1b2c3d4';
    const wsRoot = join(dir, 'workspace-root');
    const manifestDir = join(wsRoot, '.worca', 'workspace-runs', wsId);
    mkdirSync(manifestDir, { recursive: true });

    writeFileSync(
      join(wsRunsDir, `${wsId}.json`),
      JSON.stringify({ workspace_root: wsRoot, workspace_id: wsId }),
    );

    writeFileSync(
      join(manifestDir, 'workspace-manifest.json'),
      JSON.stringify({
        workspace_id: wsId,
        workspace_name: 'test-ws',
        status: 'running',
        halt_reason: null,
        dag: {
          tiers: [
            { tier: 0, repos: ['repo-a'], status: 'completed' },
            { tier: 1, repos: ['repo-b'], status: 'running' },
          ],
        },
        children: [
          { repo: 'repo-a', run_id: 'r1', status: 'completed', tier: 0 },
          { repo: 'repo-b', run_id: 'r2', status: 'running', tier: 1 },
        ],
        integration_test: { status: 'pending', exit_code: null, log_path: null },
      }),
    );

    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });

    watcher._broadcastForTest(wsId);

    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    const wsUpdate = broadcasts.find((b) => b.type === 'workspace-update');
    expect(wsUpdate).toBeDefined();
    expect(wsUpdate.payload.workspace_id).toBe(wsId);
    expect(wsUpdate.payload.status).toBe('running');
    expect(wsUpdate.payload.dag).toBeDefined();
    expect(wsUpdate.payload.children).toHaveLength(2);

    watcher.destroy();
  });

  it('broadcasts workspace-tier-update for each tier', () => {
    const wsId = 'ws_202605151034_b2c3d4e5';
    const wsRoot = join(dir, 'workspace-root-2');
    const manifestDir = join(wsRoot, '.worca', 'workspace-runs', wsId);
    mkdirSync(manifestDir, { recursive: true });

    writeFileSync(
      join(wsRunsDir, `${wsId}.json`),
      JSON.stringify({ workspace_root: wsRoot, workspace_id: wsId }),
    );

    writeFileSync(
      join(manifestDir, 'workspace-manifest.json'),
      JSON.stringify({
        workspace_id: wsId,
        workspace_name: 'test-ws-2',
        status: 'running',
        halt_reason: null,
        dag: {
          tiers: [
            { tier: 0, repos: ['repo-a'], status: 'completed' },
            { tier: 1, repos: ['repo-b'], status: 'running' },
          ],
        },
        children: [],
        integration_test: { status: 'pending', exit_code: null, log_path: null },
      }),
    );

    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });

    watcher._broadcastForTest(wsId);

    const tierUpdates = broadcasts.filter(
      (b) => b.type === 'workspace-tier-update',
    );
    expect(tierUpdates).toHaveLength(2);
    expect(tierUpdates[0].payload.workspace_id).toBe(wsId);
    expect(tierUpdates[0].payload.tier).toBe(0);
    expect(tierUpdates[0].payload.status).toBe('completed');
    expect(tierUpdates[1].payload.tier).toBe(1);
    expect(tierUpdates[1].payload.status).toBe('running');

    watcher.destroy();
  });

  it('broadcasts guide-conflict when manifest has guide_conflicts', () => {
    const wsId = 'ws_202605151034_c3d4e5f6';
    const wsRoot = join(dir, 'workspace-root-3');
    const manifestDir = join(wsRoot, '.worca', 'workspace-runs', wsId);
    mkdirSync(manifestDir, { recursive: true });

    writeFileSync(
      join(wsRunsDir, `${wsId}.json`),
      JSON.stringify({ workspace_root: wsRoot, workspace_id: wsId }),
    );

    writeFileSync(
      join(manifestDir, 'workspace-manifest.json'),
      JSON.stringify({
        workspace_id: wsId,
        workspace_name: 'test-ws-3',
        status: 'running',
        halt_reason: null,
        dag: { tiers: [] },
        children: [],
        integration_test: { status: 'pending', exit_code: null, log_path: null },
        guide_conflicts: [
          { repo: 'repo-a', conflict_type: 'modified', detail: 'Guide changed' },
        ],
      }),
    );

    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });

    watcher._broadcastForTest(wsId);

    const conflicts = broadcasts.filter((b) => b.type === 'guide-conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].payload.workspace_id).toBe(wsId);
    expect(conflicts[0].payload.conflicts).toHaveLength(1);
    expect(conflicts[0].payload.conflicts[0].repo).toBe('repo-a');

    watcher.destroy();
  });

  it('does not broadcast guide-conflict when no conflicts present', () => {
    const wsId = 'ws_202605151034_d4e5f6a7';
    const wsRoot = join(dir, 'workspace-root-4');
    const manifestDir = join(wsRoot, '.worca', 'workspace-runs', wsId);
    mkdirSync(manifestDir, { recursive: true });

    writeFileSync(
      join(wsRunsDir, `${wsId}.json`),
      JSON.stringify({ workspace_root: wsRoot, workspace_id: wsId }),
    );

    writeFileSync(
      join(manifestDir, 'workspace-manifest.json'),
      JSON.stringify({
        workspace_id: wsId,
        workspace_name: 'test-ws-4',
        status: 'completed',
        halt_reason: null,
        dag: { tiers: [] },
        children: [],
        integration_test: { status: 'passed', exit_code: 0, log_path: null },
      }),
    );

    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });

    watcher._broadcastForTest(wsId);

    const conflicts = broadcasts.filter((b) => b.type === 'guide-conflict');
    expect(conflicts).toHaveLength(0);

    watcher.destroy();
  });

  it('skips non-json files', () => {
    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });

    writeFileSync(join(wsRunsDir, 'readme.txt'), 'not json');

    // No crash, no broadcast
    expect(broadcasts).toHaveLength(0);

    watcher.destroy();
  });

  it('handles missing pointer gracefully', () => {
    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });

    watcher._broadcastForTest('ws_202605151034_nonexist1');

    expect(broadcasts).toHaveLength(0);

    watcher.destroy();
  });

  it('handles missing manifest gracefully', () => {
    const wsId = 'ws_202605151034_e5f6a7b8';
    writeFileSync(
      join(wsRunsDir, `${wsId}.json`),
      JSON.stringify({ workspace_root: '/nonexistent', workspace_id: wsId }),
    );

    const watcher = createWorkspaceManifestWatcher({
      broadcaster,
      workspaceRunsDir: wsRunsDir,
    });

    watcher._broadcastForTest(wsId);

    expect(broadcasts).toHaveLength(0);

    watcher.destroy();
  });
});
