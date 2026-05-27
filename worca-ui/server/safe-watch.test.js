import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  watch: vi.fn((...args) => {
    const emitter = new EventEmitter();
    emitter._mockArgs = args;
    return emitter;
  }),
}));

const { watch } = await import('node:fs');
const { safeWatch } = await import('./safe-watch.js');

describe('safeWatch', () => {
  it('returns an fs.FSWatcher-like object', () => {
    const w = safeWatch('/tmp/test');
    expect(w).toBeDefined();
    expect(typeof w.on).toBe('function');
  });

  it('passes all arguments through to fs.watch', () => {
    const cb = () => {};
    safeWatch('/tmp/a', { persistent: false }, cb);
    expect(watch).toHaveBeenCalledWith('/tmp/a', { persistent: false }, cb);
  });

  it('swallows EPERM errors without throwing', () => {
    const w = safeWatch('/tmp/test');
    expect(() => {
      w.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    }).not.toThrow();
  });

  it('swallows ENOENT errors without throwing', () => {
    const w = safeWatch('/tmp/test');
    expect(() => {
      w.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    }).not.toThrow();
  });

  it('logs unexpected error codes to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = safeWatch('/tmp/test');
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    w.emit('error', err);
    expect(spy).toHaveBeenCalledWith('[safeWatch] watcher error:', err);
    spy.mockRestore();
  });

  it('does not log EPERM or ENOENT to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = safeWatch('/tmp/test');
    w.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    w.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
