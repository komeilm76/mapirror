/**
 * Reusable local-only Geofabrik HTTP fixture for API tests (`P2-TST-01`).
 *
 * The server implements the provider's small, observable HTTP surface: index JSON, region HTML, PBF `HEAD`/`GET`, byte
 * ranges, and MD5 sidecars. All payloads are checked-in fixtures or deterministic in-memory bytes; requests never leave
 * loopback. The PBF payload is intentionally tiny because the download handler treats it as an opaque byte stream.
 *
 * @module tests/helpers/geofabrik-fixture-server
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Optional deterministic failure and transfer behavior for a fixture server instance. */
export interface GeofabrikFixtureServerOptions {
  /** HTTP status overrides keyed by URL pathname, e.g. `/europe/finland.html` or a `.osm.pbf` path. */
  readonly statusByPath?: Readonly<Record<string, number>>;
  /** Whether GET requests with a valid Range header receive a partial response. Defaults to `honor`. */
  readonly rangeMode?: 'honor' | 'ignore';
  /** MD5 sidecar overrides keyed by the corresponding PBF pathname; values must be 32 hexadecimal digits. */
  readonly md5ByPath?: Readonly<Record<string, string>>;
}

/** Request details needed to assert resume headers without changing the compact request log. */
export interface GeofabrikFixtureRequest {
  readonly method: string;
  readonly url: string;
  readonly range: string | null;
  readonly ifRange: string | null;
}

/** A running offline Geofabrik fixture with its loopback origin and a request audit trail. */
export interface GeofabrikFixtureServer {
  /** Loopback base URL suitable for `GEOFABRIK_BASE_URL`. */
  readonly baseUrl: string;
  /** HTTP method and URL recorded in arrival order. */
  readonly requests: string[];
  /** Range and If-Range headers for each request, preserving arrival order. */
  readonly requestDetails: GeofabrikFixtureRequest[];
  /** Stops accepting requests and waits for active connections to close. */
  close(): Promise<void>;
}

// Pre-encoded minimal OSM PBF (OSMHeader + empty OSMData), checked in as hex so its bytes do not depend on zlib version.
const PBF_FIXTURE_BYTES = Buffer.from(
  '0000000d0a094f534d486561646572183510291a31789c53e2f32fce0d4ece48cd4dd40d33d0336b6214f34d2cf0cd2c2aca2f5228492d2e5148cbac28292d4a050010610e010000000b0a074f534d44617461180f10031a0b789ce3626400000023000c',
  'hex',
);

/** Returns a defensive copy of the small OSM PBF byte fixture. */
export function getGeofabrikPbfFixture(): Buffer {
  return Buffer.from(PBF_FIXTURE_BYTES);
}

/** MD5 of the fixture, matching the provider's sidecar format. */
export const GEOFABRIK_PBF_FIXTURE_MD5 = createHash('md5').update(PBF_FIXTURE_BYTES).digest('hex');

const PBF_FILES = new Set([
  '/europe-latest.osm.pbf',
  '/europe-261023.osm.pbf',
  '/europe-261016.osm.pbf',
  '/europe/finland-latest.osm.pbf',
  '/europe/finland-261023.osm.pbf',
  '/europe/finland-261016.osm.pbf',
  '/europe/monaco-latest.osm.pbf',
  '/europe/monaco-261022.osm.pbf',
]);

const REGION_PAGES = new Map<string, URL>([
  ['/europe.html', new URL('../../src/modules/geofabrik/fixtures/europe.html', import.meta.url)],
  [
    '/europe/finland.html',
    new URL('../../src/modules/geofabrik/fixtures/finland.html', import.meta.url),
  ],
  [
    '/europe/monaco.html',
    new URL('../../src/modules/geofabrik/fixtures/monaco.html', import.meta.url),
  ],
]);

/**
 * Starts a loopback HTTP server that provides the checked-in Geofabrik pages and a tiny PBF with matching metadata.
 *
 * @param options - Per-path status overrides and range behavior.
 * @returns The local origin, observed requests, and an async cleanup method.
 */
export async function startGeofabrikFixtureServer(
  options: GeofabrikFixtureServerOptions = {},
): Promise<GeofabrikFixtureServer> {
  validateOptions(options);
  const requests: string[] = [];
  const requestDetails: GeofabrikFixtureRequest[] = [];
  const pages = new Map<string, string>();
  let fixtureOrigin = '';
  await Promise.all(
    [...REGION_PAGES].map(async ([path, url]) => {
      pages.set(path, await readFile(url, 'utf8'));
    }),
  );

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    const requestUrl = request.url ?? '/';
    requests.push(`${method} ${requestUrl}`);
    requestDetails.push({
      method,
      url: requestUrl,
      range: typeof request.headers.range === 'string' ? request.headers.range : null,
      ifRange: typeof request.headers['if-range'] === 'string' ? request.headers['if-range'] : null,
    });
    const statusOverrides = options.statusByPath;
    const forcedStatus =
      statusOverrides !== undefined && Object.hasOwn(statusOverrides, pathname)
        ? statusOverrides[pathname]
        : undefined;
    if (forcedStatus !== undefined && forcedStatus !== 200) {
      response.writeHead(forcedStatus, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : 'fixture response override');
      return;
    }

    if (pathname === '/index-v1-nogeom.json' && request.method === 'GET') {
      const index = makeIndex(fixtureOrigin);
      send(response, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(index)));
      return;
    }

    const page = pages.get(pathname);
    if (page !== undefined && request.method === 'GET') {
      send(response, 200, 'text/html; charset=utf-8', Buffer.from(page));
      return;
    }

    if (PBF_FILES.has(pathname)) {
      servePbf(request, response, options.rangeMode ?? 'honor');
      return;
    }

    const pbfPath = pathname.endsWith('.md5') ? pathname.slice(0, -4) : null;
    if (pbfPath !== null && PBF_FILES.has(pbfPath) && request.method === 'GET') {
      const filename = pbfPath.slice(pbfPath.lastIndexOf('/') + 1);
      const checksum = options.md5ByPath?.[pbfPath] ?? GEOFABRIK_PBF_FIXTURE_MD5;
      const sidecar = `${checksum}  ${filename}\n`;
      send(response, 200, 'text/plain; charset=utf-8', Buffer.from(sidecar));
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : 'fixture not found');
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  fixtureOrigin = baseUrl;

  return {
    baseUrl,
    requests,
    requestDetails,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** Starts the fixture, invokes a test callback, and closes the server even when the callback fails. */
export async function withGeofabrikFixtureServer<T>(
  options: GeofabrikFixtureServerOptions,
  run: (fixture: GeofabrikFixtureServer) => Promise<T>,
): Promise<T> {
  const fixture = await startGeofabrikFixtureServer(options);
  try {
    return await run(fixture);
  } finally {
    await fixture.close();
  }
}

function validateOptions(options: GeofabrikFixtureServerOptions): void {
  for (const [pathname, status] of Object.entries(options.statusByPath ?? {})) {
    if (!pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#')) {
      throw new TypeError('fixture status override keys must be URL pathnames');
    }
    if (!Number.isInteger(status) || (status !== 200 && (status < 400 || status > 599))) {
      throw new RangeError(
        'fixture status overrides must be HTTP 200 or an error status from 400 to 599',
      );
    }
  }
  for (const [pathname, checksum] of Object.entries(options.md5ByPath ?? {})) {
    if (!PBF_FILES.has(pathname)) {
      throw new TypeError('fixture MD5 override keys must name a served PBF pathname');
    }
    if (!/^[a-f0-9]{32}$/iu.test(checksum)) {
      throw new TypeError('fixture MD5 overrides must contain exactly 32 hexadecimal digits');
    }
  }
}

function makeIndex(origin: string) {
  const features = [
    {
      id: 'europe',
      parent: null,
      name: 'Europe',
      isoAlpha2: [],
      isoOther: [],
      path: '/europe-latest.osm.pbf',
    },
    {
      id: 'europe/finland',
      parent: 'europe',
      name: 'Finland',
      isoAlpha2: ['FI'],
      isoOther: ['FI-01'],
      path: '/europe/finland-latest.osm.pbf',
    },
    {
      id: 'europe/monaco',
      parent: 'europe',
      name: 'Monaco',
      isoAlpha2: ['MC'],
      isoOther: [],
      path: '/europe/monaco-latest.osm.pbf',
    },
  ];
  return {
    type: 'FeatureCollection',
    features: features.map(({ id, parent, name, isoAlpha2, isoOther, path }) => ({
      type: 'Feature',
      properties: {
        id,
        parent,
        name,
        'iso3166-1:alpha2': isoAlpha2,
        'iso3166-2': isoOther,
        urls: { pbf: `${origin}${path}` },
      },
    })),
  };
}

function servePbf(
  request: IncomingMessage,
  response: ServerResponse,
  rangeMode: 'honor' | 'ignore',
): void {
  const commonHeaders = {
    'accept-ranges': 'bytes',
    etag: '"mapirror-fixture-pbf-v1"',
    'last-modified': 'Fri, 23 Oct 2026 20:20:51 GMT',
  };

  if (request.method === 'HEAD') {
    response.writeHead(200, {
      ...commonHeaders,
      'content-length': String(PBF_FIXTURE_BYTES.byteLength),
    });
    response.end();
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end();
    return;
  }

  const ifRange = request.headers['if-range'];
  const validatorMatches =
    ifRange === undefined ||
    ifRange === commonHeaders.etag ||
    ifRange === commonHeaders['last-modified'];
  const range =
    rangeMode === 'honor' && validatorMatches ? parseRange(request.headers.range) : null;
  if (range === 'invalid') {
    response.writeHead(416, {
      ...commonHeaders,
      'content-range': `bytes */${String(PBF_FIXTURE_BYTES.byteLength)}`,
      'content-length': '0',
    });
    response.end();
    return;
  }
  if (range !== null) {
    const chunk = PBF_FIXTURE_BYTES.subarray(range.start, range.end + 1);
    response.writeHead(206, {
      ...commonHeaders,
      'content-range': `bytes ${String(range.start)}-${String(range.end)}/${String(PBF_FIXTURE_BYTES.byteLength)}`,
      'content-length': String(chunk.byteLength),
      'content-type': 'application/octet-stream',
    });
    response.end(chunk);
    return;
  }

  send(response, 200, 'application/octet-stream', Buffer.from(PBF_FIXTURE_BYTES), commonHeaders);
}

function parseRange(value: string | undefined): { start: number; end: number } | 'invalid' | null {
  if (value === undefined) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value.trim());
  if (match === null) return 'invalid';
  const startText = match[1];
  const endText = match[2];
  if (startText === undefined || endText === undefined) return 'invalid';
  const start = Number(startText);
  const requestedEnd = endText === '' ? PBF_FIXTURE_BYTES.byteLength - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= PBF_FIXTURE_BYTES.byteLength
  ) {
    return 'invalid';
  }
  return { start, end: Math.min(requestedEnd, PBF_FIXTURE_BYTES.byteLength - 1) };
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.byteLength),
    ...headers,
  });
  response.end(body);
}
