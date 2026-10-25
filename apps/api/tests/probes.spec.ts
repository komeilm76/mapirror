import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  READY_PROBE_TIMEOUT_MS,
  buildApp,
  installDb,
  installErrorHandlers,
  installRequestContext,
  parseEnv,
  probeRoutes,
  type PluginSlot,
  type SqlDatabase,
} from '../src/index';
import { stubDatabase, buildTestApp } from './helpers/test-app';

/**
 * Acceptance test for `P1-API-07`: liveness never fails for a dependency's reason, readiness fails when the
 * database or the cache directory is unusable, and neither probe can leak what it knows.
 *
 * The distinction is the point of having two probes, so the first test here is the one that would catch the
 * mistake of making `/healthz` "thorough": a health check that consults the database turns a database outage
 * into a restart loop.
 */

const apps: { close: () => Promise<void> }[] = [];
const dirs: string[] = [];

/** A fresh, empty directory to act as `CACHE_DIR`. */
async function tempCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mapirror-readyz-'));
  dirs.push(dir);
  return dir;
}

/**
 * A handle that answers the boot ping and then misbehaves.
 *
 * The `db` stage pings the database during boot and refuses to start when the ping fails, so a handle whose
 * `check` always rejects never produces a running app — which is correct, and means a readiness test has to
 * separate "it was up when we started" from "it is up now". The first call is the boot ping; every later call is
 * a probe.
 *
 * @param probe - What every call after the first does.
 * @returns A handle that boots successfully.
 */
function bootsThen(probe: () => Promise<void>): SqlDatabase {
  let booted = false;
  return {
    ...stubDatabase(),
    check: () => {
      if (booted) return probe();
      booted = true;
      return Promise.resolve();
    },
  };
}

/**
 * Builds the full pipeline over a stub database and a temporary cache directory.
 *
 * @param database - Handle to adopt; defaults to the shared stub.
 * @returns The booted instance, plus the cache directory it was pointed at.
 */
async function app(
  database: SqlDatabase = stubDatabase(),
): Promise<{ instance: Awaited<ReturnType<typeof buildApp>>; cacheDir: string }> {
  const cacheDir = await tempCacheDir();
  const instance = await buildTestApp({
    config: parseEnv({ CACHE_DIR: cacheDir }),
    database,
  });
  apps.push(instance);
  return { instance, cacheDir };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('GET /healthz', () => {
  it('answers 200 with just a status, and asks nothing of the database', async () => {
    // A database that is down *after* the boot: liveness must not notice.
    const { instance } = await app(
      bootsThen(() => Promise.reject(new Error('connect ECONNREFUSED'))),
    );

    const response = await instance.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('is not cached, so a proxy cannot answer it from before an incident', async () => {
    const { instance } = await app();
    const response = await instance.inject({ method: 'GET', url: '/healthz' });

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });

  it('answers HEAD, which some orchestrators probe with', async () => {
    const { instance } = await app();
    const response = await instance.inject({ method: 'HEAD', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
  });
});

describe('GET /readyz', () => {
  it('answers 200 when the database and the cache directory both work', async () => {
    const { instance, cacheDir } = await app();

    const response = await instance.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      checks: { database: 'ok', cache: 'ok' },
    });
    // A probe file must not survive the probe: the cache directory is user-visible through the admin UI.
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('creates the cache directory when it is missing, because a fresh volume is empty', async () => {
    const cacheDir = join(await tempCacheDir(), 'cache');
    const instance = await buildTestApp({
      config: parseEnv({ CACHE_DIR: cacheDir }),
      database: stubDatabase(),
    });
    apps.push(instance);

    const response = await instance.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('answers 503 naming the database when it cannot answer, and says nothing more', async () => {
    // The driver's message is where a DSN and a password would appear.
    const { instance } = await app(
      bootsThen(() =>
        Promise.reject(new Error('password authentication failed for hunter2@db:5432')),
      ),
    );

    const response = await instance.inject({ method: 'GET', url: '/readyz' });
    const body = response.json<{ status: string; checks: Record<string, string> }>();

    expect(response.statusCode).toBe(503);
    expect(body).toEqual({ status: 'unavailable', checks: { database: 'fail', cache: 'ok' } });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('db:5432');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers 503 naming the cache when the directory cannot be written', async () => {
    // A *file* where the directory should be: `mkdir` fails with ENOTDIR and the write cannot succeed. Chmod
    // would be the obvious way to make a directory unwritable and it does not work under a root test runner.
    const file = join(await tempCacheDir(), 'not-a-directory');
    await writeFile(file, '');
    const instance = await buildTestApp({
      config: parseEnv({ CACHE_DIR: file }),
      database: stubDatabase(),
    });
    apps.push(instance);

    const response = await instance.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ checks: Record<string, string> }>().checks).toEqual({
      database: 'ok',
      cache: 'fail',
    });
  });

  it('logs the reason a check failed, while the response only names the check', async () => {
    // The operator needs "password authentication failed"; the client — anything on the network, unauthenticated
    // by design — needs "database". A probe that returns the driver's message is an information leak with a
    // 200-uptime aesthetic.
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    });
    const cacheDir = await tempCacheDir();
    const instance = await buildTestApp({
      config: parseEnv({ CACHE_DIR: cacheDir }),
      database: bootsThen(() => Promise.reject(new Error('password authentication failed'))),
      logger: { level: 'warn', stream },
    });
    apps.push(instance);

    const response = await instance.inject({ method: 'GET', url: '/readyz' });
    const text = chunks.join('');

    expect(response.statusCode).toBe(503);
    expect(text).toContain('password authentication failed');
    expect(text).toContain('"check":"database"');
    expect(response.body).not.toContain('password authentication failed');
  });

  it('answers 503 when a check throws before returning a promise', async () => {
    // A closed pool throws synchronously out of `check`. Unbounded, that escapes the probe's race, reaches the
    // error handler and answers `500 INTERNAL_ERROR` — a status that tells a load balancer the *probe* is broken
    // rather than the dependency, and that a monitoring rule keyed on `503` will never fire on.
    const { instance } = await app(
      bootsThen(() => {
        throw new Error('the pool was already closed');
      }),
    );

    const response = await instance.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ checks: Record<string, string> }>().checks).toEqual({
      database: 'fail',
      cache: 'ok',
    });
    expect(response.body).not.toContain('already closed');
  });

  it('answers within its budget even when a check never settles', async () => {
    // A dependency that accepts a connection and then says nothing is the case no timeout in the driver covers
    // reliably, and the case that makes a load balancer queue requests behind a hung probe.
    const hanging = bootsThen(() => new Promise<void>(() => undefined));
    const cacheDir = await tempCacheDir();
    const slots: readonly PluginSlot[] = [
      { id: 'request-context', rationale: 'test', task: null, install: installRequestContext },
      { id: 'errors', rationale: 'test', task: null, install: installErrorHandlers },
      {
        id: 'db',
        rationale: 'test',
        task: null,
        install: (instance, context) => installDb(instance, { ...context, database: hanging }),
      },
      {
        id: 'routes',
        rationale: 'test',
        task: null,
        install: (instance) => {
          instance.register(probeRoutes, { cacheDir, timeoutMs: 50 });
        },
      },
    ];
    const instance = await buildApp({
      config: parseEnv({ CACHE_DIR: cacheDir }),
      slots,
      database: hanging,
    });
    apps.push(instance);

    const started = Date.now();
    const response = await instance.inject({ method: 'GET', url: '/readyz' });
    const elapsed = Date.now() - started;

    expect(response.statusCode).toBe(503);
    expect(response.json<{ checks: Record<string, string> }>().checks).toEqual({
      database: 'fail',
      cache: 'ok',
    });
    expect(elapsed).toBeLessThan(1_000);
    // The default budget is the one the docs quote; a test that shortened it must not change it globally.
    expect(READY_PROBE_TIMEOUT_MS).toBe(2_000);
  });
});

describe('the probes and the route law', () => {
  it('are registered at exactly their documented paths, and nowhere near them', async () => {
    const { instance } = await app();

    expect(instance.hasRoute({ method: 'GET', url: '/healthz' })).toBe(true);
    expect(instance.hasRoute({ method: 'GET', url: '/readyz' })).toBe(true);
    for (const url of ['/healthz/', '/readyz/', '/healthz/x', '/readyz/x']) {
      expect((await instance.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    // GET only: a probe answering POST is a probe somebody can turn into an amplifier.
    expect((await instance.inject({ method: 'POST', url: '/healthz' })).statusCode).toBe(404);
  });

  it('need no credentials, because a container cannot hold a Bearer token', async () => {
    const { instance } = await app();
    for (const url of ['/healthz', '/readyz']) {
      expect((await instance.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }
  });
});
