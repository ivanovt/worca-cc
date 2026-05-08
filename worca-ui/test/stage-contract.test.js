import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { STAGE_ORDER, STAGE_VALUES } from '../app/utils/stage-order.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const PYTHON_SCRIPT = `
import json, sys
sys.path.insert(0, 'src')
from worca.orchestrator.stages import Stage, STAGE_AGENT_MAP
print(json.dumps({
    'stage_values': [s.value for s in Stage],
    'stage_agent_map': {s.value: a for s, a in STAGE_AGENT_MAP.items()},
}))
`;

function hasPython3() {
  const r = spawnSync('python3', ['--version']);
  return r.status === 0 && r.error == null;
}

// settings.js can't be imported in Node — it pulls in lit-html which expects a
// browser. We parse the source instead. The empty-map check below guards
// against silent regressions if STAGE_AGENT_MAP gets reformatted.
function readJsStageAgentMap() {
  const src = readFileSync(join(__dirname, '../app/views/settings.js'), 'utf8');
  const match = src.match(/export const STAGE_AGENT_MAP = \{([^}]+)\}/);
  if (!match) throw new Error('Could not find STAGE_AGENT_MAP in settings.js');
  const map = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s+(\w+):\s+'(\w+)',?\s*$/);
    if (m) map[m[1]] = m[2];
  }
  if (Object.keys(map).length === 0) {
    throw new Error(
      'Parsed STAGE_AGENT_MAP is empty — regex in readJsStageAgentMap is out of date with settings.js',
    );
  }
  return map;
}

const python3Available = hasPython3();
if (!python3Available) {
  // Skipping silently makes the contract invisible on machines without python3.
  // CI always has python3, so this is just a local-dev signal.
  console.warn(
    '[stage-contract] python3 not on PATH — JS↔Python contract tests skipped',
  );
}

describe.skipIf(!python3Available)('stage contract: JS vs Python', () => {
  let py;

  beforeAll(() => {
    const out = execFileSync('python3', ['-c', PYTHON_SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
    py = JSON.parse(out);
  });

  it('JS STAGE_ORDER covers all Python Stage enum values', () => {
    for (const val of py.stage_values) {
      expect(
        STAGE_VALUES.has(val),
        `'${val}' is in Python Stage enum but missing from JS STAGE_ORDER`,
      ).toBe(true);
    }
  });

  it('JS STAGE_ORDER has no extra values beyond Python Stage enum', () => {
    const pySet = new Set(py.stage_values);
    for (const val of STAGE_ORDER) {
      expect(
        pySet.has(val),
        `'${val}' is in JS STAGE_ORDER but not in Python Stage enum`,
      ).toBe(true);
    }
  });

  it('JS STAGE_AGENT_MAP entries match Python STAGE_AGENT_MAP', () => {
    const jsMap = readJsStageAgentMap();
    for (const [stage, agent] of Object.entries(py.stage_agent_map)) {
      if (agent === null) continue;
      expect(jsMap[stage]).toBe(agent);
    }
  });

  it('JS STAGE_AGENT_MAP has no entries absent from Python STAGE_AGENT_MAP', () => {
    const jsMap = readJsStageAgentMap();
    for (const stage of Object.keys(jsMap)) {
      expect(
        stage in py.stage_agent_map,
        `'${stage}' is in JS STAGE_AGENT_MAP but not in Python STAGE_AGENT_MAP`,
      ).toBe(true);
    }
  });
});
