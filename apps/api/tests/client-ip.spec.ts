import { describe, expect, it } from 'vitest';

import { isIpAddress, normaliseIp } from '../src/lib/client-ip';

/**
 * Regression test for the review finding behind `lib/client-ip.ts`: `request.ip` is an **untrusted string**, and the
 * `inet` columns it feeds raise `22P02` for anything that is not an address — measured, which is how `POST
 * /_auth/api/login` would have answered `500` to a request that sent `X-Forwarded-For: not-an-ip`.
 *
 * The table is the point. Each row is a value that either arrives in production (a proxy appending a port, an IPv6
 * literal in brackets, a bare address) or does not and must not be stored (a script tag, a hostname, an empty header,
 * a whole comma-joined chain).
 */

/** Every case, as `[input, expected]`. Expected `null` means "not an address, store nothing". */
const CASES: readonly (readonly [string | null | undefined, string | null])[] = [
  // Acceptable, unchanged.
  ['203.0.113.9', '203.0.113.9'],
  ['2001:db8::1', '2001:db8::1'],
  ['::1', '::1'],
  [' 203.0.113.9 ', '203.0.113.9'],
  // Port-bearing forms real proxies emit: the address is kept, the port dropped.
  ['203.0.113.9:8080', '203.0.113.9'],
  ['203.0.113.9:65535', '203.0.113.9'],
  ['[2001:db8::1]:443', '2001:db8::1'],
  // Rejected: not addresses.
  ['not-an-ip', null],
  ['<script>alert(1)</script>', null],
  ['example.com', null],
  ['localhost', null],
  ['', null],
  ['   ', null],
  [null, null],
  [undefined, null],
  // A whole chain is not one address: the caller must pass the resolved value, not the header.
  ['203.0.113.9, 198.51.100.7', null],
  // A port-shaped suffix of 1–5 digits is discarded without being range-checked — the number is never stored, so a
  // proxy that emits a nonsense port still gives us the address. A bracketed *IPv4* is not a thing, so that is refused.
  ['203.0.113.9:99999', '203.0.113.9'],
  ['[203.0.113.9]:443', null],
  // An address-looking string with something appended is not the address.
  ['203.0.113.9/24', null],
  ['203.0.113.9;drop', null],
  // Half-formed port forms: a bracket that never closes, a bracket with no port, a port that is not a number, and a
  // host that is a name rather than an address.
  ['[2001:db8::1', null],
  ['[2001:db8::1]', null],
  ['203.0.113.9:http', null],
  ['example.com:8080', null],
  // Longer than any address form: refused before parsing, so a megabyte header costs nothing.
  ['2'.repeat(70), null],
];

describe('normaliseIp', () => {
  it.each(CASES)('maps %j to %j', (input, expected) => {
    expect(normaliseIp(input)).toBe(expected);
  });

  it('never returns something PostgreSQL would refuse', () => {
    // The property, rather than the table: whatever comes out must be a bare address. `node:net`'s `isIP` is the same
    // check the function is built on, so this asserts the *shape* contract — no brackets, no port, no whitespace —
    // rather than repeating the implementation.
    for (const [input] of CASES) {
      const result = normaliseIp(input);
      if (result === null) continue;
      expect(result).not.toContain(':443');
      expect(result.trim()).toBe(result);
      expect(result).not.toContain('[');
      expect(isIpAddress(result)).toBe(true);
    }
  });
});

describe('isIpAddress', () => {
  it('agrees with normaliseIp', () => {
    for (const [input, expected] of CASES) {
      expect(isIpAddress(input)).toBe(expected !== null);
    }
  });
});
