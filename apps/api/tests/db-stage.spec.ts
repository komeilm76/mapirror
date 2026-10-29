import { describe, expect, it, vi } from 'vitest';

import {
  AppError,
  buildApp,
  checkDatabase,
  EXPECTED_MIGRATIONS,
  installDb,
  installErrorHandlers,
  installRequestContext,
  parseEnv,
  SchemaSkewError,
  type BuildAppOptions,
  type PluginSlot,
  type SqlDatabase,
  type SchemaVersionReport,
} from '../src/index';
import { schemaInSync } from './helpers/test-app';

/** The report shape for a schema that matches the build. */
function schemaInSyncReport(): SchemaVersionReport {
  return {
    expected: EXPECTED_MIGRATIONS,
    onDisk: EXPECTED_MIGRATIONS,
    applied: EXPECTED_MIGRATIONS,
    pending: [],
    unknown: [],
    missingFromDisk: [],
    unexpectedOnDisk: [],
  };
}

/**
 * The `db` stage's own guarantees, none of which need a server: what the stage does with the handle it is given,
 * what it does when that handle cannot answer, and that closing the app closes the pool exactly once.
 *
 * `tests/integration/db.spec.ts` covers the same stage against a real Postgres. The split is deliberate — these
 * run on every save, those need a database — but the behaviours that matter most are **here**, so a machine
 * without Postgres still tests them.
 */

/** A handle that records what the stage did to it. */
function recordingHandle(overrides: Partial<SqlDatabase> = {}) {
  const calls = { check: 0, close: 0 };
  const handle: SqlDatabase = {
    db: {} as SqlDatabase['db'],
    check: () => {
      calls.check += 1;
      return Promise.resolve();
    },
    close: () => {
      calls.close += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { handle, calls };
}

describe('the db stage', () => {
  it('decorates the instance with the handle it was given', async () => {
    const { handle } = recordingHandle();
    const instance = await buildApp({ database: handle, schemaCheck: schemaInSync() });

    expect(instance.db).toBe(handle);
    await instance.close();
  });

  it('checks the database once, during the boot', async () => {
    const { handle, calls } = recordingHandle();
    const instance = await buildApp({ database: handle, schemaCheck: schemaInSync() });

    // Once, not zero times (an unverified boot) and not once per request (a query in a hook).
    expect(calls.check).toBe(1);
    await instance.inject({ method: 'GET', url: '/_public/api/countries?sort=unsupported' });
    expect(calls.check).toBe(1);
    await instance.close();
  });

  it('refuses to boot when the check fails, and lets the app close afterwards', async () => {
    const failure = Object.assign(new Error('connect ECONNREFUSED'), { code: 'DB_UNAVAILABLE' });
    const { handle, calls } = recordingHandle({ check: () => Promise.reject(failure) });

    await expect(buildApp({ database: handle, schemaCheck: schemaInSync() })).rejects.toBe(failure);
    // The instance was never returned, so nothing else will close it: `buildApp` must have. Without this the pool
    // leaks on every failed boot, and a supervisor retries a failed boot in a loop.
    expect(calls.close).toBe(1);
  });

  it('builds its own handle from the config, and still refuses a boot it cannot verify', async () => {
    // No handle is passed, so the stage must construct one from `config.databaseUrl` — the branch every real
    // deployment takes, and the one the tests above skip by supplying a stub. Nothing listens on port 1, so the
    // boot check fails fast instead of reaching a server.
    const config = parseEnv({ DATABASE_URL: 'postgres://mapirror:hunter2@127.0.0.1:1/mapirror' });
    const error = await buildApp({ config, schemaCheck: schemaInSync() }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('DB_UNAVAILABLE');
    // The client-facing message names no host, user, or password.
    expect((error as AppError).message).not.toContain('hunter2');
    expect((error as AppError).message).not.toContain('127.0.0.1');
  });

  it('closes the handle when the boot is refused for an illegal route', async () => {
    // Two boot failures exist and only one of them used to clean up. `onReady` failing is caught by `buildApp`
    // and closes the instance; a route-law violation is thrown *after* a successful boot, so if that check sits
    // outside the same guard the pool it just opened is never closed. A supervisor retries a refused boot in a
    // loop, so this is the same leak as the one pass 14 fixed, reached through a different door.
    const { handle, calls } = recordingHandle();

    await expect(
      buildApp({
        database: handle,
        schemaCheck: schemaInSync(),
        slots: [
          {
            id: 'db',
            rationale: 'test',
            task: null,
            install: (instance, context) => installDb(instance, { ...context, database: handle }),
          },
          {
            id: 'routes',
            rationale: 'test',
            task: null,
            install: (instance) => {
              instance.get('/_site/leak', () => ({ ok: true }));
            },
          },
        ],
      }),
    ).rejects.toThrow(/violates L1/);

    expect(calls.close).toBe(1);
  });

  it('verifies the schema once during the boot, after the ping', async () => {
    const order: string[] = [];
    const handle: SqlDatabase = {
      db: {} as SqlDatabase['db'],
      check: () => {
        order.push('ping');
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const check = vi.fn(() => {
      order.push('schema');
      return Promise.resolve({ ...schemaInSyncReport(), migrated: [] });
    });

    const instance = await buildApp({ database: handle, schemaCheck: check });
    await instance.inject({ method: 'GET', url: '/healthz' });

    // Once, at boot: a per-request check would query the catalogue on every call for a fact that changes when a
    // container starts. After the ping, because a failure here assumes a reachable database.
    expect(check).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['ping', 'schema']);
    await instance.close();
  });

  it('refuses to boot when the schema does not match, and closes the handle', async () => {
    // The second way a boot can be refused, and it must take the same shutdown path as the first: the pool is open
    // by the time this check runs and the instance is never returned to anyone who could close it.
    const { handle, calls } = recordingHandle();
    const skew = new SchemaSkewError('the database contains migrations this build does not ship', {
      ...schemaInSyncReport(),
      unknown: ['0002_catalog'],
    });

    await expect(
      buildApp({ database: handle, schemaCheck: () => Promise.reject(skew) }),
    ).rejects.toBe(skew);

    expect(calls.close).toBe(1);
  });

  it('closes the handle when the app closes, however the handle arrived', async () => {
    // One rule: `app.db` is the app's database, so its lifetime is the app's. An earlier version closed only
    // handles it had created itself, which made a caller-supplied pool leak across restarts — the kind of bug
    // that shows up as "too many connections" an hour after a deploy.
    const { handle, calls } = recordingHandle();
    const instance = await buildApp({ database: handle, schemaCheck: schemaInSync() });
    await instance.close();

    expect(calls.close).toBe(1);
  });
});

describe('the liveness probe', () => {
  it('reports a handle that cannot even start a query as unavailable', async () => {
    // A pool that is closed, or a client misconfigured enough that the query builder throws while assembling the
    // statement, never reaches the network at all. The boot must still fail with the same code rather than the raw
    // `TypeError`, or an operator sees a stack trace instead of "the database is not reachable".
    const broken = {
      db: new Proxy(
        {},
        {
          get() {
            throw new Error('the pool was already closed');
          },
        },
      ) as SqlDatabase['db'],
      check: () => Promise.resolve(),
      close: () => Promise.resolve(),
    } satisfies SqlDatabase;

    const error = await checkDatabase(broken).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('DB_UNAVAILABLE');
  });
});

describe('shutdown closes the pool behind a drained request', () => {
  /** A pipeline with the stages a request needs, and a db stage over a spy handle. */
  function slotsWith(handle: SqlDatabase): readonly PluginSlot[] {
    return [
      { id: 'request-context', rationale: 'test', task: null, install: installRequestContext },
      { id: 'errors', rationale: 'test', task: null, install: installErrorHandlers },
      {
        id: 'db',
        rationale: 'test',
        task: null,
        install: (app, context) => installDb(app, { ...context, database: handle }),
      },
      {
        id: 'routes',
        rationale: 'test',
        task: null,
        install: (app) => {
          // A route that is still running when the close starts, so "drains then closes" can be observed.
          app.get('/_public/api/slow', async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return { ok: true };
          });
        },
      },
    ];
  }

  it('lets an in-flight request finish, then releases the connections', async () => {
    const events: string[] = [];
    const handle: SqlDatabase = {
      db: {} as SqlDatabase['db'],
      check: () => Promise.resolve(),
      close: () => {
        events.push('pool closed');
        return Promise.resolve();
      },
    };
    const options: BuildAppOptions = { slots: slotsWith(handle) };
    const instance = await buildApp({ schemaCheck: schemaInSync(), ...options });

    const inFlight = instance.inject({ method: 'GET', url: '/_public/api/slow' });
    const response = await inFlight;
    expect(response.statusCode).toBe(200);
    expect(events).toEqual([]); // nothing closed mid-request

    await instance.close();
    expect(events).toEqual(['pool closed']);
  });

  it('runs the close hook exactly once even if the app is closed twice', async () => {
    const closeSpy = vi.fn(() => Promise.resolve());
    const handle: SqlDatabase = {
      db: {} as SqlDatabase['db'],
      check: () => Promise.resolve(),
      close: closeSpy,
    };
    const instance = await buildApp({ slots: slotsWith(handle), schemaCheck: schemaInSync() });

    await instance.close();
    // Fastify tolerates a second close; the pool must not be told to close twice.
    await instance.close().catch(() => undefined);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
