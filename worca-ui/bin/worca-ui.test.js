import { describe, expect, it } from 'vitest';
import { buildSpawnArgs, parseArgs } from './worca-ui.js';

describe('parseArgs', () => {
  it('sets global flag when --global is passed', () => {
    const result = parseArgs(['node', 'script', 'start', '--global']);
    expect(result.command).toBe('start');
    expect(result.global).toBe(true);
  });

  it('defaults global to true', () => {
    const result = parseArgs(['node', 'script', 'start']);
    expect(result.command).toBe('start');
    expect(result.global).toBe(true);
  });

  it('sets global to false when --project is passed', () => {
    const result = parseArgs(['node', 'script', 'start', '--project']);
    expect(result.command).toBe('start');
    expect(result.global).toBe(false);
  });

  it('captures project path when --project has a path argument', () => {
    const result = parseArgs([
      'node',
      'script',
      'start',
      '--project',
      '/tmp/proj',
    ]);
    expect(result.global).toBe(false);
    expect(result.projectPath).toBe('/tmp/proj');
  });

  it('parses projects list', () => {
    const result = parseArgs(['node', 'script', 'projects', 'list']);
    expect(result.command).toBe('projects');
    expect(result.subAction).toBe('list');
  });

  it('parses projects add with path', () => {
    const result = parseArgs([
      'node',
      'script',
      'projects',
      'add',
      '/tmp/proj',
    ]);
    expect(result.command).toBe('projects');
    expect(result.subAction).toBe('add');
    expect(result.projectPath).toBe('/tmp/proj');
  });

  it('parses projects remove with name', () => {
    const result = parseArgs([
      'node',
      'script',
      'projects',
      'remove',
      'my-proj',
    ]);
    expect(result.command).toBe('projects');
    expect(result.subAction).toBe('remove');
    expect(result.projectPath).toBe('my-proj');
  });

  it('parses migrate --scan with --dry-run', () => {
    const result = parseArgs([
      'node',
      'script',
      'migrate',
      '--scan',
      '/tmp/dir',
      '--dry-run',
    ]);
    expect(result.command).toBe('migrate');
    expect(result.scanDir).toBe('/tmp/dir');
    expect(result.dryRun).toBe(true);
  });

  it('parses migrate --status', () => {
    const result = parseArgs(['node', 'script', 'migrate', '--status']);
    expect(result.command).toBe('migrate');
    expect(result.migrateStatus).toBe(true);
  });

  it('parses migrate --add with path', () => {
    const result = parseArgs(['node', 'script', 'migrate', '--add', '/path']);
    expect(result.command).toBe('migrate');
    expect(result.migrateAdd).toBe('/path');
  });

  it('overrides port and host', () => {
    const result = parseArgs([
      'node',
      'script',
      '--port',
      '3500',
      '--host',
      '0.0.0.0',
    ]);
    expect(result.port).toBe(3500);
    expect(result.host).toBe('0.0.0.0');
  });

  it('preserves --open flag', () => {
    const result = parseArgs(['node', 'script', 'start', '--open']);
    expect(result.open).toBe(true);
  });

  it('parses --name for projects add', () => {
    const result = parseArgs([
      'node',
      'script',
      'projects',
      'add',
      '/tmp/proj',
      '--name',
      'my-slug',
    ]);
    expect(result.command).toBe('projects');
    expect(result.subAction).toBe('add');
    expect(result.projectPath).toBe('/tmp/proj');
    expect(result.projectName).toBe('my-slug');
  });
});

const SCRIPT = '/fake/server/index.js';

describe('buildSpawnArgs', () => {
  it('always includes serverScript, --port, and --host', () => {
    const args = buildSpawnArgs({
      serverScript: SCRIPT,
      port: 3401,
      host: '0.0.0.0',
      isGlobal: true,
      projectPath: null,
    });
    expect(args[0]).toBe(SCRIPT);
    const portIdx = args.indexOf('--port');
    expect(portIdx).toBeGreaterThan(-1);
    expect(args[portIdx + 1]).toBe('3401');
    const hostIdx = args.indexOf('--host');
    expect(hostIdx).toBeGreaterThan(-1);
    expect(args[hostIdx + 1]).toBe('0.0.0.0');
  });

  it('pushes --global when isGlobal is true', () => {
    const args = buildSpawnArgs({
      serverScript: SCRIPT,
      port: 3400,
      host: '127.0.0.1',
      isGlobal: true,
      projectPath: null,
    });
    expect(args).toContain('--global');
    expect(args).not.toContain('--project');
  });

  it('pushes --project <path> when isGlobal is false and projectPath is set', () => {
    const args = buildSpawnArgs({
      serverScript: SCRIPT,
      port: 3400,
      host: '127.0.0.1',
      isGlobal: false,
      projectPath: '/my/proj',
    });
    const idx = args.indexOf('--project');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('/my/proj');
    expect(args).not.toContain('--global');
  });

  it('omits both --global and --project when isGlobal is false and projectPath is null', () => {
    const args = buildSpawnArgs({
      serverScript: SCRIPT,
      port: 3400,
      host: '127.0.0.1',
      isGlobal: false,
      projectPath: null,
    });
    expect(args).not.toContain('--global');
    expect(args).not.toContain('--project');
  });
});
