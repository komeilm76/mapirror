import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseEnv } from '../src/index';
import { databaseUrlFor } from '../src/db/client';

/**
 * `databaseUrlFor` (`P1-DOCK-05`) — the DSN the pool is given, and the reason a password is not always written into it.
 *
 * `compose.yaml` derives `DATABASE_URL` as `postgres://mapirror@db:5432/mapirror` and passes `POSTGRES_PASSWORD`
 * separately, because a password is arbitrary text and a URL is not. Measured on a PostgreSQL requiring SCRAM (pass 43):
 * a `@` typed into a DSN authenticates with a **truncated** password (`password authentication failed`), a `#`, `?` or
 * `/` makes the string an invalid URL that `parseEnv` refuses with a message about `DATABASE_URL` — a variable the
 * operator never edited, because compose wrote it — and a bare `%` reaches the driver's `decodeURIComponent` and throws
 * `URI malformed`.
 *
 * These cases are the contract: whatever the operator's password manager produced, the string that reaches `pg` decodes
 * back to exactly that password.
 */

/** A `.env` shaped like compose's: username and service only. */
const COMPOSE_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://mapirror@db:5432/mapirror',
} as const;

/** Passwords that break a URL built by string concatenation, one per reason. */
const AWKWARD = [
  'p@ss/word#1',
  'a:b;c=d',
  'with space',
  'ünïcode-"quoted"',
  'a%41b',
  '100%',
  'trailing&',
  'plain-hex-0123456789abcdef',
] as const;

describe('databaseUrlFor', () => {
  it('returns the DSN untouched when no password is configured', () => {
    // Native development: the DSN is explicit and complete, and nothing rewrites it.
    expect(databaseUrlFor(parseEnv({ ...COMPOSE_ENV }))).toBe(COMPOSE_ENV.DATABASE_URL);
    expect(databaseUrlFor(parseEnv({ NODE_ENV: 'development' }))).toBe(
      'postgres://mapirror:mapirror@localhost:5432/mapirror',
    );
  });

  it.each(AWKWARD)('completes the DSN with %s, which decodes back to itself', (password) => {
    const url = new URL(databaseUrlFor(parseEnv({ ...COMPOSE_ENV, POSTGRES_PASSWORD: password })));

    expect(decodeURIComponent(url.password)).toBe(password);
    // The two halves of the authority are untouched: this is a password, not a rewrite of where the database is.
    expect(url.username).toBe('mapirror');
    expect(url.host).toBe('db:5432');
    expect(url.pathname).toBe('/mapirror');
    expect(url.protocol).toBe('postgres:');
  });

  it('escapes the one character URL leaves alone', () => {
    // `URL`'s password setter encodes `@`, `/`, `#`, `?`, spaces and non-ASCII, but not `%` — it is not in the userinfo
    // percent-encode set. Left alone, `a%41b` would decode to `aAb` and authenticate as a different password than the one
    // the operator set. So `%` is escaped first, and this case is the guard.
    const encoded = databaseUrlFor(parseEnv({ ...COMPOSE_ENV, POSTGRES_PASSWORD: 'a%41b' }));

    expect(encoded).toContain('a%2541b');
    expect(decodeURIComponent(new URL(encoded).password)).toBe('a%41b');
  });

  it('keeps a password that is already in the DSN', () => {
    // The rule that makes the change additive: a DSN with a password is a deliberate value (native dev, an operator's
    // own tooling) and `POSTGRES_PASSWORD` must not quietly replace it — it exists for the bundled container.
    const config = parseEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://mapirror:in-the-dsn@db:5432/mapirror',
      POSTGRES_PASSWORD: 'from-the-environment',
    });

    expect(databaseUrlFor(config)).toBe('postgres://mapirror:in-the-dsn@db:5432/mapirror');
  });

  it('keeps the query string, which carries connection options', () => {
    // `?sslmode=require` is how a managed database is reached; a completion that dropped the query would silently turn
    // TLS off. `URL` preserves it, and this case says so out loud.
    const config = parseEnv({
      ...COMPOSE_ENV,
      DATABASE_URL: 'postgres://mapirror@db:5432/mapirror?sslmode=require',
      POSTGRES_PASSWORD: 'secret-value',
    });

    const url = new URL(databaseUrlFor(config));
    expect(url.search).toBe('?sslmode=require');
    expect(decodeURIComponent(url.password)).toBe('secret-value');
  });

  it('completes from the secret file, which is how a docker secret arrives', () => {
    // The file is read and trimmed by `parseEnv` (`env.spec.ts`); this is the join — the value that came out of the file
    // is the value in the URL, so a docker-secret deployment needs no DSN at all.
    const directory = mkdtempSync(join(tmpdir(), 'mapirror-dsn-'));
    const path = join(directory, 'postgres_password');
    writeFileSync(path, 'p@ss/word#1\n');

    const config = parseEnv({ ...COMPOSE_ENV, POSTGRES_PASSWORD_FILE: path });

    expect(config.postgresPassword).toBe('p@ss/word#1');
    expect(decodeURIComponent(new URL(databaseUrlFor(config)).password)).toBe('p@ss/word#1');
  });
});
