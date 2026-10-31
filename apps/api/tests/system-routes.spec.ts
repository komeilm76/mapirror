import type { Kysely } from 'kysely';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { parseEnv } from '../src/config/env';
import type { Database } from '../src/db/schema';
import { getSystemMetrics, getSystemStatus } from '../src/modules/admin/system-routes';

interface RawRows {
  readonly rows: readonly Record<string, unknown>[];
}

function rawDatabase(rows: RawRows['rows']) {
  const executeQuery = vi.fn(() => Promise.resolve({ rows }));
  const executor = {
    transformQuery: (node: unknown) => node,
    compileQuery: (node: unknown) => node,
    executeQuery,
  };
  const database = {
    getExecutor: () => executor,
  } as unknown as Kysely<Database>;
  return { database, executeQuery };
}

function metricsRequest(rows: RawRows['rows'], query: unknown) {
  const { database, executeQuery } = rawDatabase(rows);
  const request = {
    query,
    server: { db: { db: database } },
  } as unknown as FastifyRequest;
  return { request, executeQuery };
}

function statusRequest(
  input: {
    readonly counts?: Record<string, string>;
    readonly settings?: readonly { key: string; value: unknown }[];
    readonly lastCatalogJob?: { status: 'succeeded' | 'failed' };
  } = {},
) {
  const { database: rawDb, executeQuery } = rawDatabase([
    {
      countries: '8',
      cached_countries: '3',
      public_countries: '2',
      versions: '5',
      updates_available: '1',
      jobs_running: '2',
      jobs_queued: '4',
      ...input.counts,
    },
  ]);
  const settingsRows = input.settings ?? [];
  const settingsBuilder = {
    select: () => settingsBuilder,
    where: () => settingsBuilder,
    execute: () => Promise.resolve(settingsRows),
  };
  const jobBuilder = {
    select: () => jobBuilder,
    where: () => jobBuilder,
    orderBy: () => jobBuilder,
    limit: () => jobBuilder,
    executeTakeFirst: () => Promise.resolve(input.lastCatalogJob),
  };
  const trx = {
    getExecutor: () => rawDb.getExecutor(),
    selectFrom: (table: string) => (table === 'settings' ? settingsBuilder : jobBuilder),
  };
  const database = {
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: (callback: (transaction: typeof trx) => unknown) => callback(trx),
      }),
    }),
  } as unknown as Kysely<Database>;
  const request = {
    query: {},
    server: { db: { db: database } },
  } as unknown as FastifyRequest;
  return { request, executeQuery };
}

const metricsRow = {
  t: new Date('2026-10-31T12:34:30.000Z'),
  cpu_percent: 30.5,
  load1: 0.6,
  load5: 0.5,
  load15: 0.4,
  mem_used_bytes: '9007199254740992',
  mem_total_bytes: '2000',
  disk_used_bytes: null,
  disk_total_bytes: '8000',
  cache_size_bytes: '1250',
};

describe('system metrics route', () => {
  it.each([
    ['5m', 10],
    ['1h', 30],
    ['24h', 300],
    ['7d', 1_800],
  ] as const)(
    'returns downsampled %s points with a %i-second step',
    async (window, stepSeconds) => {
      const { request, executeQuery } = metricsRequest([metricsRow], { window });
      await expect(
        getSystemMetrics(request, () => new Date('2026-10-31T12:35:00.000Z')),
      ).resolves.toEqual({
        window,
        stepSeconds,
        samples: [
          {
            t: metricsRow.t.toISOString(),
            cpuPercent: 30.5,
            load1: 0.6,
            load5: 0.5,
            load15: 0.4,
            memUsedBytes: '9007199254740992',
            memTotalBytes: 2000,
            diskUsedBytes: null,
            diskTotalBytes: 8000,
            cacheSizeBytes: 1250,
          },
        ],
        scope: 'container',
      });
      expect(executeQuery).toHaveBeenCalledOnce();
    },
  );

  it('defaults to one hour and rejects unknown query keys and windows', async () => {
    const omitted = metricsRequest([], {});
    await expect(getSystemMetrics(omitted.request)).resolves.toMatchObject({
      window: '1h',
      stepSeconds: 30,
      samples: [],
    });
    const unknownKey = metricsRequest([], { window: '1h', debug: 'true' });
    await expect(getSystemMetrics(unknownKey.request)).rejects.toMatchObject({ name: 'ZodError' });
    expect(unknownKey.executeQuery).not.toHaveBeenCalled();
    const unknownWindow = metricsRequest([], { window: '30d' });
    await expect(getSystemMetrics(unknownWindow.request)).rejects.toMatchObject({
      name: 'ZodError',
    });
    expect(unknownWindow.executeQuery).not.toHaveBeenCalled();
  });
});

describe('system status route', () => {
  it('reports counts, disk headroom, worker config, source state and safe branding', async () => {
    const { request } = statusRequest({
      settings: [
        { key: 'source.catalogSyncedAt', value: '2026-10-31T12:30:00.000Z' },
        { key: 'branding.displayName', value: '  Mirror North  ' },
      ],
      lastCatalogJob: { status: 'succeeded' },
    });
    const config = {
      ...parseEnv({}),
      appVersion: '1.2.3',
      cacheDir: '/cache',
      diskReserveBytes: 100,
      workerEnabled: false,
      workerConcurrency: 3,
      brandingDisplayName: 'MapMirror',
    };
    await expect(
      getSystemStatus(request, config, {
        uptimeSeconds: () => 42.9,
        readDiskSpace: () => Promise.resolve({ freeBytes: 100n, totalBytes: 1_000n }),
      }),
    ).resolves.toEqual({
      version: '1.2.3',
      uptimeSeconds: 42,
      worker: { enabled: false, concurrency: 3, running: 2 },
      storage: {
        cacheDir: '/cache',
        usedBytes: 900,
        freeBytes: 100,
        reserveBytes: 100,
        state: 'low',
        orphans: null,
      },
      counts: {
        countries: 8,
        cachedCountries: 3,
        publicCountries: 2,
        versions: 5,
        updatesAvailable: 1,
        jobsRunning: 2,
        jobsQueued: 4,
      },
      source: {
        id: 'geofabrik',
        lastSyncAt: '2026-10-31T12:30:00.000Z',
        reachable: true,
      },
      branding: { displayName: 'Mirror North' },
    });
  });

  it('includes the read-only cache orphan report when available', async () => {
    const { request } = statusRequest();
    await expect(
      getSystemStatus(request, parseEnv({}), {
        uptimeSeconds: () => 0,
        readDiskSpace: () =>
          Promise.resolve({ freeBytes: 1_000_000_000n, totalBytes: 2_000_000_000n }),
        readOrphans: () => Promise.resolve({ count: 2, bytes: '9007199254740992' }),
      }),
    ).resolves.toMatchObject({ storage: { orphans: { count: 2, bytes: '9007199254740992' } } });
  });

  it('does not report an upstream as reachable after its latest completed sync failed', async () => {
    const { request } = statusRequest({
      settings: [{ key: 'source.catalogSyncedAt', value: '2026-10-31T12:30:00.000Z' }],
      lastCatalogJob: { status: 'failed' },
    });
    await expect(
      getSystemStatus(request, parseEnv({}), {
        uptimeSeconds: () => 0,
        readDiskSpace: () =>
          Promise.resolve({ freeBytes: 1_000_000_000n, totalBytes: 2_000_000_000n }),
      }),
    ).resolves.toMatchObject({ source: { reachable: false } });
  });

  it('rejects unknown query keys before querying the database', async () => {
    const { request, executeQuery } = statusRequest();
    const invalidRequest = { ...request, query: { debug: 'true' } } as FastifyRequest;
    await expect(
      getSystemStatus(invalidRequest, parseEnv({}), {
        uptimeSeconds: () => 0,
        readDiskSpace: () => Promise.resolve({ freeBytes: 1n, totalBytes: 2n }),
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('rejects unsafe counts and impossible filesystem readings', async () => {
    const unsafe = statusRequest({ counts: { countries: '9007199254740992' } });
    await expect(
      getSystemStatus(unsafe.request, parseEnv({}), {
        uptimeSeconds: () => 0,
        readDiskSpace: () => Promise.resolve({ freeBytes: 1n, totalBytes: 2n }),
      }),
    ).rejects.toThrow('system status count exceeds the JSON safe integer range');

    const invalidDisk = statusRequest();
    await expect(
      getSystemStatus(invalidDisk.request, parseEnv({}), {
        uptimeSeconds: () => 0,
        readDiskSpace: () => Promise.resolve({ freeBytes: 3n, totalBytes: 2n }),
      }),
    ).rejects.toThrow('cache filesystem returned invalid capacity values');
  });
});
