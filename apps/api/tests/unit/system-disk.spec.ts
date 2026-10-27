import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { AppError, toErrorEnvelope } from '../../src/lib/errors';
import {
  preflightDownloadSpace,
  readDiskSpace,
  requiredDownloadBytes,
  type DiskSpace,
} from '../../src/modules/system/disk';

describe('download disk preflight', () => {
  it('adds ten percent with upward rounding and preserves unknown lengths as unknown', () => {
    expect(requiredDownloadBytes(null)).toBe(0n);
    expect(requiredDownloadBytes(0)).toBe(0n);
    expect(requiredDownloadBytes(1)).toBe(2n);
    expect(requiredDownloadBytes(10)).toBe(11n);
    expect(requiredDownloadBytes(100n)).toBe(110n);
    expect(requiredDownloadBytes(Number.MAX_SAFE_INTEGER)).toBe(
      (BigInt(Number.MAX_SAFE_INTEGER) * 11n + 9n) / 10n,
    );
  });

  it('allows an exact fit while leaving the configured reserve untouched', async () => {
    const readSpace = vi.fn(() =>
      Promise.resolve<DiskSpace>({ freeBytes: 130n, totalBytes: 1_000n }),
    );

    await expect(preflightDownloadSpace('/cache', 100, 20, readSpace)).resolves.toEqual({
      requiredBytes: 110n,
      freeBytes: 130n,
      reserveBytes: 20n,
    });
    expect(readSpace).toHaveBeenCalledExactlyOnceWith('/cache');
  });

  it('throws the documented 503 DISK_FULL envelope with required, free and shortfall bytes', async () => {
    const readSpace = (): Promise<DiskSpace> =>
      Promise.resolve({ freeBytes: 129n, totalBytes: 1_000n });

    let failure: unknown;
    try {
      await preflightDownloadSpace('/cache', 100, 20, readSpace);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: 'DISK_FULL' });
    const response = toErrorEnvelope(failure, 'request-1');
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'DISK_FULL',
      requestId: 'request-1',
      details: { requiredBytes: 110, freeBytes: 129, reserveBytes: 20, shortfallBytes: 1 },
    });
    expect(response.body.error.message).toContain('short by 1 byte');
  });

  it('requires only the reserve when source size is unknown', async () => {
    const readSpace = (): Promise<DiskSpace> =>
      Promise.resolve({ freeBytes: 20n, totalBytes: 1_000n });

    await expect(preflightDownloadSpace('/cache', null, 20, readSpace)).resolves.toEqual({
      requiredBytes: 0n,
      freeBytes: 20n,
      reserveBytes: 20n,
    });
  });

  it('serializes byte details as decimal strings rather than rounding unsafe JSON integers', async () => {
    const required = requiredDownloadBytes(Number.MAX_SAFE_INTEGER);
    const free = required - 1n;
    const readSpace = (): Promise<DiskSpace> =>
      Promise.resolve({ freeBytes: free, totalBytes: free + 1_000n });

    await expect(
      preflightDownloadSpace('/cache', Number.MAX_SAFE_INTEGER, 0, readSpace),
    ).rejects.toMatchObject({
      details: {
        requiredBytes: required.toString(),
        freeBytes: free.toString(),
        shortfallBytes: 1,
      },
    });
  });

  it('rejects unsafe byte values and malformed filesystem readings instead of approving them', async () => {
    const readSpace = vi.fn(() => Promise.resolve<DiskSpace>({ freeBytes: 10n, totalBytes: 10n }));

    await expect(
      preflightDownloadSpace('/cache', Number.MAX_SAFE_INTEGER + 1, 0, readSpace),
    ).rejects.toThrow('contentLengthBytes must be a non-negative safe integer');
    await expect(preflightDownloadSpace('/cache', 1, -1, readSpace)).rejects.toThrow(
      'reserveBytes must be a non-negative safe integer',
    );
    expect(readSpace).not.toHaveBeenCalled();
    await expect(
      preflightDownloadSpace('/cache', 1, 0, () =>
        Promise.resolve({ freeBytes: 11n, totalBytes: 10n }),
      ),
    ).rejects.toThrow('filesystem capacity must contain non-negative bigint values');
  });

  it('uses only blocks available to the API user, not root-reserved free blocks', async () => {
    const space = await readDiskSpace('/cache', () =>
      Promise.resolve({ bavail: 7n, bfree: 17n, bsize: 4_096n, blocks: 100n }),
    );

    expect(space).toEqual({ freeBytes: 28_672n, totalBytes: 409_600n });
  });

  it('reads bigint free-space values from the cache filesystem', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mapirror-disk-'));
    try {
      const space = await readDiskSpace(directory);
      expect(typeof space.freeBytes).toBe('bigint');
      expect(typeof space.totalBytes).toBe('bigint');
      expect(space.freeBytes).toBeGreaterThan(0n);
      expect(space.totalBytes).toBeGreaterThanOrEqual(space.freeBytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
