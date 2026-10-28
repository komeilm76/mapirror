/** Stream one ready cached map version to an authenticated administrator (`P2-API-09`).
 *
 * @module modules/admin/cache-version-download-route
 */

import { createHash, randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { basename } from 'node:path';

import { CacheVersionDeleteParamsSchema } from '@mapirror/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';

import type { AppConfig } from '../../config/env';
import type { Database } from '../../db/schema';
import {
  acquireCountryCacheStreamLock,
  cacheCountryAdvisoryLockKey,
  releaseCountryCacheStreamLock,
} from '../../db/repositories/cache';
import { normaliseIp } from '../../lib/client-ip';
import { AppError } from '../../lib/errors';
import { createCacheStorage, type StorageFile } from '../storage/storage';

/** Validated configuration for an admin version stream. */
export interface CacheVersionDownloadOptions {
  readonly config: AppConfig;
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** Creates the handler for `GET /cache/:countryId/versions/:versionId/download`. */
export function createCacheVersionDownloadHandler(options: CacheVersionDownloadOptions) {
  const storage = createCacheStorage(options.config.cacheDir);

  return async function downloadCachedVersion(
    request: FastifyRequest<{ Params: { countryId: string; versionId: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const params = CacheVersionDeleteParamsSchema.safeParse(request.params);
    if (!params.success) throw params.error;

    const { countryId, versionId } = params.data;
    const database = request.server.db.db;
    const lockKey = cacheCountryAdvisoryLockKey(countryId);

    await database.connection().execute(async (connection) => {
      let lockHeld = false;
      let fileHandle: FileHandle | undefined;
      let transfer: ReturnType<FileHandle['createReadStream']> | undefined;
      let bytesSent = 0n;
      let recordEvent = false;
      try {
        await acquireCountryCacheStreamLock(connection, countryId);
        lockHeld = true;

        const row = await connection
          .selectFrom('countries as c')
          .innerJoin('country_cache as cc', 'cc.country_id', 'c.id')
          .innerJoin('map_versions as mv', 'mv.country_id', 'c.id')
          .select([
            'c.id as country_id',
            'c.slug',
            'mv.id as version_id',
            'mv.storage_path',
            'mv.checksum_md5',
            'mv.file_size_bytes',
            sql<Date>`coalesce(mv.data_timestamp, mv.ready_at, mv.created_at)`.as('modified_at'),
          ])
          .where('c.id', '=', countryId)
          .where('mv.id', '=', versionId)
          .where('mv.status', '=', 'ready')
          .executeTakeFirst();
        if (row === undefined) {
          throw new AppError('NOT_FOUND', 'The requested cached map version does not exist.');
        }

        const file = storage.versionFileAt(row.storage_path);
        fileHandle = await openVersionFile(file, countryId, versionId);
        const fileInfo = await fileHandle.stat();
        if (!fileInfo.isFile()) {
          throw new AppError('VERSION_FILE_MISSING', 'The cached map file is not available.');
        }

        const filename = basename(file.relativePath);
        const etag = validMd5(row.checksum_md5) ? `"md5:${row.checksum_md5.toLowerCase()}"` : null;
        const lastModified = row.modified_at.toUTCString();
        const range = parseByteRange(request.headers.range, fileInfo.size);
        const status = range === null ? 200 : 206;
        const selectedRange = range ?? { start: 0, end: Math.max(0, fileInfo.size - 1) };
        const contentLength = fileInfo.size === 0 ? 0 : selectedRange.end - selectedRange.start + 1;

        setHeader(reply, 'Content-Type', 'application/x-protobuf');
        setHeader(reply, 'Content-Disposition', `attachment; filename="${filename}"`);
        setHeader(reply, 'Content-Length', String(contentLength));
        setHeader(reply, 'Accept-Ranges', 'bytes');
        setHeader(reply, 'Last-Modified', lastModified);
        // Admin can access unpublished data; never let an intermediary cache it as public content.
        setHeader(reply, 'Cache-Control', 'private, no-store');
        if (etag !== null) setHeader(reply, 'ETag', etag);
        if (validMd5(row.checksum_md5))
          setHeader(reply, 'X-Checksum-Md5', row.checksum_md5.toLowerCase());
        if (range !== null) {
          setHeader(reply, 'Content-Range', `bytes ${range.start}-${range.end}/${fileInfo.size}`);
        }

        if (etag !== null && matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
          reply.removeHeader('Content-Length');
          reply.removeHeader('Content-Range');
          reply.raw.removeHeader('Content-Length');
          reply.raw.removeHeader('Content-Range');
          await sendWithoutBody(reply, 304);
          return;
        }

        if (request.method === 'HEAD' || contentLength === 0) {
          await sendWithoutBody(reply, status);
          return;
        }

        const responseClosed = waitForResponseClose(reply.raw);
        transfer = fileHandle.createReadStream({
          start: selectedRange.start,
          end: selectedRange.end,
          autoClose: false,
        });
        transfer.on('data', (chunk: Buffer | string) => {
          bytesSent += BigInt(Buffer.byteLength(chunk));
        });
        transfer.on('error', (error: Error) => {
          request.log.error(
            { err: error, countryId, versionId },
            'cached map stream failed after response started',
          );
        });
        recordEvent = true;
        reply.code(status).send(transfer);
        await responseClosed;
      } finally {
        transfer?.destroy();
        await fileHandle?.close().catch((error: unknown) => {
          request.log.warn(
            { err: error, countryId, versionId },
            'could not close cached map file handle',
          );
        });
        if (recordEvent) {
          await recordDownloadEvent(
            connection,
            options.config,
            request,
            countryId,
            versionId,
            bytesSent,
          );
        }
        if (lockHeld) {
          try {
            await releaseCountryCacheStreamLock(connection, countryId);
          } catch (error) {
            request.log.error(
              { err: error, countryLock: lockKey, countryId, versionId },
              'could not release cached map stream lock; connection teardown will release it',
            );
          }
        }
      }
    });
  };
}

/** Opens the validated cache path, mapping a missing leaf to the documented 410 without exposing its path. */
async function openVersionFile(
  file: StorageFile,
  countryId: string,
  versionId: string,
): Promise<FileHandle> {
  try {
    return await file.open('read');
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
      throw new AppError('VERSION_FILE_MISSING', 'The cached map file is not available.', {
        countryId,
        versionId,
      });
    }
    throw error;
  }
}

/** Loads the configured IP salt or creates the persisted default on the first recorded transfer. */
async function downloadIpHashSalt(
  connection: Kysely<Database>,
  config: AppConfig,
): Promise<string> {
  if (config.ipHashSalt !== undefined) return config.ipHashSalt;

  const readSalt = async (): Promise<string | null> => {
    const setting = await connection
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'privacy.ipHashSalt')
      .executeTakeFirst();
    return typeof setting?.value === 'string' && setting.value.length > 0 ? setting.value : null;
  };

  const existing = await readSalt();
  if (existing !== null) return existing;

  const generatedSalt = randomBytes(32).toString('hex');
  await connection
    .insertInto('settings')
    .values({ key: 'privacy.ipHashSalt', value: JSON.stringify(generatedSalt) })
    .onConflict((conflict) => conflict.column('key').doNothing())
    .execute();
  const persisted = await readSalt();
  if (persisted === null) throw new Error('the persisted download IP hash salt is invalid');
  return persisted;
}

/** Adds the admin-channel transfer record after the response closes; raw IP addresses are never persisted. */
async function recordDownloadEvent(
  connection: Kysely<Database>,
  config: AppConfig,
  request: FastifyRequest,
  countryId: string,
  versionId: string,
  bytesSent: bigint,
): Promise<void> {
  try {
    const ip = normaliseIp(request.ip ?? request.raw.socket.remoteAddress);
    const salt = await downloadIpHashSalt(connection, config);
    const ipHash =
      ip === null ? null : createHash('sha256').update(`${ip}${salt}`, 'utf8').digest('hex');
    const userAgent = request.headers['user-agent'];
    await connection
      .insertInto('download_events')
      .values({
        country_id: countryId,
        version_id: versionId,
        channel: 'admin',
        bytes_sent: bytesSent,
        ip_hash: ipHash,
        user_agent: typeof userAgent === 'string' ? userAgent : null,
      })
      .execute();
  } catch (error) {
    request.log.warn(
      { err: error, countryId, versionId, bytesSent: bytesSent.toString(), channel: 'admin' },
      'could not record completed cached map download',
    );
  }
}

/** Sets headers in Fastify and the raw response so hijacked HEAD/304 paths retain representation metadata. */
function setHeader(reply: FastifyReply, name: string, value: string): void {
  reply.header(name, value);
  reply.raw.setHeader(name, value);
}

/** Handles a HEAD or conditional response without a body and waits for the response to close before releasing the lock. */
async function sendWithoutBody(reply: FastifyReply, status: number): Promise<void> {
  const responseClosed = waitForResponseClose(reply.raw);
  reply.code(status);
  reply.hijack();
  reply.raw.statusCode = status;
  reply.raw.end();
  await responseClosed;
}

/** Waits for either a normal response completion or an interrupted client connection. */
function waitForResponseClose(response: ServerResponse): Promise<void> {
  if (response.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    response.once('close', resolve);
  });
}

/** Parses one supported byte range; malformed, multi-range, or unsatisfiable values are ignored per HTTP semantics. */
function parseByteRange(value: string | undefined, size: number): ByteRange | null {
  if (value === undefined || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value.trim());
  if (match === null) return null;
  const startText = match[1] as string;
  const endText = match[2] as string;
  if (startText === '' && endText === '') return null;

  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText === '' ? size - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** Implements If-None-Match's weak comparison for GET/HEAD. */
function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate === etag || candidate === `W/${etag}`);
}

function validMd5(value: string | null): value is string {
  return value !== null && /^[a-f\d]{32}$/iu.test(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
