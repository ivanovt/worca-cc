/**
 * In-process async mutex using a promise chain.
 * Used to serialize pipeline launches so max_concurrent_pipelines is enforced atomically.
 */
export class LaunchLock {
  #tail = Promise.resolve();

  acquire() {
    let release;
    const prev = this.#tail;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    return prev.then(() => release);
  }

  async withLock(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
