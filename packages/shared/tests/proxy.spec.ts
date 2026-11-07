import { describe, expect, it } from 'vitest';

import {
  ProxyApplyRequestSchema,
  ProxyApplyResponseSchema,
  ProxyEndpointSchema,
  ProxyHealthReportSchema,
  ProxyTestRequestSchema,
} from '../src/proxy';

const HEALTH_REPORT = {
  checkedAt: '2026-11-07T12:00:00.000Z',
  proxyUsed: true,
  endpoint: 'http://proxy.example.test:8080',
  passed: true,
  checks: [
    {
      id: 'geofabrik-index',
      label: 'Geofabrik catalog index',
      method: 'GET',
      url: 'https://download.geofabrik.de/index-v1-nogeom.json',
      status: 200,
      statusText: 'OK',
      expected: 'HTTP 200 and valid catalog JSON',
      passed: true,
      reason: 'HTTP 200 OK; response content validated.',
      durationMs: 12,
    },
    {
      id: 'geofabrik-region-page',
      label: 'Geofabrik region page',
      method: 'GET',
      url: 'https://download.geofabrik.de/europe/finland.html',
      status: 200,
      statusText: 'OK',
      expected: 'HTTP 200 and valid Finland snapshot page',
      passed: true,
      reason: 'HTTP 200 OK; response content validated.',
      durationMs: 10,
    },
    {
      id: 'geofabrik-pbf-head',
      label: 'Finland latest PBF metadata',
      method: 'HEAD',
      url: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf',
      status: 200,
      statusText: 'OK',
      expected: 'HTTP 200',
      passed: true,
      reason: 'HTTP 200 OK.',
      durationMs: 8,
    },
    {
      id: 'geofabrik-md5',
      label: 'Finland latest MD5 sidecar',
      method: 'GET',
      url: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf.md5',
      status: 200,
      statusText: 'OK',
      expected: 'HTTP 200 and valid MD5 sidecar',
      passed: true,
      reason: 'HTTP 200 OK; response content validated.',
      durationMs: 9,
    },
    {
      id: 'geofabrik-pbf-range',
      label: 'Finland latest PBF download route',
      method: 'GET',
      url: 'https://download.geofabrik.de/europe/finland-latest.osm.pbf',
      status: 206,
      statusText: 'Partial Content',
      expected: 'HTTP 206 for a one-byte range',
      passed: true,
      reason: 'HTTP 206 Partial Content; one-byte range confirmed, response body cancelled.',
      durationMs: 11,
    },
  ],
} as const;

describe('proxy contracts', () => {
  it.each([
    ['http://proxy.example.test:8080', 'http://proxy.example.test:8080'],
    [' HTTPS://PROXY.EXAMPLE.TEST:443/ ', 'https://proxy.example.test'],
    ['socks5://127.0.0.1:1080', 'socks5://127.0.0.1:1080'],
  ])('normalizes supported endpoint %s', (input, expected) => {
    expect(ProxyEndpointSchema.parse(input)).toBe(expected);
  });

  it.each([
    'proxy.example.test:8080',
    'ftp://proxy.example.test:21',
    'http://user:password@proxy.example.test:8080',
    'http://proxy.example.test:8080/path',
    'http://proxy.example.test:8080/?mode=unsafe',
    'http://proxy.example.test:8080?',
    'http://proxy.example.test:8080#',
    'http://proxy.example.test:0',
    '',
  ])('rejects unsafe or malformed endpoint %s', (input) => {
    expect(ProxyEndpointSchema.safeParse(input).success).toBe(false);
  });

  it('requires an endpoint when applying and allows omitted endpoint only for a current-route test', () => {
    expect(ProxyApplyRequestSchema.safeParse({}).success).toBe(false);
    expect(ProxyApplyRequestSchema.safeParse({ endpoint: 'http://proxy.test:8080' }).success).toBe(
      true,
    );
    expect(ProxyTestRequestSchema.parse({})).toEqual({});
    expect(ProxyTestRequestSchema.safeParse({ endpoint: null }).success).toBe(false);
    expect(
      ProxyTestRequestSchema.safeParse({ endpoint: 'http://proxy.test:8080', extra: true }).success,
    ).toBe(false);
  });

  it('validates complete per-operation diagnostic reports and rejects inconsistent result counts', () => {
    expect(ProxyHealthReportSchema.parse(HEALTH_REPORT).checks).toHaveLength(5);
    expect(
      ProxyHealthReportSchema.safeParse({
        ...HEALTH_REPORT,
        checks: HEALTH_REPORT.checks.slice(0, 4),
      }).success,
    ).toBe(false);
  });

  it('validates only safe applied configuration and health data in mutation responses', () => {
    expect(
      ProxyApplyResponseSchema.safeParse({
        applied: true,
        configuration: { configured: true, endpoint: HEALTH_REPORT.endpoint },
        health: HEALTH_REPORT,
      }).success,
    ).toBe(true);
    expect(
      ProxyApplyResponseSchema.safeParse({
        applied: true,
        configuration: {
          configured: true,
          endpoint: 'http://proxy.test:8080',
          password: 'must-not-be-present',
        },
        health: HEALTH_REPORT,
      }).success,
    ).toBe(false);
  });
});
