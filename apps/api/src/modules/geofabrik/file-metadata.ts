/**
 * Bounded HTTP metadata and checksum requests for Geofabrik PBF files (`P2-SRC-04`, CACHE-1).
 *
 * The module performs only the small HEAD and `.md5` requests; it does not download PBF bodies or write files. Each
 * request has a real deadline, retries are capped, retry delays are bounded, transient statuses are retried, and
 * diagnostics deliberately omit the source URL.
 *
 * @module modules/geofabrik/file-metadata
 */

/** Fetch contract narrowed to absolute URLs so tests can inspect requests without making network calls. */
export type GeofabrikFetch = (input: URL, init?: RequestInit) => Promise<Response>;

/** Injectable HTTP controls; every numeric setting is validated and capped before use. */
export interface GeofabrikRequestOptions {
  /** Fetch implementation; defaults to the runtime's fetch. */
  readonly fetchImpl?: GeofabrikFetch;
  /** Per-request deadline in milliseconds; defaults to 10 seconds and is capped at 30 seconds. */
  readonly timeoutMs?: number;
  /** Total attempts including the first request; defaults to 3 and is capped at 5. */
  readonly maxAttempts?: number;
  /** Base retry delay in milliseconds; defaults to 150 ms and is capped at 2 seconds. */
  readonly retryDelayMs?: number;
  /** Optional caller cancellation; aborts the active request and response-body read promptly. */
  readonly signal?: AbortSignal;
}

/** Parsed response headers for one PBF file. */
export interface GeofabrikFileMetadata {
  /** Content length in bytes, or `null` if absent, malformed, or unsafe to represent. */
  readonly sizeBytes: number | null;
  /** ETag exactly as received, or `null` when absent. */
  readonly etag: string | null;
  /** Validated Last-Modified instant, or `null` when absent or malformed. */
  readonly lastModified: Date | null;
}

/** Resolved limits used for one operation. */
interface ResolvedOptions {
  readonly fetchImpl: GeofabrikFetch;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly signal: AbortSignal | undefined;
}

/** Internal timeout marker, used to distinguish an expired deadline from an ordinary network failure. */
class RequestTimeoutError extends Error {}

/** Internal HTTP status marker; only explicitly transient statuses are retryable. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`HTTP ${String(status)}`);
  }
}

/** A successful HTTP response whose contents cannot satisfy the checksum contract. */
class InvalidChecksumError extends Error {}

/** Validates optional controls and supplies finite defaults. */
function resolveOptions(options: GeofabrikRequestOptions): ResolvedOptions {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 150;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError('Geofabrik timeoutMs must be an integer from 1 to 30000');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new RangeError('Geofabrik maxAttempts must be an integer from 1 to 5');
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 2_000) {
    throw new RangeError('Geofabrik retryDelayMs must be an integer from 0 to 2000');
  }

  return {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs,
    maxAttempts,
    retryDelayMs,
    signal: options.signal,
  };
}

/** Whether HTTP status warrants another bounded attempt. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Sleeps between retries, with exponential growth capped at eight seconds. */
function retryPause(baseMs: number, attempt: number): Promise<void> {
  const delayMs = Math.min(baseMs * 2 ** (attempt - 1), 8_000);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Runs one complete request, including response parsing, under an aborting deadline. */
async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let rejectCaller: ((reason: unknown) => void) | undefined;
  const callerAbort = new Promise<never>((_resolve, reject) => {
    rejectCaller = reject;
  });
  const abortFromCaller = (): void => {
    controller.abort(outerSignal?.reason);
    rejectCaller?.(outerSignal?.reason ?? new Error('Geofabrik request was canceled'));
  };
  if (outerSignal?.aborted === true) abortFromCaller();
  else outerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RequestTimeoutError());
      controller.abort();
    }, timeoutMs);
  });

  try {
    const request = Promise.resolve().then(() => operation(controller.signal));
    return await Promise.race(
      outerSignal === undefined ? [request, timeout] : [request, timeout, callerAbort],
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Sends a request with capped retries for network failures, deadlines, and transient HTTP statuses. */
async function requestWithRetries<T>(
  url: URL,
  method: 'HEAD' | 'GET',
  operationName: 'HEAD' | 'MD5',
  headers: Readonly<Record<string, string>>,
  options: ResolvedOptions,
  readResponse: (response: Response, signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await withDeadline(
        options.timeoutMs,
        async (signal) => {
          const response = await options.fetchImpl(url, { method, headers, signal });
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new HttpStatusError(response.status, isRetryableStatus(response.status));
          }
          return readResponse(response, signal);
        },
        options.signal,
      );
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason ?? error;
      if (error instanceof InvalidChecksumError) {
        throw new Error('Geofabrik MD5 response did not contain a valid checksum');
      }
      if (error instanceof HttpStatusError && !error.retryable) {
        throw new Error(
          `Geofabrik ${operationName} request failed with HTTP ${String(error.status)}`,
        );
      }
      if (attempt === options.maxAttempts) {
        if (error instanceof HttpStatusError) {
          throw new Error(
            `Geofabrik ${operationName} request failed with HTTP ${String(error.status)} after ${String(attempt)} attempts`,
          );
        }
        if (error instanceof RequestTimeoutError) {
          throw new Error(
            `Geofabrik ${operationName} request timed out after ${String(attempt)} attempts`,
          );
        }
        throw new Error(
          `Geofabrik ${operationName} request failed after ${String(attempt)} attempts`,
        );
      }
      await retryPause(options.retryDelayMs, attempt);
    }
  }

  // maxAttempts is validated as a positive integer, so the loop always returns or throws.
  throw new Error(`Geofabrik ${operationName} request exhausted its retry budget`);
}

/** Parses a safe non-negative content length. */
function sizeFromHeader(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value.trim())) return null;
  const size = Number(value.trim());
  return Number.isSafeInteger(size) ? size : null;
}

/** Reads only a small checksum sidecar, limiting memory even if its Content-Length is absent or false. */
async function readMd5Body(response: Response, signal: AbortSignal): Promise<string> {
  const maximumBytes = 4_096;
  const declaredBytes = sizeFromHeader(response.headers.get('content-length'));
  if (declaredBytes !== null && declaredBytes > maximumBytes) throw new InvalidChecksumError();

  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelReader, { once: true });

  try {
    while (true) {
      const readResult: unknown = await reader.read();
      if (typeof readResult !== 'object' || readResult === null) {
        throw new Error('Geofabrik MD5 response stream returned an invalid chunk');
      }
      if ('done' in readResult && readResult.done === true) break;
      if (!('value' in readResult) || !(readResult.value instanceof Uint8Array)) {
        throw new Error('Geofabrik MD5 response stream returned an invalid chunk');
      }
      const chunk = readResult.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new InvalidChecksumError();
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Parses a Last-Modified header into a valid instant. */
function dateFromHeader(value: string | null): Date | null {
  if (value === null || value.trim() === '') return null;
  const normalized = value.trim();
  const date = new Date(normalized);
  // Date parses impossible dates such as February 30 by rolling into March; accept only canonical HTTP-date strings.
  return Number.isNaN(date.getTime()) || date.toUTCString() !== normalized ? null : date;
}

/** Makes a URL without echoing invalid input in a thrown diagnostic. */
function parseSourceUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('invalid protocol');
    return url;
  } catch {
    throw new Error('Geofabrik source URL must be an absolute HTTP(S) URL');
  }
}

/**
 * Fetches PBF size and HTTP validators using `HEAD`.
 *
 * @param pbfUrl - Absolute Geofabrik PBF URL.
 * @param options - Optional bounded HTTP controls and injected fetch implementation.
 * @returns Content length, ETag, and Last-Modified; absent or invalid header values are `null`.
 * @throws When HTTP fails permanently or all bounded attempts fail.
 */
export async function fetchGeofabrikHeadMetadata(
  pbfUrl: string,
  options: GeofabrikRequestOptions = {},
): Promise<GeofabrikFileMetadata> {
  const url = parseSourceUrl(pbfUrl);
  const resolved = resolveOptions(options);

  return requestWithRetries(
    url,
    'HEAD',
    'HEAD',
    { accept: 'application/octet-stream' },
    resolved,
    (response) => {
      const etag = response.headers.get('etag');
      return {
        sizeBytes: sizeFromHeader(response.headers.get('content-length')),
        etag: etag === null || etag.trim() === '' ? null : etag,
        lastModified: dateFromHeader(response.headers.get('last-modified')),
      };
    },
  );
}

/**
 * Fetches and validates the adjacent Geofabrik `.md5` sidecar.
 *
 * Accepts the common `hash  filename` form and a bare 32-hex digest; output is lowercase. The entire body read remains
 * inside the request deadline, and a malformed successful response is not retried as a transient transport failure.
 *
 * @param pbfUrl - Absolute Geofabrik PBF URL; `.md5` is appended to its path.
 * @param options - Optional bounded HTTP controls and injected fetch implementation.
 * @returns The validated 32-character lowercase MD5 digest.
 * @throws When HTTP fails, the sidecar is malformed, or all bounded attempts fail.
 */
export async function fetchGeofabrikMd5(
  pbfUrl: string,
  options: GeofabrikRequestOptions = {},
): Promise<string> {
  const url = parseSourceUrl(pbfUrl);
  url.pathname = `${url.pathname}.md5`;
  url.hash = '';
  const resolved = resolveOptions(options);

  return requestWithRetries(
    url,
    'GET',
    'MD5',
    { accept: 'text/plain' },
    resolved,
    async (response, signal) => {
      const body = await readMd5Body(response, signal);
      const firstLine =
        body
          .split(/\r?\n/u)
          .find((line) => line.trim() !== '')
          ?.trim() ?? '';
      const match = /^([a-f\d]{32})(?:\s+\*?[^\r\n]*)?$/iu.exec(firstLine);
      const checksum = match?.[1];
      if (checksum === undefined) throw new InvalidChecksumError();
      return checksum.toLowerCase();
    },
  );
}
