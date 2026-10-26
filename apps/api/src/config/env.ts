/**
 * Typed, validated configuration (task `P1-API-02`).
 *
 * Every value the API reads from the environment passes through the Zod schema in this file — law **L5**
 * ("every external input passes through a Zod schema"). The process either has a complete, typed config or it
 * has a list of problems and stops: an API that boots with a half-understood configuration fails later, in a
 * request, where the cause is invisible.
 *
 * Three rules shape the schema:
 *
 * 1. **A value the operator set is never silently ignored.** Absent → the documented default. Present but
 *    unusable (`PORT=0x10`, `LOG_LEVEL=loud`) → an error naming the variable. The earlier `readPort` fell
 *    back to 3000 for `PORT=0x10`, which is the wrong outcome: the operator asked for a port and got a
 *    different one without being told.
 * 2. **Numbers are read by a rule, not by the language.** `Number('0x10')` is 16 and `Number('30e3')` is
 *    30000, so digits-only then range-check — the same lesson as the shared pagination parser.
 * 3. **Errors name variables, never values.** `ADMIN_PASSWORD` and the password inside `DATABASE_URL` must
 *    never reach a terminal or a log aggregator, so messages quote the key and the rule only.
 *
 * @module config/env
 */

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

import { z } from 'zod';

/** Values allowed for `NODE_ENV`. */
export const NODE_ENVS = ['development', 'production', 'test'] as const;

/** One of the documented run modes. */
export type NodeEnv = (typeof NODE_ENVS)[number];

/** Pino levels, in the order `09-development.md` documents them. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** One of the accepted `LOG_LEVEL` values. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Default port; matches `PORT` in `.env.example` and the compose port mapping. */
const DEFAULT_PORT = 3000;

/** Largest valid TCP port. */
const MAX_PORT = 65_535;

/** The DSN `cp .env.example .env` produces, used when the variable is absent outside production. */
const DEFAULT_DATABASE_URL = 'postgres://mapirror:mapirror@localhost:5432/mapirror';

/** Empty means "let the UI show the build's version"; see {@link AppConfig.appVersion}. */
const DEFAULT_APP_VERSION = packageVersion();

/** Message for the one rule that protects an authenticated API from a wildcard origin. */
const CORS_WILDCARD_MESSAGE =
  'must list explicit origins — `*` would expose the authenticated admin API to any site';

/**
 * Reads the version of this package, used when `APP_VERSION` is not set.
 *
 * The docs describe the default as "from package", so the package is the source. Any surprise (a missing or
 * malformed file, a bundler that rewrote the path) degrades to `''` rather than preventing a boot: a version
 * string is not worth an outage.
 *
 * @returns The `version` field of `apps/api/package.json`, or `''` when it cannot be read.
 */
function packageVersion(): string {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const parsed = z.object({ version: z.string() }).safeParse(raw);
    return parsed.success ? parsed.data.version : '';
  } catch {
    return '';
  }
}

/** One config problem: the variable and the rule it broke. Never the value. */
export interface ConfigIssue {
  /** Environment variable the problem belongs to, e.g. `PORT`. */
  readonly key: string;
  /** What was expected, in operator language. */
  readonly message: string;
}

/**
 * Thrown by {@link parseEnv} when the environment cannot be understood.
 *
 * Carries the structured issues as well as the formatted message, so a caller can log them individually
 * (task `P1-API-03`) instead of re-parsing a string.
 */
export class ConfigError extends Error {
  /** Every problem found, in schema order. */
  readonly issues: readonly ConfigIssue[];

  /**
   * @param issues - Problems found; at least one.
   */
  constructor(issues: readonly ConfigIssue[]) {
    super(ConfigError.format(issues));
    this.name = 'ConfigError';
    this.issues = issues;
  }

  /**
   * Formats issues as an operator-facing list.
   *
   * One problem per line and the count in the heading: fixing environment variables one failed boot at a
   * time is the failure mode this format exists to avoid.
   *
   * @param issues - Problems found.
   * @returns The message, without any variable values.
   */
  private static format(issues: readonly ConfigIssue[]): string {
    const heading =
      issues.length === 1
        ? 'Invalid environment: 1 problem'
        : `Invalid environment: ${issues.length} problems`;
    return `${heading}\n${issues.map((issue) => `  • ${issue.key}: ${issue.message}`).join('\n')}`;
  }
}

/** Source of configuration: a plain record, so tests never mutate `process.env`. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Treats an empty or whitespace-only value as "not set".
 *
 * `.env.example` ships `CORS_ORIGINS=`, `ADMIN_PASSWORD=` and `APP_VERSION=` as empty, and a copied file must
 * behave exactly like a file without those lines — otherwise "unset" and "copied the template" diverge, and
 * the mutual-exclusion rules below would fire on a perfectly correct `cp .env.example .env`.
 *
 * @param source - Raw environment.
 * @returns A copy with blank values removed.
 */
function withoutBlanks(source: EnvSource): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value.trim() === '') continue;
    result[key] = value;
  }
  return result;
}

/**
 * Builds a non-negative integer reader for a variable measured in whole units.
 *
 * Digits only, because `Number()` would accept hex, exponents, signs and `Infinity`. The message states the
 * rule so the operator does not have to guess which spelling was rejected.
 *
 * @param fallback - Value used when the variable is absent.
 * @param range - Inclusive bounds and the message when they are not met.
 * @returns A schema producing a number.
 */
function wholeNumber(
  fallback: number,
  range: { min?: number; max?: number; message?: string } = {},
) {
  const min = range.min ?? 0;
  const max = range.max ?? Number.MAX_SAFE_INTEGER;
  return z
    .string()
    .trim()
    .regex(/^[0-9]+$/, 'must be a whole number written in digits (no sign, hex or exponent)')
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(min, range.message ?? `must be at least ${min}`)
        .max(max, range.message ?? `must be at most ${max}`),
    )
    .default(fallback);
}

/**
 * Builds a boolean reader that accepts exactly `true` and `false`.
 *
 * `WORKER_ENABLED=1` or `yes` is rejected rather than guessed: a worker that silently enables itself because
 * a truthy string was coerced is a harder bug than a boot that names the variable.
 *
 * @param fallback - Value used when the variable is absent.
 * @returns A schema producing a boolean.
 */
function flag(fallback: boolean) {
  return z
    .enum(['true', 'false'], { error: 'must be `true` or `false`' })
    .transform((value) => value === 'true')
    .default(fallback);
}

/**
 * Builds an absolute http(s) URL reader.
 *
 * @param fallback - Value used when the variable is absent.
 * @returns A schema producing the validated URL string.
 */
function httpUrl(fallback: string) {
  return z
    .url({ protocol: /^https?$/, error: 'must be an absolute http:// or https:// URL' })
    .default(fallback);
}

/**
 * Converts a CORS entry to its serialized browser origin, refusing URL components that are not part of an origin.
 *
 * Browsers send only scheme, host and port in the `Origin` header. Keeping a path, query or credentials in the
 * configured value makes an otherwise-valid URL silently fail exact matching; normalize an optional trailing slash
 * and default port, but reject anything that cannot be an origin.
 *
 * @param value - One configured CORS entry.
 * @returns The canonical origin, or `null` when the URL is not origin-only.
 */
function canonicalHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Values Fastify understands as a proxy preset, in the spelling it uses.
 *
 * `loopback` covers the documented deployment (`12-deployment.md`: a Caddy/Nginx on the same host proxying to
 * `127.0.0.1:8080`); the other two exist for container networks.
 */
const PROXY_PRESETS = ['loopback', 'linklocal', 'uniquelocal'] as const;

/**
 * Whether a token is an IP address or a CIDR block, the two other things Fastify accepts here.
 *
 * @param token - One entry of the comma-separated list.
 * @returns `true` for `127.0.0.1`, `172.16.0.0/12`, `::1`, `fd00::/8`.
 */
function isAddressOrSubnet(token: string): boolean {
  const [address = '', prefix, ...rest] = token.split('/');
  if (rest.length > 0 || isIP(address) === 0) return false;
  if (prefix === undefined) return true;
  if (!/^[0-9]+$/.test(prefix)) return false;
  const max = isIP(address) === 4 ? 32 : 128;
  const value = Number(prefix);
  return value >= 0 && value <= max;
}

/**
 * Reads `TRUST_PROXY`: which peers may assert a client address, or `false` to trust none.
 *
 * **Why this is not just passed through to Fastify.** Fastify accepts a number of hops, but its implementation
 * *fails closed* for numbers: `trustProxy: 1` returns a function that trusts nothing, silently, because a hop
 * count cannot validate the immediate peer. An operator writing the most natural value (`TRUST_PROXY=1`) would
 * get no proxy support at all and no warning. So numbers are rejected here with an explanation, as is `true`
 * (which trusts *every* peer, i.e. any client can invent its own address).
 *
 * The default is `loopback`: correct for the documented same-host proxy, and it never trusts a remote peer's
 * `X-Forwarded-For`. Without it every client behind the proxy shares one address, which would make the per-IP
 * rate limits in `14-security.md` §7 a single global bucket and every hashed download IP identical.
 *
 * @param fallback - Value used when the variable is absent.
 * @returns The Fastify `trustProxy` value.
 */
function trustProxySetting(fallback: string | false) {
  return z
    .string()
    .trim()
    .transform((raw, ctx) => {
      if (raw === 'none' || raw === 'false') return false as const;
      const tokens = raw
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0);
      if (tokens.length === 0) return false as const;

      const problems: string[] = [];
      for (const token of tokens) {
        if (/^[0-9]+$/.test(token)) {
          problems.push(
            `${token}: a hop count is not supported — Fastify fails closed for numbers, so it would trust ` +
              'nothing; list the proxy address or subnet instead (e.g. 172.16.0.0/12)',
          );
        } else if (token === 'true' || token === '*') {
          problems.push(
            `${token}: would trust every peer, letting any client choose its own address; list the proxy address instead`,
          );
        } else if (
          !PROXY_PRESETS.includes(token as (typeof PROXY_PRESETS)[number]) &&
          !isAddressOrSubnet(token)
        ) {
          problems.push(
            `${token}: expected an address, a CIDR block, or one of ${PROXY_PRESETS.join(' | ')}`,
          );
        }
      }

      if (problems.length > 0) {
        ctx.addIssue({ code: 'custom', message: problems.join('; ') });
        return z.NEVER;
      }
      // Fastify parses a comma-separated string itself, so the list is handed over as written.
      return tokens.join(',');
    })
    .default(fallback);
}

/**
 * The environment schema.
 *
 * Keys are the variable names an operator writes, so an issue's path is already the thing to go and fix. Every
 * variable documented in `09-development.md` §5 is here; a test compares the two lists in both directions.
 */
const ENV_SCHEMA = z.object({
  NODE_ENV: z
    .enum(NODE_ENVS, { error: `must be one of ${NODE_ENVS.join(' | ')}` })
    .default('development'),
  PORT: wholeNumber(DEFAULT_PORT, {
    min: 1,
    max: MAX_PORT,
    message: `must be a port between 1 and ${MAX_PORT}`,
  }),
  HOST: z.string().trim().min(1, 'must be a host or IP to bind').default('0.0.0.0'),

  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// connection string' })
    .default(DEFAULT_DATABASE_URL),
  DATABASE_URL_TEST: z
    .url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// connection string' })
    .default('postgres://mapirror:mapirror@localhost:5432/mapirror_test'),
  DB_POOL_MAX: wholeNumber(10, { min: 1, message: 'must be at least 1 connection' }),

  CORS_ORIGINS: z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(
      z.array(
        z
          .string()
          .refine((origin) => origin !== '*', CORS_WILDCARD_MESSAGE)
          .transform((origin, ctx) => {
            const canonical = canonicalHttpOrigin(origin);
            if (canonical === null) {
              ctx.addIssue({
                code: 'custom',
                message:
                  'must be an http(s) origin such as https://maps.example.org, without path, query, fragment or credentials',
              });
              return z.NEVER;
            }
            return canonical;
          }),
      ),
    )
    // The default belongs on the whole variable, not inside the pipe: an absent key must skip the split too.
    .default([]),
  IP_HASH_SALT: z.string().optional(),

  TRUST_PROXY: trustProxySetting('loopback'),

  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_PASSWORD_FILE: z.string().optional(),

  CACHE_DIR: z.string().trim().min(1, 'must be a directory path').default('./data/cache'),
  TMP_DIR: z.string().trim().min(1, 'must be a directory path').default('./data/tmp'),

  ADMIN_USERNAME: z.string().trim().min(1, 'must be a username').default('admin'),
  ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters').optional(),
  ADMIN_PASSWORD_FILE: z.string().optional(),
  AUTH_TOKEN_TTL_HOURS: wholeNumber(12, { min: 1, message: 'must be at least 1 hour' }),
  AUTH_MAX_LOGIN_ATTEMPTS: wholeNumber(10, { min: 1, message: 'must be at least 1 attempt' }),
  AUTH_LOCKOUT_MINUTES: wholeNumber(15, { min: 1, message: 'must be at least 1 minute' }),

  // Migration ownership: the API applies pending migrations before it serves, unless a deployment gives the job
  // to its entrypoint (`docker/entrypoint.api.sh`, `P1-DOCK-04`). Either way the *check* runs at boot.
  MIGRATE_ON_BOOT: flag(true),
  WORKER_ENABLED: flag(true),
  WORKER_CONCURRENCY: wholeNumber(2, { min: 1, message: 'must be at least 1 worker' }),
  JOB_RETENTION_DAYS: wholeNumber(30, { min: 1, message: 'must be at least 1 day' }),

  MAX_UPLOAD_BYTES: wholeNumber(8_589_934_592, { min: 1, message: 'must be at least 1 byte' }),
  DISK_RESERVE_BYTES: wholeNumber(2_147_483_648),
  PUBLIC_DOWNLOADS_PER_MINUTE: wholeNumber(10, { min: 1, message: 'must be at least 1 request' }),

  GEOFABRIK_BASE_URL: httpUrl('https://download.geofabrik.de'),
  CATALOG_TTL_MINUTES: wholeNumber(360, { min: 1, message: 'must be at least 1 minute' }),

  METRICS_INTERVAL_SECONDS: wholeNumber(10, { min: 1, message: 'must be at least 1 second' }),
  METRICS_RETENTION_DAYS: wholeNumber(7, { min: 1, message: 'must be at least 1 day' }),

  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(' | ')}` })
    .default('info'),
  APP_VERSION: z.string().trim().default(DEFAULT_APP_VERSION),
  PUBLIC_BASE_URL: httpUrl('http://localhost:8080'),
  BRANDING_DISPLAY_NAME: z.string().trim().min(1, 'must be a display name').default('MapMirror'),
});

/** Every variable the API reads, in schema order. */
export const ENV_KEYS: readonly string[] = Object.keys(ENV_SCHEMA.shape);

/** The validated, typed configuration. Every consumer takes this instead of reading `process.env`. */
export interface AppConfig {
  /** `NODE_ENV`: development, production or test. */
  readonly nodeEnv: NodeEnv;
  /** Port to listen on. */
  readonly port: number;
  /** Address to bind. */
  readonly host: string;
  /** DSN for the application database. */
  readonly databaseUrl: string;
  /** DSN for the test database; only integration tests use it. */
  readonly databaseUrlTest: string;
  /** Maximum connections in the pool. */
  readonly dbPoolMax: number;
  /** Cross-origin allow-list; empty means same-origin only. */
  readonly corsOrigins: readonly string[];
  /** Salt for hashed download IPs; empty until first boot generates one. */
  readonly ipHashSalt?: string;
  /**
   * Which peers may assert a client address in `X-Forwarded-For`, or `false` for none.
   *
   * Handed to Fastify as-is; see {@link trustProxySetting} for why numbers are refused.
   */
  readonly trustProxy: string | false;
  /**
   * The database password, when `DATABASE_URL` does not carry one.
   *
   * compose's derived DSN is username, service and database only (`compose.yaml`), and `db/client.ts` completes it from
   * this value — so a password containing `@`, `:`, `/`, `?`, `#` or `%` never has to survive a URL.
   */
  readonly postgresPassword?: string;
  /** Docker-secret alternative to {@link postgresPassword}. */
  readonly postgresPasswordFile?: string;
  /** Root of the artifact cache (`/data/cache` in compose). */
  readonly cacheDir: string;
  /** Upload staging and `.part` files (`/data/tmp` in compose). */
  readonly tmpDir: string;
  /** Bootstrap admin username. */
  readonly adminUsername: string;
  /** Bootstrap admin password, if given directly. Never logged. */
  readonly adminPassword?: string;
  /** Docker-secret alternative to {@link adminPassword}. */
  readonly adminPasswordFile?: string;
  /** Bearer token lifetime. */
  readonly authTokenTtlHours: number;
  /** Failed logins before throttling. */
  readonly authMaxLoginAttempts: number;
  /** Throttle window. */
  readonly authLockoutMinutes: number;
  /** Whether this process runs the queue worker and scheduler. */
  /** Whether this process applies pending migrations before serving. The version check runs regardless. */
  readonly migrateOnBoot: boolean;
  readonly workerEnabled: boolean;
  /** Parallel jobs. */
  readonly workerConcurrency: number;
  /** Finished-job retention. */
  readonly jobRetentionDays: number;
  /** Import size cap. */
  readonly maxUploadBytes: number;
  /** Free-space floor kept on {@link cacheDir}. */
  readonly diskReserveBytes: number;
  /** Per-IP public download limit. */
  readonly publicDownloadsPerMinute: number;
  /** Geofabrik base URL (overridden in tests). */
  readonly geofabrikBaseUrl: string;
  /** Catalog cache freshness window. */
  readonly catalogTtlMinutes: number;
  /** Metrics sampling period. */
  readonly metricsIntervalSeconds: number;
  /** Metrics retention. */
  readonly metricsRetentionDays: number;
  /** Pino level. */
  readonly logLevel: LogLevel;
  /** Version shown in the UI; empty means "from package" was unavailable. */
  readonly appVersion: string;
  /** Public base URL used in generated download links. */
  readonly publicBaseUrl: string;
  /** Default display name for the UI. */
  readonly brandingDisplayName: string;
}

/**
 * Masks the password inside a DSN or a bare secret.
 *
 * @param value - The secret, possibly a URL.
 * @returns The same shape with any password replaced by `***`, so it is safe to log.
 */
export function redactSecret(value: string): string {
  try {
    const url = new URL(value);
    if (url.password === '') return value;
    url.password = '***';
    return url.toString();
  } catch {
    return value === '' ? value : '***';
  }
}

/**
 * Renders the config for a log line or a debug dump, with every secret masked.
 *
 * Attached to the returned object as `toJSON`, so `JSON.stringify(config)` and `console.log(config)` cannot
 * leak `ADMIN_PASSWORD` or the password inside `DATABASE_URL` by accident.
 *
 * @param config - Validated configuration.
 * @returns A plain object safe to print.
 */
function redacted(config: AppConfig): Record<string, unknown> {
  return {
    ...config,
    databaseUrl: redactSecret(config.databaseUrl),
    databaseUrlTest: redactSecret(config.databaseUrlTest),
    adminPassword: config.adminPassword === undefined ? undefined : '***',
    postgresPassword: config.postgresPassword === undefined ? undefined : '***',
  };
}

/**
 * Validates an environment and returns the typed configuration.
 *
 * Cross-field rules live here rather than in the schema because they need to know whether a variable was
 * *provided* — the schema has already applied defaults by the time a refinement runs:
 *
 * - `ADMIN_PASSWORD` and `ADMIN_PASSWORD_FILE` are mutually exclusive, and so are the two
 *   `POSTGRES_PASSWORD` variables. Setting both makes "which one wins" an implementation detail of whatever
 *   reads it first.
 * - `DATABASE_URL` is required in production. Elsewhere its absence falls back to the documented local DSN,
 *   which keeps `bun run dev` and `cp .env.example .env` working; a production container that guesses a DSN
 *   is a container that connects to the wrong database.
 *
 * @param source - Environment to read; defaults to `process.env`.
 * @returns The validated config, with a `toJSON` that masks secrets.
 * @throws {ConfigError} When any variable is unusable; the message lists all problems at once.
 */
export function parseEnv(source: EnvSource = process.env): AppConfig {
  const provided = withoutBlanks(source);
  const parsed = ENV_SCHEMA.safeParse(provided);
  const issues: ConfigIssue[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') === '' ? '(environment)' : issue.path.join('.');
      // Zod's own wording is close to an operator message except for the missing-value case, which reads as an
      // implementation detail ("expected string, received undefined").
      const message =
        issue.code === 'invalid_type' && issue.message.includes('received undefined')
          ? 'is required'
          : issue.message;
      issues.push({ key, message });
    }
  }

  // …the mutual exclusions, decided on the raw input: `withoutBlanks` already dropped empty values, so a
  // copied template (which ships both variables blank) cannot trip them.
  for (const [value, file] of [
    ['ADMIN_PASSWORD', 'ADMIN_PASSWORD_FILE'],
    ['POSTGRES_PASSWORD', 'POSTGRES_PASSWORD_FILE'],
  ] as const) {
    if (provided[value] === undefined || provided[file] === undefined) continue;
    issues.push({
      key: value,
      message: `cannot be combined with ${file}; set exactly one of the two`,
    });
  }

  // `POSTGRES_PASSWORD_FILE` is read here rather than where the pool is built, so an unreadable secret is a
  // configuration problem that names the variable — the shape every other boot failure has — instead of a stack trace
  // from inside a pool constructor that four callers would each have to wrap. Only trailing line breaks are stripped:
  // `docker secret` content ends with one, and a password that really ends in `\n` is not a password anyone typed.
  // Read only when the pair rule above accepted it: with both halves set the file's contents cannot be used anyway, and
  // reporting it as unreadable too would name a second problem the operator does not have to act on.
  let postgresPasswordFromFile: string | undefined;
  if (provided.POSTGRES_PASSWORD === undefined && provided.POSTGRES_PASSWORD_FILE !== undefined) {
    try {
      postgresPasswordFromFile = readFileSync(provided.POSTGRES_PASSWORD_FILE, 'utf8').replace(
        /[\r\n]+$/u,
        '',
      );
      if (postgresPasswordFromFile.length === 0) {
        throw new Error('the file is empty');
      }
    } catch (error) {
      issues.push({
        key: 'POSTGRES_PASSWORD_FILE',
        message: `cannot be read: ${(error as Error).message}`,
      });
    }
  }

  if (provided.NODE_ENV === 'production' && provided.DATABASE_URL === undefined) {
    issues.push({
      key: 'DATABASE_URL',
      message: 'is required in production; there is no safe default',
    });
  }

  // Two gates on purpose. The first is the parse result — it lists schema failures *and* narrows `parsed` for
  // the code below. The second covers the cross-field rules, which run after parsing and would otherwise be
  // thrown away: an environment with both halves of a password pair, or a production boot without a DSN, used
  // to be accepted because only `parsed.success` was checked.
  if (!parsed.success) throw new ConfigError(issues);
  if (issues.length > 0) throw new ConfigError(issues);

  const env = parsed.data;

  const config: AppConfig = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    databaseUrlTest: env.DATABASE_URL_TEST,
    dbPoolMax: env.DB_POOL_MAX,
    corsOrigins: env.CORS_ORIGINS,
    ...(env.IP_HASH_SALT === undefined ? {} : { ipHashSalt: env.IP_HASH_SALT }),
    trustProxy: env.TRUST_PROXY,
    ...(env.POSTGRES_PASSWORD === undefined ? {} : { postgresPassword: env.POSTGRES_PASSWORD }),
    ...(postgresPasswordFromFile === undefined
      ? {}
      : { postgresPassword: postgresPasswordFromFile }),
    ...(env.POSTGRES_PASSWORD_FILE === undefined
      ? {}
      : { postgresPasswordFile: env.POSTGRES_PASSWORD_FILE }),
    cacheDir: env.CACHE_DIR,
    tmpDir: env.TMP_DIR,
    adminUsername: env.ADMIN_USERNAME,
    ...(env.ADMIN_PASSWORD === undefined ? {} : { adminPassword: env.ADMIN_PASSWORD }),
    ...(env.ADMIN_PASSWORD_FILE === undefined
      ? {}
      : { adminPasswordFile: env.ADMIN_PASSWORD_FILE }),
    authTokenTtlHours: env.AUTH_TOKEN_TTL_HOURS,
    authMaxLoginAttempts: env.AUTH_MAX_LOGIN_ATTEMPTS,
    authLockoutMinutes: env.AUTH_LOCKOUT_MINUTES,
    migrateOnBoot: env.MIGRATE_ON_BOOT,
    workerEnabled: env.WORKER_ENABLED,
    workerConcurrency: env.WORKER_CONCURRENCY,
    jobRetentionDays: env.JOB_RETENTION_DAYS,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    diskReserveBytes: env.DISK_RESERVE_BYTES,
    publicDownloadsPerMinute: env.PUBLIC_DOWNLOADS_PER_MINUTE,
    geofabrikBaseUrl: env.GEOFABRIK_BASE_URL,
    catalogTtlMinutes: env.CATALOG_TTL_MINUTES,
    metricsIntervalSeconds: env.METRICS_INTERVAL_SECONDS,
    metricsRetentionDays: env.METRICS_RETENTION_DAYS,
    logLevel: env.LOG_LEVEL,
    appVersion: env.APP_VERSION,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    brandingDisplayName: env.BRANDING_DISPLAY_NAME,
  };

  return Object.freeze({
    ...config,
    toJSON: () => redacted(config),
  });
}
