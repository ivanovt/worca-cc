import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countRunningPipelinesAcrossProjects } from './process-registry.js';

describe('countRunningPipelinesAcrossProjects', () => {
  let prefsDir;

  beforeEach(() => {
    prefsDir = join(
      tmpdir(),
      `proc-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(prefsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(prefsDir, { recursive: true, force: true });
  });

  it('returns 0 when projects.d/ does not exist', () => {
    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(0);
  });

  it('returns 0 when projects.d/ is empty', () => {
    mkdirSync(join(prefsDir, 'projects.d'));
    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(0);
  });

  it('returns 0 when projects have no runs', () => {
    const projDir = join(prefsDir, 'projects.d');
    mkdirSync(projDir);
    const projectPath = join(tmpdir(), `proj-norun-${Date.now()}`);
    mkdirSync(join(projectPath, '.worca', 'runs'), { recursive: true });
    writeFileSync(
      join(projDir, 'proj-a.json'),
      JSON.stringify({ name: 'proj-a', path: projectPath }),
    );

    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(0);

    rmSync(projectPath, { recursive: true, force: true });
  });

  it('counts running pipelines with live PIDs', () => {
    const projDir = join(prefsDir, 'projects.d');
    mkdirSync(projDir);

    const projectPath = join(tmpdir(), `proj-live-${Date.now()}`);
    const runDir = join(projectPath, '.worca', 'runs', 'run-001');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        pipeline_status: 'running',
        pid: process.pid,
      }),
    );
    writeFileSync(
      join(projDir, 'proj-a.json'),
      JSON.stringify({ name: 'proj-a', path: projectPath }),
    );

    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(1);

    rmSync(projectPath, { recursive: true, force: true });
  });

  it('skips ESRCH (dead PID) and does not count it', () => {
    const projDir = join(prefsDir, 'projects.d');
    mkdirSync(projDir);

    const projectPath = join(tmpdir(), `proj-dead-${Date.now()}`);
    const runDir = join(projectPath, '.worca', 'runs', 'run-002');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        pipeline_status: 'running',
        pid: 2147483647,
      }),
    );
    writeFileSync(
      join(projDir, 'proj-b.json'),
      JSON.stringify({ name: 'proj-b', path: projectPath }),
    );

    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(0);

    rmSync(projectPath, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'counts EPERM as alive (process exists but we lack permission)',
    () => {
      const projDir = join(prefsDir, 'projects.d');
      mkdirSync(projDir);

      const projectPath = join(tmpdir(), `proj-eperm-${Date.now()}`);
      const runDir = join(projectPath, '.worca', 'runs', 'run-003');
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'status.json'),
        JSON.stringify({
          pipeline_status: 'running',
          pid: 1,
        }),
      );
      writeFileSync(
        join(projDir, 'proj-c.json'),
        JSON.stringify({ name: 'proj-c', path: projectPath }),
      );

      const result = countRunningPipelinesAcrossProjects(prefsDir);
      expect(result).toBe(1);

      rmSync(projectPath, { recursive: true, force: true });
    },
  );

  it('prunes stale PID from status.json (clearStalePid)', () => {
    const projDir = join(prefsDir, 'projects.d');
    mkdirSync(projDir);

    const projectPath = join(tmpdir(), `proj-stale-${Date.now()}`);
    const runDir = join(projectPath, '.worca', 'runs', 'run-004');
    mkdirSync(runDir, { recursive: true });
    const statusPath = join(runDir, 'status.json');
    writeFileSync(
      statusPath,
      JSON.stringify({
        pipeline_status: 'running',
        pid: 2147483647,
      }),
    );
    writeFileSync(
      join(projDir, 'proj-d.json'),
      JSON.stringify({ name: 'proj-d', path: projectPath }),
    );

    countRunningPipelinesAcrossProjects(prefsDir);

    const updated = JSON.parse(
      require('node:fs').readFileSync(statusPath, 'utf-8'),
    );
    expect(updated.pipeline_status).toBe('error');
    expect(updated.error).toMatch(/stale/i);

    rmSync(projectPath, { recursive: true, force: true });
  });

  it('counts across multiple projects', () => {
    const projDir = join(prefsDir, 'projects.d');
    mkdirSync(projDir);

    const paths = [];
    for (let i = 0; i < 3; i++) {
      const projectPath = join(tmpdir(), `proj-multi-${Date.now()}-${i}`);
      const runDir = join(projectPath, '.worca', 'runs', `run-${i}`);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'status.json'),
        JSON.stringify({
          pipeline_status: 'running',
          pid: process.pid,
        }),
      );
      writeFileSync(
        join(projDir, `proj-${i}.json`),
        JSON.stringify({ name: `proj-${i}`, path: projectPath }),
      );
      paths.push(projectPath);
    }

    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(3);

    for (const p of paths) rmSync(p, { recursive: true, force: true });
  });

  it('ignores non-running statuses', () => {
    const projDir = join(prefsDir, 'projects.d');
    mkdirSync(projDir);

    const projectPath = join(tmpdir(), `proj-done-${Date.now()}`);
    const runDir = join(projectPath, '.worca', 'runs', 'run-005');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({
        pipeline_status: 'completed',
        pid: process.pid,
      }),
    );
    writeFileSync(
      join(projDir, 'proj-done.json'),
      JSON.stringify({ name: 'proj-done', path: projectPath }),
    );

    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(0);

    rmSync(projectPath, { recursive: true, force: true });
  });

  it('skips malformed project entries', () => {
    const projDir = join(prefsDir, 'projects.d');
    mkdirSync(projDir);
    writeFileSync(join(projDir, 'bad.json'), 'not json!!!');

    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(0);
  });

  it('skips projects whose path does not exist', () => {
    const projDir = join(prefsDir, 'projects.d');
    mkdirSync(projDir);
    writeFileSync(
      join(projDir, 'missing.json'),
      JSON.stringify({ name: 'missing', path: '/no/such/dir/ever' }),
    );

    const result = countRunningPipelinesAcrossProjects(prefsDir);
    expect(result).toBe(0);
  });
});
