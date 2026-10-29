/** Stream one ready version from an explicitly published country and record public events (`P3-API-05/06`).
 *
 * @module modules/public/country-download-route
 */

import type { FileHandle } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { basename } from 'node:path';

import { PublicCountryDownloadQuerySchema, PublicCountryParamsSchema } from '@mapirror/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config/env';
import {
  acquireCountryCacheStreamLock,
  cacheCountryAdvisoryLockKey,
  releaseCountryCacheStreamLock,
} from '../../db/repositories/cache';
import {
  findPublicCountryBySlug,
  findPublicDownloadFile,
} from '../../db/repositories/public-catalog';
import { AppError } from '../../lib/errors';
import { recordDownloadEvent } from '../download-events';
import { createCacheStorage, type StorageFile } from '../storage/storage';

/** Settings required to resolve cache files safely. */
export interface PublicCountryDownloadOptions {
  readonly config: AppConfig;
}

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** Creates the public `GET /countries/:slug/download` stream handler. */
export function createPublicCountryDownloadHandler(options: PublicCountryDownloadOptions) {
  const storage = createCacheStorage(options.config.cacheDir);

  return async function downloadPublicCountryVersion(
    request: FastifyRequest<{ Params: { slug: string }; Querystring: { version?: string } }>,
    reply: FastifyReply,
  ): Promise<void> {
    const params = PublicCountryParamsSchema.safeParse(request.params);
    if (!params.success) throw publicCountryNotFound();
    const parsedQuery = PublicCountryDownloadQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) throw parsedQuery.error;

    const { slug } = params.data;
    const requestedVersion = parsedQuery.data.version ?? 'latest';
    const database = request.server.db.db;
    // Resolve the lock key through the guarded read model. The version row is re-read after taking the lock below:
    // deletion may win between this lookup and lock acquisition, in which case the second lookup returns 404.
    const visibleCountry = await findPublicCountryBySlug(database, slug);
    if (visibleCountry === null) throw publicCountryNotFound();

    const lockKey = cacheCountryAdvisoryLockKey(visibleCountry.country_id);
    await database.connection().execute(async (connection) => {
      let lockHeld = false;
      let fileHandle: FileHandle | undefined;
      let transfer: ReturnType<FileHandle['createReadStream']> | undefined;
      let versionId: string | null = null;
      let bytesSent = 0n;
      let recordEvent = false;
      try {
        await acquireCountryCacheStreamLock(connection, visibleCountry.country_id);
        lockHeld = true;

        const row = await findPublicDownloadFile(connection, slug, requestedVersion);
        if (row === null || row.country_id !== visibleCountry.country_id) {
          throw publicCountryNotFound();
        }
        versionId = row.version_id;

        const file = storage.versionFileAt(row.storage_path);
        fileHandle = await openVersionFile(file);
        const fileInfo = await fileHandle.stat();
        if (!fileInfo.isFile()) throw versionFileMissing();

        const filename = basename(file.relativePath);
        const etag = validMd5(row.checksum_md5) ? `"md5:${row.checksum_md5.toLowerCase()}"` : null;
        const lastModified = row.modified_at.toUTCString();
        const cacheControl =
          requestedVersion === 'latest' ? 'no-cache' : 'public, max-age=31536000, immutable';
        let range = parseByteRange(request.headers.range, fileInfo.size);
        const ifRange = request.headers['if-range'];
        if (
          range !== null &&
          ifRange !== undefined &&
          (typeof ifRange !== 'string' || !matchesIfRange(ifRange, etag, row.modified_at))
        ) {
          range = null;
        }
        const status = range === null ? 200 : 206;
        const selectedRange = range ?? { start: 0, end: Math.max(0, fileInfo.size - 1) };
        const contentLength = fileInfo.size === 0 ? 0 : selectedRange.end - selectedRange.start + 1;

        setHeader(reply, 'Content-Type', 'application/x-protobuf');
        setHeader(reply, 'Content-Disposition', `attachment; filename="${filename}"`);
        setHeader(reply, 'Content-Length', String(contentLength));
        setHeader(reply, 'Accept-Ranges', 'bytes');
        setHeader(reply, 'Last-Modified', lastModified);
        setHeader(reply, 'Cache-Control', cacheControl);
        if (etag !== null) setHeader(reply, 'ETag', etag);
        if (validMd5(row.checksum_md5)) {
          setHeader(reply, 'X-Checksum-Md5', row.checksum_md5.toLowerCase());
        }
        if (range !== null) {
          setHeader(reply, 'Content-Range', `bytes ${range.start}-${range.end}/${fileInfo.size}`);
        }

        if (matchesIfNoneMatch(request.headers['if-none-match'], etag)) {
          removeHeader(reply, 'Content-Length');
          removeHeader(reply, 'Content-Range');
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
            { err: error, slug, version: row.version },
            'public cached map stream failed after response started',
          );
        });
        reply.code(status).send(transfer);
        recordEvent = true;
        await responseClosed;
      } finally {
        transfer?.destroy();
        await fileHandle?.close().catch((error: unknown) => {
          request.log.warn({ err: error, slug }, 'could not close public cached map file handle');
        });
        if (recordEvent && versionId !== null) {
          await recordDownloadEvent(connection, options.config, request, {
            countryId: visibleCountry.country_id,
            versionId,
            bytesSent,
            channel: 'public',
          });
        }
        if (lockHeld) {
          try {
            await releaseCountryCacheStreamLock(connection, visibleCountry.country_id);
          } catch (error) {
            request.log.error(
              { err: error, countryLock: lockKey, slug },
              'could not release public cached map stream lock; connection teardown will release it',
            );
          }
        }
      }
    });
  };
}

/** Opens the validated cache file, returning the documented safe 410 if the leaf has disappeared. */
async function openVersionFile(file: StorageFile): Promise<FileHandle> {
  try {
    return await file.open('read');
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) throw versionFileMissing();
    throw error;
  }
}

/** The same safe response covers a missing row and an unpublished or unknown country. */
function publicCountryNotFound(): AppError {
  return new AppError('NOT_FOUND', 'The requested public country or version does not exist.');
}

/** A ready database row with no usable file is gone from the public representation. */
function versionFileMissing(): AppError {
  return new AppError('VERSION_FILE_MISSING', 'The cached map file is not available.');
}

/** Sets representation headers on both Fastify and the raw response. */
function setHeader(reply: FastifyReply, name: string, value: string): void {
  reply.header(name, value);
  reply.raw.setHeader(name, value);
}

/** Removes a conditional-body header from Fastify and the raw response. */
function removeHeader(reply: FastifyReply, name: string): void {
  reply.removeHeader(name);
  reply.raw.removeHeader(name);
}

/** Ends HEAD and conditional responses without a body, retaining the country lock until close. */
async function sendWithoutBody(reply: FastifyReply, status: number): Promise<void> {
  const responseClosed = waitForResponseClose(reply.raw);
  reply.code(status);
  reply.hijack();
  reply.raw.statusCode = status;
  reply.raw.end();
  await responseClosed;
}

/** Waits for either a complete response or an interrupted client connection. */
function waitForResponseClose(response: ServerResponse): Promise<void> {
  if (response.destroyed) return Promise.resolve();
  return new Promise((resolve) => response.once('close', resolve));
}

/** Parses one satisfiable byte range; unsupported, malformed, and unsatisfiable values fall back to a full response. */
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

/** Implements GET/HEAD If-None-Match weak comparison, including the wildcard without a stored checksum. */
function matchesIfNoneMatch(value: string | undefined, etag: string | null): boolean {
  if (value === undefined) return false;
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .some(
      (candidate) =>
        candidate === '*' || (etag !== null && (candidate === etag || candidate === `W/${etag}`)),
    );
}

/** A weak entity tag never satisfies If-Range; HTTP dates are compared at their wire precision. */
function matchesIfRange(value: string, etag: string | null, lastModified: Date): boolean {
  const candidate = value.trim();
  if (etag !== null && candidate === etag) return true;
  if (candidate.startsWith('W/')) return false;
  const date = Date.parse(candidate);
  return (
    Number.isFinite(date) &&
    new Date(date).toUTCString() === candidate &&
    Math.floor(date / 1000) >= Math.floor(lastModified.getTime() / 1000)
  );
}

/** Treats only a syntactically valid MD5 as an entity tag and checksum header. */
function validMd5(value: string | null): value is string {
  return value !== null && /^[a-f\d]{32}$/iu.test(value);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
