import { describe, expect, it, vi } from 'vitest';

import { main, parseArgs } from '../migrate';

/**
 * The operator-facing half of `P1-DB-01`: what `bun run db:migrate` accepts, and what it refuses.
 *
 * The migration work itself is tested in `apps/api/tests` (unit) and
 * `apps/api/tests/integration/migrations.spec.ts` (against a real server). What is tested *here* is the part that
 * runs unattended in a container entrypoint (`P1-DOCK-04`), where the failure modes are a mistyped flag and an
 * exit code somebody's shell script believes.
 */

describe('parseArgs', () => {
  it('defaults to a plain migrate', () => {
    expect(parseArgs([])).toEqual({ reset: false, help: false });
  });

  it('reads both flags in any order', () => {
    expect(parseArgs(['--reset', '--help'])).toEqual({ reset: true, help: true });
    expect(parseArgs(['--help', '--reset'])).toEqual({ reset: true, help: true });
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    // `--resest` doing nothing on the command that drops schemas is the mistake this catches.
    expect(() => parseArgs(['--resest'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--reset', 'extra'])).toThrow(/unknown argument/);
  });
});

describe('main', () => {
  it('prints usage and exits 0 for --help, without touching the database', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(main(['--help'])).resolves.toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('--reset');
    } finally {
      log.mockRestore();
    }
  });

  it('exits 1 on an unknown flag', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(main(['--resest'])).resolves.toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('unknown argument');
    } finally {
      error.mockRestore();
    }
  });

  it('refuses --reset in production before opening a connection', async () => {
    // The DSN points at a closed port on purpose: if the guard ran after the connection, the message would be a
    // connection error instead of the refusal. That is the difference between a guard and a comment.
    const env = { ...process.env };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:1/none';
      process.env.ADMIN_PASSWORD = 'a-long-enough-dev-password';

      await expect(main(['--reset'])).resolves.toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('NODE_ENV=production');
    } finally {
      process.env = env;
      error.mockRestore();
    }
  });
});
