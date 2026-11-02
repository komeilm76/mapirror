import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/env';
import type { FastifyReply, FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({
  acquireCountryCacheStreamLock: vi.fn(),
  cacheCountryAdvisoryLockKey: vi.fn(),
  releaseCountryCacheStreamLock: vi.fn(),
  recordDownloadEvent: vi.fn(),
  createCacheStorage: vi.fn(),
}));
vi.mock('../../src/db/repositories/cache', () => ({
  acquireCountryCacheStreamLock: mocks.acquireCountryCacheStreamLock,
  cacheCountryAdvisoryLockKey: mocks.cacheCountryAdvisoryLockKey,
  releaseCountryCacheStreamLock: mocks.releaseCountryCacheStreamLock,
}));
vi.mock('../../src/modules/download-events', () => ({
  recordDownloadEvent: mocks.recordDownloadEvent,
}));
vi.mock('../../src/modules/storage/storage', () => ({
  createCacheStorage: mocks.createCacheStorage,
}));

import { createCacheVersionDownloadHandler } from '../../src/modules/admin/cache-version-download-route';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const VERSION_ID = '00000000-0000-4000-8000-000000000002';
const CHECKSUM = 'a'.repeat(32);

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    country_id: COUNTRY_ID,
    slug: 'finland',
    version_id: VERSION_ID,
    storage_path: 'finland/261101/finland.osm.pbf',
    checksum_md5: CHECKSUM,
    file_size_bytes: '8',
    modified_at: new Date('2026-11-01T12:00:00Z'),
    ...overrides,
  };
}

function makeSetup(
  options: {
    readonly row?: ReturnType<typeof makeRow> | null;
    readonly params?: unknown;
    readonly method?: 'GET' | 'HEAD';
    readonly headers?: Record<string, string | undefined>;
    readonly fileSize?: number;
    readonly openError?: Error;
    readonly isFile?: boolean;
  } = {},
) {
  const row = options.row === null ? undefined : (options.row ?? makeRow());
  const query = {
    innerJoin: vi.fn(() => query),
    select: vi.fn(() => query),
    where: vi.fn(() => query),
    executeTakeFirst: vi.fn(() => Promise.resolve(row)),
  };
  const connection = { selectFrom: vi.fn(() => query) };
  const database = {
    connection: vi.fn(() => ({
      execute: (work: (connection: object) => Promise<unknown>) => work(connection),
    })),
  };
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
    params: options.params ?? { countryId: COUNTRY_ID, versionId: VERSION_ID },
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    log: { error: vi.fn(), warn: vi.fn() },
    server: { db: { db: database } },
  } as unknown as FastifyRequest<{ Params: { countryId: string; versionId: string } }>;
  mocks.createCacheStorage.mockReturnValue(storage);
  const config = { cacheDir: '/unused' } as AppConfig;
  const handler = createCacheVersionDownloadHandler({ config });
  return {
    handler,
    request,
    reply,
    header,
    removeHeader,
    code,
    hijack,
    raw,
    query,
    database,
    connection,
    file,
    fileHandle,
    stream,
    storage,
    config,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cacheCountryAdvisoryLockKey.mockReturnValue('country-lock');
  mocks.acquireCountryCacheStreamLock.mockResolvedValue(undefined);
  mocks.releaseCountryCacheStreamLock.mockResolvedValue(undefined);
  mocks.recordDownloadEvent.mockResolvedValue(undefined);
});

describe('admin cached-version download handler', () => {
  it('rejects malformed identifiers and releases the lock when the version row is missing', async () => {
    const invalid = makeSetup({ params: { countryId: 'bad', versionId: VERSION_ID } });

    await expect(invalid.handler(invalid.request, invalid.reply)).rejects.toThrow();
    expect(invalid.database.connection).not.toHaveBeenCalled();

    const missing = makeSetup({ row: null });
    await expect(missing.handler(missing.request, missing.reply)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.acquireCountryCacheStreamLock).toHaveBeenCalledWith(
      missing.connection,
      COUNTRY_ID,
    );
    expect(mocks.releaseCountryCacheStreamLock).toHaveBeenCalledWith(
      missing.connection,
      COUNTRY_ID,
    );
  });

  it('streams a bounded range, records bytes sent, and keeps admin responses private', async () => {
    const setup = makeSetup({ headers: { range: 'bytes=2-4' } });
    await setup.handler(setup.request, setup.reply);
    expect(setup.code.mock.calls[0]?.[0]).toBe(206);
    expect(setup.header.mock.calls).toContainEqual(['Content-Range', 'bytes 2-4/8']);
    expect(setup.header.mock.calls).toContainEqual([
      'Content-Disposition',
      'attachment; filename="finland.osm.pbf"',
    ]);
    expect(setup.storage.versionFileAt).toHaveBeenCalledWith('finland/261101/finland.osm.pbf');
    expect(setup.header.mock.calls).toContainEqual(['Cache-Control', 'private, no-store']);
    expect(setup.header.mock.calls).toContainEqual(['ETag', `"md5:${CHECKSUM}"`]);
    expect(setup.fileHandle.createReadStream).toHaveBeenCalledWith({
      start: 2,
      end: 4,
      autoClose: false,
    });
    expect(mocks.recordDownloadEvent).toHaveBeenCalledWith(
      setup.connection,
      setup.config,
      setup.request,
      { countryId: COUNTRY_ID, versionId: VERSION_ID, bytesSent: 8n, channel: 'admin' },
    );
    expect(mocks.releaseCountryCacheStreamLock).toHaveBeenCalledOnce();
  });

  it('handles HEAD, conditional 304, zero-byte and non-file responses without recording events', async () => {
    const head = makeSetup({ method: 'HEAD' });
    await head.handler(head.request, head.reply);
    expect(head.code.mock.calls[0]?.[0]).toBe(200);
    expect(head.hijack.mock.calls).toHaveLength(1);
    expect(head.raw.end).toHaveBeenCalledOnce();
    expect(mocks.recordDownloadEvent).not.toHaveBeenCalled();

    const conditional = makeSetup({ headers: { 'if-none-match': `W/"md5:${CHECKSUM}"` } });
    await conditional.handler(conditional.request, conditional.reply);
    expect(conditional.code.mock.calls[0]?.[0]).toBe(304);
    expect(conditional.removeHeader.mock.calls).toContainEqual(['Content-Length']);

    const empty = makeSetup({ fileSize: 0 });
    await empty.handler(empty.request, empty.reply);
    expect(empty.code.mock.calls[0]?.[0]).toBe(200);
    expect(empty.header.mock.calls).toContainEqual(['Content-Length', '0']);

    const directory = makeSetup({ isFile: false });
    await expect(directory.handler(directory.request, directory.reply)).rejects.toMatchObject({
      code: 'VERSION_FILE_MISSING',
    });
  });

  it('maps missing cache files to a safe error and still releases the acquired lock', async () => {
    const missing = Object.assign(new Error('private filesystem path'), { code: 'ENOENT' });
    const setup = makeSetup({ openError: missing });
    await expect(setup.handler(setup.request, setup.reply)).rejects.toMatchObject({
      code: 'VERSION_FILE_MISSING',
      message: 'The cached map file is not available.',
    });
    expect(mocks.recordDownloadEvent).not.toHaveBeenCalled();
    expect(mocks.releaseCountryCacheStreamLock).toHaveBeenCalledWith(setup.connection, COUNTRY_ID);
  });
});
