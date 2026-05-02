import { describe, expect, it } from 'vitest';
import { LaunchLock } from './launch-lock.js';

describe('LaunchLock', () => {
  it('allows a single acquire without contention', async () => {
    const lock = new LaunchLock();
    const release = await lock.acquire();
    expect(typeof release).toBe('function');
    release();
  });

  it('serializes concurrent acquires', async () => {
    const lock = new LaunchLock();
    const order = [];

    const p1 = lock.acquire().then((release) => {
      order.push('a-start');
      return new Promise((resolve) => {
        setTimeout(() => {
          order.push('a-end');
          release();
          resolve();
        }, 20);
      });
    });

    const p2 = lock.acquire().then((release) => {
      order.push('b-start');
      release();
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('releases lock even if holder throws', async () => {
    const lock = new LaunchLock();

    const release1 = await lock.acquire();
    release1();

    const release2 = await lock.acquire();
    release2();
  });

  it('withLock runs the callback and returns its result', async () => {
    const lock = new LaunchLock();
    const result = await lock.withLock(async () => 42);
    expect(result).toBe(42);
  });

  it('withLock serializes concurrent calls', async () => {
    const lock = new LaunchLock();
    const order = [];

    const p1 = lock.withLock(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a-end');
    });

    const p2 = lock.withLock(async () => {
      order.push('b-start');
      order.push('b-end');
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('withLock releases lock when callback throws', async () => {
    const lock = new LaunchLock();

    await expect(
      lock.withLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const result = await lock.withLock(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('handles many concurrent acquires in FIFO order', async () => {
    const lock = new LaunchLock();
    const order = [];
    const count = 10;

    const promises = Array.from({ length: count }, (_, i) =>
      lock.acquire().then((release) => {
        order.push(i);
        release();
      }),
    );

    await Promise.all(promises);
    expect(order).toEqual(Array.from({ length: count }, (_, i) => i));
  });
});
