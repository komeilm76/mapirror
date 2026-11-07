import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { OutboundFetch } from '../src/modules/network/outbound-proxy';
import { checkGeofabrikProxy } from '../src/modules/network/proxy-health';

const BASE_URL = 'https://download.geofabrik.de';
const INDEX = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        id: 'europe/finland',
        name: 'Finland',
        urls: { pbf: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf' },
      },
    },
  ],
};
const FINLAND_PAGE = readFileSync(
  new URL('../src/modules/geofabrik/fixtures/finland.html', import.meta.url),
  'utf8',
);

function successfulFetch(
  onRequest?: (url: URL, init: RequestInit | undefined) => void,
): OutboundFetch {
  return (url, init) => {
    onRequest?.(url, init);
    if (url.pathname.endsWith('index-v1-nogeom.json')) {
      return Promise.resolve(Response.json(INDEX, { statusText: 'OK' }));
    }
    if (url.pathname.endsWith('.html')) {
      return Promise.resolve(new Response(FINLAND_PAGE, { status: 200, statusText: 'OK' }));
    }
    if (url.pathname.endsWith('.md5')) {
      return Promise.resolve(
        new Response(`${'a'.repeat(32)}  finland-latest.osm.pbf\n`, {
          status: 200,
          statusText: 'OK',
        }),
      );
    }
    if (init?.method === 'HEAD') {
      return Promise.resolve(new Response(null, { status: 200, statusText: 'OK' }));
    }
    return Promise.resolve(
      new Response(new Uint8Array([0]), {
        status: 206,
        statusText: 'Partial Content',
        headers: { 'content-range': 'bytes 0-0/100' },
      }),
    );
  };
}

describe('Geofabrik proxy health checks', () => {
  it('routes and validates each real outbound operation, reporting status and reason per endpoint', async () => {
    const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const report = await checkGeofabrikProxy({
      baseUrl: BASE_URL,
      proxyEndpoint: 'http://proxy.example.test:8080',
      fetch: successfulFetch((url, init) => requests.push({ url, init })),
      now: () => new Date('2026-11-07T12:00:00.000Z'),
    });

    expect(report.passed).toBe(true);
    expect(report.checkedAt).toBe('2026-11-07T12:00:00.000Z');
    expect(report.proxyUsed).toBe(true);
    expect(report.checks.map(({ id }) => id)).toEqual([
      'geofabrik-index',
      'geofabrik-region-page',
      'geofabrik-pbf-head',
      'geofabrik-md5',
      'geofabrik-pbf-range',
    ]);
    expect(
      report.checks.every(
        ({ status, statusText, reason }) =>
          status !== null && statusText !== null && reason.length > 0,
      ),
    ).toBe(true);
    expect(requests.map(({ init }) => init?.method ?? 'GET')).toEqual([
      'GET',
      'GET',
      'HEAD',
      'GET',
      'GET',
    ]);
    expect(new Headers(requests[4]?.init?.headers).get('range')).toBe('bytes=0-0');
    expect(report.checks[4]?.reason).toContain('one-byte range confirmed');
  });

  it('keeps the actual non-2xx status and HTTP response reason, then continues checking the remaining URLs', async () => {
    const report = await checkGeofabrikProxy({
      baseUrl: BASE_URL,
      proxyEndpoint: null,
      fetch: (url, init) => {
        if (url.pathname.endsWith('index-v1-nogeom.json')) {
          return Promise.resolve(
            new Response('busy', { status: 429, statusText: 'Too Many Requests' }),
          );
        }
        return successfulFetch()(url, init);
      },
    });

    expect(report.passed).toBe(false);
    expect(report.checks[0]).toMatchObject({
      status: 429,
      statusText: 'Too Many Requests',
      passed: false,
      reason: 'HTTP 429 Too Many Requests; expected HTTP 200 and valid catalog JSON.',
    });
    expect(report.checks.slice(1).every(({ passed }) => passed)).toBe(true);
  });

  it('uses a deadline, reports timeout without leaking transport messages, and validates its bound', async () => {
    const report = await checkGeofabrikProxy({
      baseUrl: BASE_URL,
      proxyEndpoint: 'socks5://127.0.0.1:1080',
      timeoutMs: 10,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('sensitive proxy internals', 'AbortError')),
            { once: true },
          );
        }),
    });

    expect(report.passed).toBe(false);
    expect(
      report.checks.every(
        ({ status, reason }) => status === null && reason === 'Request timed out after 10 ms.',
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain('sensitive proxy internals');
    await expect(
      checkGeofabrikProxy({
        baseUrl: BASE_URL,
        proxyEndpoint: null,
        fetch: successfulFetch(),
        timeoutMs: 30_001,
      }),
    ).rejects.toThrow('proxy health-check timeout');
  });

  it('rejects a partial-content status that does not confirm the requested byte range', async () => {
    const report = await checkGeofabrikProxy({
      baseUrl: BASE_URL,
      proxyEndpoint: 'http://proxy.example.test:8080',
      fetch: (url, init) => {
        if (url.pathname.endsWith('.osm.pbf') && init?.method !== 'HEAD') {
          return Promise.resolve(
            new Response(new Uint8Array([0]), {
              status: 206,
              statusText: 'Partial Content',
              headers: { 'content-range': 'bytes 1-1/100' },
            }),
          );
        }
        return successfulFetch()(url, init);
      },
    });

    expect(report.checks[4]).toMatchObject({
      status: 206,
      passed: false,
      reason: 'HTTP 206 did not confirm the requested byte range.',
    });
    expect(report.passed).toBe(false);
  });

  it('accepts an upstream that ignores Range with HTTP 200 while cancelling its large response body', async () => {
    let cancelled = false;
    const fetch: OutboundFetch = (url, init) => {
      if (url.pathname.endsWith('index-v1-nogeom.json'))
        return Promise.resolve(Response.json(INDEX));
      if (url.pathname.endsWith('.html')) return Promise.resolve(new Response(FINLAND_PAGE));
      if (url.pathname.endsWith('.md5'))
        return Promise.resolve(new Response(`${'b'.repeat(32)} file.md5\n`));
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 200 }));
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      });
      return Promise.resolve(new Response(body, { status: 200, statusText: 'OK' }));
    };
    const report = await checkGeofabrikProxy({ baseUrl: BASE_URL, proxyEndpoint: null, fetch });
    expect(report.checks[4]).toMatchObject({ passed: true, status: 200 });
    expect(report.checks[4]?.reason).toContain('range ignored');
    expect(cancelled).toBe(true);
  });
});
