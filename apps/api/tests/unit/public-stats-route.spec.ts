import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

const mocks = vi.hoisted(() => ({ getPublicStats: vi.fn() }));
vi.mock('../../src/db/repositories/public-catalog', () => ({
  getPublicStats: mocks.getPublicStats,
}));

import { getPublicStatsResponse } from '../../src/modules/public/stats-route';

function makeRequest(query: unknown = {}) {
  const execute = vi.fn((work: (transaction: object) => Promise<unknown>) => work({}));
  const setIsolationLevel = vi.fn(() => ({ execute }));
  const transaction = vi.fn(() => ({ setIsolationLevel }));
  const request = {
    query,
    server: { db: { db: { transaction } } },
  } as unknown as FastifyRequest;
  const header = vi.fn();
  const reply = { header } as unknown as FastifyReply;
  return { request, reply, transaction, setIsolationLevel, execute, header };
}

beforeEach(() => vi.resetAllMocks());

describe('public stats response', () => {
  it('validates query and runs an aggregate in a repeatable-read transaction', async () => {
    const setup = makeRequest({ unexpected: 'value' });
    await expect(getPublicStatsResponse(setup.request, setup.reply)).rejects.toThrow();
    expect(setup.transaction).not.toHaveBeenCalled();

    const valid = makeRequest();
    mocks.getPublicStats.mockResolvedValue({
      countries: '2',
      total_size_bytes: '600',
      downloads_30d: '3',
      total_downloads: '4',
      last_published_at: new Date('2026-11-01T00:00:00Z'),
    });
    await expect(getPublicStatsResponse(valid.request, valid.reply)).resolves.toEqual({
      countries: 2,
      totalSizeBytes: 600,
      downloads30d: 3,
      totalDownloads: 4,
      lastPublishedAt: '2026-11-01T00:00:00.000Z',
    });
    expect(valid.setIsolationLevel).toHaveBeenCalledWith('repeatable read');
    expect(valid.execute).toHaveBeenCalledOnce();
    expect(mocks.getPublicStats).toHaveBeenCalledOnce();
    expect(valid.header.mock.calls[0]).toEqual(['Cache-Control', 'no-store']);
  });

  it('preserves integers beyond JSON safe precision and serializes absent publication time as null', async () => {
    const setup = makeRequest();
    mocks.getPublicStats.mockResolvedValue({
      countries: '9007199254740992',
      total_size_bytes: '0',
      downloads_30d: '0',
      total_downloads: '0',
      last_published_at: null,
    });
    await expect(getPublicStatsResponse(setup.request, setup.reply)).resolves.toEqual({
      countries: '9007199254740992',
      totalSizeBytes: 0,
      downloads30d: 0,
      totalDownloads: 0,
      lastPublishedAt: null,
    });
  });
});
