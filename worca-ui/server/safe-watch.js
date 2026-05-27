import { watch } from 'node:fs';

export function safeWatch(...args) {
  const w = watch(...args);
  w.on('error', (err) => {
    if (err && err.code !== 'EPERM' && err.code !== 'ENOENT') {
      console.error('[safeWatch] watcher error:', err);
    }
  });
  return w;
}
