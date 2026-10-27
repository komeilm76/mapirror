/**
 * Filesystem capacity measurement and download preflight (`P2-JOB-04`).
 *
 * Uses bytes available to the API's unprivileged process (`bavail`), not all free blocks (`bfree`), and keeps the
 * configured reserve after accounting for a 10% download-size margin. The helper does not create or modify files.
 *
 * @module modules/system/disk
 */

import { statfs } from 'node:fs/promises';

import { AppError } from '../../lib/errors';

/** PostgreSQL and filesystem byte values can exceed JS's exact-number range. */
const MAX_POSTGRES_INT8 = 9_223_372_036_854_775_807n;
const MAX_SAFE_JSON_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

/** Filesystem block counts returned by `statfs`; `bfree` includes blocks reserved for root. */
export interface StatfsSnapshot {
  /** Free blocks available to unprivileged processes. */
  readonly bavail: bigint;
  /** Total free blocks, including those reserved for root; deliberately not used for preflight. */
  readonly bfree: bigint;
  /** Filesystem block size. */
  readonly bsize: bigint;
  /** Total filesystem blocks. */
  readonly blocks: bigint;
}

/** Injectable low-level `statfs` reader. */
export type StatfsReader = (directory: string) => Promise<StatfsSnapshot>;

/** Capacity facts for the filesystem containing the cache directory. */
export interface DiskSpace {
  /** Bytes available to an unprivileged process, excluding blocks reserved for the superuser. */
  readonly freeBytes: bigint;
  /** Total filesystem capacity in bytes. */
  readonly totalBytes: bigint;
}

/** Injectable filesystem reader used to test the capacity boundary without depending on the host disk. */
export type DiskSpaceReader = (directory: string) => Promise<DiskSpace>;

/** Result when a download can proceed without consuming the configured reserve. */
export interface DiskPreflightResult {
  /** Download allocation including the 10% safety margin. */
  readonly requiredBytes: bigint;
  /** Filesystem bytes available at the time of the check. */
  readonly freeBytes: bigint;
  /** Minimum free bytes preserved for other work. */
  readonly reserveBytes: bigint;
}

/**
 * Reads free and total bytes for the filesystem containing `directory`.
 *
 * `bavail` is intentional: `bfree` includes blocks reserved to root, which a non-root API process cannot consume.
 * Bigint mode prevents precision loss on multi-terabyte volumes.
 *
 * @param directory - Existing directory on the cache filesystem.
 * @returns Available and total bytes.
 */
export async function readDiskSpace(
  directory: string,
  readStats: StatfsReader = (path) => statfs(path, { bigint: true }),
): Promise<DiskSpace> {
  validateDirectory(directory);
  const filesystem = await readStats(directory);
  if (filesystem.bsize <= 0n) throw new Error('filesystem reported a non-positive block size');

  return {
    freeBytes: filesystem.bavail > 0n ? filesystem.bavail * filesystem.bsize : 0n,
    totalBytes: filesystem.blocks * filesystem.bsize,
  };
}

/**
 * Calculates a download allocation with the architecture's 10% safety margin, rounding up to a whole byte.
 *
 * A missing content length yields zero known transfer bytes; the caller still preserves the reserve. The download
 * handler must handle an unknown or incorrect upstream length while streaming.
 *
 * @param contentLengthBytes - Known source length, or `null` when upstream metadata is unavailable.
 * @returns Required bytes including the safety margin.
 */
export function requiredDownloadBytes(contentLengthBytes: number | bigint | null): bigint {
  if (contentLengthBytes === null) return 0n;
  const contentLength = toNonNegativeInt8(contentLengthBytes, 'contentLengthBytes');
  return (contentLength * 11n + 9n) / 10n;
}

/**
 * Refuses a download when its padded allocation would consume the disk reserve.
 *
 * The predicate is `freeBytes >= requiredBytes + reserveBytes`; equality is safe. A failed preflight throws the
 * documented `503 DISK_FULL` `AppError` with JSON-safe `requiredBytes` and `freeBytes` details, plus the reserve and
 * shortfall. Integers larger than JavaScript's safe JSON range are encoded as decimal strings rather than rounded.
 *
 * @param directory - Existing cache directory whose filesystem will hold the artifact.
 * @param contentLengthBytes - Expected source length, or `null` when unknown.
 * @param reserveBytes - Configured free-space floor, in bytes.
 * @param readSpace - Injectable capacity reader; defaults to {@link readDiskSpace}.
 * @returns The measured and required byte counts when the request fits.
 * @throws {AppError} With code `DISK_FULL` when the transfer plus reserve do not fit.
 */
export async function preflightDownloadSpace(
  directory: string,
  contentLengthBytes: number | bigint | null,
  reserveBytes: number | bigint,
  readSpace: DiskSpaceReader = readDiskSpace,
): Promise<DiskPreflightResult> {
  validateDirectory(directory);
  const requiredBytes = requiredDownloadBytes(contentLengthBytes);
  const reserve = toNonNegativeInt8(reserveBytes, 'reserveBytes');
  const space = await readSpace(directory);
  validateDiskSpace(space);

  const shortfallBytes = requiredBytes + reserve - space.freeBytes;
  if (shortfallBytes > 0n) {
    throw new AppError(
      'DISK_FULL',
      `Insufficient disk space: the download needs ${requiredBytes} bytes and ${reserve} bytes must remain reserved; ${space.freeBytes} bytes are available (short by ${shortfallBytes} ${shortfallBytes === 1n ? 'byte' : 'bytes'}).`,
      {
        requiredBytes: toJsonBytes(requiredBytes),
        freeBytes: toJsonBytes(space.freeBytes),
        reserveBytes: toJsonBytes(reserve),
        shortfallBytes: toJsonBytes(shortfallBytes),
      },
    );
  }

  return { requiredBytes, freeBytes: space.freeBytes, reserveBytes: reserve };
}

/** Rejects invalid directory arguments before touching the filesystem. */
function validateDirectory(directory: string): void {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new TypeError('cache directory must be a non-empty path');
  }
}

/** Converts an accepted byte value to a non-negative PostgreSQL int8. */
function toNonNegativeInt8(value: number | bigint, name: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_POSTGRES_INT8) {
      throw new RangeError(`${name} must fit a non-negative PostgreSQL bigint`);
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

/** Validates injected capacity facts so a malformed reader cannot accidentally approve a download. */
function validateDiskSpace(space: DiskSpace): void {
  if (
    typeof space.freeBytes !== 'bigint' ||
    typeof space.totalBytes !== 'bigint' ||
    space.freeBytes < 0n ||
    space.totalBytes < 0n ||
    space.freeBytes > space.totalBytes
  ) {
    throw new RangeError(
      'filesystem capacity must contain non-negative bigint values with freeBytes <= totalBytes',
    );
  }
}

/** Encodes potentially large integers for JSON without precision loss or unsupported bigint values. */
function toJsonBytes(value: bigint): number | string {
  return value <= MAX_SAFE_JSON_INTEGER ? Number(value) : value.toString();
}
