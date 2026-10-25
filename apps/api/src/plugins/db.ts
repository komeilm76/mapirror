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
  const database = context.database ?? createDatabase(context.config);

  app.decorate('db', database);

  app.addHook('onReady', async () => {
    try {
      await database.check();
    } catch (error) {
      // The driver's message is what says *why* (a refused connection, a bad password, a missing database), and
      // it is logged here — the thrown `AppError` carries no DSN for the client-facing path.
      app.log.error(
        { err: error, code: 'DB_UNAVAILABLE' },
        'database is not reachable; refusing to boot',
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
