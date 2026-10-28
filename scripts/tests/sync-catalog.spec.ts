import { describe, expect, it } from 'vitest';

import { parseArgs, main } from '../sync-catalog';
import {
  dsnFor,
  freshDatabaseSkipReason,
  withFreshDatabase,
} from '../../apps/api/tests/helpers/fresh-db';

const skipReason = await freshDatabaseSkipReason();

describe('sync:catalog CLI', () => {
  it('accepts only --help and rejects misspelled options', () => {
    expect(parseArgs([])).toEqual({ help: false });
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(() => parseArgs(['--hel'])).toThrow('unknown argument(s): --hel');
  });

  it('prints help without parsing config or opening a database', async () => {
    const output: string[] = [];
    const exitCode = await main(['--help'], {
      env: { PORT: 'not-a-port' },
      out: (line) => output.push(line),
      connect: () => {
        throw new Error('must not connect');
      },
    });

    expect(exitCode).toBe(0);
    expect(output.join('\n')).toContain('Enqueue (or reuse) one Geofabrik catalog-sync job');
  });

  it('reports invalid configuration before connecting', async () => {
    let connected = false;
    const errors: string[] = [];
    const exitCode = await main([], {
      env: { PORT: 'not-a-port' },
      err: (line) => errors.push(line),
      connect: () => {
        connected = true;
        throw new Error('must not connect');
      },
    });

    expect(exitCode).toBe(1);
    expect(connected).toBe(false);
    expect(errors.join('\n')).toContain('PORT');
  });

  it.skipIf(skipReason !== null)(
    'uses the same idempotent queue operation as the API endpoint',
    async () => {
      await withFreshDatabase(
        async (database, name) => {
          const output: string[] = [];
          let closes = 0;
          const connect = () => ({
            db: database.db,
            check: () => Promise.resolve(),
            close: () => {
              closes += 1;
              return Promise.resolve();
            },
          });
          const env = { NODE_ENV: 'test', DATABASE_URL: dsnFor(name) };
          const dependencies = { env, out: (line: string) => output.push(line), connect };

          expect(await main([], dependencies)).toBe(0);
          expect(await main([], dependencies)).toBe(0);
          const ids = output.map((line) => line.replace('catalog sync job: ', ''));
          expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/u);
          expect(ids[1]).toBe(ids[0]);
          expect(closes).toBe(2);
          const jobs = await database.db
            .selectFrom('jobs')
            .select(['id', 'created_by'])
            .where('type', '=', 'catalog_sync')
            .where('status', 'in', ['queued', 'running'])
            .execute();
          expect(jobs).toEqual([{ id: ids[0], created_by: null }]);
        },
        { prefix: 'catalogsynccmd', migrate: true },
      );
    },
  );
});
