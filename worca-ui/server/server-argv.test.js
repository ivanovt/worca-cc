import { describe, expect, it } from 'vitest';
import { parseServerArgv } from './argv-parser.js';

describe('parseServerArgv', () => {
  it('returns defaults when no flags given', () => {
    const r = parseServerArgv(['node', 'index.js']);
    expect(r.port).toBe(3400);
    expect(r.host).toBe('127.0.0.1');
    expect(r.isGlobal).toBe(true);
    expect(r.projectPath).toBeNull();
  });

  it('parses --port', () => {
    const r = parseServerArgv(['node', 'index.js', '--port', '4000']);
    expect(r.port).toBe(4000);
  });

  it('parses --host', () => {
    const r = parseServerArgv(['node', 'index.js', '--host', '0.0.0.0']);
    expect(r.host).toBe('0.0.0.0');
  });

  it('parses --global', () => {
    const r = parseServerArgv(['node', 'index.js', '--global']);
    expect(r.isGlobal).toBe(true);
    expect(r.projectPath).toBeNull();
  });

  it('parses --project and captures path', () => {
    const r = parseServerArgv([
      'node',
      'index.js',
      '--project',
      '/path/to/proj',
    ]);
    expect(r.isGlobal).toBe(false);
    expect(r.projectPath).toBe('/path/to/proj');
  });

  it('--project with no following value leaves projectPath null', () => {
    const r = parseServerArgv(['node', 'index.js', '--project']);
    expect(r.isGlobal).toBe(false);
    expect(r.projectPath).toBeNull();
  });

  it('--project with flag-like next arg leaves projectPath null; subsequent --global wins', () => {
    const r = parseServerArgv(['node', 'index.js', '--project', '--global']);
    expect(r.isGlobal).toBe(true);
    expect(r.projectPath).toBeNull();
  });

  it('parses combined flags', () => {
    const r = parseServerArgv([
      'node',
      'index.js',
      '--port',
      '3401',
      '--project',
      '/my/proj',
    ]);
    expect(r.port).toBe(3401);
    expect(r.isGlobal).toBe(false);
    expect(r.projectPath).toBe('/my/proj');
  });
});
