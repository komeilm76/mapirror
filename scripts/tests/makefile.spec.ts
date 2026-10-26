import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8');

interface MakeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly args: readonly string[];
}

/** Runs a Make target with fake Docker/Bun executables, capturing exactly what the target asks them to do. */
function runMake(
  target: string,
  options: { readonly service?: string; readonly status?: number } = {},
): MakeResult {
  const temp = mkdtempSync(join(tmpdir(), 'mapirror-make-'));
  const bin = join(temp, 'bin');
  const capture = join(temp, 'args');
  const command = `#!/bin/sh\nprintf '%s\\n' "$@" > "$MAKE_CAPTURE"\nexit "${options.status ?? 0}"\n`;
  const executableNames = target === 'test' ? ['bun'] : ['docker'];

  try {
    mkdirSync(bin);
    for (const name of executableNames) {
      const path = join(bin, name);
      writeFileSync(path, command, { mode: 0o755 });
      chmodSync(path, 0o755);
    }

    const env = {
      ...process.env,
      MAKE_CAPTURE: capture,
      PATH: [bin, process.env.PATH ?? '/usr/bin:/bin'].join(delimiter),
    };
    const makeArgs = ['-f', 'Makefile', target];
    if (options.service !== undefined) makeArgs.push(`SERVICE=${options.service}`);
    const result = spawnSync('make', makeArgs, { cwd: ROOT, env, encoding: 'utf8' });
    const args = readFileSync(capture, 'utf8').trimEnd().split('\n').filter(Boolean);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, args };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('Makefile (P1-DOCK-06)', () => {
  it('declares every operator target phony so same-named files cannot suppress the command', () => {
    expect(MAKEFILE).toMatch(
      /^\.PHONY:.*\bup\b.*\bdown\b.*\blogs\b.*\bmigrate\b.*\btest\b.*\breset-admin\b/mu,
    );
  });

  it('builds and starts the stack', () => {
    expect(runMake('up').args).toEqual(['compose', 'up', '-d', '--build']);
  });

  it('stops containers without deleting the persistent volumes', () => {
    expect(runMake('down').args).toEqual(['compose', 'down']);
  });

  it('follows all service logs by default and accepts a selected service', () => {
    expect(runMake('logs').args).toEqual(['compose', 'logs', '-f']);
    expect(runMake('logs', { service: 'api' }).args).toEqual(['compose', 'logs', '-f', 'api']);
  });

  it('runs migrations through the API container without allocating a TTY', () => {
    expect(runMake('migrate').args).toEqual([
      'compose',
      'exec',
      '-T',
      'api',
      'bun',
      'scripts/migrate.ts',
    ]);
  });

  it('runs the root Vitest script on the host, not in a container', () => {
    expect(runMake('test').args).toEqual(['run', 'test']);
  });

  it('starts the password reset script with inherited terminal input', () => {
    expect(runMake('reset-admin').args).toEqual([
      'compose',
      'exec',
      'api',
      'bun',
      'scripts/reset-admin-password.ts',
    ]);
  });

  it('returns the wrapped command failure instead of hiding it', () => {
    const result = runMake('down', { status: 17 });
    expect(result.status).toBe(2); // GNU make reports a failed recipe, preserving the original status in its diagnostic.
    expect(result.stderr).toContain('Error 17');
  });
});
