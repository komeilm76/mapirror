/** Offline tests for bounded Geofabrik HEAD and MD5 requests (`P2-SRC-04`). */

import { describe, expect, it } from 'vitest';

import {
  fetchGeofabrikHeadMetadata,
  fetchGeofabrikMd5,
  type GeofabrikFetch,
} from '../src/modules/geofabrik/file-metadata';

const PBF_URL = 'https://download.geofabrik.de/europe/finland-261023.osm.pbf';
const MD5 = '0123456789abcdef0123456789abcdef';

/** A successful HEAD response containing representative Geofabrik headers. */
function headResponse(headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'content-length': '773465008',
      etag: '"geofabrik-etag"',
      'last-modified': 'Fri, 23 Oct 2026 21:00:00 GMT',
      ...headers,
    },
  });
}

describe('fetchGeofabrikHeadMetadata', () => {
  it('sends a bounded HEAD request and returns size and HTTP validators', async () => {
    const calls: {
      url: string;
      method: string | undefined;
      signal: AbortSignal | null | undefined;
    }[] = [];
    const fetchImpl: GeofabrikFetch = (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        signal: init?.signal,
      });
      return Promise.resolve(headResponse());
    };

    const metadata = await fetchGeofabrikHeadMetadata(PBF_URL, { fetchImpl, retryDelayMs: 0 });

    expect(metadata).toEqual({
      sizeBytes: 773_465_008,
      etag: '"geofabrik-etag"',
      lastModified: new Date('2026-10-23T21:00:00.000Z'),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(PBF_URL);
    expect(calls[0]?.method).toBe('HEAD');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('represents missing, malformed, and unsafe headers as null', async () => {
    const fetchImpl: GeofabrikFetch = () =>
      Promise.resolve(
        headResponse({
          'content-length': '9007199254740992',
          etag: ' ',
          'last-modified': 'Mon, 30 Feb 2026 21:00:00 GMT',
        }),
      );

    await expect(fetchGeofabrikHeadMetadata(PBF_URL, { fetchImpl })).resolves.toEqual({
      sizeBytes: null,
      etag: null,
      lastModified: null,
    });
  });

  it('retries a transient HTTP status, but does not retry a permanent 404', async () => {
    let attempts = 0;
    const transientThenOk: GeofabrikFetch = () => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? new Response('busy', { status: 503 }) : headResponse(),
      );
    };

    await expect(
      fetchGeofabrikHeadMetadata(PBF_URL, {
        fetchImpl: transientThenOk,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({ sizeBytes: 773_465_008 });
    expect(attempts).toBe(2);

    attempts = 0;
    const missing: GeofabrikFetch = () => {
      attempts += 1;
      return Promise.resolve(new Response('gone', { status: 404 }));
    };
    await expect(fetchGeofabrikHeadMetadata(PBF_URL, { fetchImpl: missing })).rejects.toThrow(
      'Geofabrik HEAD request failed with HTTP 404',
    );
    expect(attempts).toBe(1);
  });

  it('retries network failures only up to the configured attempt cap', async () => {
    let attempts = 0;
    const unreachable: GeofabrikFetch = () => {
      attempts += 1;
      return Promise.reject(new Error('socket closed'));
    };

    await expect(
      fetchGeofabrikHeadMetadata(PBF_URL, {
        fetchImpl: unreachable,
        maxAttempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('Geofabrik HEAD request failed after 3 attempts');
    expect(attempts).toBe(3);
  });

  it('aborts and settles even when an injected fetch ignores its signal', async () => {
    const signals: AbortSignal[] = [];
    const neverSettles: GeofabrikFetch = (_input, init) => {
      const signal = init?.signal;
      if (signal instanceof AbortSignal) signals.push(signal);
      return new Promise<Response>(() => undefined);
    };

    await expect(
      fetchGeofabrikHeadMetadata(PBF_URL, {
        fetchImpl: neverSettles,
        timeoutMs: 5,
        maxAttempts: 2,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('Geofabrik HEAD request timed out after 2 attempts');
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('settles promptly when the caller aborts a fetch implementation that ignores AbortSignal', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const neverSettles: GeofabrikFetch = (_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    };
    const pending = fetchGeofabrikHeadMetadata(PBF_URL, {
      fetchImpl: neverSettles,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('caller canceled')), 5);

    await expect(pending).rejects.toThrow('caller canceled');
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('rejects unbounded option values and invalid source URLs', async () => {
    const fetchImpl: GeofabrikFetch = () => Promise.resolve(headResponse());

    await expect(
      fetchGeofabrikHeadMetadata(PBF_URL, { fetchImpl, maxAttempts: 6 }),
    ).rejects.toThrow(RangeError);
    await expect(
      fetchGeofabrikHeadMetadata('file:///tmp/secret.pbf', { fetchImpl }),
    ).rejects.toThrow('Geofabrik source URL must be an absolute HTTP(S) URL');
  });
});

describe('fetchGeofabrikMd5', () => {
  it('requests the adjacent sidecar and parses a bare or filename-suffixed digest', async () => {
    const calls: { url: string; method: string | undefined; accept: string | null }[] = [];
    const fetchImpl: GeofabrikFetch = (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        accept: new Headers(init?.headers).get('accept'),
      });
      return Promise.resolve(new Response(`${MD5.toUpperCase()}  finland-261023.osm.pbf\n`));
    };

    await expect(fetchGeofabrikMd5(PBF_URL, { fetchImpl })).resolves.toBe(MD5);
    expect(calls).toEqual([
      {
        url: `${PBF_URL}.md5`,
        method: 'GET',
        accept: 'text/plain',
      },
    ]);
  });

  it('retries transient sidecar failures and rejects malformed checksums without retrying', async () => {
    let attempts = 0;
    const transientThenOk: GeofabrikFetch = () => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1 ? new Response('busy', { status: 429 }) : new Response(MD5),
      );
    };
    await expect(
      fetchGeofabrikMd5(PBF_URL, { fetchImpl: transientThenOk, retryDelayMs: 0 }),
    ).resolves.toBe(MD5);
    expect(attempts).toBe(2);

    attempts = 0;
    const malformed: GeofabrikFetch = () => {
      attempts += 1;
      return Promise.resolve(new Response('not an md5'));
    };
    await expect(
      fetchGeofabrikMd5(PBF_URL, { fetchImpl: malformed, retryDelayMs: 0 }),
    ).rejects.toThrow('Geofabrik MD5 response did not contain a valid checksum');
    expect(attempts).toBe(1);
  });

  it('rejects oversized sidecar bodies instead of buffering arbitrary upstream data', async () => {
    const oversized: GeofabrikFetch = () =>
      Promise.resolve(new Response(`${MD5}  ${'x'.repeat(5_000)}`));

    await expect(
      fetchGeofabrikMd5(PBF_URL, { fetchImpl: oversized, retryDelayMs: 0 }),
    ).rejects.toThrow('Geofabrik MD5 response did not contain a valid checksum');
  });

  it('keeps reading the sidecar body inside the request deadline', async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        canceled = true;
      },
    });
    const response = new Response(body);
    const hangsOnBody: GeofabrikFetch = () => Promise.resolve(response);

    await expect(
      fetchGeofabrikMd5(PBF_URL, {
        fetchImpl: hangsOnBody,
        timeoutMs: 5,
        maxAttempts: 1,
      }),
    ).rejects.toThrow('Geofabrik MD5 request timed out after 1 attempts');
    expect(canceled).toBe(true);
  });

  it('does not echo a private source URL in permanent HTTP errors', async () => {
    const missing: GeofabrikFetch = () => Promise.resolve(new Response('gone', { status: 404 }));

    await expect(
      fetchGeofabrikMd5('https://user:private@mirror.example.org/map.pbf', { fetchImpl: missing }),
    ).rejects.toThrow('Geofabrik MD5 request failed with HTTP 404');
  });
});
