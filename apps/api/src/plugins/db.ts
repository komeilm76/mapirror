/**
 * The database stage: one pool, one handle, one owner (task `P1-API-06`).
 *
 * Slot 4 of the pipeline. It sits after `security` and before `rate-limit`, `auth` and the routes because those
 * three read the database and none of them should have to ask whether it is there.
 *
 * Three responsibilities, and one rule that shapes all of them — **nothing here connects twice**:
 *
 * 1. **Create the handle once** and decorate the instance with it (`app.db`). A second pool somewhere else would
 *    quietly double the connection count and split the transaction space.
 * 2. **Prove it at boot.** The `onReady` hook pings the database, so `buildApp()` rejects — and the process exits
 *    1 — when Postgres is unreachable. Failing here is the whole point of the stage: a server that starts and
 *    then 500s on every request is worse than one that refuses to start, because a supervisor and a load balancer
 *    both believe it is healthy.
 * 3. **Close it on the way down.** The `onClose` hook destroys the pool, so the shutdown path already built in
 *    `server.ts` (drain requests, 8 s bound, exit 0/1) also releases connections. Docker's `docker compose down`
 *    then leaves nothing behind for Postgres to time out.
 *
 * @module plugins/db
 */

import type { FastifyInstance } from 'fastify';

import { createDatabase, type SqlDatabase } from '../db/client';
import { checkSchemaVersion, SchemaSkewError, type SchemaCheck } from '../db/version-check';
import type { PipelineContext } from './order';

declare module 'fastify' {
  interface FastifyInstance {
    /** The database handle for this process; installed by this stage. */
    db: SqlDatabase;
  }
}

/**
 * Installs the database stage on the **root** instance.
 *
 * @param app - Root instance.
 * @param context - Pipeline context: `config` supplies the DSN and pool size; `database` is an existing handle to
 * adopt, handed over by `buildApp` when the caller already owns one (tests with a stub, integration tests with a
 * real server).
 */
export function installDb(app: FastifyInstance, context: PipelineContext): void {
  const database =
    context.database ??
    createDatabase(context.config, (error) => {
      // `warn`, not `error`: the pool recovers on the next query, and this fires once per dropped connection —
      // during a Postgres restart that is a handful of lines, not an outage alarm.
      app.log.warn({ err: error }, 'a database connection was lost; the pool will reconnect');
    });

  app.decorate('db', database);

  app.addHook('onReady', async () => {
    try {
      await database.check();
      // Migrate (when this process owns that job) and then prove the schema matches the code. Runs after the ping
      // because every failure below assumes a reachable database, and inside the same hook because none of these
      // answers is useful once the server is accepting requests.
      const check: SchemaCheck =
        context.schemaCheck ??
        ((handle, config) => checkSchemaVersion(handle, { migrateOnBoot: config.migrateOnBoot }));
      const report = await check(database, context.config);
      if (report.migrated.length > 0) {
        app.log.info({ migrations: report.migrated }, 'migrations applied');
      }
      app.log.info(
        { migrations: report.applied.length, expected: report.expected.length },
        'database schema matches this build',
      );
    } catch (error) {
      // The driver's message is what says *why* (a refused connection, a bad password, a missing database), and
      // it is logged here — the thrown `AppError` carries no DSN for the client-facing path.
      // Two distinct refuse-to-boot reasons share this path: an unreachable database and a schema that does not match
      // the code. Both mean "serving now would answer 500s", and both name themselves in the log.
      const skew = error instanceof SchemaSkewError ? error : undefined;
      app.log.error(
        skew === undefined
          ? { err: error, code: 'DB_UNAVAILABLE' }
          : { err: error, code: skew.code, report: skew.report },
        skew === undefined
          ? 'database is not reachable; refusing to boot'
          : 'database schema does not match this build; refusing to boot',
      );
      throw error;
    }
  });

  app.addHook('onClose', async () => {
    // Whichever way the handle arrived, its lifetime is this instance's: `app.db` is *the app's* database, and a
    // handle that outlived its app would be a pool leaking across restarts. A caller that genuinely shares one
    // handle between two apps says so at the call site (`{ ...handle, close: () => Promise.resolve() }`) instead
    // of relying on the stage to guess. Learned the hard way: an earlier version inferred ownership from "was it
    // passed in?", which is a different question and made a correct call site behave like a leak.
    await database.close();
  });
}
