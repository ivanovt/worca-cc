import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLatestRunDir } from './ws.js';

describe('resolveLatestRunDir', () => {
  let worcaDir;

  beforeEach(() => {
    worcaDir = join(tmpdir(), `worca-ws-${Date.now()}`);
    mkdirSync(worcaDir, { recursive: true });
  });

  afterEach(() => rmSync(worcaDir, { recursive: true, force: true }));

  it('returns run dir when pipeline.pid references the current process', () => {
    const runId = '20260317-084204';
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'pipeline.pid'), String(process.pid));

    const result = resolveLatestRunDir(worcaDir);
    expect(result).toBe(runDir);
  });

  it('falls back to worcaDir when no runs/ directory exists', () => {
    const result = resolveLatestRunDir(worcaDir);
    expect(result).toBe(worcaDir);
  });

  it('falls back to worcaDir when run has no pipeline.pid', () => {
    const runId = '20260317-084204';
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({ pipeline_status: 'running' }),
    );

    const result = resolveLatestRunDir(worcaDir);
    expect(result).toBe(worcaDir);
  });

  it('falls back to worcaDir when pipeline.pid references a dead process', () => {
    const runId = '20260317-084204';
    const runDir = join(worcaDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'pipeline.pid'), '999999999');

    const result = resolveLatestRunDir(worcaDir);
    expect(result).toBe(worcaDir);
  });
});
