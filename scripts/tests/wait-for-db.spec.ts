import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WAIT_TIMEOUT_SECONDS,
  MAX_REASON_LENGTH,
  MAX_WAIT_TIMEOUT_SECONDS,
  PERMANENT_FAILURES,
  PROGRESS_EVERY_ATTEMPTS,
  WAIT_INTERVAL_MS,
  driverCode,
  main,
  parseArgs,
  reasonFor,
} from '../wait-for-db';
import { AppError } from '../../apps/api/src/lib/errors';
import type { SqlDatabase } from '../../apps/api/src/db/client';

/**
 * `scripts/wait-for-db.ts` (`P1-DOCK-04`) — the entrypoint's first step.
 *
 * The behaviour worth pinning is not "it loops": it is *when it stops*. A wait that gives up too early starts a
 * container that restart-loops against a database that was a second away; one that never gives up turns a broken
 * `DATABASE_URL` into a container that sits there looking healthy to `docker ps` while nothing will ever serve. So the
 * cases below drive a fake clock and a fake handle, and read the deadline from the side an operator would: how many
 * attempts, how long, and what the last line says.
 *
 * No database and no sleeping: `sleep` is injected and advances the clock, so a 60-second timeout is proved in
 * microseconds.
 */

/** An environment that parses, including a password, so the redaction cases have something to leak. */
const ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://mirror:super-secret-password@db:5432/mirror',
};

/** The error `check` throws when the database is not there, in the shape `db/client.ts` builds it. */
function unreachable(cause: Error): AppError {
  return new AppError('DB_UNAVAILABLE', 'The database is not reachable.', undefined, { cause });
}

/** A driver-style failure: an errno code and a message. */
function connectionRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
}

/** A PostgreSQL refusal: the server answered, and the answer will not change. */
function refused(code: string): Error {
  return Object.assign(new Error(`driver detail for ${code}`), { code });
}

/** How a harness failure is driven. */
interface HarnessOptions {
  /** Fail this many attempts, then succeed. `'forever'` never succeeds. */
  readonly failures: number | 'forever';
  /** Milliseconds each `check` consumes on the fake clock — a slow driver, not a slow sleep. */
  readonly attemptMs?: number;
  /** What `check` throws. */
  readonly error?: () => unknown;
  /** Arguments after the script name. */
  readonly argv?: readonly string[];
  /** Environment to read. */
  readonly env?: Record<string, string>;
}

/** Everything a case needs to make assertions about what the command did. */
interface Harness {
  readonly code: number;
  readonly lines: readonly string[];
  readonly errors: readonly string[];
  readonly sleeps: readonly number[];
  /** The per-attempt budget handed to `check`, in order. */
  readonly budgets: readonly number[];
  readonly attempts: number;
  readonly closes: number;
  readonly connects: number;
}

/**
 * Runs `main` against a fake handle and a fake clock.
 *
 * @param options - Failure plan, clock cost, arguments and environment.
 * @returns Exit code and everything the run exposed.
 */
async function run(options: HarnessOptions): Promise<Harness> {
  const lines: string[] = [];
  const errors: string[] = [];
  const sleeps: number[] = [];
  const budgets: number[] = [];
  let clock = 0;
  let attempts = 0;
  let closes = 0;
  let connects = 0;

  const code = await main([...(options.argv ?? [])], {
    env: options.env ?? ENV,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    connect: (): SqlDatabase => {
      connects += 1;
      return {
        // Never touched: the module under test only calls `check` and `close` on the handle.
        db: {} as SqlDatabase['db'],
        close: () => {
          closes += 1;
          return Promise.resolve();
        },
        check: (timeoutMs = 0) => {
          attempts += 1;
          budgets.push(timeoutMs);
          clock += options.attemptMs ?? 0;
          const failing = options.failures === 'forever' || attempts <= options.failures;
          return failing
            ? Promise.reject(unreachable((options.error ?? connectionRefused)() as Error))
            : Promise.resolve();
        },
      };
    },
  });

  return { code, lines, errors, sleeps, budgets, attempts, closes, connects };
}

describe('parseArgs', () => {
  it('waits the documented minute by default', () => {
    expect(parseArgs([])).toEqual({ timeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS, help: false });
    expect(DEFAULT_WAIT_TIMEOUT_SECONDS).toBe(60);
  });

  it('reads --timeout and --help, in any order', () => {
    expect(parseArgs(['--timeout', '300'])).toEqual({ timeoutSeconds: 300, help: false });
    expect(parseArgs(['--help', '--timeout', '5'])).toEqual({ timeoutSeconds: 5, help: true });
  });

  it('refuses a timeout that is not a whole number of seconds', () => {
    // `Number('5min')` is `NaN` and `Number('')` is 0, so the shape is checked first — otherwise every one of these
    // would become "wait zero seconds", which fails on the first attempt and looks like a database problem.
    for (const value of ['abc', '5s', '', '5.5', '-5']) {
      expect(() => parseArgs(['--timeout', value]), value).toThrow(/whole seconds/u);
    }
    expect(() => parseArgs(['--timeout'])).toThrow(/needs a value/u);
  });

  it('refuses a timeout outside the range instead of pretending', () => {
    expect(() => parseArgs(['--timeout', '0'])).toThrow(/between 1 and/u);
    expect(() => parseArgs(['--timeout', String(MAX_WAIT_TIMEOUT_SECONDS + 1)])).toThrow(
      /between 1 and/u,
    );
  });

  it('refuses an unknown flag rather than waiting the default', () => {
    expect(() => parseArgs(['--tmeout', '300'])).toThrow(/unknown argument/u);
  });
});

describe('reasonFor', () => {
  it('prefers the driver’s code, which is the line an operator greps for', () => {
    expect(reasonFor(unreachable(connectionRefused()))).toBe('ECONNREFUSED');
  });

  it('falls back to the message, with any connection string masked', () => {
    const reason = reasonFor(
      unreachable(new Error(`could not connect to ${ENV.DATABASE_URL} and gave up`)),
    );

    expect(reason).toContain('could not connect to');
    expect(reason).toContain('postgres://[redacted]');
    // The whole point: a DSN contains a password (`14-security.md` L9).
    expect(reason).not.toContain('super-secret-password');
  });

  it('keeps one bounded line out of a multi-line driver message', () => {
    const reason = reasonFor(unreachable(new Error(`${'x'.repeat(400)}\nsecond line`)));

    expect(reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
    expect(reason).not.toContain('\n');
  });

  it('describes a thrown non-Error without inventing a reason', () => {
    expect(reasonFor('a string, somehow')).toBe('no reason given');
    expect(reasonFor(undefined)).toBe('no reason given');
  });
});

describe('a refusal that cannot change', () => {
  it('gives up on a wrong password at once, not after the deadline', async () => {
    // The defect this covers: `28P01` spent the whole 60 s retrying and then said "did not answer", which reads like a
    // slow database while the actual answer is in `.env`. One attempt, no sleep, one line that names the code.
    const result = await run({ failures: 'forever', error: () => refused('28P01') });

    expect(result.code).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.sleeps).toEqual([]);
    expect(result.lines).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('28P01');
    expect(result.errors[0]).toMatch(/will keep refusing/u);
    expect(result.errors[0]).toContain('POSTGRES_PASSWORD');
    // The pool is closed on this path too: a leaked client keeps the process alive past its own failure.
    expect(result.closes).toBe(1);
  });

  it('gives up on a database that is not there', async () => {
    const result = await run({ failures: 'forever', error: () => refused('3D000') });

    expect(result.code).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.errors[0]).toContain('does not exist');
  });

  it('treats every documented permanent code as permanent', async () => {
    for (const code of ['3D000', '28P01', '28000', '42501']) {
      expect(PERMANENT_FAILURES.get(code), code).toBeDefined();
      const result = await run({ failures: 'forever', error: () => refused(code) });
      expect(result.code, code).toBe(1);
      expect(result.attempts, code).toBe(1);
      expect(result.errors[0], code).toContain(code);
    }
  });

  it('keeps waiting while the server is still starting up', async () => {
    // `57P03` is the opposite answer from the same server: it has not read the request yet. Retrying is the whole
    // point of step 1 — classifying it as permanent would turn a 20-second recovery into a dead container.
    const result = await run({ failures: 2, error: () => refused('57P03') });

    expect(result.code).toBe(0);
    expect(result.attempts).toBe(3);
    expect(result.sleeps).toHaveLength(2);
    expect(result.lines[0]).toContain('57P03');
  });

  it('keeps waiting when the port is closed', async () => {
    const result = await run({ failures: 2 });

    expect(result.code).toBe(0);
    expect(result.attempts).toBe(3);
  });
});

describe('driverCode', () => {
  it('reads the code from the cause, which is where `check` puts it', () => {
    expect(driverCode(unreachable(refused('28P01')))).toBe('28P01');
  });

  it('prefers nothing over an invented code', () => {
    expect(driverCode(unreachable(new Error('no code here')))).toBeUndefined();
    expect(driverCode('a string, somehow')).toBeUndefined();
    expect(driverCode(undefined)).toBeUndefined();
  });
});

describe('main', () => {
  it('exits 0 on the first attempt when the database is up', async () => {
    const result = await run({ failures: 0 });

    expect(result.code).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(/^database: ready after 1 attempt\(s\), \d+ ms$/u);
    // The handle is always closed: a wait that leaked a pool would keep its own process alive.
    expect(result.closes).toBe(1);
    expect(result.sleeps).toEqual([]);
  });

  it('keeps trying, and says so once rather than every second', async () => {
    const result = await run({ failures: 2 });

    expect(result.code).toBe(0);
    expect(result.attempts).toBe(3);
    expect(result.lines[0]).toMatch(
      /^database: not ready yet \(ECONNREFUSED\); retrying for up to 60s$/u,
    );
    expect(result.lines).toHaveLength(2);
    expect(result.lines[1]).toMatch(/^database: ready after 3 attempt\(s\)/u);
    expect(result.sleeps).toEqual([WAIT_INTERVAL_MS, WAIT_INTERVAL_MS]);
  });

  it('gives up at the deadline with one line that says how long it waited', async () => {
    const result = await run({ failures: 'forever', argv: ['--timeout', '5'] });

    expect(result.code).toBe(1);
    // Five sleeps of a second exhaust a five-second budget, so the sixth attempt is refused before it is made.
    expect(result.attempts).toBe(6);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(
      /^error: the database did not answer within 5s \(6 attempt\(s\)/u,
    );
    expect(result.errors[0]).toContain('ECONNREFUSED');
    expect(result.closes).toBe(1);
  });

  it('reports progress every ten seconds, not every second', async () => {
    const result = await run({ failures: 'forever', argv: ['--timeout', '60'] });

    expect(result.code).toBe(1);
    const progress = result.lines.filter((line) => line.includes('still not ready'));
    // 60 s of attempts at one per second: the ten-second marks only — and the last one is `after 50s`, because the
    // attempt at the deadline itself is the one that gives up rather than a progress line.
    expect(progress).toEqual([
      'database: still not ready after 10s (ECONNREFUSED)',
      'database: still not ready after 20s (ECONNREFUSED)',
      'database: still not ready after 30s (ECONNREFUSED)',
      'database: still not ready after 40s (ECONNREFUSED)',
      'database: still not ready after 50s (ECONNREFUSED)',
    ]);
    expect(result.lines.filter((line) => line.includes('not ready yet'))).toHaveLength(1);
    expect(PROGRESS_EVERY_ATTEMPTS).toBe(10);
  });

  it('bounds each attempt by the time left, so a slow probe cannot outlive the deadline', async () => {
    // A driver that takes four seconds per attempt against a two-second budget: the first probe is given two seconds,
    // not the five-second default, and the loop stops at the deadline rather than after it.
    const result = await run({
      failures: 'forever',
      attemptMs: 4_000,
      argv: ['--timeout', '2'],
    });

    expect(result.code).toBe(1);
    expect(result.budgets[0]).toBe(2_000);
    expect(result.attempts).toBeLessThanOrEqual(2);
  });

  it('prints no password, whatever the driver said', async () => {
    const result = await run({
      failures: 'forever',
      error: () => new Error(`timeout connecting to ${ENV.DATABASE_URL}`),
      argv: ['--timeout', '3'],
    });

    expect(result.code).toBe(1);
    expect([...result.lines, ...result.errors].join('\n')).not.toContain('super-secret-password');
    expect(result.errors[0]).toContain('postgres://[redacted]');
  });

  it('refuses an unusable environment before it tries to connect', async () => {
    const result = await run({ failures: 0, env: { NODE_ENV: 'production', PORT: '0' } });

    expect(result.code).toBe(1);
    expect(result.errors[0]).toContain('PORT');
    // No handle, no attempts: a typo in `.env` must not look like a database outage in the log.
    expect(result.connects).toBe(0);
    expect(result.attempts).toBe(0);
  });

  it('prints usage without connecting for --help', async () => {
    const result = await run({ failures: 0, argv: ['--help'] });

    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toContain('--timeout');
    expect(result.connects).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('exits 1 for a bad flag without connecting', async () => {
    const result = await run({ failures: 0, argv: ['--timeout', 'soon'] });

    expect(result.code).toBe(1);
    expect(result.errors[0]).toContain('whole seconds');
    expect(result.connects).toBe(0);
  });
});
