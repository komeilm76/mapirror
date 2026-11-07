/** Bounded probes for every Geofabrik HTTP operation used by the product (`P6-OPS-04`).
 *
 * The range probe requests one byte only and cancels the body immediately; the diagnostic never downloads a map extract.
 * Results retain HTTP status/reason phrases but never echo proxy errors or credentials.
 *
 * @module modules/network/proxy-health
 */

import {
  ProxyHealthReportSchema,
  type ProxyHealthCheck,
  type ProxyHealthReport,
} from '@mapirror/shared';

import { geofabrikRegionPageUrl, geofabrikRegionPbfUrl } from '../geofabrik/region-page-client';
import { parseGeofabrikIndex } from '../geofabrik/index-client';
import { parseGeofabrikRegionPage } from '../geofabrik/region-page';
import type { OutboundFetch } from './outbound-proxy';

const CHECK_TIMEOUT_MS = 5_000;
const INDEX_MAX_BYTES = 8 * 1024 * 1024;
const REGION_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const MD5_MAX_BYTES = 4_096;

interface Probe {
  readonly id: ProxyHealthCheck['id'];
  readonly label: string;
  readonly method: ProxyHealthCheck['method'];
  readonly url: URL;
  readonly expected: string;
  readonly validate?: (response: Response, signal: AbortSignal) => Promise<string | null>;
  readonly headers?: RequestInit['headers'];
  readonly rangeStatus?: boolean;
}

/** Checks all Geofabrik endpoints that the catalog, update checker and download worker use. */
export async function checkGeofabrikProxy(options: {
  readonly baseUrl: string;
  readonly proxyEndpoint: string | null;
  readonly fetch: OutboundFetch;
  readonly now?: () => Date;
  /** Shorter request deadline for deterministic tests; production keeps the five-second default. */
  readonly timeoutMs?: number;
}): Promise<ProxyHealthReport> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError('proxy health-check timeout must be an integer from 1 to 30000 ms');
  }
  const probes = createProbes(options.baseUrl);
  const checks = await Promise.all(
    probes.map((probe) => checkOne(probe, options.fetch, timeoutMs)),
  );
  const report = {
    checkedAt: validNow(options.now ?? (() => new Date())).toISOString(),
    proxyUsed: options.proxyEndpoint !== null,
    endpoint: options.proxyEndpoint,
    passed: checks.every((check) => check.passed),
    checks,
  };
  return ProxyHealthReportSchema.parse(report);
}

function createProbes(baseUrl: string): Probe[] {
  const indexUrl = basePathUrl(baseUrl, 'index-v1-nogeom.json');
  const regionUrl = geofabrikRegionPageUrl(baseUrl, 'europe/finland');
  const pbfUrl = geofabrikRegionPbfUrl(baseUrl, 'europe/finland', 'latest');
  const checksumUrl = new URL(`${pbfUrl.pathname}.md5`, pbfUrl);

  return [
    {
      id: 'geofabrik-index',
      label: 'Geofabrik catalog index',
      method: 'GET',
      url: indexUrl,
      expected: 'HTTP 200 and valid catalog JSON',
      headers: { accept: 'application/json' },
      validate: async (response, signal) => {
        const body = await readBoundedText(response, INDEX_MAX_BYTES, signal);
        try {
          const regions = parseGeofabrikIndex(JSON.parse(body) as unknown);
          return regions.length > 0 ? null : 'Catalog JSON contained no regions.';
        } catch {
          return 'HTTP 200 returned invalid Geofabrik catalog JSON.';
        }
      },
    },
    {
      id: 'geofabrik-region-page',
      label: 'Geofabrik region page',
      method: 'GET',
      url: regionUrl,
      expected: 'HTTP 200 and valid Finland snapshot page',
      headers: { accept: 'text/html' },
      validate: async (response, signal) => {
        const body = await readBoundedText(response, REGION_PAGE_MAX_BYTES, signal);
        try {
          const page = parseGeofabrikRegionPage(body);
          return page.snapshots.length > 0 ? null : 'HTTP 200 page contained no dated snapshots.';
        } catch {
          return 'HTTP 200 returned an invalid Geofabrik region page.';
        }
      },
    },
    {
      id: 'geofabrik-pbf-head',
      label: 'Finland latest PBF metadata',
      method: 'HEAD',
      url: pbfUrl,
      expected: 'HTTP 200',
    },
    {
      id: 'geofabrik-md5',
      label: 'Finland latest MD5 sidecar',
      method: 'GET',
      url: checksumUrl,
      expected: 'HTTP 200 and valid MD5 sidecar',
      headers: { accept: 'text/plain' },
      validate: async (response, signal) => {
        const body = await readBoundedText(response, MD5_MAX_BYTES, signal);
        const line =
          body
            .split(/\r?\n/u)
            .find((item) => item.trim() !== '')
            ?.trim() ?? '';
        return /^[a-f\d]{32}(?:\s+\*?[^\r\n]*)?$/iu.test(line)
          ? null
          : 'HTTP 200 did not contain a valid MD5 checksum.';
      },
    },
    {
      id: 'geofabrik-pbf-range',
      label: 'Finland latest PBF download route',
      method: 'GET',
      url: pbfUrl,
      expected: 'HTTP 206 for a one-byte range (HTTP 200 is accepted if ranges are ignored)',
      headers: { accept: 'application/octet-stream', range: 'bytes=0-0' },
      rangeStatus: true,
    },
  ];
}

function basePathUrl(baseUrl: string, file: string): URL {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/u, '');
  base.pathname = `${prefix}/${file}`;
  base.search = '';
  base.hash = '';
  return base;
}

async function checkOne(
  probe: Probe,
  fetch: OutboundFetch,
  timeoutMs: number,
): Promise<ProxyHealthCheck> {
  const controller = new AbortController();
  const startedAt = performance.now();
  let response: Response | undefined;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    response = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      signal: controller.signal,
    });
    const status = response.status;
    const statusText = cleanStatusText(response.statusText);
    const accepted = probe.rangeStatus === true ? status === 200 || status === 206 : status === 200;
    if (!accepted) {
      await cancelBody(response);
      return result(probe, startedAt, {
        status,
        statusText,
        passed: false,
        reason: `HTTP ${String(status)}${statusText === null ? '' : ` ${statusText}`}; expected ${probe.expected}.`,
      });
    }

    if (probe.rangeStatus === true) {
      const contentRange = response.headers.get('content-range');
      const passed =
        status === 200 || (contentRange !== null && /^bytes 0-0\//u.test(contentRange));
      await cancelBody(response);
      return result(probe, startedAt, {
        status,
        statusText,
        passed,
        reason:
          status === 206 && !passed
            ? 'HTTP 206 did not confirm the requested byte range.'
            : status === 206
              ? `HTTP 206${statusText === null ? '' : ` ${statusText}`}; one-byte range confirmed, response body cancelled.`
              : `HTTP 200${statusText === null ? '' : ` ${statusText}`}; range ignored, response body cancelled immediately.`,
      });
    }

    if (probe.validate !== undefined) {
      const validationReason = await probe.validate(response, controller.signal);
      response = undefined;
      return result(probe, startedAt, {
        status,
        statusText,
        passed: validationReason === null,
        reason:
          validationReason ??
          `HTTP ${String(status)}${statusText === null ? '' : ` ${statusText}`}; response content validated.`,
      });
    }

    await cancelBody(response);
    response = undefined;
    return result(probe, startedAt, {
      status,
      statusText,
      passed: true,
      reason: `HTTP ${String(status)}${statusText === null ? '' : ` ${statusText}`}.`,
    });
  } catch (error) {
    await cancelBody(response);
    const timedOut = controller.signal.aborted;
    return result(probe, startedAt, {
      status: response?.status ?? null,
      statusText: response === undefined ? null : cleanStatusText(response.statusText),
      passed: false,
      reason: timedOut
        ? `Request timed out after ${String(timeoutMs)} ms.`
        : networkFailureReason(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    await cancelBody(response);
    throw new Error('Response exceeded the diagnostic body limit.');
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Response body was empty.');
  const cancelOnAbort = (): void => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array))
        throw new Error('Response stream returned an invalid chunk.');
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Response exceeded the diagnostic body limit.');
      }
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function cancelBody(response: Response | undefined): Promise<void> {
  await response?.body?.cancel().catch(() => undefined);
}

function result(
  probe: Probe,
  startedAt: number,
  outcome: Pick<ProxyHealthCheck, 'status' | 'statusText' | 'passed' | 'reason'>,
): ProxyHealthCheck {
  return {
    id: probe.id,
    label: probe.label,
    method: probe.method,
    url: safeUrl(probe.url),
    expected: probe.expected,
    ...outcome,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

function safeUrl(input: URL): string {
  const url = new URL(input);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

function cleanStatusText(value: string): string | null {
  const clean = [...value]
    .filter((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 200);
  return clean === '' ? null : clean;
}

function networkFailureReason(error: unknown): string {
  const cause = typeof error === 'object' && error !== null ? error : null;
  const code = cause !== null && 'code' in cause ? cause.code : undefined;
  if (typeof code === 'string' && /^[A-Z][A-Z\d_]{1,39}$/u.test(code)) {
    return `Connection failed (${code}); check proxy reachability, firewall rules, and DNS.`;
  }
  const name = error instanceof Error ? error.name : 'UnknownError';
  return `Connection failed (${name}); check proxy reachability, firewall rules, and DNS.`;
}

function validNow(now: () => Date): Date {
  const value = now();
  if (!Number.isFinite(value.getTime()))
    throw new TypeError('proxy health-check clock returned an invalid date');
  return value;
}
