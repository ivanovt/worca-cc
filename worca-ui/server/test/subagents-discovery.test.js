import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTINS, discoverSubagents } from '../subagents-discovery.js';

let root;

function write(path, content = '# agent\n') {
  writeFileSync(path, content);
}

beforeEach(() => {
  root = join(
    tmpdir(),
    `worca-subagents-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverSubagents', () => {
  it('returns builtins when no dirs are provided', () => {
    const result = discoverSubagents();
    expect(result).toEqual(BUILTINS);
  });

  it('returns builtins when provided dirs do not exist', () => {
    const result = discoverSubagents({
      userDir: join(root, 'missing-user'),
      pluginCacheDir: join(root, 'missing-plugins'),
      projectAgentsDir: join(root, 'missing-project'),
    });
    expect(result).toEqual(BUILTINS);
  });

  it('discovers user-global agents as group=User', () => {
    const userDir = join(root, 'user');
    mkdirSync(userDir);
    write(join(userDir, 'doc-sync-analyzer.md'));
    write(join(userDir, 'document-summarizer.md'));
    // Non-md file should be ignored
    write(join(userDir, 'readme.txt'));

    const result = discoverSubagents({ userDir });
    const userEntries = result.filter((t) => t.group === 'User');
    expect(userEntries.map((t) => t.name).sort()).toEqual([
      'doc-sync-analyzer',
      'document-summarizer',
    ]);
    expect(userEntries.every((t) => t.label === '(user)')).toBe(true);
  });

  it('discovers plugin agents under cache/<marketplace>/<plugin>/<version>/agents/', () => {
    const cache = join(root, 'cache');
    const agentsDir = join(
      cache,
      'claude-plugins-official',
      'feature-dev',
      '1.0.0',
      'agents',
    );
    mkdirSync(agentsDir, { recursive: true });
    write(join(agentsDir, 'code-reviewer.md'));
    write(join(agentsDir, 'code-architect.md'));

    const result = discoverSubagents({ pluginCacheDir: cache });
    const pluginEntries = result.filter((t) => t.group === 'Plugin');
    expect(pluginEntries.map((t) => t.name).sort()).toEqual([
      'feature-dev:code-architect',
      'feature-dev:code-reviewer',
    ]);
    expect(pluginEntries.every((t) => t.label === '(plugin)')).toBe(true);
  });

  it('deduplicates plugin agents across versions (first-seen wins)', () => {
    const cache = join(root, 'cache');
    const v1 = join(cache, 'mkt', 'feature-dev', '1.0.0', 'agents');
    const v2 = join(cache, 'mkt', 'feature-dev', '2.0.0', 'agents');
    mkdirSync(v1, { recursive: true });
    mkdirSync(v2, { recursive: true });
    write(join(v1, 'code-reviewer.md'));
    write(join(v2, 'code-reviewer.md'));
    write(join(v2, 'new-agent.md'));

    const result = discoverSubagents({ pluginCacheDir: cache });
    const names = result.filter((t) => t.group === 'Plugin').map((t) => t.name);
    // code-reviewer appears once; new-agent from v2 is included
    expect(names.filter((n) => n === 'feature-dev:code-reviewer')).toHaveLength(
      1,
    );
    expect(names).toContain('feature-dev:new-agent');
  });

  it('discovers project-local agents as group=Project', () => {
    const projectAgents = join(root, 'proj', '.claude', 'agents');
    mkdirSync(projectAgents, { recursive: true });
    write(join(projectAgents, 'local-helper.md'));

    const result = discoverSubagents({ projectAgentsDir: projectAgents });
    const projectEntries = result.filter((t) => t.group === 'Project');
    expect(projectEntries).toHaveLength(1);
    expect(projectEntries[0]).toEqual({
      name: 'local-helper',
      label: '(project)',
      group: 'Project',
    });
  });

  it('user discovery does not override a builtin with the same name', () => {
    const userDir = join(root, 'user');
    mkdirSync(userDir);
    write(join(userDir, 'explore.md')); // shadows builtin

    const result = discoverSubagents({ userDir });
    const exploreEntries = result.filter((t) => t.name === 'explore');
    expect(exploreEntries).toHaveLength(1);
    expect(exploreEntries[0].group).toBe('Built-in');
  });

  it('returns a single flat array with all sources combined', () => {
    const userDir = join(root, 'user');
    const cache = join(root, 'cache');
    const projectAgents = join(root, 'proj', '.claude', 'agents');
    const pluginAgents = join(cache, 'mkt', 'feature-dev', '1.0.0', 'agents');
    mkdirSync(userDir);
    mkdirSync(pluginAgents, { recursive: true });
    mkdirSync(projectAgents, { recursive: true });
    write(join(userDir, 'user-one.md'));
    write(join(pluginAgents, 'plug-one.md'));
    write(join(projectAgents, 'proj-one.md'));

    const result = discoverSubagents({
      userDir,
      pluginCacheDir: cache,
      projectAgentsDir: projectAgents,
    });
    const names = result.map((t) => t.name);
    expect(names).toContain('explore'); // builtin
    expect(names).toContain('user-one');
    expect(names).toContain('feature-dev:plug-one');
    expect(names).toContain('proj-one');
  });

  it('handles a completely empty plugin cache directory', () => {
    const cache = join(root, 'cache-empty');
    mkdirSync(cache);
    const result = discoverSubagents({ pluginCacheDir: cache });
    expect(result).toEqual(BUILTINS);
  });

  it('skips plugin directories missing the agents/ subfolder', () => {
    const cache = join(root, 'cache');
    // Create <marketplace>/<plugin>/<version>/ but no agents/ subdir
    mkdirSync(join(cache, 'mkt', 'plugin-a', '1.0.0'), { recursive: true });
    // Another plugin with a valid agents dir — should still be discovered
    const validAgents = join(cache, 'mkt', 'plugin-b', '1.0.0', 'agents');
    mkdirSync(validAgents, { recursive: true });
    write(join(validAgents, 'agent-b.md'));

    const result = discoverSubagents({ pluginCacheDir: cache });
    const names = result.map((t) => t.name);
    expect(names).toContain('plugin-b:agent-b');
    expect(names.some((n) => n.startsWith('plugin-a:'))).toBe(false);
  });
});
