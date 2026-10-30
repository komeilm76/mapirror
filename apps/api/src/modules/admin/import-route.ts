/** Stream and validate an administrator-supplied OSM PBF import (`P4-IMP-02`).
 *
 * @module modules/admin/import-route
 */

import { randomUUID } from 'node:crypto';
import {
  ImportMultipartFieldsSchema,
  ImportResponseSchema,
  type ImportMultipartFields,
  type ImportResponse,
} from '@mapirror/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { FileHandle } from 'node:fs/promises';

import type { AppConfig } from '../../config/env';
import { withTransaction } from '../../db/transaction';
import { AppError } from '../../lib/errors';
import { hasOsmPbfHeader, OSM_PBF_HEADER_PREFIX_BYTES } from '../imports/pbf-header';
import { createUploadStorage, type UploadStorage } from '../storage/upload-storage';
const MAX_FILENAME_LENGTH = 255;
const SUPPORTED_PBF_MIME_TYPES = new Set([
  'application/octet-stream',
  'application/x-protobuf',
  'application/protobuf',
  'application/x-osm-pbf',
]);
const DUPLICATE_UPLOAD_STATUSES = ['received', 'installing'] as const;

/** Dependencies required by the import admission route. */
export interface ImportRouteOptions {
  readonly config: AppConfig;
  readonly uploadStorage?: UploadStorage;
}

/** Creates `POST /_admin/api/imports`, streaming directly into UUID-only staging. */
export function createImportHandler(options: ImportRouteOptions) {
  const storage = options.uploadStorage ?? createUploadStorage(options.config.tmpDir);

  return async function postImport(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ImportResponse> {
    if (!request.isMultipart()) {
      throw new AppError('UNSUPPORTED_FORMAT', 'Send the import as multipart form data.');
    }

    const admin = request.authenticatedAdmin;
    if (admin === null) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

    const stagingId = randomUUID();
    const stagedFile = storage.file(stagingId);
    let fileHandle: FileHandle | undefined;
    let fileCreated = false;
    let databaseCommitted = false;
    let fileCount = 0;
    let totalBytes = 0;
    let prefix = Buffer.alloc(0);
    const rawFields: Record<string, string> = {};
    let metadataPreflighted = false;
    let pendingError: Error | undefined;
    let originalName: string | undefined;

    try {
      const parts = request.parts({
        limits: {
          files: 1,
          fields: 3,
          parts: 4,
          fieldSize: 256,
          fileSize: options.config.maxUploadBytes,
        },
      });

      for await (const part of parts) {
        if (part.type === 'field') {
          if (Object.hasOwn(rawFields, part.fieldname)) {
            pendingError ??= badImportRequest('Each import field may be supplied only once.');
            continue;
          }
          if (typeof part.value !== 'string' || part.valueTruncated) {
            pendingError ??= badImportRequest('Import fields must be short text values.');
            continue;
          }
          rawFields[part.fieldname] = part.value;
          if (
            pendingError === undefined &&
            !metadataPreflighted &&
            rawFields.countryId !== undefined &&
            rawFields.version !== undefined &&
            rawFields.replace !== undefined
          ) {
            try {
              const earlyFields = parseFields(rawFields);
              await assertCountryAndVersion(request, earlyFields);
              metadataPreflighted = true;
            } catch (error) {
              pendingError = mapMultipartError(error);
            }
          }
          continue;
        }

        fileCount += 1;
        const isExpectedFile = fileCount === 1 && part.fieldname === 'file';
        if (!isExpectedFile) {
          pendingError ??= badImportRequest('Provide exactly one file field named file.');
        }
        const validExtension = part.filename.toLowerCase().endsWith('.osm.pbf');
        const mimeType = part.mimetype.split(';', 1)[0]?.trim().toLowerCase() ?? '';
        const validMimeType = SUPPORTED_PBF_MIME_TYPES.has(mimeType);
        if (!validExtension || !validMimeType) {
          pendingError ??= new AppError(
            'UNSUPPORTED_FORMAT',
            'The upload must use the .osm.pbf extension and a supported PBF media type.',
          );
        }
        const validFilename =
          part.filename.length > 0 && part.filename.length <= MAX_FILENAME_LENGTH;
        if (!validFilename) {
          pendingError ??= badImportRequest('The uploaded filename is invalid.');
        }
        if (isExpectedFile && validExtension && validFilename) originalName = part.filename;

        if (isExpectedFile && validExtension && validFilename && pendingError === undefined) {
          try {
            fileHandle = await stagedFile.openForWrite();
            fileCreated = true;
          } catch (error) {
            pendingError = mapMultipartError(error);
          }
        }
        for await (const value of part.file) {
          const chunk = Buffer.from(value);
          if (fileCount === 1) totalBytes += chunk.byteLength;
          if (fileCount === 1 && totalBytes > options.config.maxUploadBytes) {
            pendingError ??= new AppError(
              'FILE_TOO_LARGE',
              'The uploaded file exceeds the configured size limit.',
            );
          }
          if (fileCount === 1 && pendingError === undefined && fileHandle !== undefined) {
            if (prefix.byteLength < OSM_PBF_HEADER_PREFIX_BYTES) {
              const remaining = OSM_PBF_HEADER_PREFIX_BYTES - prefix.byteLength;
              prefix = Buffer.concat([prefix, chunk.subarray(0, remaining)]);
            }
            try {
              await writeChunk(fileHandle, chunk);
            } catch (error) {
              pendingError = mapMultipartError(error);
            }
          }
        }
        if ('truncated' in part.file && part.file.truncated) {
          pendingError ??= new AppError(
            'FILE_TOO_LARGE',
            'The uploaded file exceeds the configured size limit.',
          );
        }
      }

      if (pendingError !== undefined) throw pendingError;
      if (fileCount !== 1 || fileHandle === undefined || originalName === undefined) {
        throw badImportRequest('A file field named file is required.');
      }
      const fields = parseFields(rawFields);
      const filename = originalName;
      if (!metadataPreflighted) await assertCountryAndVersion(request, fields);
      if (!hasOsmPbfHeader(prefix, totalBytes)) {
        throw new AppError('UNSUPPORTED_FORMAT', 'The uploaded file is not a valid OSM PBF file.');
      }
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;

      const accepted = await withTransaction(request.server.db.db, async (trx) => {
        // Serialize same-country admissions so two simultaneous uploads cannot both pass the duplicate check.
        const country = await trx
          .selectFrom('countries')
          .select('id')
          .where('id', '=', fields.countryId)
          .forUpdate()
          .executeTakeFirst();
        if (country === undefined) {
          throw new AppError('NOT_FOUND', 'The requested catalog region does not exist.');
        }

        await assertVersionAvailable(trx, fields.countryId, fields.version, fields.replace);

        const session = await trx
          .insertInto('upload_sessions')
          .values({
            country_id: fields.countryId,
            version: fields.version,
            original_name: filename,
            temp_path: stagedFile.relativePath,
            size_bytes: BigInt(totalBytes),
            status: 'received',
            created_by: admin.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        const job = await trx
          .insertInto('jobs')
          .values({
            type: 'import',
            payload: {
              uploadId: session.id,
              countryId: fields.countryId,
              version: fields.version,
              replace: fields.replace,
            },
            created_by: admin.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await trx
          .updateTable('upload_sessions')
          .set({ job_id: job.id })
          .where('id', '=', session.id)
          .execute();

        return { uploadId: session.id, jobId: job.id };
      });

      databaseCommitted = true;
      reply.code(202);
      return ImportResponseSchema.parse({
        uploadId: accepted.uploadId,
        jobId: accepted.jobId,
        version: fields.version,
      });
    } catch (error) {
      throw mapMultipartError(error);
    } finally {
      if (fileHandle !== undefined) await fileHandle.close().catch(() => undefined);
      if (fileCreated && !databaseCommitted) {
        await stagedFile.remove().catch((error: unknown) => {
          request.log.warn(
            { err: error, stagingId },
            'failed to remove rejected import staging file',
          );
        });
      }
    }
  };
}

async function assertCountryAndVersion(
  request: FastifyRequest,
  fields: ImportMultipartFields,
): Promise<void> {
  const country = await request.server.db.db
    .selectFrom('countries')
    .select('id')
    .where('id', '=', fields.countryId)
    .executeTakeFirst();
  if (country === undefined) {
    throw new AppError('NOT_FOUND', 'The requested catalog region does not exist.');
  }
  await assertVersionAvailable(
    request.server.db.db,
    fields.countryId,
    fields.version,
    fields.replace,
  );
}

async function assertVersionAvailable(
  database: FastifyRequest['server']['db']['db'],
  countryId: string,
  version: string,
  replace: boolean,
): Promise<void> {
  const existingVersion = await database
    .selectFrom('map_versions')
    .select(['id', 'status'])
    .where('country_id', '=', countryId)
    .where('version', '=', version)
    .executeTakeFirst();
  const existingUpload = await database
    .selectFrom('upload_sessions')
    .select('id')
    .where('country_id', '=', countryId)
    .where('version', '=', version)
    .where('status', 'in', [...DUPLICATE_UPLOAD_STATUSES])
    .executeTakeFirst();
  const activeDownload = await database
    .selectFrom('jobs')
    .select('id')
    .where('type', '=', 'download')
    .where('status', 'in', ['queued', 'running'])
    .where(sql<string>`payload ->> 'countryId'`, '=', countryId)
    .where(sql<string>`payload ->> 'version'`, 'in', [version, 'latest'])
    .executeTakeFirst();
  const replaceable =
    existingVersion !== undefined &&
    (existingVersion.status === 'ready' || existingVersion.status === 'failed') &&
    existingUpload === undefined &&
    activeDownload === undefined;
  const existingVersionBlocksRequest = existingVersion !== undefined && !(replace && replaceable);
  if (
    existingVersionBlocksRequest ||
    existingUpload !== undefined ||
    activeDownload !== undefined
  ) {
    throw new AppError(
      'VERSION_DUPLICATE',
      replaceable
        ? 'A version with this label already exists. Confirm replacement and resubmit with replace=true.'
        : 'A version with this label already exists for the selected country.',
      { countryId, version, replaceAllowed: replaceable },
    );
  }
}

function parseFields(rawFields: Record<string, string>): ImportMultipartFields {
  const parsed = ImportMultipartFieldsSchema.safeParse(rawFields);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

async function writeChunk(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten === 0) throw new Error('Upload staging write made no progress.');
    offset += result.bytesWritten;
  }
}

function mapMultipartError(error: unknown): Error {
  if (!(error instanceof Error))
    return new Error('The multipart import request failed.', { cause: error });
  if (isCodedError(error) && (error.code === 'ENOSPC' || error.code === 'EDQUOT')) {
    return new AppError(
      'DISK_FULL',
      'There is not enough disk space to stage this upload.',
      undefined,
      {
        cause: error,
      },
    );
  }
  if (!isCodedError(error)) return error;
  if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
    return new AppError(
      'FILE_TOO_LARGE',
      'The uploaded file exceeds the configured size limit.',
      undefined,
      {
        cause: error,
      },
    );
  }
  if (
    error.code === 'FST_FILES_LIMIT' ||
    error.code === 'FST_FIELDS_LIMIT' ||
    error.code === 'FST_PARTS_LIMIT' ||
    error.code === 'FST_INVALID_MULTIPART_CONTENT' ||
    error.code === 'FST_PROTO_VIOLATION'
  ) {
    return badImportRequest('The multipart import fields are invalid.');
  }
  return error;
}

function isCodedError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

function badImportRequest(message: string): AppError {
  return new AppError('BAD_REQUEST', message);
}
