import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  generateToken,
  hashToken,
  isTokenShaped,
  issueToken,
  pruneExpiredTokens,
  revokeToken,
  TOKEN_DISPLAY_PREFIX_LENGTH,
  TOKEN_MARKER,
  TOKEN_PATTERN,
  verifyToken,
} from '../src/modules/auth/tokens';
import type { TokenExecutor } from '../src/db/repositories/admin-tokens';

/**
 * Acceptance test for `P1-AUTH-02`, the half that needs no database: the token's format and entropy, the digest that
 * is stored instead of the token, and the cheap rejections that must happen *before* a query is issued.
 *
 * The lifecycle itself — issue, verify, expiry, revocation, the `last_used_at` throttle — is in
 * `tests/integration/tokens.spec.ts`, against a real database, because the questions there are about rows.
 */

/**
 * An executor that fails the moment it is used.
 *
 * These tests assert that a malformed token never reaches the database, and "never reached it" is only observable if
 * touching it is loud.
 */
const untouchable = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `the database was touched (${String(property)}) for a token that cannot be one`,
      );
    },
  },
) as TokenExecutor;

describe('generateToken', () => {
  it('produces mm_ plus 43 base64url characters, with the digest and prefix derived from it', () => {
    const generated = generateToken();

    expect(generated.token).toHaveLength(TOKEN_MARKER.length + 43);
    expect(generated.token.startsWith(TOKEN_MARKER)).toBe(true);
    expect(TOKEN_PATTERN.test(generated.token)).toBe(true);
    // 32 bytes of base64url is exactly 43 characters, with no padding to strip.
    expect(generated.token).not.toContain('=');

    expect(generated.tokenHash).toHaveLength(32);
    expect(generated.tokenHash.equals(hashToken(generated.token))).toBe(true);
    expect(generated.tokenPrefix).toBe(generated.token.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH));
    expect(generated.tokenPrefix).toHaveLength(8);
  });

  it('gives every token its own 256 bits of randomness', () => {
    // Not a statistical test — a smoke test for the failure that matters: a generator that reuses a seed, counts, or
    // formats the timestamp. 200 tokens with no repeats and no shared prefix would be a miracle for anything but a
    // real CSPRNG, and a repeated token would be a repeated credential.
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken().token));

    expect(tokens.size).toBe(200);
    expect(new Set([...tokens].map((token) => token.slice(0, 12))).size).toBe(200);
  });
});

describe('hashToken', () => {
  it('is SHA-256 of the token bytes, and knows nothing else', () => {
    const digest = hashToken('mm_example');

    expect(digest).toHaveLength(32);
    expect(digest.toString('hex')).toBe(
      createHash('sha256').update('mm_example', 'utf8').digest('hex'),
    );
    // Deterministic — otherwise verification could never match — and sensitive to a single character.
    expect(hashToken('mm_example').equals(digest)).toBe(true);
    expect(hashToken('mm_examplE').equals(digest)).toBe(false);
    // Not hex-encoded and not a substring of the token: the column has a 32-byte CHECK for that reason.
    expect(digest.toString('hex')).not.toContain('mm_');
  });
});

describe('isTokenShaped', () => {
  const valid = generateToken().token;

  it('accepts a token this module generated', () => {
    expect(isTokenShaped(valid)).toBe(true);
  });

  it('rejects everything that is not exactly mm_ plus 43 base64url characters', () => {
    for (const candidate of [
      '',
      'mm_',
      TOKEN_MARKER,
      valid.slice(0, -1), // one character short: a truncated paste
      `${valid}a`, // one too many
      valid.replace(TOKEN_MARKER, 'MM_'), // markers are case-sensitive
      `${TOKEN_MARKER}${'a'.repeat(42)}=`, // base64 padding is not part of the format
      `${TOKEN_MARKER}${'a'.repeat(42)}+`, // standard base64, not base64url
      `${TOKEN_MARKER}${'a'.repeat(42)}/`,
      `${TOKEN_MARKER}${'a'.repeat(42)} `, // trailing space from a copy-paste
      ` ${valid}`,
      'Bearer mm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]) {
      expect(isTokenShaped(candidate), candidate).toBe(false);
    }
  });
});

describe('cheap rejections', () => {
  it('answers for a malformed token without touching the database', async () => {
    await expect(verifyToken(untouchable, 'not-a-token')).resolves.toEqual({ status: 'unknown' });
    await expect(revokeToken(untouchable, 'not-a-token')).resolves.toBe(false);
    // A well-shaped token that simply does not exist *does* reach the database — this proves the boundary is the
    // format check, not "anything unusual".
    await expect(verifyToken(untouchable, generateToken().token)).rejects.toThrow(/touched/u);
  });

  it('refuses a TTL that would mint an unusable token, before inserting it', async () => {
    for (const ttlHours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(issueToken(untouchable, 'admin-id', { ttlHours })).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });

  it('refuses a negative retention window before deleting anything', async () => {
    for (const afterDays of [-1, Number.NaN]) {
      await expect(pruneExpiredTokens(untouchable, { afterDays })).rejects.toBeInstanceOf(
        RangeError,
      );
    }
  });
});
