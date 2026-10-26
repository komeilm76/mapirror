import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { parseEnv } from '../../apps/api/src/config/env';
import { databaseUrlFor } from '../../apps/api/src/db/client';

/**
 * `compose.yaml` — the deployment an operator actually runs (task `P1-DOCK-05`, requirements DOCK-1/2).
 *
 * There is no Docker daemon in the gate, so this file is checked by **reading it the way compose does**: the YAML is
 * parsed, the `${…}` interpolations are resolved from `.env.example` the same way `docker compose` resolves them from
 * `.env`, and the result is compared with the images it starts — `docker/api.Dockerfile`, `docker/web.Dockerfile` and
 * `docker/nginx.conf`.
 *
 * The four properties that make `docker compose up -d` work on a clean Ubuntu box, and that each have a case below:
 *
 * | Property | What breaks without it |
 * |---|---|
 * | the DSN is derived and carries no password | two copies of one password drift, and a password with `@`, `/`, `#`, `?` or `%` cannot survive a URL (`database-url.spec.ts`) |
 * | `environment:` overrides the `.env` values that are wrong inside a container | the API binds `localhost`, writes to `./data` and runs in `development` — with the `.env` copy, on a volume nothing can write to |
 * | healthchecks use tools each image actually has | `curl` in a Bun-only image and `bun` in an nginx image both fail forever, so `depends_on: service_healthy` never fires |
 * | one published port, no credentials in the file | a database on the host, and a secret in git |
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads a repository file. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** A compose service, as far as this file uses them. */
interface Service {
  readonly image?: string;
  readonly build?: { readonly context?: string; readonly dockerfile?: string };
  readonly command?: readonly string[] | string;
  readonly entrypoint?: readonly string[] | string;
  readonly restart?: string;
  readonly environment?: Readonly<Record<string, unknown>>;
  readonly env_file?: readonly string[];
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
  readonly depends_on?: Readonly<Record<string, { readonly condition?: string }>>;
  readonly healthcheck?: {
    readonly test?: readonly string[] | string;
    readonly interval?: string;
    readonly timeout?: string;
    readonly retries?: number;
    readonly start_period?: string;
  };
  readonly stop_grace_period?: string;
  readonly security_opt?: readonly string[];
  readonly shm_size?: string;
  readonly logging?: { readonly driver?: string; readonly options?: Record<string, string> };
}

/** The parsed file. */
interface ComposeFile {
  readonly name?: string;
  readonly services: Readonly<Record<string, Service>>;
  readonly volumes?: Readonly<Record<string, unknown>>;
  readonly version?: string;
}

const FILE = parse(read('compose.yaml')) as ComposeFile;

/** The `.env.example` values, read exactly as a shell would. */
const EXAMPLE = ((): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const line of read('.env.example').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = (match[2] ?? '').trim();
  }
  return values;
})();

/**
 * Resolves compose's `${VAR}` / `${VAR:-default}` / `${VAR:?message}` forms against a source.
 *
 * Only the three forms this file uses are supported, and an unknown form throws — so a future `${…}` construct that this
 * test cannot reason about fails loudly instead of being asserted about vacuously.
 *
 * @param text - A string from the compose file.
 * @param source - Values to substitute.
 * @returns The interpolated string.
 * @throws When a variable is missing from `source` and has no default, or the form is not one of the three.
 */
function interpolate(text: string, source: Record<string, string> = EXAMPLE): string {
  return text.replace(
    /\$\{([A-Z][A-Z0-9_]*)(?::([-?])([^}]*))?\}/gu,
    (_match, name: string, op?: string, argument?: string) => {
      const value = source[name];
      if (op === '?') {
        if (value === undefined || value === '')
          throw new Error(`${name} is required: ${argument ?? ''}`);
        return value;
      }
      if (op === '-') return value === undefined || value === '' ? (argument ?? '') : value;
      if (value === undefined) throw new Error(`${name} is not defined`);
      return value;
    },
  );
}

/** Every service in the file, as `[name, service]` pairs. */
const SERVICES = Object.entries(FILE.services);

/** The API service. */
const API = FILE.services.api as Service;

/** The database service. */
const DB = FILE.services.db as Service;

/** The web service. */
const WEB = FILE.services.web as Service;

/** A command line from a healthcheck, whatever form it was written in. */
function healthcheckCommand(service: Service): string {
  const test = service.healthcheck?.test ?? [];
  return typeof test === 'string' ? test : test.join(' ');
}

describe('the compose file', () => {
  it('describes the three services the deployment guide names, and two volumes', () => {
    expect(FILE.name).toBe('mapirror');
    expect(Object.keys(FILE.services).sort()).toEqual(['api', 'db', 'web']);
    expect(Object.keys(FILE.volumes ?? {}).sort()).toEqual(['data', 'pg-data']);
    // `version:` is the compose-spec-1 key that a modern plugin warns about and ignores.
    expect(FILE.version).toBeUndefined();
  });

  it('builds the two images from this repository', () => {
    for (const [service, dockerfile] of [
      [API, 'docker/api.Dockerfile'],
      [WEB, 'docker/web.Dockerfile'],
    ] as const) {
      expect(service.build?.context).toBe('.');
      expect(service.build?.dockerfile).toBe(dockerfile);
      // The path is only checked once here; `dockerfile.spec.ts` owns what is inside it.
      expect(() => read(dockerfile as string)).not.toThrow();
    }
    // The database is a published image, pinned by minor version: `postgres:16` would change under a restart, and
    // `latest` would change the on-disk format of the volume.
    expect(DB.image).toMatch(/^postgres:16(\.\d+)?-alpine$/u);
  });

  it('publishes one port, on the web service, and nothing else', () => {
    // The database's port on the host is a password-guessing surface with no benefit (the API is its only client), and a
    // published API port would let a client reach it without nginx — bypassing the proxy and the CSP, and making
    // `TRUST_PROXY` a way for anyone to choose their own address.
    expect(WEB.ports).toEqual(['8080:8080']);
    expect(API.ports).toBeUndefined();
    expect(DB.ports).toBeUndefined();
  });

  it('restarts unless stopped, and stops the API gently', () => {
    for (const [name, service] of SERVICES) {
      // `always` restarts a container an operator deliberately stopped; `no` leaves a crashed one down.
      expect(service.restart, name).toBe('unless-stopped');
      expect(service.logging?.driver, name).toBe('json-file');
      expect(service.logging?.options?.['max-size'], name).toBe('10m');
    }
    // Longer than the API's own 8 s shutdown bound, so a drain finishes before Docker escalates to SIGKILL.
    expect(API.stop_grace_period).toBe('30s');
  });
});

describe('the derived database URL', () => {
  it('names the service, the user and the database — and carries no password', () => {
    const dsn = API.environment?.['DATABASE_URL'];
    expect(typeof dsn).toBe('string');

    const url = new URL(dsn as string);
    expect(url.protocol).toBe('postgres:');
    expect(url.username).toBe('mapirror');
    expect(url.password, 'the password must not be in the URL').toBe('');
    // `db` is the *service name*: compose's DNS resolves it. `localhost` here would be the API's own container.
    expect(url.hostname).toBe('db');
    expect(url.port).toBe('5432');
    expect(url.pathname).toBe('/mapirror');
  });

  it('agrees with the database container it connects to', () => {
    // Three places state the same three names; a test that only checked the DSN would pass while the database was
    // created under another user or database name, and the failure would be `role "mapirror" does not exist`.
    const url = new URL(API.environment?.['DATABASE_URL'] as string);

    expect(DB.environment?.['POSTGRES_USER']).toBe(url.username);
    expect(DB.environment?.['POSTGRES_DB']).toBe(url.pathname.slice(1));
    expect(DB.environment?.['POSTGRES_PASSWORD']).toBe(API.environment?.['POSTGRES_PASSWORD']);
  });

  it('is completed at boot by the password, and works for any password', () => {
    // The join between this file and `db/client.ts`: the container's environment is fed to `parseEnv`, and the DSN that
    // reaches the pool contains the password — percent-encoded, so that `@`, `:`, `/`, `?`, `#` and `%` survive.
    for (const password of ['plain-hex-value', 'p@ss/word#1', '100%', 'ünïcode']) {
      const config = parseEnv({
        NODE_ENV: 'production',
        DATABASE_URL: interpolate(API.environment?.['DATABASE_URL'] as string, {
          ...EXAMPLE,
          POSTGRES_PASSWORD: password,
        }),
        POSTGRES_PASSWORD: password,
      });
      const url = new URL(databaseUrlFor(config));

      expect(decodeURIComponent(url.password)).toBe(password);
      expect(url.hostname).toBe('db');
    }
  });

  it('refuses to start without a password instead of inventing one', () => {
    // `:?` in the compose file: a blank `POSTGRES_PASSWORD` would create a database nobody can authenticate against, and
    // the image's own default (`postgres`) is a credential that exists in every tutorial on the internet.
    expect(DB.environment?.['POSTGRES_PASSWORD']).toContain('${POSTGRES_PASSWORD:?');
    expect(API.environment?.['POSTGRES_PASSWORD']).toContain('${POSTGRES_PASSWORD:?');
    expect(() => interpolate('${POSTGRES_PASSWORD:?set it}', { POSTGRES_PASSWORD: '' })).toThrow(
      /set it/u,
    );
  });
});

describe('the container environment', () => {
  it('hands over `.env` and then replaces the values that are wrong inside a container', () => {
    // `.env` is written for native development: `localhost`, `./data`, `NODE_ENV=development`. `environment:` wins over
    // `env_file:`, and these six keys are why `cp .env.example .env` is enough for both flows.
    expect(API.env_file).toContain('.env');

    const environment = API.environment ?? {};
    expect(environment['NODE_ENV']).toBe('production');
    expect(environment['HOST']).toBe('0.0.0.0');
    expect(environment['PORT']).toBe('3000');
    // The entrypoint has migrated already, in the open (`P1-DOCK-04`); this removes the second pass, not the check.
    expect(environment['MIGRATE_ON_BOOT']).toBe('false');
    expect(environment['CACHE_DIR']).toBe('/data/cache');
    expect(environment['TMP_DIR']).toBe('/data/tmp');
  });

  it('pins the port the web container proxies to', () => {
    // `docker/nginx.conf` proxies to the `api_upstream` upstream, whose one server is `api:3000` — followed through the
    // indirection here, because a `PORT` from `.env` that disagreed with it would produce a 502 whose message says
    // nothing about ports.
    const nginx = read('docker/nginx.conf');
    const block = /upstream\s+api_upstream\s*\{([^}]*)\}/u.exec(nginx);
    expect(block, 'the upstream `nginx-routing.spec.ts` asserts must exist').not.toBeNull();
    const server = /server\s+([a-z0-9.-]+):(\d+)\s+resolve;/u.exec(block?.[1] ?? '');

    expect(server?.[1]).toBe('api');
    expect(server?.[2]).toBe(String(API.environment?.['PORT']));
  });

  it('never hands the API both halves of the password', () => {
    // `parseEnv` refuses `POSTGRES_PASSWORD` beside `POSTGRES_PASSWORD_FILE` (measured: "cannot be combined with
    // POSTGRES_PASSWORD_FILE; set exactly one of the two"). This file supplies the first one, and `.env` arrives whole
    // through `env_file`, so a `_FILE` line in the template would be the second — a deployment that looks configured and
    // exits at boot. A secrets-based install replaces the mechanism instead (`12-deployment.md` §2).
    for (const [name, service] of SERVICES) {
      expect(service.environment ?? {}, `${name} must not set the file variant`).not.toHaveProperty(
        'POSTGRES_PASSWORD_FILE',
      );
    }
    // …while the half that is set is the same interpolation in both services: one variable, two readers.
    for (const [name, service] of [
      ['db', DB],
      ['api', API],
    ] as const) {
      const value = service.environment?.['POSTGRES_PASSWORD'];
      expect(typeof value, `${name} must interpolate the password`).toBe('string');
      expect(String(value), `${name} must read POSTGRES_PASSWORD`).toContain('${POSTGRES_PASSWORD');
    }
  });

  it('trusts the proxy hop that is actually in front of the API', () => {
    // The API's peer is the `web` container on the compose bridge. `loopback` alone records nginx's address as every
    // client's (one rate-limit bucket for the internet); `uniquelocal` alone does not trust a host-side proxy that
    // reaches the API over loopback. Both, then — and this is the one value an operator must not copy from `.env`.
    const value = API.environment?.['TRUST_PROXY'];
    expect(typeof value).toBe('string');
    const parts = String(value)
      .split(',')
      .map((part) => part.trim());
    expect(parts).toContain('loopback');
    expect(parts).toContain('uniquelocal');
  });

  it('writes no credential into a tracked file', () => {
    // Every credential is an interpolation, so `.env` (gitignored, `chmod 600`) is the only place a secret exists.
    const credentials = ['POSTGRES_PASSWORD', 'ADMIN_PASSWORD', 'IP_HASH_SALT'];
    for (const [name, service] of SERVICES) {
      for (const key of credentials) {
        const value = service.environment?.[key];
        if (value === undefined) continue;
        // `unknown` here is a YAML scalar; a literal secret would be a string, and the assertion is about its text.
        expect(typeof value === 'string' && value.includes('${'), `${name}.${key}`).toBe(true);
      }
    }
    // And the API's own environment is what a container inherits from `.env`, so nothing may be a bare literal secret
    // here — checked above — and no literal password may appear anywhere in the file.
    // Anchored to a line start and requiring the space before the value, so the `${POSTGRES_PASSWORD:?…}` inside a value
    // is not mistaken for a literal password.
    expect(read('compose.yaml')).not.toMatch(/^[ \t]*POSTGRES_PASSWORD:[ \t]+(?!\$\{)/mu);
  });

  it('interpolates one variable, and `.env.example` defines it', () => {
    // This is the `cp .env.example .env && docker compose up -d` promise: every `${…}` in the file resolves from the
    // template the guide tells the operator to copy. There is exactly one, and it is the one value an operator must set;
    // the volume path is a literal that `12-deployment.md` §2 shows how to change.
    const text = read('compose.yaml');
    const used = new Set(
      [...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1] ?? ''),
    );

    // One variable, and it is the only one an operator must set: `api/model`'s environment is otherwise `.env` plus the
    // container's own values, and `env.spec.ts` already owns the rule that every variable in the template is read by the
    // application — a compose-only knob would have to be an exception to it.
    expect([...used]).toEqual(['POSTGRES_PASSWORD']);
    expect(EXAMPLE['POSTGRES_PASSWORD']).not.toBe('');
    // Interpolation of the whole file succeeds with the template's values — the same resolution compose performs.
    expect(() => interpolate(text)).not.toThrow();
  });
});

describe('startup order and health', () => {
  it('waits for a database that answers, and only then starts the API', () => {
    expect(API.depends_on?.['db']?.condition).toBe('service_healthy');
    // The entrypoint's own wait is the backstop for a restart or a database that becomes unready later; healthy-first
    // keeps the common case from spending that minute.
    expect(healthcheckCommand(DB)).toContain('pg_isready');
  });

  it('starts the web server as soon as the API container exists', () => {
    // nginx resolves `api` when it starts. Waiting for *healthy* would keep the UI down for the length of a first
    // migration; this way the operator sees nginx's 502 naming its upstream.
    expect(WEB.depends_on?.['api']?.condition).toBe('service_started');
  });

  it('probes each container with a tool that exists in its image', () => {
    const api = healthcheckCommand(API);
    const web = healthcheckCommand(WEB);

    // The API image is Bun and sources with no OS packages (`dockerfile.spec.ts`), so `curl`/`wget` would fail forever.
    expect(api).toContain('bun');
    expect(api).not.toMatch(/curl|wget/u);
    // `/readyz` rather than `/healthz`: "healthy" in `docker compose ps` should mean "can answer queries".
    expect(api).toContain('/readyz');
    // The web image is `nginx:alpine`, which is busybox — `wget` is there, `curl` is not.
    expect(web).toContain('wget');
    expect(web).toContain('/index.html');
  });

  it('does not make the web container depend on the database', () => {
    // A health probe that asks the API would take the *page that explains the outage* away during an outage. The shell is
    // a static file, so this is the one probe that stays green.
    expect(healthcheckCommand(WEB)).not.toContain('/healthz');
    expect(healthcheckCommand(WEB)).not.toContain('/readyz');

    for (const [name, service] of SERVICES) {
      expect(service.healthcheck?.interval, name).toMatch(/^\d+[sm]$/u);
      expect(service.healthcheck?.timeout, name).toMatch(/^\d+[sm]$/u);
      expect(service.healthcheck?.retries, name).toBeGreaterThan(0);
      expect(service.healthcheck?.start_period, name).toMatch(/^\d+[sm]$/u);
    }
  });

  it('gives the first boot longer than the first request', () => {
    // Migrations, an Argon2id hash and only then a listening socket: a start period in single-digit seconds marks a
    // working container unhealthy while it is still starting, and `restart: unless-stopped` does not restart on
    // unhealthy — the operator just sees `unhealthy` next to a container that is fine.
    expect(API.healthcheck?.start_period).toBe('60s');
  });
});

describe('the volumes', () => {
  it('gives the database its own data directory', () => {
    expect(DB.volumes).toEqual(['pg-data:/var/lib/postgresql/data']);
  });

  it('gives the API the volume its two paths name', () => {
    // `CACHE_DIR` and `TMP_DIR` point inside the mounted volume — a container writing 700 MB artifacts into its own layer
    // would lose them on the next `up`.
    const mount = API.volumes?.[0] ?? '';
    expect(mount).toMatch(/:\/data$/u);
    for (const variable of ['CACHE_DIR', 'TMP_DIR']) {
      expect(String(API.environment?.[variable]), variable).toMatch(/^\/data\//u);
    }
    // The named volume, because a fresh clone has no `./data` owned by uid 10001 and a bind mount would make the first
    // boot fail on permissions instead of working untouched. The bind-mount alternative is a one-line edit the guide shows.
    expect(mount).toBe('data:/data');
  });

  it('keeps both volumes when the stack is taken down', () => {
    // Declared at the top level, so `docker compose down` preserves them and only `down -v` does not — the difference
    // between a restart and an install.
    expect(Object.keys(FILE.volumes ?? {})).toEqual(expect.arrayContaining(['pg-data', 'data']));
  });
});

describe('the deployment guide', () => {
  it('runs the file this test parses', () => {
    const guide = read('docs/12-deployment.md');

    expect(guide).toContain('compose.yaml');
    expect(guide).toContain('docker compose up -d');
    expect(guide).toContain('cp .env.example .env');
    // The three services, named where an operator looks when one of them is not up.
    for (const service of ['db', 'api', 'web']) {
      expect(guide).toMatch(new RegExp(`\\b${service}\\b`, 'u'));
    }
  });

  it('tells the operator what "healthy" means and how to see it', () => {
    const guide = read('docs/12-deployment.md');

    expect(guide).toContain('docker compose ps');
    expect(guide).toContain('readyz');
    expect(guide).toContain('healthz');
  });
});
