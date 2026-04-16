/**
 * Subagent discovery for the settings dispatch-rule editor.
 *
 * Walks three sources (built-ins, user-global, plugin cache) and returns a
 * deduplicated list matching the shape used by `worca-ui/app/views/
 * dispatch-tag-state.js` (`{name, label, group}`).
 *
 * The three sources:
 *   1. Built-ins — hardcoded Claude Code types that are not on disk.
 *   2. User — `<userDir>/*.md`, one file per subagent.
 *   3. Plugins — `<pluginCacheDir>/<marketplace>/<plugin>/<version>/agents/*.md`.
 *      Deduped by the qualified name `<plugin>:<agent>` — first file wins
 *      across versions (the set of agents within a plugin is stable in
 *      practice; when two versions disagree we prefer filesystem order for
 *      determinism rather than trying to parse semver from directory names).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const BUILTINS = [
  { name: 'explore', label: '(built-in)', group: 'Built-in' },
  { name: 'general-purpose', label: '(built-in)', group: 'Built-in' },
  { name: 'Plan', label: '(built-in)', group: 'Built-in' },
];

function listMarkdownBasenames(dir) {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => basename(n, '.md'));
  } catch {
    return [];
  }
}

function listSubdirs(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Discover all subagent types reachable from the given directories.
 *
 * @param {object} options
 * @param {Array<{name:string,label:string,group:string}>} [options.builtins]
 * @param {string} [options.userDir]           e.g. ~/.claude/agents
 * @param {string} [options.pluginCacheDir]    e.g. ~/.claude/plugins/cache
 * @param {string} [options.projectAgentsDir]  e.g. <project>/.claude/agents
 * @returns {Array<{name:string,label:string,group:string}>}
 */
export function discoverSubagents({
  builtins = BUILTINS,
  userDir,
  pluginCacheDir,
  projectAgentsDir,
} = {}) {
  const result = [...builtins];
  const seen = new Set(result.map((t) => t.name));

  for (const name of listMarkdownBasenames(userDir)) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push({ name, label: '(user)', group: 'User' });
    }
  }

  if (pluginCacheDir && existsSync(pluginCacheDir)) {
    for (const marketplace of listSubdirs(pluginCacheDir)) {
      const marketplaceDir = join(pluginCacheDir, marketplace);
      for (const plugin of listSubdirs(marketplaceDir)) {
        const pluginDir = join(marketplaceDir, plugin);
        for (const version of listSubdirs(pluginDir)) {
          const agentsDir = join(pluginDir, version, 'agents');
          for (const agent of listMarkdownBasenames(agentsDir)) {
            const qualified = `${plugin}:${agent}`;
            if (!seen.has(qualified)) {
              seen.add(qualified);
              result.push({
                name: qualified,
                label: '(plugin)',
                group: 'Plugin',
              });
            }
          }
        }
      }
    }
  }

  for (const name of listMarkdownBasenames(projectAgentsDir)) {
    if (!seen.has(name)) {
      seen.add(name);
      result.push({ name, label: '(project)', group: 'Project' });
    }
  }

  return result;
}
