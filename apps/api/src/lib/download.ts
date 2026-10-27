/**
 * Bounded-memory HTTP range transfer and streaming file verification (`P2-JOB-05`).
 *
 * This utility owns the byte-stream protocol, not source identity or cache path construction. The caller supplies a file
 * handle from the storage boundary, obtains a trusted expected MD5 from the configured source adapter, and decides
 * whether a mutable alias has a validator.
 * It never buffers the complete artifact in memory.
 *
 * @module lib/download
 */

import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

/** Fetch signature narrowed to absolute URLs for deterministic offline tests. */
export type DownloadFetch = (input: URL, init?: RequestInit) => Promise<Response>;
/** Minimal safe file operations required by the byte-stream utility; storage supplies the implementation. */
export interface DownloadFile {
  /** Current size, or zero if absent. */
  size(): Promise<bigint>;
  /** Opens the file using storage-enforced no-follow rules. */
  open(mode: 'read' | 'write' | 'append'): Promise<FileHandle>;
  /** Removes this storage-owned file/link without traversing a symlink. */
  remove(): Promise<void>;
}
/** Injectable low-level write operation; production loops until the entire chunk is written. */
export type DownloadChunkWriter = (handle: FileHandle, bytes: Uint8Array) => Promise<void>;
/** The one progress shape emitted by a streaming transfer. */
export interface DownloadProgressUpdate {
  readonly progressBytes: bigint;
  readonly totalBytes: bigint | null;
  readonly phase: 'downloading';
}

/** Inputs to one resumable HTTP transfer into an already chosen `.part` path. */
export interface StreamDownloadOptions {
  /** Validated absolute upstream URL. */
  readonly url: string;
  /** Caller-owned `.part` file reference supplied by the safe storage module. */
  readonly part: DownloadFile;
  /** Advertised full size, or `null` when unavailable. */
  readonly expectedSize: bigint | null;
  /** Whether the URL is mutable (`latest`) rather than an immutable dated snapshot. */
  readonly mutable: boolean;
  /** Strong ETag or Last-Modified for safe `If-Range`, if available. */
  readonly validator: string | null;
  /** Previously persisted progress floor, preserving worker monotonicity after a restart. */
  readonly progressFloor: bigint;
  /** Cancellation propagated to fetch and response reader. */
  readonly signal: AbortSignal;
  /** Worker progress callback. */
  readonly reportProgress: (update: DownloadProgressUpdate) => Promise<void>;
  /** Injected fetch implementation; defaults to the runtime. */
  readonly fetchImpl?: DownloadFetch;
  /** Low-level writer seam for deterministic ENOSPC tests. */
  readonly writeChunk?: DownloadChunkWriter;
}

/**
 * Streams a source response to `.part`, using Range only when the local prefix is safe to resume.
 *
 * A valid 206 must begin exactly at the local file size and agree with any known full length. If a mutable alias cannot
 * be validated, its partial file is discarded. A 200 after a Range request replaces the old partial body from byte 0.
 * Transport/write failures preserve the partial for a retry; callers remove it for cancellation or integrity failures.
 */
export async function streamDownloadToPart(options: StreamDownloadOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const writeChunk = options.writeChunk ?? writeAll;
  let offset = await options.part.size();
  if (options.mutable && options.validator === null && offset > 0n) {
    await options.part.remove();
    offset = 0n;
  }
  if (options.expectedSize !== null && offset > options.expectedSize) {
    await options.part.remove();
    offset = 0n;
  }
  if (options.expectedSize !== null && offset === options.expectedSize && offset > 0n) return;

  const headers = new Headers({ accept: 'application/octet-stream' });
  if (offset > 0n) {
    headers.set('range', `bytes=${offset.toString()}-`);
    if (options.validator !== null) headers.set('if-range', options.validator);
  }
  const response = await fetchImpl(new URL(options.url), {
    method: 'GET',
    headers,
    signal: options.signal,
  });
  if (offset > 0n && response.status === 200) {
    // If-Range failed or Range was ignored: use this full response as a replacement, not an append.
    try {
      await options.part.remove();
      offset = 0n;
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }
  if (response.status !== (offset > 0n ? 206 : 200)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Source returned an unexpected download status.');
  }
  if (offset > 0n) {
    try {
      validateContentRange(response.headers.get('content-range'), offset, options.expectedSize);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
  }
  if (response.body === null) {
    throw new Error('Source returned an empty download.');
  }

  let target: FileHandle;
  try {
    target = await options.part.open(offset > 0n ? 'append' : 'write');
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    throw error;
  }
  try {
    const reader = response.body.getReader();
    const abortReader = (): void => {
      void reader.cancel(options.signal.reason).catch(() => undefined);
    };
    options.signal.addEventListener('abort', abortReader, { once: true });
    let streamCompleted = false;
    try {
      while (true) {
        assertNotAborted(options.signal);
        const result = await reader.read();
        if (result.done) {
          streamCompleted = true;
          break;
        }
        if (!(result.value instanceof Uint8Array)) {
          throw new Error('Source returned an invalid stream chunk.');
        }
        if (result.value.byteLength === 0) continue;
        await writeChunk(target, result.value);
        offset += BigInt(result.value.byteLength);
        await options.reportProgress({
          progressBytes: maxBigInt(options.progressFloor, offset),
          totalBytes: options.expectedSize,
          phase: 'downloading',
        });
      }
    } finally {
      options.signal.removeEventListener('abort', abortReader);
      if (!streamCompleted) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } finally {
    await target.close();
  }
  if (options.expectedSize !== null && offset !== options.expectedSize) {
    throw new Error('Downloaded file length did not match source metadata.');
  }
}

/** Streams the file through MD5 and counts bytes without materializing it in memory. */
export async function hashFile(
  file: DownloadFile,
  signal: AbortSignal,
): Promise<{ checksum: string; size: bigint }> {
  const handle = await file.open('read');
  try {
    const hash = createHash('md5');
    let size = 0n;
    for await (const chunk of readFileChunks(handle)) {
      assertNotAborted(signal);
      size += BigInt(chunk.byteLength);
      hash.update(chunk);
    }
    return { checksum: hash.digest('hex'), size };
  } finally {
    await handle.close();
  }
}

/** Reads an already safe-opened file in bounded copies. */
async function* readFileChunks(handle: FileHandle): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8Array(128 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.slice(0, bytesRead);
  }
}

export async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error('Filesystem write made no progress.');
    offset += result.bytesWritten;
  }
}

function validateContentRange(
  value: string | null,
  offset: bigint,
  expectedSize: bigint | null,
): void {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value ?? '');
  if (match?.[1] === undefined || BigInt(match[1]) !== offset) {
    throw new Error('Source returned an invalid resume range.');
  }
  if (match[2] === undefined || BigInt(match[2]) < offset) {
    throw new Error('Source returned an invalid resume range.');
  }
  const total = match[3] === undefined || match[3] === '*' ? null : BigInt(match[3]);
  if (
    (expectedSize !== null && total !== expectedSize) ||
    (total !== null && BigInt(match[2]) >= total)
  ) {
    throw new Error('Source returned an inconsistent resume length.');
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Download canceled.');
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
