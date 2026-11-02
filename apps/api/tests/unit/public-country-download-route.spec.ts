import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/env';
import type { FastifyReply, FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({
  acquireCountryCacheStreamLock: vi.fn(),
  cacheCountryAdvisoryLockKey: vi.fn(),
  releaseCountryCacheStreamLock: vi.fn(),
  findPublicCountryBySlug: vi.fn(),
  findPublicDownloadFile: vi.fn(),
  recordDownloadEvent: vi.fn(),
  createCacheStorage: vi.fn(),
}));
vi.mock('../../src/db/repositories/cache', () => ({
  acquireCountryCacheStreamLock: mocks.acquireCountryCacheStreamLock,
  cacheCountryAdvisoryLockKey: mocks.cacheCountryAdvisoryLockKey,
  releaseCountryCacheStreamLock: mocks.releaseCountryCacheStreamLock,
}));
vi.mock('../../src/db/repositories/public-catalog', () => ({
  findPublicCountryBySlug: mocks.findPublicCountryBySlug,
  findPublicDownloadFile: mocks.findPublicDownloadFile,
}));
vi.mock('../../src/modules/download-events', () => ({
  recordDownloadEvent: mocks.recordDownloadEvent,
}));
vi.mock('../../src/modules/storage/storage', () => ({
  createCacheStorage: mocks.createCacheStorage,
}));

import { createPublicCountryDownloadHandler } from '../../src/modules/public/country-download-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const VERSION_ID = '00000000-0000-4000-8000-000000000002';
const CHECKSUM = 'b'.repeat(32);

function makeFileRow(overrides: Record<string, unknown> = {}) {
  return {
    country_id: COUNTRY_ID,
    slug: 'finland',
    version_id: VERSION_ID,
    version: '261101',
    storage_path: 'finland/261101/finland.osm.pbf',
    checksum_md5: CHECKSUM,
    file_size_bytes: '8',
    modified_at: new Date('2026-11-01T12:00:00Z'),
    ...overrides,
  };
}

function makeSetup(
  options: {
    readonly params?: unknown;
    readonly query?: unknown;
    readonly visibleCountry?: { country_id: string; slug: string } | null;
    readonly row?: ReturnType<typeof makeFileRow> | null;
    readonly method?: 'GET' | 'HEAD';
    readonly headers?: Record<string, string | undefined>;
    readonly fileSize?: number;
    readonly openError?: Error;
    readonly isFile?: boolean;
    readonly lockReleaseError?: Error;
  } = {},
) {
  const query = { version: '261101' };
  const visibleCountry =
    options.visibleCountry === undefined
      ? { country_id: COUNTRY_ID, slug: 'finland' }
      : options.visibleCountry;
  const row = options.row === null ? null : (options.row ?? makeFileRow());
  const connection = {};
  const database = {
    connection: vi.fn(() => ({
      execute: (work: (connection: object) => Promise<unknown>) => work(connection),
    })),
  };
  mocks.findPublicCountryBySlug.mockResolvedValue(visibleCountry);
  mocks.findPublicDownloadFile.mockResolvedValue(row);
  if (options.lockReleaseError !== undefined) {
    mocks.releaseCountryCacheStreamLock.mockRejectedValue(options.lockReleaseError);
  }
  const stream = new PassThrough();
  const fileHandle = {
    stat: vi.fn(() =>
      Promise.resolve({
        size: options.fileSize ?? 8,
        isFile: () => options.isFile ?? true,
      }),
    ),
    createReadStream: vi.fn(() => stream),
    close: vi.fn(() => Promise.resolve()),
  };
  const file = {
    relativePath: 'finland/261101/finland.osm.pbf',
    open: vi.fn(() =>
      options.openError ? Promise.reject(options.openError) : Promise.resolve(fileHandle),
    ),
  };
  const storage = { versionFileAt: vi.fn(() => file) };
  const raw = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    statusCode: number;
    setHeader: ReturnType<typeof vi.fn>;
    removeHeader: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  raw.destroyed = false;
  raw.statusCode = 200;
  raw.setHeader = vi.fn();
  raw.removeHeader = vi.fn();
  raw.end = vi.fn(() => {
    raw.destroyed = true;
    raw.emit('close');
  });
  const replyHolder: { current?: FastifyReply } = {};
  const header = vi.fn();
  const removeHeader = vi.fn();
  const code = vi.fn((_status: number) => replyHolder.current);
  const hijack = vi.fn();
  const send = vi.fn((body: unknown) => {
    if (body instanceof PassThrough) body.emit('data', Buffer.from('abcdefgh'));
    raw.destroyed = true;
    raw.emit('close');
    return replyHolder.current;
  });
  const reply = { raw, header, removeHeader, code, hijack, send } as unknown as FastifyReply;
  replyHolder.current = reply;
  const request = {
    params: options.params ?? { slug: 'finland' },
    query: options.query ?? query,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    log: { error: vi.fn(), warn: vi.fn() },
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { slug: string }; Querystring: { version?: string } }>;
  mocks.cacheCountryAdvisoryLockKey.mockReturnValue('country-lock');
  mocks.createCacheStorage.mockReturnValue(storage);
  const config = { cacheDir: '/unused' } as AppConfig;
  const handler = createPublicCountryDownloadHandler({ config });
  return {
    handler,
    request,
    reply,
    raw,
    header,
    removeHeader,
    code,
    hijack,
    connection,
    database,
    file,
    fileHandle,
    stream,
    storage,
    config,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquireCountryCacheStreamLock.mockResolvedValue(undefined);
  mocks.releaseCountryCacheStreamLock.mockResolvedValue(undefined);
  mocks.recordDownloadEvent.mockResolvedValue(undefined);
});

describe('public country download handler', () => {
  it('validates the route, hides unpublished countries, and rechecks rows under the stream lock', async () => {
    const invalidParams = makeSetup({ params: { slug: '../finland' } });
    await expect(
      invalidParams.handler(invalidParams.request, invalidParams.reply),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.findPublicCountryBySlug).not.toHaveBeenCalled();

    const invalidQuery = makeSetup({ query: { version: 'bad/value', extra: 'x' } });
    await expect(invalidQuery.handler(invalidQuery.request, invalidQuery.reply)).rejects.toThrow();

    const unpublished = makeSetup({ visibleCountry: null });
    await expect(unpublished.handler(unpublished.request, unpublished.reply)).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
    expect(unpublished.database.connection).not.toHaveBeenCalled();

    const disappeared = makeSetup({ row: null });
    await expect(disappeared.handler(disappeared.request, disappeared.reply)).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
    expect(mocks.releaseCountryCacheStreamLock).toHaveBeenCalledWith(
      disappeared.connection,
      COUNTRY_ID,
    );
  });

  it('streams a selected byte range, advertises public cache metadata and records only sent bytes', async () => {
    const setup = makeSetup({ headers: { range: 'bytes=2-4', 'if-range': `"md5:${CHECKSUM}"` } });
    await setup.handler(setup.request, setup.reply);
    expect(setup.code.mock.calls[0]?.[0]).toBe(206);
    expect(setup.header.mock.calls).toContainEqual(['Content-Range', 'bytes 2-4/8']);
    expect(setup.header.mock.calls).toContainEqual([
      'Cache-Control',
      'public, max-age=31536000, immutable',
    ]);
    expect(setup.header.mock.calls).toContainEqual(['ETag', `"md5:${CHECKSUM}"`]);
    expect(mocks.findPublicDownloadFile).toHaveBeenCalledWith(
      setup.connection,
      'finland',
      '261101',
    );
    expect(setup.fileHandle.createReadStream).toHaveBeenCalledWith({
      start: 2,
      end: 4,
      autoClose: false,
    });
    expect(mocks.recordDownloadEvent).toHaveBeenCalledWith(
      setup.connection,
      setup.config,
      setup.request,
      { countryId: COUNTRY_ID, versionId: VERSION_ID, bytesSent: 8n, channel: 'public' },
    );
    expect(mocks.releaseCountryCacheStreamLock).toHaveBeenCalledWith(setup.connection, COUNTRY_ID);
  });

  it('supports HEAD, conditional 304, immutable explicit versions, and ignores invalid ranges', async () => {
    const head = makeSetup({ method: 'HEAD', query: {} });
    await head.handler(head.request, head.reply);
    expect(mocks.findPublicDownloadFile).toHaveBeenCalledWith(head.connection, 'finland', 'latest');
    expect(head.code.mock.calls[0]?.[0]).toBe(200);
    expect(head.header.mock.calls).toContainEqual(['Cache-Control', 'no-cache']);
    expect(head.hijack.mock.calls).toHaveLength(1);
    expect(mocks.recordDownloadEvent).not.toHaveBeenCalled();

    const conditional = makeSetup({ headers: { 'if-none-match': `W/"md5:${CHECKSUM}"` } });
    await conditional.handler(conditional.request, conditional.reply);
    expect(conditional.code.mock.calls[0]?.[0]).toBe(304);
    expect(conditional.removeHeader.mock.calls).toContainEqual(['Content-Length']);

    const invalidRange = makeSetup({
      query: { version: '261101' },
      headers: { range: 'bytes=9-10', 'if-range': 'W/"weak"' },
    });
    await invalidRange.handler(invalidRange.request, invalidRange.reply);
    expect(invalidRange.code.mock.calls[0]?.[0]).toBe(200);
    expect(invalidRange.header.mock.calls).not.toContainEqual(
      expect.arrayContaining(['Content-Range']),
    );
    expect(invalidRange.header.mock.calls).toContainEqual([
      'Cache-Control',
      'public, max-age=31536000, immutable',
    ]);

    const weakIfRange = makeSetup({
      headers: { range: 'bytes=0-2', 'if-range': 'W/"weak"' },
    });
    await weakIfRange.handler(weakIfRange.request, weakIfRange.reply);
    expect(weakIfRange.code.mock.calls[0]?.[0]).toBe(200);
    expect(weakIfRange.header.mock.calls).not.toContainEqual(['Content-Range', expect.any(String)]);

    const dateIfRange = makeSetup({
      headers: { range: 'bytes=-3', 'if-range': 'Sun, 01 Nov 2026 12:00:00 GMT' },
    });
    await dateIfRange.handler(dateIfRange.request, dateIfRange.reply);
    expect(dateIfRange.code.mock.calls[0]?.[0]).toBe(206);
    expect(dateIfRange.header.mock.calls).toContainEqual(['Content-Range', 'bytes 5-7/8']);
  });

  it('maps missing files and non-file artifacts safely, and does not mask lock-release failures', async () => {
    const missingFile = makeSetup({
      openError: Object.assign(new Error('private path'), { code: 'ENOTDIR' }),
    });
    await expect(missingFile.handler(missingFile.request, missingFile.reply)).rejects.toMatchObject(
      {
        code: 'VERSION_FILE_MISSING',
        message: 'The cached map file is not available.',
      },
    );
    expect(mocks.recordDownloadEvent).not.toHaveBeenCalled();

    const directory = makeSetup({ isFile: false });
    await expect(directory.handler(directory.request, directory.reply)).rejects.toMatchObject({
      code: 'VERSION_FILE_MISSING',
    });

    const releaseFailure = makeSetup({ lockReleaseError: new Error('unlock failed') });
    await expect(
      releaseFailure.handler(releaseFailure.request, releaseFailure.reply),
    ).resolves.toBeUndefined();
    expect(releaseFailure.request.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ countryLock: 'country-lock' }),
      'could not release public cached map stream lock; connection teardown will release it',
    );
  });
});
