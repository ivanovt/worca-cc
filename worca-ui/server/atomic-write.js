/**
 * Atomic file write: write to a temp file then rename into place.
 * Prevents partial reads when a reader opens the file mid-write.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function atomicWriteSync(filePath, data, options = {}) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  writeFileSync(tmp, data, options);
  renameSync(tmp, filePath);
}
