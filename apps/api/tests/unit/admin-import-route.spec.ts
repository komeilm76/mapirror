import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

const mockTransaction = vi.hoisted(() => vi.fn());
vi.mock('../../src/db/transaction', () => ({ withTransaction: mockTransaction }));

import type { FastifyReply, FastifyRequest } from 'fastify';
import { createImportHandler } from '../../src/modules/admin/import-route';
import type { UploadStorage } from '../../src/modules/storage/upload-storage';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_ID = '00000000-0000-4000-8000-000000000002';
const UPLOAD_ID = '00000000-0000-4000-8000-000000000003';
const JOB_ID = '00000000-0000-4000-8000-000000000004';
const VALID_PBF_HEADER = Buffer.from([0, 0, 0, 11, 0x0a, 0x09, ...Buffer.from('OSMHeader')]);

interface MockOptions {
  readonly countryExists?: boolean;
  readonly existingVersion?: { readonly id: string; readonly status: string };
  readonly existingUpload?: { readonly id: string };
  readonly activeDownload?: { readonly id: string };
  readonly maxUploadBytes?: number;
  readonly openError?: Error;
  readonly writeBytes?: number;
}

function field(fieldname: string, value: unknown, overrides: Record<string, unknown> = {}) {
  return { type: 'field', fieldname, value, valueTruncated: false, ...overrides };
}

function filePart(
  overrides: {
    fieldname?: string;
    filename?: string;
    mimetype?: string;
    bytes?: Buffer;
    truncated?: boolean;
  } = {},
) {
  const {
    fieldname = 'file',
    filename = 'finland.osm.pbf',
    mimetype = 'application/octet-stream',
    bytes = VALID_PBF_HEADER,
    truncated = false,
  } = overrides;
  return {
    type: 'file',
    fieldname,
    filename,
    mimetype,
    file: {
      truncated,
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield bytes;
      },
    },
  };
}

function makeSetup(parts: unknown[], options: MockOptions = {}) {
  const fileHandle = {
    write: vi.fn((_chunk: Uint8Array, _offset: number, length: number) => ({
      bytesWritten: Math.min(options.writeBytes ?? length, length),
    })),
    sync: vi.fn(() => undefined),
    close: vi.fn(() => Promise.resolve()),
  };
  const file = {
    relativePath: 'staging-id.osm.pbf',
    openForWrite: vi.fn(() => {
      if (options.openError) throw options.openError;
      return fileHandle;
    }),
    remove: vi.fn(() => Promise.resolve()),
  };
  const storage = { file: vi.fn(() => file) } as unknown as UploadStorage;
  const selectResults: Record<string, unknown> = {
    countries: options.countryExists === false ? undefined : { id: COUNTRY_ID },
    map_versions: options.existingVersion,
    upload_sessions: options.existingUpload,
    jobs: options.activeDownload,
  };
  function queryBuilder(table: string) {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['select', 'where', 'forUpdate', 'values', 'returning', 'set']) {
      builder[method] = vi.fn(() => (builder[method] === undefined ? undefined : builder));
    }
    builder.executeTakeFirst = vi.fn(() => selectResults[table]);
    builder.executeTakeFirstOrThrow = vi.fn(() =>
      table === 'upload_sessions' ? { id: UPLOAD_ID } : { id: JOB_ID },
    );
    builder.execute = vi.fn(() => []);
    return builder;
  }
  const database = {
    selectFrom: vi.fn((table: string) => queryBuilder(table)),
    insertInto: vi.fn((table: string) => queryBuilder(table)),
    updateTable: vi.fn((table: string) => queryBuilder(table)),
  };
  mockTransaction.mockImplementation((_database: unknown, callback: (trx: unknown) => unknown) =>
    callback(database),
  );
  const request = {
    isMultipart: vi.fn(() => true),
    authenticatedAdmin: { id: ADMIN_ID },
    parts: vi.fn(() =>
      (async function* () {
        await Promise.resolve();
        for (const part of parts) yield part;
      })(),
    ),
    server: { db: { db: database } },
    log: { warn: vi.fn() },
  } as unknown as FastifyRequest;
  const replyCode = vi.fn();
  const reply = { code: replyCode } as unknown as FastifyReply;
  const handler = createImportHandler({
    config: { tmpDir: '/tmp', maxUploadBytes: options.maxUploadBytes ?? 1024 } as never,
    uploadStorage: storage,
  });
  return { handler, request, reply, replyCode, file, fileHandle, database };
}

const validFields = () => [
  field('countryId', COUNTRY_ID),
  field('version', '261030'),
  field('replace', 'false'),
];

describe('admin import admission handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires multipart authentication before allocating staging', async () => {
    const notMultipart = makeSetup([]);
    (notMultipart.request as unknown as { isMultipart: () => boolean }).isMultipart = () => false;
    await expect(
      notMultipart.handler(notMultipart.request, notMultipart.reply),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
    expect(notMultipart.file.openForWrite).not.toHaveBeenCalled();

    const unauthenticated = makeSetup([]);
    (unauthenticated.request as unknown as { authenticatedAdmin: null }).authenticatedAdmin = null;
    await expect(
      unauthenticated.handler(unauthenticated.request, unauthenticated.reply),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('streams a valid file, creates the session and job together, and links them', async () => {
    const setup = makeSetup([...validFields(), filePart()]);
    await expect(setup.handler(setup.request, setup.reply)).resolves.toEqual({
      uploadId: UPLOAD_ID,
      jobId: JOB_ID,
      version: '261030',
    });
    expect(setup.replyCode).toHaveBeenCalledWith(202);
    expect(setup.fileHandle.write).toHaveBeenCalledWith(
      VALID_PBF_HEADER,
      0,
      VALID_PBF_HEADER.length,
      null,
    );
    expect(setup.fileHandle.sync).toHaveBeenCalledOnce();
    expect(setup.fileHandle.close).toHaveBeenCalledOnce();
    expect(setup.database.insertInto).toHaveBeenNthCalledWith(1, 'upload_sessions');
    expect(setup.database.insertInto).toHaveBeenNthCalledWith(2, 'jobs');
    expect(setup.database.updateTable).toHaveBeenCalledWith('upload_sessions');
    expect(setup.file.remove).not.toHaveBeenCalled();
  });

  it('accepts a replaceable ready version only when replacement was confirmed', async () => {
    const allowed = makeSetup(
      [...validFields().slice(0, 2), field('replace', 'true'), filePart()],
      { existingVersion: { id: 'version-id', status: 'ready' } },
    );
    await expect(allowed.handler(allowed.request, allowed.reply)).resolves.toMatchObject({
      uploadId: UPLOAD_ID,
    });

    const notConfirmed = makeSetup([...validFields(), filePart()], {
      existingVersion: { id: 'version-id', status: 'ready' },
    });
    await expect(
      notConfirmed.handler(notConfirmed.request, notConfirmed.reply),
    ).rejects.toMatchObject({
      code: 'VERSION_DUPLICATE',
      details: { replaceAllowed: true },
    });
    expect(notConfirmed.file.openForWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['installing version', { existingVersion: { id: 'v', status: 'installing' } }],
    ['duplicate upload', { existingUpload: { id: 'u' } }],
    ['active download', { activeDownload: { id: 'j' } }],
  ])('rejects a conflicting %s before writing the upload', async (_label, options) => {
    const setup = makeSetup([...validFields(), filePart()], options);
    await expect(setup.handler(setup.request, setup.reply)).rejects.toMatchObject({
      code: 'VERSION_DUPLICATE',
    });
    expect(setup.file.openForWrite).not.toHaveBeenCalled();
    expect(setup.database.insertInto).not.toHaveBeenCalled();
  });

  it('rejects unknown countries and malformed or duplicate multipart fields', async () => {
    const missingCountry = makeSetup([...validFields(), filePart()], { countryExists: false });
    await expect(
      missingCountry.handler(missingCountry.request, missingCountry.reply),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const invalidFields = makeSetup([
      field('countryId', 'not-a-uuid'),
      field('version', '261030'),
      field('replace', 'false'),
      filePart(),
    ]);
    await expect(
      invalidFields.handler(invalidFields.request, invalidFields.reply),
    ).rejects.toBeInstanceOf(ZodError);

    const duplicateFields = makeSetup([
      field('countryId', COUNTRY_ID),
      field('version', '261030'),
      field('version', '261031'),
      filePart(),
    ]);
    await expect(
      duplicateFields.handler(duplicateFields.request, duplicateFields.reply),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const truncatedField = makeSetup([
      field('countryId', COUNTRY_ID, { valueTruncated: true }),
      filePart(),
    ]);
    await expect(
      truncatedField.handler(truncatedField.request, truncatedField.reply),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects wrong file fields, invalid names, unsupported media and malformed PBF data', async () => {
    const cases = [
      { fieldname: 'attachment' },
      { filename: 'map.zip' },
      { filename: '' },
      { filename: 'x'.repeat(256) },
      { mimetype: 'text/plain' },
      { bytes: Buffer.from('not PBF') },
    ];
    for (const options of cases) {
      const setup = makeSetup([...validFields(), filePart(options)]);
      await expect(setup.handler(setup.request, setup.reply)).rejects.toBeInstanceOf(Error);
    }

    const noFile = makeSetup(validFields());
    await expect(noFile.handler(noFile.request, noFile.reply)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('cleans staging after size, truncated stream, storage and transaction failures', async () => {
    const oversized = makeSetup([...validFields(), filePart()], { maxUploadBytes: 10 });
    await expect(oversized.handler(oversized.request, oversized.reply)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
    expect(oversized.file.remove).toHaveBeenCalledOnce();

    const truncated = makeSetup([...validFields(), filePart({ truncated: true })]);
    await expect(truncated.handler(truncated.request, truncated.reply)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
    expect(truncated.file.remove).toHaveBeenCalledOnce();

    const diskFull = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const openFailure = makeSetup([...validFields(), filePart()], { openError: diskFull });
    await expect(openFailure.handler(openFailure.request, openFailure.reply)).rejects.toMatchObject(
      {
        code: 'DISK_FULL',
      },
    );

    const failedTransaction = makeSetup([...validFields(), filePart()]);
    mockTransaction.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      failedTransaction.handler(failedTransaction.request, failedTransaction.reply),
    ).rejects.toThrow('db unavailable');
    expect(failedTransaction.file.remove).toHaveBeenCalledOnce();
  });

  it('maps framework multipart limits to safe bad requests and preserves unrelated errors', async () => {
    for (const code of [
      'FST_FILES_LIMIT',
      'FST_FIELDS_LIMIT',
      'FST_PARTS_LIMIT',
      'FST_INVALID_MULTIPART_CONTENT',
      'FST_PROTO_VIOLATION',
    ]) {
      const request = makeSetup([]);
      request.request.parts = vi.fn(() => {
        throw Object.assign(new Error(code), { code });
      });
      await expect(request.handler(request.request, request.reply)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    const unrelated = makeSetup([]);
    const error = new Error('unexpected multipart failure');
    unrelated.request.parts = vi.fn(() => {
      throw error;
    });
    await expect(unrelated.handler(unrelated.request, unrelated.reply)).rejects.toBe(error);
  });
});
