/** Installs staged administrator uploads as immutable ready map versions (`P4-IMP-03`).
 *
 * @module modules/jobs/import-handler
 */

import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

import { ImportJobPayloadSchema } from '@mapirror/shared';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { AppConfig } from '../../config/env';
import type { Database, Job, JsonValue } from '../../db/schema';
import { withTransaction } from '../../db/transaction';
import { hashFile, writeAll } from '../../lib/download';
import { JobCancellationRequestedError, JobOwnershipLostError } from './cancellation';
import { createCacheStorage, type CacheStorage, type StorageFile } from '../storage/storage';
import { createUploadStorage, type UploadStorage } from '../storage/upload-storage';
import type { JobHandler, JobHandlerContext } from './worker';

const UUID_PATTERN = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const READ_BUFFER_BYTES = 256 * 1024;

/** Optional storage seams let tests exercise failures without replacing the worker contract. */
export interface ImportHandlerOptions {
  /** Roots used for staged uploads and installed cache versions. */
  readonly config: Pick<AppConfig, 'tmpDir' | 'cacheDir'>;
  /** Injectable upload staging boundary. */
  readonly uploadStorage?: UploadStorage;
  /** Injectable cache boundary, including atomic installation. */
  readonly cacheStorage?: CacheStorage;
}

interface ImportSession {
  readonly id: string;
  readonly country_id: string;
  readonly country_slug: string;
  readonly version: string;
  readonly original_name: string;
  readonly temp_path: string;
  readonly size_bytes: string;
  readonly checksum_md5: string | null;
  readonly status: 'received' | 'installing' | 'installed' | 'failed' | 'expired';
  readonly job_id: string | null;
  readonly created_by: string | null;
}

interface ReservedVersion {
  readonly id: string;
  readonly storagePath: string;
}

/**
 * Creates the `import` job handler. It streams the staged file to a private cache part while computing MD5, atomically
 * installs that part, then commits the map-version and upload-session ready state together. The handler owns the staged
 * file only after the session/job relationship has been verified.
 *
 * @param options - Storage roots and optional low-level test seams.
 * @returns A handler suitable for the worker's `import` slot.
 */
export function createImportHandler(options: ImportHandlerOptions): JobHandler {
  const uploads = options.uploadStorage ?? createUploadStorage(options.config.tmpDir);
  const cache = options.cacheStorage ?? createCacheStorage(options.config.cacheDir);

  return async (job, context) => runImport(job, context, uploads, cache);
}

async function runImport(
  job: Job,
  context: JobHandlerContext,
  uploads: UploadStorage,
  cache: CacheStorage,
): Promise<JsonValue> {
  if (job.type !== 'import') throw new TypeError('Import handler received a non-import job.');
  if (!UUID_PATTERN.test(job.id)) throw new TypeError('Job id is not a UUID.');
  const payload = ImportJobPayloadSchema.parse(job.payload);
  const session = await loadImportSession(context.database, payload.uploadId);
  assertSessionMatches(session, job, payload);

  const part = cache.partFile(job.id);
  let target: StorageFile | undefined;
  let versionId: string | undefined;
  let versionReserved = false;
  let targetInstalled = false;
  let finalized = false;
  let checksumMd5: string | undefined;
  let fileSize = BigInt(session.size_bytes);
  let unrecoverableInstalledState = false;

  try {
    if (session.status === 'installed') {
      const existing = await findCompletedImport(context.database, session, job);
      if (existing !== null) {
        versionId = existing.id;
        target = cache.versionFileAt(existing.storage_path);
        versionReserved = true;
        unrecoverableInstalledState = true;
        const completed = await loadCompletedImport(existing, session, cache, context.signal);
        throwIfAborted(context.signal);
        await removeUploadPathForCleanup(
          uploads,
          session.temp_path,
          context,
          job.id,
          'completed import staging',
        );
        throwIfAborted(context.signal);
        return completed;
      }
      unrecoverableInstalledState = true;
      throw new Error('Installed upload session has no matching ready map version.');
    }
    if (session.status !== 'received' && session.status !== 'installing') {
      throw new Error('Import upload session is not eligible for installation.');
    }

    await markSessionInstalling(context.database, session.id, job.id);
    throwIfAborted(context.signal);
    const staged = uploads.fileAt(session.temp_path);
    target = cache.versionFile(
      session.country_slug,
      session.version,
      `upload-${session.id}.osm.pbf`,
    );
    await context.reportProgress({
      progressBytes: 0n,
      totalBytes: fileSize,
      phase: 'verifying',
    });
    const measured = await copyAndHash(staged, part, fileSize, context);
    checksumMd5 = measured.checksumMd5;
    fileSize = measured.sizeBytes;

    if (fileSize <= 0n || fileSize !== BigInt(session.size_bytes)) {
      throw new Error('Staged import size does not match its durable upload metadata.');
    }
    throwIfAborted(context.signal);

    const reserved = await reserveVersion(
      context.database,
      job,
      payload,
      session,
      target,
      checksumMd5,
      fileSize,
    );
    versionId = reserved.id;
    versionReserved = true;
    if (reserved.storagePath !== target.relativePath) {
      throw new Error('Reserved import path does not match the validated cache path.');
    }

    throwIfAborted(context.signal);
    await context.reportProgress({
      progressBytes: fileSize,
      totalBytes: fileSize,
      phase: 'installing',
    });
    await cache.installPart(part, target);
    targetInstalled = true;
    throwIfAborted(context.signal);

    await finalizeVersion(context.database, session, job, versionId, fileSize, checksumMd5);
    finalized = true;

    // A cancellation racing the final transaction is resolved as a cleanup-and-fail, not a succeeded worker job with
    // a live ready row. The cleanup below runs before the worker writes its terminal state.
    throwIfAborted(context.signal);
    await removeUploadForCleanup(staged, context, job.id, 'completed import staging');
    throwIfAborted(context.signal);
    return {
      uploadId: session.id,
      versionId,
      version: session.version,
      sizeBytes: fileSize.toString(),
      checksumMd5,
    };
  } catch (error) {
    const ownershipLost = isOwnershipLost(error, context.signal);
    const canceled = !ownershipLost && isCancellation(error, context.signal);
    const terminal =
      !ownershipLost &&
      (canceled || unrecoverableInstalledState || job.attempts >= job.max_attempts);

    await removeCacheForCleanup(part, context, job.id, 'partial import');
    if (
      target !== undefined &&
      (targetInstalled || (unrecoverableInstalledState && !ownershipLost))
    ) {
      await removeCacheForCleanup(target, context, job.id, 'installed import');
    }
    if (terminal) {
      await removeUploadPathForCleanup(
        uploads,
        session.temp_path,
        context,
        job.id,
        'failed import staging',
      );
    }

    // A lost ownership signal means another worker/reaper owns the durable retry decision; do not mutate its rows.
    if (!ownershipLost) {
      if (versionReserved && versionId !== undefined) {
        await recordVersionFailure(
          context.database,
          session.country_id,
          versionId,
          job.id,
          terminal || finalized || unrecoverableInstalledState,
          canceled,
        );
      }
      if (terminal) {
        await markSessionFailed(context.database, session.id, job.id);
      }
    }
    throw error;
  }
}

async function loadImportSession(
  database: Kysely<Database>,
  uploadId: string,
): Promise<ImportSession> {
  const row = await database
    .selectFrom('upload_sessions as upload')
    .innerJoin('countries as country', 'country.id', 'upload.country_id')
    .select([
      'upload.id',
      'upload.country_id',
      'country.slug as country_slug',
      'upload.version',
      'upload.original_name',
      'upload.temp_path',
      'upload.size_bytes',
      'upload.checksum_md5',
      'upload.status',
      'upload.job_id',
      'upload.created_by',
    ])
    .where('upload.id', '=', uploadId)
    .executeTakeFirst();
  if (row === undefined) throw new Error('Import upload session does not exist.');
  return row;
}

function assertSessionMatches(
  session: ImportSession,
  job: Job,
  payload: ReturnType<typeof ImportJobPayloadSchema.parse>,
): void {
  if (
    session.job_id !== job.id ||
    session.country_id !== payload.countryId ||
    session.version !== payload.version
  ) {
    throw new Error('Import job does not match its durable upload session.');
  }
}

async function markSessionInstalling(
  database: Kysely<Database>,
  uploadId: string,
  jobId: string,
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    const session = await transaction
      .selectFrom('upload_sessions')
      .select(['status', 'job_id'])
      .where('id', '=', uploadId)
      .forUpdate()
      .executeTakeFirst();
    if (session === undefined || session.job_id !== jobId) {
      throw new Error('Import upload session ownership changed.');
    }
    if (session.status === 'received' || session.status === 'installing') {
      await transaction
        .updateTable('upload_sessions')
        .set({ status: 'installing' })
        .where('id', '=', uploadId)
        .where('job_id', '=', jobId)
        .execute();
      return;
    }
    if (session.status !== 'installed') {
      throw new Error('Import upload session is not eligible for installation.');
    }
  });
}

async function findCompletedImport(
  database: Kysely<Database>,
  session: ImportSession,
  job: Job,
): Promise<{
  readonly id: string;
  readonly storage_path: string;
  readonly file_size_bytes: string;
  readonly checksum_md5: string | null;
} | null> {
  const row = await database
    .selectFrom('map_versions')
    .select(['id', 'storage_path', 'file_size_bytes', 'checksum_md5', 'status', 'job_id'])
    .where('country_id', '=', session.country_id)
    .where('version', '=', session.version)
    .executeTakeFirst();
  if (row === undefined || row.status !== 'ready' || row.job_id !== job.id) return null;
  return row;
}

async function loadCompletedImport(
  row: NonNullable<Awaited<ReturnType<typeof findCompletedImport>>>,
  session: ImportSession,
  cache: CacheStorage,
  signal: AbortSignal,
): Promise<JsonValue> {
  const file = cache.versionFileAt(row.storage_path);
  const integrity = await hashFile(file, signal);
  if (
    integrity.size !== BigInt(row.file_size_bytes) ||
    integrity.checksum !== row.checksum_md5 ||
    row.checksum_md5 === null
  ) {
    throw new Error('Previously installed import failed its integrity check.');
  }
  return {
    uploadId: session.id,
    versionId: row.id,
    version: session.version,
    sizeBytes: integrity.size.toString(),
    checksumMd5: integrity.checksum,
  };
}

async function copyAndHash(
  source: ReturnType<UploadStorage['fileAt']>,
  part: StorageFile,
  expectedBytes: bigint,
  context: JobHandlerContext,
): Promise<{ readonly sizeBytes: bigint; readonly checksumMd5: string }> {
  const input = await source.openForRead();
  let output: FileHandle | undefined;
  const digest = createHash('md5');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let totalBytes = 0n;
  try {
    output = await part.open('write');
    for (;;) {
      throwIfAborted(context.signal);
      const result = await input.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead === 0) break;
      totalBytes += BigInt(result.bytesRead);
      if (totalBytes > expectedBytes)
        throw new Error('Staged import exceeds its durable size metadata.');
      const chunk = buffer.subarray(0, result.bytesRead);
      digest.update(chunk);
      await writeAll(output, chunk);
      await context.reportProgress({
        progressBytes: totalBytes,
        totalBytes: expectedBytes,
        phase: 'verifying',
      });
    }
    await output.sync();
  } finally {
    await Promise.all([input.close(), output?.close()]);
  }
  return { sizeBytes: totalBytes, checksumMd5: digest.digest('hex') };
}

async function reserveVersion(
  database: Kysely<Database>,
  job: Job,
  payload: ReturnType<typeof ImportJobPayloadSchema.parse>,
  session: ImportSession,
  target: StorageFile,
  checksumMd5: string,
  fileSize: bigint,
): Promise<ReservedVersion> {
  return withTransaction(database, async (transaction) => {
    const country = await transaction
      .selectFrom('countries')
      .select('id')
      .where('id', '=', payload.countryId)
      .forUpdate()
      .executeTakeFirst();
    if (country === undefined) throw new Error('Import country does not exist.');

    const existing = await transaction
      .selectFrom('map_versions')
      .select(['id', 'status', 'job_id', 'storage_path'])
      .where('country_id', '=', payload.countryId)
      .where('version', '=', payload.version)
      .forUpdate()
      .executeTakeFirst();
    if (existing !== undefined) {
      if (
        existing.job_id !== job.id ||
        (existing.status !== 'pending' && existing.status !== 'failed')
      ) {
        throw new Error('A map version with this country and version already exists.');
      }
      await transaction
        .updateTable('map_versions')
        .set({
          origin: 'upload',
          source_url: null,
          source_filename: session.original_name,
          data_timestamp: null,
          file_size_bytes: fileSize,
          checksum_md5: checksumMd5,
          checksum_sha256: null,
          storage_path: target.relativePath,
          status: 'pending',
          failure_reason: null,
          uploaded_by: session.created_by,
          ready_at: null,
        })
        .where('id', '=', existing.id)
        .execute();
      return { id: existing.id, storagePath: target.relativePath };
    }

    const inserted = await transaction
      .insertInto('map_versions')
      .values({
        country_id: payload.countryId,
        version: payload.version,
        origin: 'upload',
        source_url: null,
        source_filename: session.original_name,
        data_timestamp: null,
        file_size_bytes: fileSize,
        checksum_md5: checksumMd5,
        checksum_sha256: null,
        storage_path: target.relativePath,
        status: 'pending',
        failure_reason: null,
        job_id: job.id,
        uploaded_by: session.created_by,
        ready_at: null,
      })
      .returning(['id', 'storage_path'])
      .executeTakeFirstOrThrow();
    return { id: inserted.id, storagePath: inserted.storage_path };
  });
}

async function finalizeVersion(
  database: Kysely<Database>,
  session: ImportSession,
  job: Job,
  versionId: string,
  fileSize: bigint,
  checksumMd5: string,
): Promise<void> {
  await withTransaction(database, async (transaction) => {
    await transaction
      .selectFrom('countries')
      .select('id')
      .where('id', '=', session.country_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const currentSession = await transaction
      .selectFrom('upload_sessions')
      .select(['status', 'job_id'])
      .where('id', '=', session.id)
      .forUpdate()
      .executeTakeFirst();
    if (
      currentSession === undefined ||
      currentSession.job_id !== job.id ||
      currentSession.status !== 'installing'
    ) {
      throw new Error('Import upload session changed before installation completed.');
    }

    const updated = await transaction
      .updateTable('map_versions')
      .set({
        status: 'ready',
        failure_reason: null,
        file_size_bytes: fileSize,
        checksum_md5: checksumMd5,
        ready_at: sql<Date>`now()`,
      })
      .where('id', '=', versionId)
      .where('job_id', '=', job.id)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (updated === undefined)
      throw new Error('Import version reservation was lost before finalization.');

    await refreshCountryCache(transaction, session.country_id);
    await transaction
      .updateTable('upload_sessions')
      .set({ status: 'installed', checksum_md5: checksumMd5 })
      .where('id', '=', session.id)
      .where('job_id', '=', job.id)
      .execute();
  });
}

async function recordVersionFailure(
  database: Kysely<Database>,
  countryId: string,
  versionId: string,
  jobId: string,
  includeReady: boolean,
  canceled: boolean,
): Promise<void> {
  const safeReason = canceled ? 'CANCELED' : 'IMPORT_FAILED';
  await withTransaction(database, async (transaction) => {
    if (includeReady) {
      await transaction
        .selectFrom('countries')
        .select('id')
        .where('id', '=', countryId)
        .forUpdate()
        .executeTakeFirst();
    }
    const updated = await transaction
      .updateTable('map_versions')
      .set({
        status: 'failed',
        failure_reason: safeReason,
        ready_at: null,
      })
      .where('id', '=', versionId)
      .where('job_id', '=', jobId)
      .where('status', 'in', includeReady ? ['pending', 'ready'] : ['pending'])
      .returning('id')
      .executeTakeFirst();
    if (updated !== undefined && includeReady) {
      await refreshCountryCache(transaction, countryId);
    }
  });
}

async function markSessionFailed(
  database: Kysely<Database>,
  uploadId: string,
  jobId: string,
): Promise<void> {
  await database
    .updateTable('upload_sessions')
    .set({ status: 'failed' })
    .where('id', '=', uploadId)
    .where('job_id', '=', jobId)
    .where('status', 'in', ['received', 'installing', 'installed'])
    .execute();
}

async function refreshCountryCache(
  transaction: Transaction<Database>,
  countryId: string,
): Promise<void> {
  const aggregates = await transaction
    .selectFrom('map_versions')
    .select([
      sql<number>`count(*)::int`.as('versions_ready_count'),
      sql<string>`coalesce(sum(file_size_bytes), 0)::text`.as('total_size_bytes'),
    ])
    .where('country_id', '=', countryId)
    .where('status', '=', 'ready')
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto('country_cache')
    .values({
      country_id: countryId,
      versions_ready_count: aggregates.versions_ready_count,
      total_size_bytes: aggregates.total_size_bytes,
    })
    .onConflict((conflict) =>
      conflict.column('country_id').doUpdateSet({
        versions_ready_count: aggregates.versions_ready_count,
        total_size_bytes: aggregates.total_size_bytes,
        updated_at: sql<Date>`now()`,
      }),
    )
    .execute();
}

async function removeCacheForCleanup(
  file: StorageFile,
  context: JobHandlerContext,
  jobId: string,
  description: string,
): Promise<void> {
  try {
    if (!(await file.remove())) {
      context.log?.warn(
        { jobId, storagePath: file.relativePath },
        `${description} cleanup incomplete; orphan file may remain`,
      );
    }
  } catch (error) {
    context.log?.warn(
      { jobId, storagePath: file.relativePath, err: error },
      `${description} cleanup incomplete; orphan file may remain`,
    );
  }
}

async function removeUploadForCleanup(
  file: ReturnType<UploadStorage['fileAt']>,
  context: JobHandlerContext,
  jobId: string,
  description: string,
): Promise<void> {
  try {
    await file.remove();
  } catch (error) {
    context.log?.warn(
      { jobId, storagePath: file.relativePath, err: error },
      `${description} cleanup incomplete; orphan file may remain`,
    );
  }
}

async function removeUploadPathForCleanup(
  uploads: UploadStorage,
  relativePath: string,
  context: JobHandlerContext,
  jobId: string,
  description: string,
): Promise<void> {
  try {
    await removeUploadForCleanup(uploads.fileAt(relativePath), context, jobId, description);
  } catch (error) {
    context.log?.warn(
      { jobId, err: error },
      `${description} path could not be validated; staging cleanup incomplete`,
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Import job was canceled.');
}

function isOwnershipLost(error: unknown, signal: AbortSignal): boolean {
  return error instanceof JobOwnershipLostError || signal.reason instanceof JobOwnershipLostError;
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    error instanceof JobCancellationRequestedError ||
    (signal !== undefined && signal.reason instanceof JobCancellationRequestedError)
  );
}
