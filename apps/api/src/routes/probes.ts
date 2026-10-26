/**
 * Liveness and readiness probes (task `P1-API-07`).
 *
 * Two routes, and the difference between them is the whole point:
 *
 * - `GET /healthz` answers `200 {"status":"ok"}` whenever the process can answer at all. It touches **nothing** —
 *   no database, no filesystem. A liveness probe that depends on a dependency turns one broken dependency into a
 *   restart loop: Docker kills a perfectly healthy API because Postgres is briefly away, the API comes back,
 *   cannot reach Postgres either, and is killed again.
 * - `GET /readyz` answers `200` only when the things a request needs are usable — the database answers `select 1`
 *   and the cache directory accepts a write — and `503` naming the checks that failed. This is the probe a load
 *   balancer gates on, so it is allowed to be pessimistic and must never hang.
 *
 * Both are outside every API prefix and allow-listed by L1 (`isProbePath`), because Docker, Kubernetes and an
 * uptime monitor cannot send a Bearer token and must not need one (`config/prefixes.ts` keeps them out of the
 * admin guard for the same reason).
 *
 * @module routes/probes
 */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PROBE_PATHS } from '@mapirror/shared';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply } from 'fastify';

/** How long a readiness check may take before it counts as failed. */
export const READY_PROBE_TIMEOUT_MS = 2_000;

/**
 * File the cache check writes and removes. Dot-prefixed, so it can never collide with a country artifact, and
 * **one fixed name** rather than one per call: a probe killed between the write and the unlink would otherwise
 * leave a uniquely named file that nothing ever cleans up, and the storage screen reports unknown files under
 * `CACHE_DIR` as orphans. With a fixed name the next probe overwrites and removes it.
 */
export const CACHE_PROBE_FILE = '.readyz';

/** Outcome of one readiness check, as it appears in the body. */
export type CheckResult = 'ok' | 'fail';

/** A check's outcome and, when it failed, the reason — logged, never returned. */
interface ProbeResult {
  readonly result: CheckResult;
  readonly error?: unknown;
}

/** The two things a request may need. Adding a third means adding a line to {@link readiness}. */
export interface ReadinessChecks {
  readonly database: CheckResult;
  readonly cache: CheckResult;
}

/** Options for {@link probeRoutes}. */
export interface ProbeOptions {
  /** Directory that must accept a write, i.e. `config.cacheDir`. */
  readonly cacheDir: string;
  /** Per-check bound; defaults to {@link READY_PROBE_TIMEOUT_MS}. Shortened by tests. */
  readonly timeoutMs?: number;
}

/**
 * Races a check against a timer.
 *
 * **A check signals failure by rejecting, never by returning** — one direction, no ambiguity. The first version
 * also accepted a returned `'fail'`, and because a fulfilled promise was mapped to `'ok'`, an unwritable cache
 * directory reported itself healthy.
 *
 * The database handle already bounds its own ping, but a `SqlDatabase` is an interface — a test double, or a
 * future implementation over a driver without timeouts, is free to ignore the argument. A readiness probe that
 * can hang is worse than one that is missing: the load balancer waits, the request queue fills, and the failure
 * looks like an outage of everything rather than of one dependency.
 *
 * Takes a **thunk**, not a promise: a check that throws before it returns one — a closed pool does exactly that —
 * would otherwise escape the race and turn a `503` into a `500 INTERNAL_ERROR`, which is the wrong answer for a
 * probe and the wrong status for a load balancer. Invoking it inside the race makes every failure one shape.
 *
 * @param run - Work to bound.
 * @param timeoutMs - Budget in milliseconds.
 * @returns The result, plus the reason when it failed — the body names the failing check, the log says why.
 */
async function bounded(run: () => Promise<unknown>, timeoutMs: number): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ result: 'fail', error: new Error(`no answer within ${timeoutMs} ms`) }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .then(
          () => ({ result: 'ok' as const }),
          (error: unknown) => ({ result: 'fail' as const, error }),
        ),
      expiry,
    ]);
  } finally {
    // Always cleared: a pending timer keeps the event loop alive for up to two seconds after every probe.
    clearTimeout(timer);
  }
}

/**
 * Proves the cache directory is writable.
 *
 * A write, not an `access(W_OK)` call: the mode bits lie for root, and they say nothing about a read-only bind
 * mount or a full disk — the two ways a cache volume actually fails. The directory is created if missing for the
 * same reason the download path will create it: a fresh install has an empty volume, and "not ready" until a
 * write happens would be a permanent not-ready.
 *
 * @param cacheDir - Directory to prove.
 * @throws When the directory cannot be created or written to. The reason is logged by the caller's handler.
 */
async function cacheWritable(cacheDir: string): Promise<void> {
  const file = join(cacheDir, CACHE_PROBE_FILE);
  try {
    await mkdir(cacheDir, { recursive: true });
    // One byte, not an empty file: a full data volume may still allow a zero-byte inode, which would falsely report
    // readiness while every real cache artifact fails with ENOSPC.
    await writeFile(file, 'x');
  } finally {
    // Best-effort, and outside the failure path: a leftover probe file is harmless, and a throw here would mask
    // the write error that explains why the probe failed.
    await unlink(file).catch(() => undefined);
  }
}

/**
 * Runs every readiness check concurrently.
 *
 * Concurrent because two sequential two-second checks would make the worst case four seconds, which is long
 * enough for a load balancer to give up on a probe it has already decided about.
 *
 * @param app - Instance carrying the `db` decoration.
 * @param options - Cache directory and per-check budget.
 * @returns The result of each check, keyed by name.
 */
async function readiness(
  app: FastifyInstance,
  options: ProbeOptions,
): Promise<{ checks: ReadinessChecks; failures: { check: string; error: unknown }[] }> {
  const timeoutMs = options.timeoutMs ?? READY_PROBE_TIMEOUT_MS;
  const [database, cache] = await Promise.all([
    // The budget is handed to the driver too, so a slow ping is cancelled rather than merely abandoned.
    bounded(() => app.db.check(timeoutMs), timeoutMs),
    bounded(() => cacheWritable(options.cacheDir), timeoutMs),
  ]);

  const failures: { check: string; error: unknown }[] = [];
  const named = { database, cache } as const;
  for (const [check, outcome] of Object.entries(named)) {
    if (outcome.result === 'fail') failures.push({ check, error: outcome.error });
  }
  return {
    checks: { database: database.result, cache: cache.result },
    failures,
  };
}

/**
 * Sets the headers both probes share.
 *
 * `no-store` because a probe response is a fact about *now*: a proxy or a browser cache that answers `200` from
 * ten minutes ago during an incident is worse than no probe at all.
 *
 * @param reply - Reply being prepared.
 */
function probeHeaders(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

/** The probe routes. Registered with no prefix, so the URLs are exactly `/healthz` and `/readyz`. */
export const probeRoutes: FastifyPluginCallback<ProbeOptions> = (app, options, done) => {
  // Liveness: no `await`, no dependency, no possibility of a 503. If this cannot answer, the process is gone.
  app.get(PROBE_PATHS.health, async (_request, reply) => {
    probeHeaders(reply);
    return { status: 'ok' };
  });

  app.get(PROBE_PATHS.ready, async (request, reply) => {
    probeHeaders(reply);
    const { checks, failures } = await readiness(app, options);

    if (failures.length > 0) {
      // The body names the checks, never the reason: the driver's message can contain the DSN, and the cache
      // path is an internal detail. The reason goes to the log, one line per check, tied to the request id an
      // operator can quote — and under the `err` key, the one the logger's serializer renders as a stack.
      for (const failure of failures) {
        request.log.warn(
          { err: failure.error, check: failure.check, code: 'NOT_READY' },
          'readiness check failed',
        );
      }
      reply.code(503);
      return { status: 'unavailable', checks };
    }

    return { status: 'ok', checks };
  });

  done();
};
