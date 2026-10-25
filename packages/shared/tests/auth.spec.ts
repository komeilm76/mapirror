import { describe, expect, it } from 'vitest';

import {
  AdminProfileSchema,
  LOGIN_PASSWORD_MAX,
  LOGIN_PASSWORD_MIN,
  LOGIN_USERNAME_MAX,
  LOGIN_USERNAME_MIN,
  LoginRateLimitDetailsSchema,
  LoginRequestSchema,
  LoginResponseSchema,
} from '../src/index';

/**
 * The login contract (`P1-AUTH-03`). These are contract tests in the literal sense: what the SPA may send, what the API
 * promises to return, and whether `04-api.md` still describes those bounds.
 *
 * The comparison against `04-api.md` lives in `apps/api/tests/auth-contract.spec.ts`, not here: this package declares
 * `types: []` so that a `node:*` import is a compile error (it is bundled for the browser), and reading a file needs
 * one. The split is the point — the contract is pure, the check that the document matches it is not.
 */

describe('LoginRequestSchema', () => {
  it('accepts the shape the login form sends', () => {
    expect(LoginRequestSchema.safeParse({ username: 'admin', password: 'x' }).success).toBe(true);
  });

  it('accepts any one-character password, because the policy is enforced at creation', () => {
    // Not an oversight: an account created before the policy tightened must still log in, and answering "too short"
    // (or anything other than the generic 401) would tell an attacker something about the account.
    expect(LOGIN_PASSWORD_MIN).toBe(1);
    expect(LoginRequestSchema.safeParse({ username: 'admin', password: 'x' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ username: 'admin', password: '' }).success).toBe(false);
  });

  it('rejects an empty or over-long username, and an over-long password', () => {
    for (const payload of [
      { username: '', password: 'x' },
      { username: 'x'.repeat(LOGIN_USERNAME_MAX + 1), password: 'x' },
      { password: 'x' },
      { username: 'admin' },
      { username: 42, password: 'x' },
      { username: 'admin', password: 42 },
      { username: null, password: 'x' },
    ]) {
      expect(LoginRequestSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(false);
    }
  });

  it('names the failing field, so a form can mark the right input', () => {
    const result = LoginRequestSchema.safeParse({ username: '', password: 'x' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['username']);
    expect(result.error.issues[0]?.message).toBe('Enter your username.');
  });

  it('accepts exactly the boundary values', () => {
    expect(LOGIN_USERNAME_MIN).toBe(1);
    expect(
      LoginRequestSchema.safeParse({
        username: 'u'.repeat(LOGIN_USERNAME_MAX),
        password: 'p'.repeat(LOGIN_PASSWORD_MAX),
      }).success,
    ).toBe(true);
    expect(
      LoginRequestSchema.safeParse({
        username: 'u'.repeat(LOGIN_USERNAME_MAX + 1),
        password: 'p',
      }).success,
    ).toBe(false);
    expect(
      LoginRequestSchema.safeParse({
        username: 'u',
        password: 'p'.repeat(LOGIN_PASSWORD_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('counts the password ceiling in code points, which is what Zod actually measures', () => {
    // Measured, not assumed (pass 23): Zod 4's `.max()` compares code points, so `'😀'.repeat(200)` — 400 UTF-16 units
    // but 200 characters — passes a 256 ceiling. Pass 20 assumed the opposite unit and made the creation policy
    // stricter than this schema; the policy now measures the same thing, and the two are kept in step by a test in
    // `apps/api/tests/password.spec.ts`.
    const emoji = '😀'.repeat(200);
    expect(emoji.length).toBe(400);
    expect([...emoji].length).toBe(200);
    expect(LoginRequestSchema.safeParse({ username: 'admin', password: emoji }).success).toBe(true);

    // One code point over the ceiling is refused.
    expect(
      LoginRequestSchema.safeParse({
        username: 'admin',
        password: '😀'.repeat(LOGIN_PASSWORD_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('counts raw code points, so a decomposed string is refused on its submitted length', () => {
    // `e` + U+0301 repeated 150 times is 300 code points as sent and 150 after NFKC. The schema sees the raw value, so
    // the creation policy has to as well — otherwise the account is created and the login form cannot use it.
    const decomposed = 'e\u0301'.repeat(150);
    expect([...decomposed].length).toBe(300);
    expect([...decomposed.normalize('NFKC')].length).toBe(150);
    expect(LoginRequestSchema.safeParse({ username: 'admin', password: decomposed }).success).toBe(
      false,
    );
  });

  it('ignores unknown keys instead of rejecting the request', () => {
    // A client that sends `rememberMe` should not fail: nothing here is a boundary an extra key could cross.
    expect(
      LoginRequestSchema.safeParse({ username: 'admin', password: 'x', rememberMe: true }).success,
    ).toBe(true);
  });

  it('does not trim either field', () => {
    // Trimming the password would change the secret; trimming the username is the service's decision, made against the
    // stored value, not the schema's.
    const parsed = LoginRequestSchema.parse({ username: ' admin ', password: ' secret ' });
    expect(parsed.username).toBe(' admin ');
    expect(parsed.password).toBe(' secret ');
  });
});

describe('LoginResponseSchema', () => {
  const valid = {
    token: 'mm_8JkQ2v9m4XpR7sT1uW3yZ5aB6cD8eF0gH2iJ4kL6mN',
    expiresAt: '2026-10-25T21:00:00.000Z',
    admin: { id: '6f1d0f34-3c6a-4d1b-9e0c-0b8f7a2e5d41', username: 'admin' },
  };

  it('accepts the documented response', () => {
    expect(LoginResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('requires an ISO instant and a UUID, not just any string', () => {
    expect(LoginResponseSchema.safeParse({ ...valid, expiresAt: 'tomorrow' }).success).toBe(false);
    expect(LoginResponseSchema.safeParse({ ...valid, expiresAt: 1_792_929_600 }).success).toBe(
      false,
    );
    expect(
      LoginResponseSchema.safeParse({ ...valid, admin: { id: 'admin', username: 'admin' } })
        .success,
    ).toBe(false);
  });

  it('has no place for a password, a hash or a session cookie', () => {
    // The envelope is what the SPA stores and what a proxy sees: it must not grow a field that is a credential other
    // than the token the client asked for.
    expect(Object.keys(LoginResponseSchema.shape).sort()).toEqual(['admin', 'expiresAt', 'token']);
    expect(Object.keys(AdminProfileSchema.shape).sort()).toEqual(['id', 'username']);
  });
});

describe('LoginRateLimitDetailsSchema', () => {
  it('accepts an instant plus a whole number of seconds', () => {
    expect(
      LoginRateLimitDetailsSchema.safeParse({
        lockedUntil: '2026-10-25T09:15:00.000Z',
        retryAfterSeconds: 900,
      }).success,
    ).toBe(true);
  });

  it('refuses a zero or fractional retry', () => {
    // `Retry-After: 0` invites a hot retry loop; a fraction is not a number any client can honour.
    for (const retryAfterSeconds of [0, -1, 1.5, Number.NaN]) {
      expect(
        LoginRateLimitDetailsSchema.safeParse({
          lockedUntil: '2026-10-25T09:15:00.000Z',
          retryAfterSeconds,
        }).success,
        String(retryAfterSeconds),
      ).toBe(false);
    }
  });
});
