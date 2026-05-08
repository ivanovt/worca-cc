import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { STAGE_ORDER, STAGE_VALUES } from '../app/utils/stage-order.js';
import { assertStageShape } from './helpers/assert-stage-shape.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const PYTHON_SCRIPT = `
import json, sys
sys.path.insert(0, 'src')
from worca.orchestrator.stages import Stage, STAGE_AGENT_MAP, STAGE_SCHEMA_MAP
print(json.dumps({
    'stage_values': [s.value for s in Stage],
    'stage_agent_map': {s.value: a for s, a in STAGE_AGENT_MAP.items()},
    'stage_schema_map': {s.value: sc for s, sc in STAGE_SCHEMA_MAP.items()},
}))
`;

function hasPython3() {
  const r = spawnSync('python3', ['--version']);
  return r.status === 0 && r.error == null;
}

/**
 * Parse STAGE_AGENT_MAP from settings.js source without importing it.
 * Avoids the lit-html browser dependency in the Node test environment.
 */
function readJsStageAgentMap() {
  const src = readFileSync(join(__dirname, '../app/views/settings.js'), 'utf8');
  const match = src.match(/export const STAGE_AGENT_MAP = \{([^}]+)\}/);
  if (!match) throw new Error('Could not find STAGE_AGENT_MAP in settings.js');
  const map = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s+(\w+):\s+'(\w+)',?\s*$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

const python3Available = hasPython3();

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

describe('assertStageShape self-tests', () => {
  it("rejects 'guardian' as a stage key with 'pr' hint", () => {
    expect(() => assertStageShape({ stage: 'guardian' })).toThrow(
      "'guardian' is not a stage key; you probably meant 'pr'",
    );
  });

  it("accepts 'pr' as a valid stage key", () => {
    expect(() => assertStageShape({ stage: 'pr' })).not.toThrow();
  });

  it("rejects 'guardian' in stages map with 'pr' hint", () => {
    expect(() => assertStageShape({ stages: { guardian: {} } })).toThrow(
      "'guardian' is not a stage key; you probably meant 'pr'",
    );
  });

  it("accepts 'pr' key in stages map", () => {
    expect(() => assertStageShape({ stages: { pr: {} } })).not.toThrow();
  });
});
