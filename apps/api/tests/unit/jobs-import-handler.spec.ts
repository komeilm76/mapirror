import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { Database, Job } from '../../src/db/schema';
import { JobCancellationRequestedError } from '../../src/modules/jobs/cancellation';
import { createImportHandler } from '../../src/modules/jobs/import-handler';
import type { JobHandlerContext } from '../../src/modules/jobs/worker';
import type { CacheStorage } from '../../src/modules/storage/storage';
import type { UploadStorage } from '../../src/modules/storage/upload-storage';

const mocks = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  hashFile: vi.fn(),
  writeAll: vi.fn(),
}));

vi.mock('kysely', () => ({
  sql: Object.assign(() => ({ as: () => ({}) }), { val: (value: unknown) => value }),
}));
vi.mock('../../src/db/transaction', () => ({ withTransaction: mocks.withTransaction }));
vi.mock('../../src/lib/download', () => ({
  hashFile: mocks.hashFile,
  writeAll: mocks.writeAll,
}));

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const COUNTRY_ID = '00000000-0000-4000-8000-000000000002';
const UPLOAD_ID = '00000000-0000-4000-8000-000000000003';
const BYTES = Buffer.from('pbf!');
const CHECKSUM = createHash('md5').update(BYTES).digest('hex');
const IMPORT_SESSION = {
  id: UPLOAD_ID,
  country_id: COUNTRY_ID,
  country_slug: 'finland',
  version: '20261101',
  original_name: 'finland.osm.pbf',
  temp_path: `${UPLOAD_ID}.osm.pbf`,
  size_bytes: String(BYTES.length),
  checksum_md5: null,
  status: 'received' as const,
  job_id: JOB_ID,
  created_by: 'admin-id',
};

function makeJob(overrides: Partial<Job> = {}): Job {
  const now = new Date('2026-11-01T12:00:00.000Z');
  return {
    id: JOB_ID,
    type: 'import',
    status: 'running',
    priority: 0,
    payload: {
      uploadId: UPLOAD_ID,
      countryId: COUNTRY_ID,
      version: IMPORT_SESSION.version,
      replace: false,
    },
    result: null,
    created_by: 'admin-id',
    created_at: now,
    run_after: now,
    started_at: now,
    finished_at: null,
    locked_by: 'worker-1',
    locked_at: now,
    cancel_requested: false,
    attempts: 1,
    max_attempts: 3,
    progress_bytes: '0',
    total_bytes: String(BYTES.length),
    speed_bps: null,
    phase: null,
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

function makeContext(signal = new AbortController().signal): JobHandlerContext {
  return {
    database: {} as Kysely<Database>,
    signal,
    reportProgress: vi.fn(() => Promise.resolve()),
  };
}

function makeImportSetup(
  session:
    (Omit<typeof IMPORT_SESSION, 'status'> & { readonly status: string }) | null = IMPORT_SESSION,
  completedImport?: {
    readonly id: string;
    readonly storage_path: string;
    readonly file_size_bytes: string;
    readonly checksum_md5: string | null;
    readonly status: string;
    readonly job_id: string;
  },
) {
  const sessionQuery = {
    innerJoin: vi.fn(() => sessionQuery),
    select: vi.fn(() => sessionQuery),
    where: vi.fn(() => sessionQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(session ?? undefined)),
  };
  const completedQuery = {
    select: vi.fn(() => completedQuery),
    where: vi.fn(() => completedQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve(completedImport)),
  };
  const updateQuery = {
    set: vi.fn(() => updateQuery),
    where: vi.fn(() => updateQuery),
    execute: vi.fn(() => Promise.resolve()),
  };
  const database = {
    selectFrom: vi.fn((table: string) =>
      table.startsWith('upload_sessions') ? sessionQuery : completedQuery,
    ),
    updateTable: vi.fn(() => updateQuery),
  } as unknown as Kysely<Database>;
  return { database, sessionQuery, completedQuery, updateQuery };
}

function makeFakeFile(relativePath: string) {
  const input = {
    read: vi.fn((buffer: Buffer, offset: number) => {
      if (input.read.mock.calls.length > 1) return Promise.resolve({ bytesRead: 0, buffer });
      BYTES.copy(buffer, offset);
      return Promise.resolve({ bytesRead: BYTES.length, buffer });
    }),
    close: vi.fn(() => Promise.resolve()),
  };
  const output = {
    sync: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const file = {
    relativePath,
    ensureParent: vi.fn(() => Promise.resolve()),
    size: vi.fn(() => Promise.resolve(BigInt(BYTES.length))),
    open: vi.fn(() => Promise.resolve(output)),
    openForRead: vi.fn(() => Promise.resolve(input)),
    remove: vi.fn(() => Promise.resolve(true)),
  };
  return { file, input, output };
}

function makeTransaction(phase: 'installing' | 'reserve' | 'finalize') {
  const updateQuery = {
    set: vi.fn(() => updateQuery),
    where: vi.fn(() => updateQuery),
    execute: vi.fn(() => Promise.resolve()),
    returning: vi.fn(() => updateQuery),
    executeTakeFirst: vi.fn(() => Promise.resolve({ id: 'version-id' })),
  };
  const insertQuery = {
    values: vi.fn(() => insertQuery),
    returning: vi.fn(() => insertQuery),
    onConflict: vi.fn((callback: (builder: { column: (name: string) => unknown }) => unknown) => {
      callback({ column: () => ({ doUpdateSet: () => undefined }) });
      return insertQuery;
    }),
    execute: vi.fn(() => Promise.resolve()),
    executeTakeFirstOrThrow: vi.fn(() =>
      Promise.resolve({ id: 'version-id', storage_path: 'finland/20261101/upload.osm.pbf' }),
    ),
  };
  const deleteQuery = { where: vi.fn(() => deleteQuery), execute: vi.fn(() => Promise.resolve()) };
  const trx = {
    selectFrom: vi.fn((table: string) => {
      const row =
        table === 'countries'
          ? { id: COUNTRY_ID }
          : table === 'upload_sessions'
            ? phase === 'installing'
              ? { status: 'received', job_id: JOB_ID }
              : { status: 'installing', job_id: JOB_ID }
            : undefined;
      const query = {
        select: vi.fn(() => query),
        where: vi.fn(() => query),
        forUpdate: vi.fn(() => query),
        executeTakeFirst: vi.fn(() => Promise.resolve(row)),
        executeTakeFirstOrThrow: vi.fn(() =>
          Promise.resolve(
            table === 'map_versions'
              ? { versions_ready_count: 1, total_size_bytes: String(BYTES.length) }
              : row,
          ),
        ),
      };
      return query;
    }),
    updateTable: vi.fn(() => updateQuery),
    insertInto: vi.fn(() => insertQuery),
    deleteFrom: vi.fn(() => deleteQuery),
  };
  if (phase === 'reserve') {
    trx.selectFrom = vi.fn((table: string) => {
      const query = {
        select: vi.fn(() => query),
        where: vi.fn(() => query),
        forUpdate: vi.fn(() => query),
        executeTakeFirst: vi.fn(() =>
          Promise.resolve(table === 'countries' ? { id: COUNTRY_ID } : undefined),
        ),
        executeTakeFirstOrThrow: vi.fn(() => Promise.resolve({ id: COUNTRY_ID })),
      };
      return query;
    });
  }
  return { trx, updateQuery, insertQuery, deleteQuery };
}

function makeStorages() {
  const staged = makeFakeFile(IMPORT_SESSION.temp_path);
  const part = makeFakeFile('');
  const target = makeFakeFile('finland/20261101/upload.osm.pbf');
  const uploadStorage = {
    file: vi.fn(() => staged.file),
    fileAt: vi.fn(() => staged.file),
  } as unknown as UploadStorage;
  const installPart = vi.fn(() => Promise.resolve());
  const cacheStorage = {
    listEntries: vi.fn(() => Promise.resolve([])),
    versionFile: vi.fn(() => target.file),
    versionFileAt: vi.fn(() => target.file),
    partFile: vi.fn(() => part.file),
    installPart,
    probeWritable: vi.fn(() => Promise.resolve()),
  } as unknown as CacheStorage;
  return { uploadStorage, cacheStorage, staged, part, target, installPart };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAll.mockResolvedValue(undefined);
  mocks.hashFile.mockResolvedValue({ checksum: CHECKSUM, size: BigInt(BYTES.length) });
});

describe('import job handler', () => {
  it('copies, hashes, installs, finalizes and cleans up a valid staged import', async () => {
    const setup = makeImportSetup();
    const storages = makeStorages();
    const installingTransaction = makeTransaction('installing');
    const reserveTransaction = makeTransaction('reserve');
    const finalizeTransaction = makeTransaction('finalize');
    const transactions = [installingTransaction, reserveTransaction, finalizeTransaction];
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(transactions.shift()?.trx),
    );
    const handler = createImportHandler({
      config: { tmpDir: '/unused/tmp', cacheDir: '/unused/cache' },
      uploadStorage: storages.uploadStorage,
      cacheStorage: storages.cacheStorage,
    });
    const context = { ...makeContext(), database: setup.database };

    await expect(handler(makeJob(), context)).resolves.toEqual({
      uploadId: UPLOAD_ID,
      versionId: 'version-id',
      version: IMPORT_SESSION.version,
      sizeBytes: String(BYTES.length),
      checksumMd5: CHECKSUM,
    });

    expect(setup.sessionQuery.executeTakeFirst).toHaveBeenCalledTimes(1);
    expect(storages.installPart).toHaveBeenCalledWith(storages.part.file, storages.target.file);
    expect(transactions).toHaveLength(0);
    expect(storages.staged.file.remove).toHaveBeenCalledTimes(1);
    expect(storages.part.file.remove).not.toHaveBeenCalled();
    expect(finalizeTransaction.updateQuery.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready', checksum_md5: CHECKSUM }),
    );
    expect(context.reportProgress).toHaveBeenCalledTimes(3);
  });

  it('returns an already installed import only after verifying the ready file', async () => {
    const completed = {
      id: 'version-id',
      storage_path: 'finland/20261101/upload.osm.pbf',
      file_size_bytes: String(BYTES.length),
      checksum_md5: CHECKSUM,
      status: 'ready',
      job_id: JOB_ID,
    };
    const setup = makeImportSetup({ ...IMPORT_SESSION, status: 'installed' }, completed);
    const storages = makeStorages();
    const context = { ...makeContext(), database: setup.database };
    const handler = createImportHandler({
      config: { tmpDir: '/unused/tmp', cacheDir: '/unused/cache' },
      uploadStorage: storages.uploadStorage,
      cacheStorage: storages.cacheStorage,
    });

    await expect(handler(makeJob(), context)).resolves.toEqual({
      uploadId: UPLOAD_ID,
      versionId: 'version-id',
      version: IMPORT_SESSION.version,
      sizeBytes: String(BYTES.length),
      checksumMd5: CHECKSUM,
    });
    expect(mocks.hashFile).toHaveBeenCalledWith(storages.target.file, context.signal);
    expect(storages.staged.file.remove).toHaveBeenCalledTimes(1);
    expect(storages.installPart).not.toHaveBeenCalled();
  });

  it('cleans an unrecoverable installed session that has no corresponding ready version', async () => {
    const setup = makeImportSetup({ ...IMPORT_SESSION, status: 'installed' });
    const storages = makeStorages();
    const context = { ...makeContext(), database: setup.database };
    const handler = createImportHandler({
      config: { tmpDir: '/unused/tmp', cacheDir: '/unused/cache' },
      uploadStorage: storages.uploadStorage,
      cacheStorage: storages.cacheStorage,
    });

    await expect(handler(makeJob(), context)).rejects.toThrow(
      'Installed upload session has no matching ready map version.',
    );
    expect(storages.part.file.remove).toHaveBeenCalledTimes(1);
    expect(storages.staged.file.remove).toHaveBeenCalledTimes(1);
    expect(setup.updateQuery.set).toHaveBeenCalledWith({ status: 'failed' });
  });

  it('marks a terminal size mismatch failed after removing the partial artifact and staging file', async () => {
    const session = { ...IMPORT_SESSION, size_bytes: String(BYTES.length + 1) };
    const setup = makeImportSetup(session);
    const storages = makeStorages();
    const transaction = makeTransaction('installing');
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) =>
        work(transaction.trx),
    );
    const handler = createImportHandler({
      config: { tmpDir: '/unused/tmp', cacheDir: '/unused/cache' },
      uploadStorage: storages.uploadStorage,
      cacheStorage: storages.cacheStorage,
    });

    await expect(
      handler(makeJob({ attempts: 3, max_attempts: 3 }), {
        ...makeContext(),
        database: setup.database,
      }),
    ).rejects.toThrow('Staged import size does not match its durable upload metadata.');
    expect(storages.part.file.remove).toHaveBeenCalledTimes(1);
    expect(storages.staged.file.remove).toHaveBeenCalledTimes(1);
    expect(storages.target.file.remove).not.toHaveBeenCalled();
    expect(setup.updateQuery.set).toHaveBeenCalledWith({ status: 'failed' });
  });

  it('rejects non-import jobs, malformed ids, invalid payloads and absent sessions before installation', async () => {
    const setup = makeImportSetup(null);
    const storages = makeStorages();
    const handler = createImportHandler({
      config: { tmpDir: '/unused/tmp', cacheDir: '/unused/cache' },
      uploadStorage: storages.uploadStorage,
      cacheStorage: storages.cacheStorage,
    });
    const context = { ...makeContext(), database: setup.database };

    await expect(handler(makeJob({ type: 'download' }), context)).rejects.toThrow(
      'Import handler received a non-import job.',
    );
    await expect(handler(makeJob({ id: 'bad-id' }), context)).rejects.toThrow(
      'Job id is not a UUID.',
    );
    await expect(handler(makeJob({ payload: { bad: true } }), context)).rejects.toThrow();
    await expect(handler(makeJob(), context)).rejects.toThrow(
      'Import upload session does not exist.',
    );
    expect(storages.installPart).not.toHaveBeenCalled();
  });

  it('rejects a mismatched upload session and ineligible durable status', async () => {
    const mismatch = makeImportSetup({
      ...IMPORT_SESSION,
      country_id: '00000000-0000-4000-8000-000000000099',
    });
    const ineligible = makeImportSetup({ ...IMPORT_SESSION, status: 'failed' as const });
    const storages = makeStorages();
    const handler = createImportHandler({
      config: { tmpDir: '/unused/tmp', cacheDir: '/unused/cache' },
      uploadStorage: storages.uploadStorage,
      cacheStorage: storages.cacheStorage,
    });

    await expect(
      handler(makeJob(), { ...makeContext(), database: mismatch.database }),
    ).rejects.toThrow('Import job does not match its durable upload session.');
    await expect(
      handler(makeJob(), { ...makeContext(), database: ineligible.database }),
    ).rejects.toThrow('Import upload session is not eligible for installation.');
    expect(storages.installPart).not.toHaveBeenCalled();
  });

  it('cleans up a canceled import before installation and marks its session failed', async () => {
    const setup = makeImportSetup();
    const storages = makeStorages();
    const transaction = makeTransaction('installing');
    mocks.withTransaction.mockImplementation(
      async (_database: unknown, work: (transaction: unknown) => Promise<unknown>) => {
        await work(transaction.trx);
        throw new JobCancellationRequestedError(JOB_ID);
      },
    );
    const handler = createImportHandler({
      config: { tmpDir: '/unused/tmp', cacheDir: '/unused/cache' },
      uploadStorage: storages.uploadStorage,
      cacheStorage: storages.cacheStorage,
    });
    const context = { ...makeContext(), database: setup.database };

    await expect(handler(makeJob(), context)).rejects.toBeInstanceOf(JobCancellationRequestedError);
    expect(storages.part.file.remove).toHaveBeenCalledTimes(1);
    expect(storages.staged.file.remove).toHaveBeenCalledTimes(1);
    expect(storages.installPart).not.toHaveBeenCalled();
  });
});
