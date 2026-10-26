import { existsSync, readFileSync } from 'node:fs';
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
} from '../lib/dockerfile';

/**
 * The web image's Dockerfile (task `P1-DOCK-02`).
 *
 * The same shape of check as `dockerfile.spec.ts` (the API image), for a build that is nearly the mirror image of it: the
 * API image installs **production** dependencies and ships the sources, the web image installs **development**
 * dependencies and ships a bundle. Everything below is a way to get that wrong:
 *
 * | Mistake | What it costs | Assertion |
 * |---|---|---|
 * | `--production` in the build stage | `vite: not found`, and no `dist/` at all | the install must not be `--production` |
 * | a hand-written `vite build` instead of the workspace script | two build definitions that drift | the `RUN` must be `bun run --filter @mapirror/web build` |
 * | sources copied *before* the install | every source edit re-installs 261 packages | the manifests are copied before the `RUN`, the sources after |
 * | `dist/` read from the build context instead of the build stage | an image serving whatever was last built on the developer's disk, or nothing | the copy must be `--from=build` |
 * | a `root` in nginx and a `COPY` destination that disagree | nginx serving a directory that is empty | the two files are cross-checked |
 * | a bundle served by root | the same reason as the API image | a numeric non-root `USER` |
 * | the base image's entrypoint left in place | it edits `/etc/nginx/conf.d/default.conf`, which this image does not use and uid 101 cannot write | `ENTRYPOINT []` |
 *
 * What is *not* claimed here: that the image builds or that nginx serves it. There is no container engine in this
 * environment; the build was rehearsed on a staging tree (pass 39) and `docker/nginx.conf` was run against the real bundle
 * with a locally built nginx 1.29.0 (`nginx-conf.spec.ts` records what that proved).
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The file these cases describe. */
const DOCKERFILE = 'docker/web.Dockerfile';

/** Reads a repository file. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** The parsed Dockerfile. */
const FILE: Dockerfile = parseDockerfile(read(DOCKERFILE));

/** `.dockerignore`, through the same matcher the gate uses. */
const dockerIgnore = parseDockerIgnore(read('.dockerignore'));

/** The build stage. */
const BUILD = stageNamed(FILE, 'build');

/** The runtime stage. */
const RUNTIME = stageNamed(FILE, 'runtime');

/** The single `RUN` line of a stage that contains a phrase. */
function runContaining(stage: typeof BUILD, phrase: string): string {
  return instructionsOf(stage, 'RUN')
    .map((instruction) => instruction.args)
    .filter((args) => args.includes(phrase))
    .join('\n');
}

describe('the web Dockerfile', () => {
  it('exists, and asks buildkit for its frontend', () => {
    expect(existsSync(join(ROOT, DOCKERFILE))).toBe(true);
    expect(read(DOCKERFILE).split('\n')[0]?.trim()).toBe('# syntax=docker/dockerfile:1');
  });

  it('builds the bundle, then serves it', () => {
    expect(FILE.stages.map((stage) => stage.name)).toEqual(['build', 'runtime']);
    // The only thing that crosses the stage boundary is the built directory; if nothing does, the build was for nothing.
    const fromBuild = copiesOf(RUNTIME).filter((copy) => copy.from === 'build');
    expect(fromBuild).toHaveLength(1);
    expect(fromBuild[0]?.sources).toEqual(['/app/apps/web/dist']);
  });

  it('pins both base images', () => {
    const declared = JSON.parse(read('package.json')) as { packageManager?: string };
    const bunVersion = (declared.packageManager ?? '').replace(/^bun@/u, '');

    // The same bun the repository pins and the API image uses: two images on two runtimes is two sets of bugs.
    expect(read(DOCKERFILE)).toContain(`ARG BUN_IMAGE=oven/bun:${bunVersion}`);
    expect(read(DOCKERFILE)).toMatch(/ARG NGINX_IMAGE=nginx:\d+\.\d+\.\d+-alpine/u);
    for (const stage of FILE.stages) expect(stage.image).toMatch(/^\$\{(BUN|NGINX)_IMAGE\}$/u);
    expect(read(DOCKERFILE)).not.toMatch(/FROM\s+\S+:latest/u);
    // Alpine, not the Debian image: the runtime carries no toolchain, and the difference is ~100 MB.
    expect(read(DOCKERFILE)).toContain('nginx:1.29.0-alpine');
  });

  it('installs development dependencies, because the bundler is one', () => {
    const install = runContaining(BUILD, 'bun install');

    expect(install).toContain('--frozen-lockfile');
    // The mirror image of the API image's rule: without vite there is no build at all.
    expect(install).not.toContain('--production');
    expect(install).toContain('--no-progress');
  });

  it('keeps the install layer above the sources', () => {
    // A source edit must not invalidate the install: the whole-directory copies have to come after the `RUN`, and the only
    // `RUN` after them is the build itself. Written as an order assertion, because "the sources are somewhere in the file"
    // is true of a Dockerfile that reinstalls 261 packages on every typo.
    const body = BUILD.instructions;
    const install = body.findIndex(
      (instruction) => instruction.keyword === 'RUN' && instruction.args.includes('bun install'),
    );
    expect(install).toBeGreaterThan(-1);

    const firstSourceCopy = body.findIndex(
      (instruction) =>
        instruction.keyword === 'COPY' &&
        /(^|\s)(\.\/)?(apps\/web|packages\/shared)(\s|$)/u.test(instruction.args),
    );
    expect(firstSourceCopy, 'the sources must be copied after the install').toBeGreaterThan(
      install,
    );

    const runsAfter = body
      .slice(install + 1)
      .filter((instruction) => instruction.keyword === 'RUN');
    expect(runsAfter.map((instruction) => instruction.args)).toEqual([
      'bun run --filter @mapirror/web build',
    ]);
  });

  it('runs the workspace script rather than a second build definition', () => {
    const scripts = JSON.parse(read('apps/web/package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(scripts.scripts?.['build']).toBeDefined();
    expect(runContaining(BUILD, 'bun run --filter @mapirror/web build')).not.toBe('');
    // The script the image runs is the one `bun run build:web` runs at the root.
    const root = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(root.scripts?.['build:web']).toContain('@mapirror/web');
  });

  it('copies everything vite reads, and nothing it does not', () => {
    const sources = contextSources(FILE);

    for (const required of [
      'package.json',
      'bun.lock',
      'apps/web/package.json',
      'apps/web',
      'packages/shared',
    ]) {
      expect(sources, `${required} is needed for the build`).toContain(required);
    }
    // `apps/web` is copied whole, which is what covers `vite.config.ts`'s imports (`alias.ts`, `dev-proxy.ts`) and the
    // `index.html` Vite starts from — listing files one by one is how a build breaks three weeks later.
    expect(sources).toContain('apps/web');
  });

  it('only copies paths that exist, and that the build context keeps', () => {
    for (const source of contextSources(FILE)) {
      expect(existsSync(join(ROOT, source)), `${source} must exist`).toBe(true);
      expect(isExcludedFromBuild(source, dockerIgnore), `.dockerignore must keep ${source}`).toBe(
        false,
      );
    }
  });

  it('serves the bundle where nginx.conf says it does', () => {
    const config = read('docker/nginx.conf');
    const copied = copiesOf(RUNTIME).filter((copy) => copy.from === 'build');
    const root = /^\s*root\s+(\S+);$/mu.exec(config)?.[1];

    expect(root).toBeDefined();
    // The failure this prevents: a `COPY` to `/usr/share/nginx/html` and a `root` naming something else — an image that
    // starts, answers 404 for everything, and looks like a broken build.
    expect(copied[0]?.dest).toBe(root);
    // And the config itself has to reach the path nginx reads at startup.
    expect(
      copiesOf(RUNTIME)
        .map((copy) => copy.raw)
        .join('\n'),
    ).toContain('COPY docker/nginx.conf /etc/nginx/nginx.conf');
  });

  it('listens where nginx.conf listens, and runs unprivileged', () => {
    const config = read('docker/nginx.conf');
    const listen = /^\s*listen\s+(\d+);$/mu.exec(config)?.[1];

    expect(listen).toBeDefined();
    // A port below 1024 cannot be bound without a capability, and the container is not given one.
    expect(Number(listen)).toBeGreaterThan(1023);
    expect(instructionsOf(RUNTIME, 'EXPOSE').map((instruction) => instruction.args)).toEqual([
      listen,
    ]);

    const user = instructionsOf(RUNTIME, 'USER').at(-1)?.args ?? '';
    const [uid, gid] = user.split(':');
    expect(Number(uid), 'a numeric uid is what `runAsNonRoot` checks').toBeGreaterThan(0);
    expect(Number(gid)).toBeGreaterThan(0);
    // Nothing may write to the filesystem after the switch: a `COPY` or `RUN` below `USER` would either fail (the
    // destination is root-owned) or, worse, succeed and leave files the process cannot read back.
    const userIndex = RUNTIME.instructions.findIndex(
      (instruction) => instruction.keyword === 'USER',
    );
    expect(userIndex).toBeGreaterThan(-1);
    expect(
      RUNTIME.instructions.slice(userIndex + 1).map((instruction) => instruction.keyword),
    ).toEqual(['EXPOSE', 'STOPSIGNAL', 'ENTRYPOINT', 'CMD']);
  });

  it('stops gracefully and starts nginx itself', () => {
    // `docker stop` sends SIGTERM; nginx treats that as an immediate shutdown that can cut a download in half, and SIGQUIT
    // as the graceful one.
    expect(instructionsOf(RUNTIME, 'STOPSIGNAL').map((instruction) => instruction.args)).toEqual([
      'SIGQUIT',
    ]);

    // The base image's entrypoint edits `/etc/nginx/conf.d/default.conf` — a root-owned file this image does not use.
    // Measured: as uid 101 that write is refused, so the entrypoint is replaced with nothing.
    expect(instructionsOf(RUNTIME, 'ENTRYPOINT').map((instruction) => instruction.args)).toEqual([
      '[]',
    ]);

    const cmd = instructionsOf(RUNTIME, 'CMD').at(-1)?.args ?? '';
    expect(cmd).toContain('nginx');
    // Without `daemon off` the container's main process forks and exits, and the container stops while nginx keeps running
    // in a process nothing is watching.
    expect(cmd).toContain('daemon off;');
  });

  it('needs no operating-system packages and no secrets', () => {
    const text = read(DOCKERFILE);

    expect(text).not.toMatch(/apt-get|apk add|apk update/iu);
    expect(text).not.toMatch(/^ADD /mu);
    expect(text).not.toMatch(/curl[^\n]*\|\s*(sh|bash)/iu);
    // Nothing in this image needs a credential: it is static files and one config.
    expect(text).not.toMatch(/^(ARG|ENV)\s+\S*(PASSWORD|SECRET|TOKEN|DATABASE_URL)/mu);
  });

  it('is what the deployment guide says it is', () => {
    const guide = read('docs/12-deployment.md');

    expect(guide).toContain('docker/web.Dockerfile');
    // The host port the guide tells an operator to open, and the container port nginx listens on.
    expect(guide).toContain('8080');
  });
});
