#!/usr/bin/env bun
/** Run the normal missing-cache reconciliation as a one-off restore step. */

import { parseEnv } from '../apps/api/src/config/env';
import { createDatabase } from '../apps/api/src/db/client';
import { createCacheStorage } from '../apps/api/src/modules/storage/storage';
import { reconcileMissingReadyVersions } from '../apps/api/src/modules/system/storage-reconciliation';

export async function main(): Promise<number> {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = parseEnv(process.env);
    database = createDatabase(config);
    await database.check();
    const reconciled = await reconcileMissingReadyVersions(
      database.db,
      createCacheStorage(config.cacheDir),
      {
        info: (context, message) => console.info(message, context),
        warn: (context, message) => console.warn(message, context),
      },
    );
    console.info(`cache reconciliation complete; marked ${reconciled} ready version(s) failed`);
    return 0;
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : 'cache reconciliation failed'}`,
    );
    return 1;
  } finally {
    await database?.close();
  }
}

if (import.meta.main) process.exitCode = await main();
