import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createShutdown, SHUTDOWN_TIMEOUT_MS, type ShutdownTarget } from '../src/server';

/**
 * The shutdown path, tested against a fake instance.
 *
 * The case that matters cannot be produced with a real socket in a unit test: `close()` waits for in-flight
 * requests, and a client streaming an 800 MB download will outlast Docker's grace period. A fake whose
 * `close()` never resolves reproduces exactly that, and an injected `exit` keeps the test runner alive.
 */
describe('createShutdown', () => {
  let exited: number[];
  let logs: string[];
  const exit = (code: number): void => {
    exited.push(code);
  };

  /**
   * A fake instance whose close resolves, rejects, or never settles.
   *
   * @param behaviour - How `close()` behaves.
   * @returns The fake.
   */
  const target = (behaviour: 'resolve' | 'reject' | 'hang'): ShutdownTarget => ({
    close: () => {
      if (behaviour === 'resolve') return Promise.resolve();
      if (behaviour === 'reject') return Promise.reject(new Error('pool still busy'));
      return new Promise(() => undefined);
    },
    log: {
      info: (_context, message) => logs.push(`info:${message}`),
      error: (_context, message) => logs.push(`error:${message}`),
    },
  });

  beforeEach(() => {
    exited = [];
    logs = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains and exits 0 on a clean close', async () => {
    await createShutdown(target('resolve'), { exit })('SIGTERM');

    expect(exited).toEqual([0]);
    expect(logs).toContain('info:shutting down');
  });

  it('exits 1 when close fails, and says why', async () => {
    await createShutdown(target('reject'), { exit })('SIGTERM');

    expect(exited).toEqual([1]);
    expect(logs).toContain('error:shutdown failed');
  });

  it('gives up after the timeout instead of hanging forever', async () => {
    const shutdown = createShutdown(target('hang'), { exit, timeoutMs: 1000 });
    const started = shutdown('SIGTERM');

    // Nothing has exited yet: the close is still pending.
    expect(exited).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(exited).toEqual([1]);
    expect(logs).toContain('error:shutdown timed out; exiting non-zero');

    // The pending promise stays pending; awaiting it would hang, which is the point of the timer.
    void started;
  });

  it('defaults the timeout below Docker’s 10 s grace period', () => {
    // Above 10 s the container is SIGKILLed before we can log or choose an exit code.
    expect(SHUTDOWN_TIMEOUT_MS).toBeLessThan(10_000);
    expect(SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('ignores a second signal instead of closing twice', async () => {
    let closes = 0;
    const instance: ShutdownTarget = {
      close: () => {
        closes += 1;
        return new Promise((resolve) => setTimeout(resolve, 50));
      },
      log: { info: () => undefined, error: () => undefined },
    };
    const shutdown = createShutdown(instance, { exit, timeoutMs: 1000 });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);

    expect(closes).toBe(1);
    expect(exited).toEqual([0]);
  });

  it('clears the timeout on a clean close, so no stray exit fires later', async () => {
    let closes = 0;
    const instance: ShutdownTarget = {
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
      log: { info: () => undefined, error: () => undefined },
    };
    await createShutdown(instance, { exit, timeoutMs: 1000 })('SIGINT');

    await vi.advanceTimersByTimeAsync(5000);
    // Only the clean exit, once; a leftover timer would add a second (1) entry.
    expect(exited).toEqual([0]);
    expect(closes).toBe(1);
  });
});
