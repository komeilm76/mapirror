import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isExcludedFromBuild, parseDockerIgnore } from '../lib/dockerignore';
import {
  contextSources,
  copiesOf,
  instructionsOf,
  parseDockerfile,
  stageNamed,
  type Dockerfile,
  type Instruction,
} from '../lib/dockerfile';

/**
 * The API image's Dockerfile, read as a document (task `P1-DOCK-01`).
 *
 * There is no container engine in this environment, so "image builds" cannot be demonstrated here — but most of what
 * makes an image *wrong* is visible in the file itself, and every item below is a mistake that has bitten this kind of
 * project at least once:
 *
 * | Mistake | What it costs | Assertion |
 * |---|---|---|
 * | a `COPY` of a path `.dockerignore` excludes | the build fails with `not found`, on another machine, after the install | every source is checked against `.dockerignore`, through the same matcher `check-hygiene` uses |
 * | a `COPY` of a path that does not exist | the same failure, one line earlier | every source is checked against the tree |
 * | only `node_modules` copied, not `apps/api/node_modules` | `Cannot find module 'fastify'` at runtime — bun links each workspace's dependencies into **its own** directory (measured, pass 38) | the three `node_modules` copies are required by name |
 * | `latest` as a base tag | two builds of one commit produce two images | the tag must equal the `packageManager` version in the root `package.json` |
 * | no `USER` | the process runs as root and writes root-owned files into the mounted volume | a non-root `USER` in the runtime stage, consistent with the `/data` ownership |
 * | a credential baked into `ENV`/`ARG` | a password in every image layer, for ever | no password/secret/token/`.env` may appear outside a comment |
 * | dev dependencies in the runtime layer | ~200 MB of test runners in production | `--frozen-lockfile --production` must be the install |
 *
 * The behavioural half — that the resulting tree actually boots and answers `/healthz` — was measured by executing the
 * Dockerfile's stages against the working tree (`docs/16-changelog.md`, pass 38); it needs a checkout and a database, so
 * it is a probe rather than a case in this file.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The one file these cases describe. */
const DOCKERFILE = 'docker/api.Dockerfile';

/** Reads a repository file. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** The parsed Dockerfile, read once per module load: it is a fixture, not a mutation target. */
const FILE: Dockerfile = parseDockerfile(read(DOCKERFILE));

/** `.dockerignore`, through the matcher the hygiene check uses. */
const dockerIgnore = parseDockerIgnore(read('.dockerignore'));

describe('the Dockerfile', () => {
  it('exists, and asks buildkit for its frontend', () => {
    expect(existsSync(join(ROOT, DOCKERFILE))).toBe(true);
    // A parser directive only takes effect above every other line, so it is the first one. Without the directive the
    // `# syntax` line is dead text, and a build that later needs a frontend feature fails in a confusing way.
    expect(read(DOCKERFILE).split('\n')[0]?.trim()).toBe('# syntax=docker/dockerfile:1');
  });

  it('builds in two stages, dependencies then runtime', () => {
    const stages = FILE.stages;

    expect(stages.map((stage) => stage.name)).toEqual(['deps', 'runtime']);
    // A stage without a name cannot be copied from, and `--from=0` is a number to keep in step by hand.
    expect(stages.every((stage) => stage.name !== 'default')).toBe(true);
    // The runtime stage must copy the modules the deps stage installed — otherwise it installed them for nothing.
    expect(copiesOf(stageNamed(FILE, 'runtime')).some((copy) => copy.from === 'deps')).toBe(true);
  });

  it('pins the base image to the bun version the repository declares', () => {
    const declared = JSON.parse(read('package.json')) as { packageManager?: string };
    const version = (declared.packageManager ?? '').replace(/^bun@/u, '');

    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    const text = read(DOCKERFILE);
    expect(text).toContain(`ARG BUN_IMAGE=oven/bun:${version}`);
    // Every stage uses the one argument: a second, hard-coded `FROM` is how two halves of an image end up on two
    // versions of the runtime.
    for (const stage of FILE.stages) expect(stage.image).toBe('${BUN_IMAGE}');
    expect(text).not.toMatch(/FROM\s+\S+:latest/u);
  });

  it('installs the lockfile, without dev dependencies', () => {
    const deps = stageNamed(FILE, 'deps');
    const install = instructionsOf(deps, 'RUN')
      .map((instruction) => instruction.args)
      .find((args) => args.includes('bun install'));

    expect(install, 'the deps stage must run `bun install`').toBeDefined();
    // `--frozen-lockfile`: a build resolves nothing the lockfile does not already name.
    expect(install).toContain('--frozen-lockfile');
    // `--production`: a test runner has no business in a runtime image.
    expect(install).toContain('--production');
    expect(install).toContain('--no-progress');
  });

  it('gives the install every workspace manifest the API needs, and no other', () => {
    const deps = stageNamed(FILE, 'deps');
    const copied = copiesOf(deps).flatMap((copy) => copy.sources);
    const workspaces =
      (JSON.parse(read('package.json')) as { workspaces?: string[] }).workspaces ?? [];

    const manifests = workspaces.flatMap((glob) =>
      readdirSync(join(ROOT, glob.split('/')[0] as string))
        .map((entry) => `${glob.split('/')[0] as string}/${entry}/package.json`)
        .filter((path) => existsSync(join(ROOT, path))),
    );
    // `apps/web` is the documented exception: a static bundle, built by `web.Dockerfile` (`P1-DOCK-02`). Every other
    // workspace must be present, or bun resolves nothing for it and the runtime dies on a missing module.
    const excluded = new Map([
      ['apps/web/package.json', 'built by web.Dockerfile, never runs on the server'],
    ]);

    expect(manifests).toContain('apps/api/package.json');
    for (const manifest of manifests) {
      if (excluded.has(manifest)) {
        expect(copied, `${manifest} is ${excluded.get(manifest) as string}`).not.toContain(
          manifest,
        );
      } else {
        expect(copied, `${manifest} must be installed for`).toContain(manifest);
      }
    }
    expect(copied).toContain('bun.lock');
    expect(copied).toContain('package.json');
  });

  it('copies all three node_modules, because bun links each workspace separately', () => {
    // Measured with a production install (pass 38): the store lands in `/app/node_modules/.bun`, and each workspace's
    // symlinks land in that workspace's own `node_modules`. Copying only the first produces an image that boots and
    // then fails on `Cannot find module 'fastify'` — the exact failure this assertion exists to prevent.
    const runtime = stageNamed(FILE, 'runtime');
    const fromDeps = copiesOf(runtime)
      .filter((copy) => copy.from === 'deps')
      .flatMap((copy) => copy.sources);

    expect(fromDeps).toContain('/app/node_modules');
    expect(fromDeps).toContain('/app/apps/api/node_modules');
    expect(fromDeps).toContain('/app/packages/shared/node_modules');
  });

  it('ships the sources and the operator scripts the container has to run', () => {
    const sources = contextSources(FILE);

    for (const required of [
      'apps/api/src',
      'packages/shared/src',
      'scripts/migrate.ts',
      'scripts/init-admin.ts',
      'scripts/reset-admin-password.ts',
      'scripts/wait-for-db.ts',
      'scripts/lib/secret-prompt.ts',
      'docker/entrypoint.api.sh',
    ]) {
      expect(sources, `${required} must be in the image`).toContain(required);
    }
    // Tests are a development artefact; a container has no reason to carry a second copy of the suite.
    expect(sources.some((source) => source.startsWith('scripts/tests'))).toBe(false);
  });

  it('only copies paths that exist, and that the build context keeps', () => {
    // Two failures, one cause: the path is not where the Dockerfile says it is. The first is caught on the building
    // machine, the second only when someone else builds the image.
    for (const source of contextSources(FILE)) {
      expect(existsSync(join(ROOT, source)), `${source} must exist in the repository`).toBe(true);
      expect(
        isExcludedFromBuild(source, dockerIgnore),
        `.dockerignore must keep ${source} in the build context`,
      ).toBe(false);
    }
  });

  it('runs as a non-root user, and owns the volume it writes to', () => {
    const runtime = stageNamed(FILE, 'runtime');
    const user = instructionsOf(runtime, 'USER').at(-1);

    expect(user, 'the runtime stage must switch user').toBeDefined();
    const [uid, gid] = (user?.args ?? '').split(':');
    expect(Number(uid), 'a numeric uid is what `runAsNonRoot` checks').toBeGreaterThan(0);
    expect(Number(gid)).toBeGreaterThan(0);
    // The same ids the volume is handed: a `/data` owned by 0 and a process running as 10001 writes nothing.
    expect(
      runtime.instructions.some((instruction) =>
        instruction.raw.includes(`chown -R ${uid}:${gid} /data`),
      ),
    ).toBe(true);
    // Nothing may switch back to root after that line.
    expect(
      runtime.instructions.slice(runtime.instructions.indexOf(user as Instruction) + 1),
    ).not.toContainEqual(expect.objectContaining({ keyword: 'USER' }));
  });

  it('never bakes a credential into the image', () => {
    // `ARG` and `ENV` survive in the image's metadata, and a `COPY` of a `.env` survives in a layer — either way the
    // value is committed to the registry. The check is on **names and paths**, not on the text: a file called
    // `reset-admin-password.ts` is a script that asks for a password, not a password.
    const all = [...FILE.preamble, ...FILE.stages.flatMap((stage) => stage.instructions)];
    const assignments = all
      .filter((instruction) => instruction.keyword === 'ARG' || instruction.keyword === 'ENV')
      .flatMap((instruction) => instruction.args.split(/\s+/u))
      .filter((token) => token.includes('='));
    const names = assignments.map((token) => token.split('=')[0] ?? '');
    // `DATABASE_URL` is on the list by name because compose derives it from `POSTGRES_PASSWORD` at run time — a DSN in
    // the image would be a second copy of the password, and the one that never gets rotated.
    const credentialNames = names.filter((name) =>
      /(PASSWORD|SECRET|TOKEN|_FILE|DATABASE_URL|DSN)/u.test(name),
    );
    // And by shape, because a name nobody predicted can still carry one: `scheme://user:password@host` is a credential
    // whatever the variable is called.
    const credentialValues = assignments.filter((token) => /:\/\/[^/\s:]+:[^/\s@]+@/u.test(token));

    expect(credentialNames, 'no credential may be baked into ARG or ENV').toEqual([]);
    expect(credentialValues, 'no DSN with a password may be baked into ARG or ENV').toEqual([]);

    const credentialPaths = contextSources(FILE).filter((source) =>
      /(^|\/)(\.env|secrets?)(\.|\/|$)|(\.pem|\.key|\.p12)$/u.test(source),
    );
    expect(credentialPaths, 'no secret file may be copied into a layer').toEqual([]);

    // Secrets reach the process through the environment at run time (`docker compose` reads `.env` on the host), and
    // the file says so where an operator will read it.
    expect(read(DOCKERFILE)).toContain('docker compose');
  });

  it('states where it listens, what stops it, and what it is', () => {
    const runtime = stageNamed(FILE, 'runtime');
    const env = instructionsOf(runtime, 'ENV').map((instruction) => instruction.args);

    expect(env.join(' ')).toContain('NODE_ENV=production');
    // The volume paths are the API's defaults for a container: writes go to a mount, not to the image layer.
    expect(env.join(' ')).toContain('CACHE_DIR=/data/cache');
    expect(env.join(' ')).toContain('TMP_DIR=/data/tmp');
    expect(env.join(' ')).toContain('HOST=0.0.0.0');

    expect(instructionsOf(runtime, 'EXPOSE').map((instruction) => instruction.args)).toEqual([
      '3000',
    ]);
    // The worker loop has to be told to stop, not killed: `docker stop` sends this signal, and compose restarts a
    // process that ignores it.
    expect(instructionsOf(runtime, 'STOPSIGNAL').map((instruction) => instruction.args)).toEqual([
      'SIGTERM',
    ]);

    const cmd = instructionsOf(runtime, 'CMD').at(-1)?.args ?? '';
    expect(cmd).toContain('bun');
    expect(cmd).toContain('apps/api/src/server.ts');
    expect(existsSync(join(ROOT, 'apps/api/src/server.ts'))).toBe(true);

    // `CMD` is the *last* boot step, not the boot: the entrypoint waits for the database, migrates and bootstraps the
    // admin first (`P1-DOCK-04`; `scripts/tests/entrypoint.spec.ts` asserts the order). An image with a `CMD` and no
    // `ENTRYPOINT` starts the API against an empty volume and answers 500 until someone runs the scripts by hand.
    const entrypoint = instructionsOf(runtime, 'ENTRYPOINT').at(-1)?.args ?? '';
    expect(entrypoint).toBe('["/usr/local/bin/entrypoint.api.sh"]');
  });

  it('needs no operating-system packages', () => {
    const text = read(DOCKERFILE);

    // Nothing in this image is compiled at build time — `@node-rs/argon2` ships a prebuilt binary — so there is no
    // toolchain to install and no `apt-get` layer to keep patched.
    expect(text).not.toMatch(/apt-get|apk add|apk update/iu);
    // `ADD` fetches URLs and unpacks tarballs implicitly; `COPY` does neither.
    expect(text).not.toMatch(/^ADD /mu);
    // The classic supply-chain shortcut: a script downloaded and executed in one step.
    expect(text).not.toMatch(/curl[^\n]*\|\s*(sh|bash)/iu);
  });
});

describe('the build context', () => {
  it('is small enough to be a build context', () => {
    // Not every file: `node_modules` is reinstalled, `dist` is rebuilt, `data` is a volume. The Dockerfile copies a
    // dozen paths; anything else in the context is upload time.
    expect(read('.dockerignore')).toContain('node_modules');
    expect(read('.dockerignore')).toContain('data');
    expect(isExcludedFromBuild('node_modules/fastify/index.js', dockerIgnore)).toBe(true);
    expect(isExcludedFromBuild('apps/api/src/server.ts', dockerIgnore)).toBe(false);
  });

  it('is what the deployment guide says it is', () => {
    const guide = read('docs/12-deployment.md');

    // The image is the thing `docker compose up` builds, so the guide has to name the file an operator will edit.
    expect(guide).toContain('docker/api.Dockerfile');
    expect(guide).toContain('non-root');
  });
});
