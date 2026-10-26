import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  ENV_KEYS,
  NODE_ENVS,
  LOG_LEVELS,
  parseEnv,
  redactSecret,
  type EnvSource,
} from '../src/index';

/**
 * `parseEnv` is the only place where a string from outside the process becomes configuration, so these tests
 * are also the contract for the operator: each one is a mistake someone will actually make while writing a
 * `.env` (a hex port, a truthy-looking flag, a copied template, a wildcard CORS origin).
 *
 * No test mutates `process.env`: the function takes its source as an argument precisely so that a failure
 * cannot leak into the next test file.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Reads the active (uncommented) assignments from `.env.example`.
 *
 * @returns The template's variables, as an environment source.
 */
function exampleEnv(): EnvSource {
  const source: Record<string, string> = {};
  for (const line of readFileSync(`${ROOT}.env.example`, 'utf8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) source[match[1]] = (match[2] ?? '').trim();
  }
  return source;
}

/**
 * Reads the variable names documented in `09-development.md` §5.
 *
 * @returns Documented names, including the commented-out `_FILE` alternatives.
 */
function documentedEnv(): string[] {
  const doc = readFileSync(`${ROOT}docs/09-development.md`, 'utf8');
  const start = doc.indexOf('## 5. Environment variables');
  const end = doc.indexOf('## 6.', start);
  expect(start, '09-development.md has a §5').toBeGreaterThan(-1);
  expect(end, '09-development.md has a §6').toBeGreaterThan(start);
  return [...doc.slice(start, end).matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map(
    (match) => match[1] ?? '',
  );
}

/**
 * Collects a thrown `ConfigError` so its issues can be asserted without matching a formatted string.
 *
 * @param source - Environment to parse.
 * @returns The thrown error.
 */
function errorFrom(source: EnvSource): ConfigError {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected parseEnv to throw');
}

/** Keys of the issues, in order. */
const keysOf = (error: ConfigError): string[] => error.issues.map((issue) => issue.key);

describe('parseEnv defaults', () => {
  it('parses an empty environment into the documented defaults', () => {
    // Every value here is quoted in 09-development.md §5; if a default moves, that table must move with it.
    const config = parseEnv({});

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.databaseUrl).toBe('postgres://mapirror:mapirror@localhost:5432/mapirror');
    expect(config.dbPoolMax).toBe(10);
    expect(config.corsOrigins).toEqual([]);
    expect(config.cacheDir).toBe('./data/cache');
    expect(config.tmpDir).toBe('./data/tmp');
    expect(config.adminUsername).toBe('admin');
    expect(config.authTokenTtlHours).toBe(12);
    expect(config.workerEnabled).toBe(true);
    expect(config.workerConcurrency).toBe(2);
    expect(config.maxUploadBytes).toBe(8_589_934_592);
    expect(config.diskReserveBytes).toBe(2_147_483_648);
    expect(config.geofabrikBaseUrl).toBe('https://download.geofabrik.de');
    expect(config.catalogTtlMinutes).toBe(360);
    expect(config.logLevel).toBe('info');
    expect(config.publicBaseUrl).toBe('http://localhost:8080');
    expect(config.brandingDisplayName).toBe('MapMirror');
  });

  it('treats the copied template as valid, blanks included', () => {
    // `cp .env.example .env` must not fail: the template ships `CORS_ORIGINS=`, `ADMIN_PASSWORD=`,
    // `IP_HASH_SALT=` and `APP_VERSION=` as empty, and empty must mean "not set", not "set to nothing".
    const config = parseEnv(exampleEnv());

    expect(config.adminPassword).toBeUndefined();
    expect(config.adminPasswordFile).toBeUndefined();
    expect(config.corsOrigins).toEqual([]);
    expect(config.ipHashSalt).toBeUndefined();
    expect(config.appVersion).not.toBe('');
  });

  it('reads the version from the package when APP_VERSION is unset', () => {
    const pkg: unknown = JSON.parse(readFileSync(`${ROOT}apps/api/package.json`, 'utf8'));
    const version = (pkg as { version?: string }).version;

    expect(parseEnv({}).appVersion).toBe(version);
    expect(parseEnv({ APP_VERSION: '1.2.3' }).appVersion).toBe('1.2.3');
  });

  it('freezes the result, so a consumer cannot rewrite configuration at runtime', () => {
    const config = parseEnv({});
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('parseEnv rejects unusable values, naming the variable', () => {
  it('reports every problem at once instead of the first', () => {
    const error = errorFrom({ PORT: '0x10', LOG_LEVEL: 'loud', WORKER_ENABLED: 'yes' });

    // Order is Zod's, not ours: assert membership, not sequence.
    expect([...keysOf(error)].sort()).toEqual(['LOG_LEVEL', 'PORT', 'WORKER_ENABLED']);
    expect(error.message).toMatch(/3 problems/);
    expect(error.message).toMatch(/• PORT: /);
  });

  it.each(['0', '65536', '99999'])('refuses the out-of-range PORT=%s', (value) => {
    // The old reader fell back to 3000 here. Silently listening on a different port than the one the operator
    // wrote is worse than not starting: the container looks healthy and is unreachable.
    const error = errorFrom({ PORT: value });
    expect(keysOf(error)).toEqual(['PORT']);
    expect(error.message).toMatch(/between 1 and 65535/);
  });

  it.each(['-1', 'abc', '30 00', '3000.5', '0x10', '30e3', ''])(
    'refuses the non-numeric PORT=%s',
    (value) => {
      // '' is "not set" and takes the default; every other spelling is a mistake worth naming.
      if (value === '') return expect(parseEnv({ PORT: value }).port).toBe(3000);
      const error = errorFrom({ PORT: value });
      expect(keysOf(error)).toEqual(['PORT']);
      expect(error.message).toMatch(/whole number written in digits/);
    },
  );

  it('refuses a hex PORT even though Number() would accept it', () => {
    // `Number('0x10')` is 16, so a schema written with z.coerce.number() would bind port 16 without complaint.
    expect(() => parseEnv({ PORT: '0x10' })).toThrow(/PORT/);
  });

  it('refuses a NODE_ENV outside the documented set', () => {
    expect(errorFrom({ NODE_ENV: 'staging' }).message).toMatch(/NODE_ENV: must be one of/);
    for (const env of NODE_ENVS) {
      // `production` carries the DSN rule with it, so supply one; the rule itself is tested below.
      expect(
        parseEnv({ NODE_ENV: env, DATABASE_URL: 'postgres://u:p@db:5432/mapirror' }).nodeEnv,
      ).toBe(env);
    }
  });

  it('accepts exactly the documented log levels', () => {
    for (const level of LOG_LEVELS) expect(parseEnv({ LOG_LEVEL: level }).logLevel).toBe(level);
    expect(errorFrom({ LOG_LEVEL: 'verbose' }).message).toMatch(/fatal \| error \| warn \| info/);
  });

  it('refuses a flag that merely looks true', () => {
    // `WORKER_ENABLED=1` and `=yes` are the classic footguns; guessing turns a typo into a running worker.
    for (const value of ['1', '0', 'yes', 'TRUE', 'on']) {
      expect(() => parseEnv({ WORKER_ENABLED: value }), value).toThrow(/WORKER_ENABLED/);
    }
    expect(parseEnv({ WORKER_ENABLED: 'false' }).workerEnabled).toBe(false);
  });

  it('refuses byte counts written with units', () => {
    expect(errorFrom({ MAX_UPLOAD_BYTES: '8GiB' }).message).toMatch(
      /MAX_UPLOAD_BYTES: must be a whole number/,
    );
    expect(errorFrom({ MAX_UPLOAD_BYTES: '-1' }).message).toMatch(/MAX_UPLOAD_BYTES/);
    expect(errorFrom({ MAX_UPLOAD_BYTES: '0' }).message).toMatch(/at least 1 byte/);
    expect(parseEnv({ MAX_UPLOAD_BYTES: '1' }).maxUploadBytes).toBe(1);
  });

  it('refuses a DSN that is not postgres', () => {
    expect(errorFrom({ DATABASE_URL: 'mysql://u:p@h/db' }).message).toMatch(
      /DATABASE_URL: must be a postgres/,
    );
  });

  it('trims surrounding whitespace instead of failing on it', () => {
    // Editors and `export` lines leave spaces; a port of ` 8080 ` is unambiguous.
    expect(parseEnv({ PORT: ' 8080 ', HOST: ' 127.0.0.1 ' })).toMatchObject({
      port: 8080,
      host: '127.0.0.1',
    });
  });
});

describe('parseEnv CORS allow-list', () => {
  it('splits, trims and drops empty entries', () => {
    const config = parseEnv({ CORS_ORIGINS: ' https://a.example.org , ,https://b.example.org,' });
    expect(config.corsOrigins).toEqual(['https://a.example.org', 'https://b.example.org']);
  });

  it('refuses a wildcard, which would expose the authenticated admin API', () => {
    const error = errorFrom({ CORS_ORIGINS: 'https://a.example.org,*' });
    expect(error.message).toMatch(/explicit origins/);
  });

  it('refuses a bare origin without a scheme', () => {
    expect(errorFrom({ CORS_ORIGINS: 'a.example.org' }).message).toMatch(/http\(s\) origin/);
  });

  it('accepts an origin with a port and a subdomain', () => {
    expect(parseEnv({ CORS_ORIGINS: 'http://localhost:5173' }).corsOrigins).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('rejects URLs that are not origins and canonicalizes a trailing slash', () => {
    for (const value of [
      'https://maps.example.org/admin',
      'https://maps.example.org?tenant=one',
      'https://maps.example.org/#section',
      'https://user:secret@maps.example.org',
    ]) {
      expect(errorFrom({ CORS_ORIGINS: value }).message, value).toContain('without path');
    }

    expect(parseEnv({ CORS_ORIGINS: 'https://maps.example.org/' }).corsOrigins).toEqual([
      'https://maps.example.org',
    ]);
  });
});

describe('parseEnv cross-field rules', () => {
  it('requires DATABASE_URL in production', () => {
    const error = errorFrom({ NODE_ENV: 'production' });
    expect(keysOf(error)).toEqual(['DATABASE_URL']);
    expect(error.message).toMatch(/required in production/);
    expect(() =>
      parseEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db:5432/mapirror' }),
    ).not.toThrow();
  });

  it('reports a schema problem and a cross-field problem in the same error', () => {
    // The cross-field rules run after the schema has parsed, so a naive implementation that throws on
    // `!parsed.success` first would report the port and hide the missing DSN — two boots to fix one .env.
    const error = errorFrom({ NODE_ENV: 'production', PORT: '0x10' });

    expect([...keysOf(error)].sort()).toEqual(['DATABASE_URL', 'PORT']);
    expect(error.message).toMatch(/2 problems/);
  });

  it('allows DATABASE_URL to be absent outside production', () => {
    // Native dev and the test suite must not need a DSN before anything connects to the database.
    expect(parseEnv({ NODE_ENV: 'development' }).databaseUrl).toBe(
      'postgres://mapirror:mapirror@localhost:5432/mapirror',
    );
  });

  it.each([
    ['ADMIN_PASSWORD', 'ADMIN_PASSWORD_FILE'],
    ['POSTGRES_PASSWORD', 'POSTGRES_PASSWORD_FILE'],
  ])('refuses %s together with %s', (value, file) => {
    const source: Record<string, string> = {
      [value]: 'twelve-chars-or-more',
      [file]: '/run/secrets/x',
    };
    const error = errorFrom(source);

    expect(keysOf(error)).toEqual([value]);
    expect(error.message).toMatch(new RegExp(`cannot be combined with ${file}`));
  });

  it('accepts either half of each pair on its own', () => {
    expect(parseEnv({ ADMIN_PASSWORD_FILE: '/run/secrets/admin' }).adminPasswordFile).toBe(
      '/run/secrets/admin',
    );
    expect(parseEnv({ ADMIN_PASSWORD: 'twelve-chars-or-more' }).adminPassword).toBe(
      'twelve-chars-or-more',
    );
  });

  it('requires a bootstrap password long enough to be worth hashing', () => {
    expect(errorFrom({ ADMIN_PASSWORD: 'short' }).message).toMatch(
      /ADMIN_PASSWORD: must be at least 12/,
    );
  });
});

describe('parseEnv reads POSTGRES_PASSWORD_FILE', () => {
  /** Writes a secret to a throwaway file and returns its path. */
  function secretFile(contents: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'mapirror-secret-'));
    const path = join(directory, 'postgres_password');
    writeFileSync(path, contents);
    return path;
  }

  it('resolves the secret, stripping only the trailing line breaks', () => {
    // `docker secret` content ends with a newline. A password that really ends in one is not a password anyone typed, and
    // an unstripped one authenticates as nothing that works (`P1-DOCK-05`, `compose.yaml`).
    const path = secretFile('p@ss/word#1\n');
    expect(parseEnv({ POSTGRES_PASSWORD_FILE: path }).postgresPassword).toBe('p@ss/word#1');
    expect(parseEnv({ POSTGRES_PASSWORD_FILE: secretFile('crlf\r\n') }).postgresPassword).toBe(
      'crlf',
    );
  });

  it('keeps the path in the configuration and the value out of every message', () => {
    const path = secretFile('do-not-print-me-4f2c\n');
    const config = parseEnv({ POSTGRES_PASSWORD_FILE: path });

    expect(config.postgresPasswordFile).toBe(path);
    expect(JSON.stringify(config)).not.toContain('do-not-print-me-4f2c');
  });

  it('reports an unreadable file as a configuration problem naming the variable', () => {
    // Not a stack trace from inside the pool constructor: this is the boot path, and every other failure there is one
    // line that names a variable.
    const error = errorFrom({ POSTGRES_PASSWORD_FILE: '/nonexistent/postgres_password' });

    expect(keysOf(error)).toEqual(['POSTGRES_PASSWORD_FILE']);
    expect(error.message).toMatch(/cannot be read/);
    expect(error.message).toMatch(/ENOENT/);
  });

  it('refuses an empty file instead of authenticating with nothing', () => {
    expect(errorFrom({ POSTGRES_PASSWORD_FILE: secretFile('\n') }).message).toMatch(
      /the file is empty/,
    );
  });
});

describe('parseEnv never prints a secret', () => {
  const password = 'do-not-print-me-95a1';

  it('names the variable but not its value when both halves of a pair are set', () => {
    const error = errorFrom({ ADMIN_PASSWORD: password, ADMIN_PASSWORD_FILE: '/run/secrets/x' });

    expect(error.message).toMatch(/ADMIN_PASSWORD/);
    expect(error.message).not.toContain(password);
    // The message is what reaches stderr and therefore the container log.
    expect(JSON.stringify(error.issues)).not.toContain(password);
  });

  it('masks the DSN password and the admin password when the config is serialised', () => {
    const config = parseEnv({
      DATABASE_URL: `postgres://mapirror:${password}@db:5432/mapirror`,
      ADMIN_PASSWORD: password,
    });
    const json = JSON.stringify(config);

    expect(json).not.toContain(password);
    expect(json).toMatch(/postgres:\/\/mapirror:\*\*\*@db:5432/);
    expect(config.databaseUrl).toContain(password); // the real value is still available to the code that connects
  });

  it('redacts a bare secret and leaves a password-free URL alone', () => {
    expect(redactSecret(password)).toBe('***');
    expect(redactSecret('https://download.geofabrik.de')).toBe('https://download.geofabrik.de');
    expect(redactSecret('postgres://u:p@h:5432/d')).toBe('postgres://u:***@h:5432/d');
  });
});

describe('the schema covers exactly the documented variables', () => {
  it('knows every variable in .env.example, including the commented alternatives', () => {
    const template = readFileSync(`${ROOT}.env.example`, 'utf8');
    const names = [
      ...new Set(
        [...template.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? ''),
      ),
    ];
    const unknown = names.filter((name) => !ENV_KEYS.includes(name));

    expect(unknown, '.env.example variables the API does not read').toEqual([]);
  });

  it('reads no variable that 09-development.md does not document', () => {
    const undocumented = ENV_KEYS.filter((key) => !documentedEnv().includes(key));
    expect(undocumented, 'schema keys missing from docs/09 §5').toEqual([]);
  });

  it('documents no variable the API cannot read', () => {
    const unread = documentedEnv().filter((key) => !ENV_KEYS.includes(key));
    expect(unread, 'documented variables missing from the schema').toEqual([]);
  });

  it('keeps the default port in step with the template and the docs', () => {
    expect(exampleEnv().PORT).toBe('3000');
    expect(documentedEnv()).toContain('PORT');
    expect(parseEnv({}).port).toBe(3000);
  });
});
