import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Look for keys.json in two places:
//   1. server/schemas/keys.json — the in-package copy populated by
//      scripts/build-frontend.js. This is what ships in the npm tarball.
//   2. ../../src/worca/schemas/keys.json — the canonical Python source,
//      reachable from a fresh monorepo checkout before `npm run build` has run.
const candidates = [
  resolve(__dirname, './schemas/keys.json'),
  resolve(__dirname, '../../src/worca/schemas/keys.json'),
];
const schemaPath = candidates.find((p) => existsSync(p));
if (!schemaPath) {
  throw new Error(
    `worca-ui: keys.json not found. Run "npm run build" inside worca-ui/ before starting the server. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

export const GLOBAL_ONLY_KEYS = schema.global_only_keys;
export const NORMALIZE_SKIP_KEYS = schema.normalize_skip_keys;
export const GLOBAL_DEFAULTS = schema.defaults.global;
export const PROJECT_DEFAULTS = schema.defaults.project;
