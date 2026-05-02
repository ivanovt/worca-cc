import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(import.meta.dirname, '..');

function collectJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (
      entry.name.endsWith('.js') &&
      !entry.name.endsWith('.test.js') &&
      entry.name !== 'main.bundle.js'
    ) {
      results.push(full);
    }
  }
  return results;
}

const FLAT_DOT_PATTERNS = [
  /settings\[['"]worca\./,
  /preferences\[['"]worca\./,
  /state\.settings\[['"]worca\./,
];

describe('flat-dot settings audit', () => {
  const files = collectJsFiles(APP_DIR);

  it('finds app source files to audit', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no source files use flat-dot settings keys', () => {
    const violations = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        for (const pat of FLAT_DOT_PATTERNS) {
          if (pat.test(lines[i])) {
            const rel = file.replace(`${APP_DIR}/`, '');
            violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
