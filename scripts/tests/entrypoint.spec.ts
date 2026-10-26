import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
 * `docker/entrypoint.api.sh` — the API container's boot sequence (task `P1-DOCK-04`, requirement DOCK-2).
 *
 * The script is 120 lines of shell that decide whether a `docker compose up -d` on a clean Ubuntu box needs a human.
 * Four things make it right, and each is an assertion below:
 *
 * | Property | What breaks without it |
 * |---|---|
 * | the four steps, in order | `init-admin` before `migrate` fails with `relation "admins" does not exist` on a clean volume — the one case the task exists for |
 * | `exec` for the last step | a waiting shell stays PID 1 and swallows `SIGTERM`, so `docker stop` becomes `SIGKILL` after the grace period and the API never drains |
 * | a failing step stops the boot | a container that starts its API with no database and no admin looks healthy in `docker ps` and serves `503` |
 * | nothing touches the password | `ADMIN_PASSWORD` in a `set -x` trace, an `echo`, or a `printf` is a secret in `docker compose logs` for ever |
 *
 * The behavioural half — that the chain really goes from empty volume to a serving API, twice, and that a missing
 * password on a *fresh* database stops the boot — was probed by running this exact file against a real PostgreSQL
 * (`docs/16-changelog.md`, pass 42). What is left to a test is the reading: structure, order, and which commands the
 * image actually contains.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The script under test. */
const SCRIPT = 'docker/entrypoint.api.sh';

/** The image that installs it. */
const DOCKERFILE = 'docker/api.Dockerfile';

/** Reads a repository file. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** The script, with its comment lines removed: a comment is documentation, and the assertions are about behaviour. */
const CODE = read(SCRIPT)
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

/** The Dockerfile, parsed. */
const FILE: Dockerfile = parseDockerfile(read(DOCKERFILE));

/** The stage that runs. */
const RUNTIME = stageNamed(FILE, 'runtime');

/** `.dockerignore`, through the matcher the gate uses. */
const dockerIgnore = parseDockerIgnore(read('.dockerignore'));

/** Where the image puts the script; the `ENTRYPOINT` and the `COPY` must agree on it. */
const INSTALLED_AT = '/usr/local/bin/entrypoint.api.sh';

describe('the script', () => {
  it('exists, is executable, and is valid POSIX shell', () => {
    expect(existsSync(join(ROOT, SCRIPT))).toBe(true);
    // The bit is in git, and an `ENTRYPOINT` in exec form needs it even when the image copies with `--chmod`.
    expect(statSync(join(ROOT, SCRIPT)).mode & 0o111, 'mode 0755').toBeGreaterThan(0);
    // `/bin/sh`, not bash: the image is Debian-based and `sh` is what every future base image has.
    expect(read(SCRIPT).split('\n')[0]).toBe('#!/bin/sh');
    // Parsed by a real shell, not by my reading: `sh -n` is the syntax check an editor would run.
    expect(() => execFileSync('sh', ['-n', join(ROOT, SCRIPT)])).not.toThrow();
  });

  it('fails fast and loudly', () => {
    // `-e`: a failed step stops the script instead of continuing to the next one. `-u`: a typo in a variable name is
    // an error rather than an empty string — `$ADMIN_PASWORD` would otherwise expand to nothing and pass silently.
    expect(CODE).toMatch(/^set -eu$/mu);
    // The two ways a shell script "handles" errors badly: ignoring one, or tracing the whole environment.
    expect(CODE).not.toMatch(/\|\|\s*true/u);
    expect(CODE).not.toMatch(/^\s*set \+e/mu);
    // `set -x` prints every expanded word, including any secret a future step passes on the command line.
    expect(CODE).not.toMatch(/^\s*set -x/mu);
  });

  it('runs the four steps in the one order that works on an empty volume', () => {
    // The order is the task: the database has to answer, `admins` has to exist, and only then can the account be
    // bootstrapped — and the API is the last thing, because it is what serves traffic.
    const steps = [
      'bun scripts/wait-for-db.ts',
      'bun scripts/migrate.ts',
      'bun scripts/init-admin.ts --bootstrap',
      'bun apps/api/src/server.ts',
    ].map((step) => CODE.indexOf(step));

    for (const [index, at] of steps.entries()) {
      expect(at, `${steps[index]} must be in the script`).toBeGreaterThan(-1);
      if (index > 0) expect(at).toBeGreaterThan(steps[index - 1] as number);
    }
  });

  it('bootstraps the admin in the mode that survives a restart', () => {
    // Without `--bootstrap`, the step asks for a password on every boot and exits 1 when `ADMIN_PASSWORD` has been
    // removed from `.env` — a working install that refuses to restart (the defect this task fixed, pass 42).
    expect(CODE).toContain('bun scripts/init-admin.ts --bootstrap');
    expect(CODE).not.toMatch(/init-admin\.ts(?!\s+--bootstrap)/u);
  });

  it('becomes the API instead of waiting for it', () => {
    // `exec` replaces the shell, so the API is PID 1 and receives `docker stop`'s SIGTERM itself. A script that ran
    // `bun ...` without `exec` would take the signal and leave the API to be killed after the grace period.
    expect(CODE).toMatch(/^exec bun apps\/api\/src\/server\.ts$/mu);
    // …and an explicit command still wins, which is what makes `docker run <image> bun scripts/migrate.ts` usable.
    expect(CODE).toMatch(/^\s*exec "\$@"$/mu);
    expect(CODE).toMatch(/if \[ "\$#" -gt 0 \]/u);
  });

  it('numbers its four steps, so a failure line points at one of them', () => {
    // The failure message quotes the label, and the operator reads the label against this file and `05-flows.md` F1.
    // A label that counts wrong (`step 2/4` twice) makes that cross-reference useless.
    const labels = [...CODE.matchAll(/step (\d)\/4: [a-z]/gu)].map((match) => match[1]);

    // Steps 1–3 run once; step 4 is the API start, which exists twice because an override and the default are two
    // different commands.
    expect(labels.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(new Set(labels.slice(3))).toEqual(new Set(['4']));
  });

  it('reports which step failed, with its exit code', () => {
    // The line an operator reads at 2 a.m.: not "the container exited", but which of four things failed and what the
    // process said. `$?` is captured from the failed command, and the script exits with the same code.
    expect(CODE).toContain('failed (exit $status); the API is not started');
    expect(CODE).toMatch(/exit "\$status"/u);
  });

  it('runs from the application root rather than from wherever it was started', () => {
    // Every path in the script is relative (`scripts/…`). A container started with `--workdir /` would otherwise run
    // `./scripts/migrate.ts` against nothing.
    const cd = CODE.indexOf('cd /app');
    expect(cd).toBeGreaterThan(-1);
    expect(cd).toBeLessThan(CODE.indexOf('bun scripts/wait-for-db.ts'));
  });

  it('never touches the password', () => {
    // The secret is read by `init-admin.ts` through the validated configuration. Nothing here may name it, print it,
    // or pass it — a shell variable is one `set -x` away from the log, and a `ps` listing away from the host.
    for (const leak of ['ADMIN_PASSWORD', 'printenv', 'env |', 'set -x', '--password']) {
      expect(CODE, `the entrypoint must not mention ${leak}`).not.toContain(leak);
    }
  });

  it('uses only the tools the image has', () => {
    // The API image installs no OS packages (`dockerfile.spec.ts` asserts it): there is no `psql`, no `pg_isready`, no
    // `curl`, no `nc`. And no `sleep` loop — the wait is a TypeScript script that asks the database a question.
    for (const missing of [
      'psql',
      'pg_isready',
      'apt-get',
      'apk',
      'curl',
      'wget',
      'nc ',
      'sleep ',
    ]) {
      expect(CODE, `${missing} does not exist in the image`).not.toContain(missing);
    }
    // `bun` and shell builtins are all that is left: every step is a `bun` invocation of a file in the repository.
    expect(CODE.match(/\bbun (?:scripts|apps)\/\S+/gu)).toHaveLength(4);
  });
});

describe('the image that installs it', () => {
  it('starts from the entrypoint, and copies it where the entrypoint says', () => {
    expect(instructionsOf(RUNTIME, 'ENTRYPOINT').map((instruction) => instruction.args)).toEqual([
      `["${INSTALLED_AT}"]`,
    ]);

    // The `COPY` and the `ENTRYPOINT` are two lines that have to agree; a path one character off is an image that
    // fails at `docker run` with "no such file or directory" after a successful build.
    const install = copiesOf(RUNTIME).find((copy) => copy.sources.includes(SCRIPT));

    expect(install, `${SCRIPT} must be copied into the image`).toBeDefined();
    expect(install?.dest).toBe(INSTALLED_AT);
    expect(install?.raw).toContain('--chmod=0755');
    // The script has to exist in the build context and survive `.dockerignore` — the two ways a `COPY` fails.
    expect(isExcludedFromBuild(SCRIPT, dockerIgnore)).toBe(false);
    expect(contextSources(FILE)).toContain(SCRIPT);
  });

  it('installs it before dropping to the unprivileged user', () => {
    // `/usr/local/bin` belongs to root. A `COPY` after `USER 10001` fails the build with a permission error that reads
    // like a broken context.
    const instructions = RUNTIME.instructions.map((instruction) => instruction.raw);
    const copyAt = instructions.findIndex((line) => line.includes(SCRIPT));
    const userAt = instructions.findIndex((line) => line.startsWith('USER '));

    expect(copyAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(copyAt);
  });

  it('keeps the API as the command the entrypoint starts', () => {
    // The entrypoint's last step, and the thing an override replaces. If the CMD were the entrypoint itself the
    // script would re-enter itself; if it were empty, the default boot would be "do nothing".
    const cmd = instructionsOf(RUNTIME, 'CMD').at(-1)?.args ?? '';

    expect(cmd).toContain('bun');
    expect(cmd).toContain('apps/api/src/server.ts');
    expect(existsSync(join(ROOT, 'apps/api/src/server.ts'))).toBe(true);
  });

  it('ships every script the four steps call', () => {
    // A step naming a file the image does not contain fails at runtime, on the operator's machine, one boot at a time.
    const copies = contextSources(FILE);

    for (const script of [
      'scripts/wait-for-db.ts',
      'scripts/migrate.ts',
      'scripts/init-admin.ts',
      'scripts/reset-admin-password.ts',
    ]) {
      expect(copies, `${script} must be in the image`).toContain(script);
    }
  });
});

describe('the documentation', () => {
  it('walks through the same four commands, in the same order', () => {
    const guide = read('docs/12-deployment.md');

    // A guide and a script drift one edit at a time: a step renumbered here and not there is how the failure line an
    // operator greps (`step 2/4`) stops matching the command they are looking for.
    const documented = [
      'scripts/wait-for-db.ts',
      'scripts/migrate.ts',
      'scripts/init-admin.ts --bootstrap',
      'apps/api/src/server.ts',
    ].map((command) => guide.indexOf(command));

    for (const [index, at] of documented.entries()) {
      expect(at, `the guide must document the command at position ${index + 1}`).toBeGreaterThan(
        -1,
      );
      if (index > 0) expect(at).toBeGreaterThan(documented[index - 1] as number);
    }
    // The file that owns the order has to be named, or the walkthrough describes a boot nobody can find the code for.
    expect(guide).toContain('docker/entrypoint.api.sh');
  });

  it('names the flags an operator needs when something does not start', () => {
    const guide = read('docs/12-deployment.md');

    // `--bootstrap` is the difference between a restart and a refusal (it was a defect, pass 42); `--timeout` is the
    // answer to the top support question a slow database produces. Both belong in the guide, not only in `--help`.
    expect(guide).toContain('--bootstrap');
    expect(guide).toContain('--timeout');
    // The guide says what a failure looks like, so the log line is recognisable before it happens.
    expect(guide).toMatch(/the API is not started/u);
  });
});
