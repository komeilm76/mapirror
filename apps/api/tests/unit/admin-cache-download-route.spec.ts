import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/env';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MapSource, ResolvedDownload } from '../../src/modules/geofabrik/source';

const mocks = vi.hoisted(() => ({
  findCountryById: vi.fn(),
  findMapVersionByLabel: vi.fn(),
  enqueueDownloadJob: vi.fn(),
  preflightDownloadSpace: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('../../src/db/repositories/catalog', () => ({ findCountryById: mocks.findCountryById }));
vi.mock('../../src/db/repositories/map-versions', () => ({
  findMapVersionByLabel: mocks.findMapVersionByLabel,
}));
vi.mock('../../src/modules/jobs/enqueue-download', () => ({
  enqueueDownloadJob: mocks.enqueueDownloadJob,
}));
vi.mock('../../src/modules/system/disk', () => ({
  preflightDownloadSpace: mocks.preflightDownloadSpace,
}));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }));

import {
  createCacheDownloadHandler,
  createCacheSpecificVersionHandler,
} from '../../src/modules/admin/cache-download-route';
import { GeofabrikSnapshotGoneError } from '../../src/modules/geofabrik/map-source';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const JOB_ID = '00000000-0000-4000-8000-000000000002';
const SYNCED_DATE = new Date('2026-11-01T12:00:00Z');

function makeSetup(
  options: {
    body?: unknown;
    params?: unknown;
    admin?: { id: string; username: string } | null;
    country?: { id: string; source: string; source_id: string } | null;
    versionRow?: { status: string } | null;
    resolved?: ResolvedDownload;
    sourceError?: Error;
    preflightError?: Error;
  } = {},
) {
  const country =
    options.country === undefined
      ? { id: COUNTRY_ID, source: 'geofabrik', source_id: 'europe/finland' }
      : options.country;
  const database = {};
  const source = {
    resolveDownload: vi.fn(() =>
      options.sourceError
        ? Promise.reject(options.sourceError)
        : Promise.resolve(
            options.resolved ?? {
              version: '261102',
              url: 'https://download.example/finland-latest.osm.pbf',
              sizeBytes: 125,
              dataTimestamp: SYNCED_DATE,
              checksumMd5: null,
              etag: null,
              lastModified: null,
            },
          ),
    ),
  } as unknown as Pick<MapSource, 'resolveDownload'>;
  const config = { cacheDir: '/never-created', diskReserveBytes: 99 } as AppConfig;
  const optionsForHandler = { config, source };
  mocks.findCountryById.mockResolvedValue(country);
  mocks.findMapVersionByLabel.mockResolvedValue(options.versionRow ?? null);
  mocks.enqueueDownloadJob.mockResolvedValue(JOB_ID);
  mocks.preflightDownloadSpace.mockImplementation(() =>
    options.preflightError ? Promise.reject(options.preflightError) : Promise.resolve(),
  );
  mocks.mkdir.mockResolvedValue(undefined);
  const request = {
    body: options.body ?? { countryId: COUNTRY_ID, version: 'latest' },
    params: options.params ?? { countryId: COUNTRY_ID },
    authenticatedAdmin:
      options.admin === undefined ? { id: 'admin-id', username: 'operator' } : options.admin,
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { countryId: string } }>;
  const code = vi.fn();
  const reply = { code } as unknown as FastifyReply;
  return {
    database,
    source,
    config,
    optionsForHandler,
    request,
    reply,
    code,
    handler: createCacheDownloadHandler(optionsForHandler),
    specificHandler: createCacheSpecificVersionHandler(optionsForHandler),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCountryById.mockResolvedValue({
    id: COUNTRY_ID,
    source: 'geofabrik',
    source_id: 'europe/finland',
  });
  mocks.findMapVersionByLabel.mockResolvedValue(null);
  mocks.enqueueDownloadJob.mockResolvedValue(JOB_ID);
  mocks.preflightDownloadSpace.mockResolvedValue(undefined);
  mocks.mkdir.mockResolvedValue(undefined);
});

describe('source-backed cache download admission', () => {
  it('resolves latest, checks its stable identity, preflights disk and enqueues one job', async () => {
    const setup = makeSetup();
    await expect(setup.handler(setup.request, setup.reply)).resolves.toEqual({
      jobId: JOB_ID,
      resolvedVersion: '261102',
    });
    expect(setup.source.resolveDownload).toHaveBeenCalledWith('europe/finland', 'latest');
    expect(mocks.findMapVersionByLabel).toHaveBeenCalledWith(
      setup.database,
      COUNTRY_ID,
      'latest@2026-11-01T12-00-00Z',
    );
    expect(mocks.mkdir).toHaveBeenCalledWith('/never-created', { recursive: true, mode: 0o700 });
    expect(mocks.preflightDownloadSpace).toHaveBeenCalledWith('/never-created', 125, 99);
    expect(mocks.enqueueDownloadJob).toHaveBeenCalledWith(setup.database, {
      countryId: COUNTRY_ID,
      version: 'latest',
      origin: 'geofabrik_latest',
      createdBy: 'admin-id',
    });
    expect(setup.code).toHaveBeenCalledWith(202);
  });

  it('skips stable latest identity checks when source timestamp is unknown', async () => {
    const setup = makeSetup({
      resolved: {
        version: null,
        url: 'https://download.example/latest.osm.pbf',
        sizeBytes: null,
        dataTimestamp: null,
        checksumMd5: null,
        etag: null,
        lastModified: null,
      },
    });
    await expect(setup.handler(setup.request, setup.reply)).resolves.toEqual({
      jobId: JOB_ID,
      resolvedVersion: null,
    });
    expect(mocks.findMapVersionByLabel).not.toHaveBeenCalled();
    expect(mocks.preflightDownloadSpace).toHaveBeenCalledWith('/never-created', null, 99);
  });

  it('rejects cached explicit versions before contacting the source', async () => {
    const setup = makeSetup({
      body: { countryId: COUNTRY_ID, version: '261101' },
      versionRow: { status: 'ready' },
    });
    await expect(setup.handler(setup.request, setup.reply)).rejects.toMatchObject({
      code: 'VERSION_ALREADY_CACHED',
    });
    expect(setup.source.resolveDownload).not.toHaveBeenCalled();
    expect(mocks.enqueueDownloadJob).not.toHaveBeenCalled();
  });

  it('allows non-ready duplicates, returns the pinned-version contract and enqueues snapshot origin', async () => {
    const setup = makeSetup({
      params: { countryId: COUNTRY_ID },
      body: { version: '261101' },
      versionRow: { status: 'failed' },
      resolved: {
        version: '261101',
        url: 'https://download.example/finland-261101.osm.pbf',
        sizeBytes: 75,
        dataTimestamp: null,
        checksumMd5: 'a'.repeat(32),
        etag: null,
        lastModified: null,
      },
    });
    await expect(setup.specificHandler(setup.request, setup.reply)).resolves.toEqual({
      jobId: JOB_ID,
    });
    expect(setup.source.resolveDownload).toHaveBeenCalledWith('europe/finland', '261101');
    expect(mocks.enqueueDownloadJob).toHaveBeenCalledWith(setup.database, {
      countryId: COUNTRY_ID,
      version: '261101',
      origin: 'geofabrik_snapshot',
      createdBy: 'admin-id',
    });
  });

  it('maps expired snapshots and upstream failures to safe application errors', async () => {
    const expired = makeSetup({
      body: { countryId: COUNTRY_ID, version: '261101' },
      sourceError: new GeofabrikSnapshotGoneError('261101'),
    });
    await expect(expired.handler(expired.request, expired.reply)).rejects.toMatchObject({
      code: 'SOURCE_VERSION_GONE',
      details: { version: '261101' },
    });

    const unavailable = makeSetup({ sourceError: new Error('secret upstream detail') });
    await expect(unavailable.handler(unavailable.request, unavailable.reply)).rejects.toMatchObject(
      {
        code: 'SOURCE_UNAVAILABLE',
        message: 'The map source could not be reached. Try again shortly.',
      },
    );
  });

  it('validates input, auth, source ownership and disk capacity before job admission', async () => {
    const invalid = makeSetup({ body: { countryId: COUNTRY_ID, version: 'tomorrow' } });
    await expect(invalid.handler(invalid.request, invalid.reply)).rejects.toThrow();

    const unauthenticated = makeSetup({ admin: null });
    await expect(
      unauthenticated.handler(unauthenticated.request, unauthenticated.reply),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const missingCountry = makeSetup({ country: null });
    await expect(
      missingCountry.handler(missingCountry.request, missingCountry.reply),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const uploadCountry = makeSetup({
      country: { id: COUNTRY_ID, source: 'upload', source_id: 'local' },
    });
    await expect(
      uploadCountry.handler(uploadCountry.request, uploadCountry.reply),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const diskFailure = new Error('insufficient disk');
    const noSpace = makeSetup({ preflightError: diskFailure });
    await expect(noSpace.handler(noSpace.request, noSpace.reply)).rejects.toBe(diskFailure);
    expect(mocks.enqueueDownloadJob).not.toHaveBeenCalled();
  });

  it('validates the specific-version path, body, auth and returned job id', async () => {
    const invalidPath = makeSetup({ params: { countryId: 'bad' }, body: { version: '261101' } });
    await expect(
      invalidPath.specificHandler(invalidPath.request, invalidPath.reply),
    ).rejects.toThrow();

    const invalidVersion = makeSetup({ body: { version: 'latest' } });
    await expect(
      invalidVersion.specificHandler(invalidVersion.request, invalidVersion.reply),
    ).rejects.toThrow();

    const unauthenticated = makeSetup({ admin: null, body: { version: '261101' } });
    await expect(
      unauthenticated.specificHandler(unauthenticated.request, unauthenticated.reply),
    ).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const malformedResponse = makeSetup({ body: { version: '261101' } });
    mocks.enqueueDownloadJob.mockResolvedValue('bad-job-id');
    await expect(
      malformedResponse.specificHandler(malformedResponse.request, malformedResponse.reply),
    ).rejects.toThrow();
    expect(malformedResponse.code).not.toHaveBeenCalled();
  });
});
