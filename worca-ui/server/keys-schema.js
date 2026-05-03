import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../src/worca/schemas/keys.json'),
    'utf-8',
  ),
);

export const GLOBAL_ONLY_KEYS = schema.global_only_keys;
export const NORMALIZE_SKIP_KEYS = schema.normalize_skip_keys;
export const GLOBAL_DEFAULTS = schema.defaults.global;
export const PROJECT_DEFAULTS = schema.defaults.project;
