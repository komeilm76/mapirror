import { describe, expect, it } from 'vitest';

import {
  buildPublicDownloadUrl,
  parseContentRange,
  parseDockerMemoryUsage,
} from '../perf-download';

describe('P6-PERF-01 benchmark helpers', () => {
  it('parses Docker memory values with binary and decimal units', () => {
    expect(parseDockerMemoryUsage('1.5GiB / 4GB')).toEqual({
      usedBytes: 1_610_612_736,
      limitBytes: 4_000_000_000,
    });
    expect(parseDockerMemoryUsage('64.5MiB / 1024MiB')).toEqual({
      usedBytes: 67_633_152,
      limitBytes: 1_073_741_824,
    });
  });

  it.each(['12 bytes / 1GiB', 'NaNMiB / 1GiB', '1MiB', '1MiB / 1GiB / 2GiB'])(
    'rejects malformed Docker memory output: %s',
    (value) => {
      expect(() => parseDockerMemoryUsage(value)).toThrow();
    },
  );

  it('constructs the explicit version download URL without leaking query data into its base', () => {
    const url = buildPublicDownloadUrl('http://127.0.0.1:8080', 'country with space', '20261101');
    expect(url.origin).toBe('http://127.0.0.1:8080');
    expect(url.pathname).toBe('/_public/api/countries/country%20with%20space/download');
    expect(url.searchParams.get('version')).toBe('20261101');
  });

  it.each([
    'https://user:secret@example.test',
    'file:///tmp/mapirror',
    'https://example.test/?token=x',
  ])('rejects unsafe benchmark base URLs: %s', (baseUrl) => {
    expect(() => buildPublicDownloadUrl(baseUrl, 'finland', '20261101')).toThrow(
      'BASE_URL must be an HTTP(S) origin',
    );
  });

  it('accepts a complete prefix range and returns the full cached artifact size', () => {
    expect(parseContentRange('bytes 0-2999999999/33000000000')).toEqual({
      endByte: 2_999_999_999,
      totalBytes: 33_000_000_000,
    });
  });

  it.each([null, 'bytes 1-2/3', 'bytes 0-2/2', 'bytes 0-2/99999999999999999'])(
    'rejects a missing or invalid Content-Range: %s',
    (value) => {
      expect(() => parseContentRange(value)).toThrow();
    },
  );
});
