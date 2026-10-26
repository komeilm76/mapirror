import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isExcludedFromBuild, parseDockerIgnore } from '../lib/dockerignore';

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

/** One parsed instruction. */
interface Instruction {
  readonly keyword: string;
  /** Everything after the keyword, whitespace-normalised. */
  readonly args: string;
  /** The whole logical line, for matching. */
  readonly raw: string;
}

/** One `FROM … AS …` and everything under it. */
interface Stage {
  readonly name: string;
  readonly image: string;
  readonly instructions: readonly Instruction[];
}

/**
 * Splits a Dockerfile into logical lines: continuations joined, comments and blanks dropped.
 *
 * @param text - The Dockerfile's contents.
 * @returns One string per instruction.
 */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let buffer = '';
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (buffer === '' && (line.trim() === '' || line.trimStart().startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      buffer += `${line.slice(0, -1)} `;
      continue;
    }
    buffer += line;
    lines.push(buffer.replace(/\s+/gu, ' ').trim());
    buffer = '';
  }
  return lines;
}

/**
 * Parses the Dockerfile into its global instructions and its stages.
 *
 * An `ARG` before the first `FROM` is not stray text: it is the only way to parameterise a `FROM` line, and this
 * Dockerfile uses it for the base image. So prelude instructions are kept, not rejected.
 *
 * @returns `preamble` (instructions above the first `FROM`) and `stages`, in file order.
 */
function parseFile(): { readonly preamble: Instruction[]; readonly stages: Stage[] } {
  const preamble: Instruction[] = [];
  const stages: Stage[] = [];
  for (const raw of logicalLines(read(DOCKERFILE))) {
    const keyword = (raw.split(' ')[0] ?? '').toUpperCase();
    if (keyword === 'FROM') {
      const tokens = raw.split(' ');
      stages.push({
        name: tokens[3] ?? 'default',
        image: tokens[1] ?? '',
        instructions: [],
      });
      continue;
    }
    const parsed: Instruction = { keyword, args: raw.slice(keyword.length).trim(), raw };
    const current = stages.at(-1);
    if (current === undefined) {
      preamble.push(parsed);
      continue;
    }
    (current.instructions as Instruction[]).push(parsed);
  }
  return { preamble, stages };
}

/**
 * Every stage, in file order.
 *
 * @returns The parsed stages.
 */
function parseStages(): Stage[] {
  return parseFile().stages;
}

/**
 * The instructions above the first `FROM`.
 *
 * @returns Those instructions, in file order.
 */
function preambleInstructions(): Instruction[] {
  return parseFile().preamble;
}

/**
 * The instructions of a stage, by keyword.
 *
 * @param stage - The stage to search.
 * @param keyword - Instruction keyword, case-insensitive.
 * @returns Matching instructions, in order.
 */
function instructionsOf(stage: Stage, keyword: string): Instruction[] {
  return stage.instructions.filter((instruction) => instruction.keyword === keyword.toUpperCase());
}

/**
 * The operands of every `COPY` in a stage, with the source/destination split.
 *
 * @param stage - The stage to read.
 * @returns One entry per `COPY`, in order.
 */
function copiesOf(stage: Stage): {
  readonly sources: string[];
  readonly dest: string;
  readonly from?: string;
  readonly raw: string;
}[] {
  return instructionsOf(stage, 'COPY').map((instruction) => {
    const tokens = instruction.args.split(' ').filter((token) => token.length > 0);
    const flags = tokens.filter((token) => token.startsWith('--'));
    const operands = tokens.filter((token) => !token.startsWith('--'));
    const from = flags.find((flag) => flag.startsWith('--from='))?.slice('--from='.length);
    return {
      sources: operands.slice(0, -1),
      dest: operands.at(-1) ?? '',
      ...(from === undefined ? {} : { from }),
      raw: instruction.raw,
    };
  });
}

/** Every context path the Dockerfile copies, normalised (no `./`, no trailing `/`). */
function contextSources(): string[] {
  const runtime = parseStages().find((stage) => stage.name === 'runtime');
  const deps = parseStages().find((stage) => stage.name === 'deps');
  const copies = [
    ...(deps === undefined ? [] : copiesOf(deps)),
    ...(runtime === undefined ? [] : copiesOf(runtime)),
  ];
  return copies
    .filter((copy) => copy.from === undefined)
    .flatMap((copy) => copy.sources)
    .map((source) => source.replace(/^\.\//u, '').replace(/\/$/u, ''));
}

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
    const stages = parseStages();

    expect(stages.map((stage) => stage.name)).toEqual(['deps', 'runtime']);
    // A stage without a name cannot be copied from, and `--from=0` is a number to keep in step by hand.
    expect(stages.every((stage) => stage.name !== 'default')).toBe(true);
    // The runtime stage must copy the modules the deps stage installed — otherwise it installed them for nothing.
    expect(copiesOf(stages[1] as Stage).some((copy) => copy.from === 'deps')).toBe(true);
  });

  it('pins the base image to the bun version the repository declares', () => {
    const declared = JSON.parse(read('package.json')) as { packageManager?: string };
    const version = (declared.packageManager ?? '').replace(/^bun@/u, '');

    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    const text = read(DOCKERFILE);
    expect(text).toContain(`ARG BUN_IMAGE=oven/bun:${version}`);
    // Every stage uses the one argument: a second, hard-coded `FROM` is how two halves of an image end up on two
    // versions of the runtime.
    for (const stage of parseStages()) expect(stage.image).toBe('${BUN_IMAGE}');
    expect(text).not.toMatch(/FROM\s+\S+:latest/u);
  });

  it('installs the lockfile, without dev dependencies', () => {
    const deps = parseStages()[0] as Stage;
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
    const deps = parseStages()[0] as Stage;
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
    const runtime = parseStages()[1] as Stage;
    const fromDeps = copiesOf(runtime)
      .filter((copy) => copy.from === 'deps')
      .flatMap((copy) => copy.sources);

    expect(fromDeps).toContain('/app/node_modules');
    expect(fromDeps).toContain('/app/apps/api/node_modules');
    expect(fromDeps).toContain('/app/packages/shared/node_modules');
  });

  it('ships the sources and the operator scripts the container has to run', () => {
    const sources = contextSources();

    for (const required of [
      'apps/api/src',
      'packages/shared/src',
      'scripts/migrate.ts',
      'scripts/init-admin.ts',
      'scripts/reset-admin-password.ts',
      'scripts/lib/secret-prompt.ts',
    ]) {
      expect(sources, `${required} must be in the image`).toContain(required);
    }
    // Tests are a development artefact; a container has no reason to carry a second copy of the suite.
    expect(sources.some((source) => source.startsWith('scripts/tests'))).toBe(false);
  });

  it('only copies paths that exist, and that the build context keeps', () => {
    // Two failures, one cause: the path is not where the Dockerfile says it is. The first is caught on the building
    // machine, the second only when someone else builds the image.
    for (const source of contextSources()) {
      expect(existsSync(join(ROOT, source)), `${source} must exist in the repository`).toBe(true);
      expect(
        isExcludedFromBuild(source, dockerIgnore),
        `.dockerignore must keep ${source} in the build context`,
      ).toBe(false);
    }
  });

  it('runs as a non-root user, and owns the volume it writes to', () => {
    const runtime = parseStages()[1] as Stage;
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
    const all = [
      ...preambleInstructions(),
      ...parseStages().flatMap((stage) => stage.instructions),
    ];
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

    const credentialPaths = contextSources().filter((source) =>
      /(^|\/)(\.env|secrets?)(\.|\/|$)|(\.pem|\.key|\.p12)$/u.test(source),
    );
    expect(credentialPaths, 'no secret file may be copied into a layer').toEqual([]);

    // Secrets reach the process through the environment at run time (`docker compose` reads `.env` on the host), and
    // the file says so where an operator will read it.
    expect(read(DOCKERFILE)).toContain('docker compose');
  });

  it('states where it listens, what stops it, and what it is', () => {
    const runtime = parseStages()[1] as Stage;
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
