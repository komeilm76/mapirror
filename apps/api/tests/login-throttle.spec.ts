import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_THROTTLE_KEYS,
  LoginThrottle,
  loginThrottleFromConfig,
} from '../src/modules/auth/login-throttle';

/**
 * Acceptance tests for `P1-AUTH-03`'s throttle, without a server: `14-security.md` §3 says "≤ 10 failures / 15 min per
 * (ip, username) → `429`", and this file is that sentence, executed.
 *
 * A **mutable clock** is the point of the design: the interesting behaviour is what happens after fifteen minutes, and
 * a test that waited would not run in the gate. Every case here advances `clock.now` explicitly, so "the window
 * expired" is an assertion about arithmetic rather than about how long the suite took.
 */

/** A clock a test can move. */
function clockAt(start: Date): { now: () => Date; advance: (ms: number) => void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

const T0 = new Date('2026-10-25T09:00:00.000Z');
const WINDOW_MS = 15 * 60_000;

/** A throttle with the documented limits, on a controllable clock. */
function throttleWith(
  options: { maxAttempts?: number; perIpMultiplier?: number; maxKeys?: number } = {},
) {
  const clock = clockAt(T0);
  const throttle = new LoginThrottle({
    maxAttempts: options.maxAttempts ?? 10,
    windowMs: WINDOW_MS,
    now: clock.now,
    ...(options.perIpMultiplier === undefined ? {} : { perIpMultiplier: options.perIpMultiplier }),
    ...(options.maxKeys === undefined ? {} : { maxKeys: options.maxKeys }),
  });
  return { throttle, clock };
}

const IP = '203.0.113.9';

describe('LoginThrottle', () => {
  it('allows the first ten failures and locks the eleventh attempt', () => {
    const { throttle } = throttleWith();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(throttle.check(IP, 'admin'), `attempt ${String(attempt)}`).toEqual({ limited: false });
      throttle.recordFailure(IP, 'admin');
    }

    const verdict = throttle.check(IP, 'admin');
    expect(verdict.limited).toBe(true);
    if (!verdict.limited) return;

    // The lock lifts when the *oldest* failure leaves the window: ten failures at t0 means locked until t0 + 15 min.
    expect(verdict.lockedUntil.toISOString()).toBe(
      new Date(T0.getTime() + WINDOW_MS).toISOString(),
    );
    expect(verdict.retryAfterSeconds).toBe(15 * 60);
  });

  it('unlocks itself exactly when the oldest failure leaves the window, not before', () => {
    const { throttle, clock } = throttleWith();
    for (let attempt = 0; attempt < 10; attempt += 1) throttle.recordFailure(IP, 'admin');

    clock.advance(WINDOW_MS - 1);
    expect(throttle.check(IP, 'admin').limited).toBe(true);

    clock.advance(1);
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
  });

  it('is a sliding window: a burst spread across the boundary does not double the allowance', () => {
    // With a fixed window an attacker gets 2N attempts around every boundary — five at 14:59 and five at 15:00. Here
    // the second five are still inside the first five's window.
    const { throttle, clock } = throttleWith();

    for (let attempt = 0; attempt < 5; attempt += 1) throttle.recordFailure(IP, 'admin');
    clock.advance(WINDOW_MS - 1_000);
    for (let attempt = 0; attempt < 5; attempt += 1) throttle.recordFailure(IP, 'admin');

    // Five old + five new = ten inside one window, so the eleventh is refused — which is exactly what a fixed window
    // would have allowed 15 minutes after the first burst started.
    expect(throttle.check(IP, 'admin').limited).toBe(true);

    // Once the *first* five leave the window the count drops to five and attempts are allowed again. That is the
    // sliding behaviour, not a reset: the second burst is still on the record, a second later it is still five-and-a-bit.
    clock.advance(2_000);
    expect(throttle.check(IP, 'admin').limited).toBe(false);
    for (let attempt = 0; attempt < 5; attempt += 1) throttle.recordFailure(IP, 'admin');
    expect(throttle.check(IP, 'admin').limited).toBe(true);
  });

  it('counts attempts that are still being verified against the allowance', () => {
    // The reservation, in isolation: ten checks with nothing settled exhausts the allowance even though no failure has
    // been recorded yet. Without it, ten simultaneous requests all pass `check` and all reach Argon2 (pass 28).
    const { throttle } = throttleWith();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(throttle.check(IP, 'admin'), `attempt ${String(attempt)}`).toEqual({ limited: false });
    }

    const verdict = throttle.check(IP, 'admin');
    expect(verdict.limited).toBe(true);
    if (!verdict.limited) return;
    // A second, not the window: the attempts holding the slots are one hash away from finishing.
    expect(verdict.reason).toBe('in-flight');
    expect(verdict.retryAfterSeconds).toBe(1);
    expect(throttle.inFlight).toBe(2); // eleven keys minus the one that was refused: pair + ip, ten times over
  });

  it('gives the slot back when an attempt is released, and when one settles as a failure', () => {
    const { throttle } = throttleWith({ maxAttempts: 2 });

    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
    expect(throttle.check(IP, 'admin').limited).toBe(true);

    // A release is "this attempt neither succeeded nor failed" — a database error, a request that died.
    throttle.release(IP, 'admin');
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });

    // Settling the two remaining reservations as failures fills the counter: the answer is now the lockout, not the
    // busy signal, because a recorded failure is what the window is measured from.
    throttle.recordFailure(IP, 'admin');
    throttle.recordFailure(IP, 'admin');
    const verdict = throttle.check(IP, 'admin');
    expect(verdict.limited).toBe(true);
    if (!verdict.limited) return;
    expect(verdict.reason).toBe('failures');
    expect(verdict.retryAfterSeconds).toBe(15 * 60);
  });

  it("settling more often than reserving does not go negative or free someone else's slot", () => {
    // A caller that records a failure without a reservation (a test, a future code path) must not hand out extra
    // allowance, and a double release must not cancel another attempt's reservation.
    const { throttle } = throttleWith({ maxAttempts: 2 });

    throttle.recordFailure(IP, 'admin');
    throttle.release(IP, 'admin');
    throttle.release(IP, 'admin');
    expect(throttle.inFlight).toBe(0);

    // The stray failure still counts — the releases returned slots, not failures — so exactly one of the two attempts
    // is left: it takes the last slot, and the next attempt is refused because that one is still in progress.
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
    expect(throttle.inFlight).toBe(2); // the pair key and the address key, one reservation each
    const verdict = throttle.check(IP, 'admin');
    expect(verdict.limited).toBe(true);
    if (!verdict.limited) return;
    // Still `in-flight`, and deliberately so: the outstanding attempt may yet succeed and free the pair, so promising a
    // fifteen-minute lockout would be a guess. Once it settles as a failure, the next answer is the real lockout — which
    // is the other test's assertion, and the branch this one exists to keep distinct.
    expect(verdict.reason).toBe('in-flight');
  });

  it('applies the in-flight allowance to the address counter too', () => {
    // Spraying: one attempt per username never fills a pair counter, so the address counter is what has to bound the
    // number of verifications in flight. `perIpMultiplier: 1` makes both limits 4 here.
    const { throttle } = throttleWith({ maxAttempts: 4, perIpMultiplier: 1 });

    for (let index = 0; index < 4; index += 1) {
      expect(throttle.check(IP, `user${String(index)}`)).toEqual({ limited: false });
    }

    const verdict = throttle.check(IP, 'user-4');
    expect(verdict.limited).toBe(true);
    if (!verdict.limited) return;
    expect(verdict.reason).toBe('in-flight');

    // Another address is unaffected: the reservation belongs to the address that made it.
    expect(throttle.check('198.51.100.7', 'user-4')).toEqual({ limited: false });
  });

  it('a successful login releases its reservation and clears the pair', () => {
    const { throttle } = throttleWith({ maxAttempts: 2 });

    throttle.recordFailure(IP, 'admin');
    expect(throttle.inFlight).toBe(0);

    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
    throttle.recordSuccess(IP, 'admin');

    // Slot back, failures gone: two more attempts are allowed before the pair counter fills again.
    expect(throttle.inFlight).toBe(0);
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
    expect(throttle.check(IP, 'admin').limited).toBe(true);
  });

  it('names the instant the lock actually lifts, not an earlier one', () => {
    // `lockedUntil` is the **oldest** failure plus the window, which is also when that failure leaves the sliding window
    // and the count first falls below the limit. The two must agree: a client that sleeps to the stated instant and
    // retries has to be let in, and one that retries a moment earlier must still be refused. The failures are spread out
    // here on purpose — with them all at one instant, "oldest" and "newest" would be the same number and a wrong pick
    // would pass.
    const { throttle, clock } = throttleWith({ maxAttempts: 3 });
    const started = clock.now().getTime();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throttle.check(IP, 'admin');
      throttle.recordFailure(IP, 'admin');
      clock.advance(60_000);
    }

    const early = throttle.check(IP, 'admin');
    expect(early.limited).toBe(true);
    if (!early.limited) return;
    expect(early.lockedUntil.getTime()).toBe(started + WINDOW_MS);
    // Three minutes have passed, so the wait is the remaining twelve — not the full fifteen.
    expect(early.retryAfterSeconds).toBe(720);

    clock.advance(WINDOW_MS - 180_000 - 1);
    expect(throttle.check(IP, 'admin').limited).toBe(true);
    clock.advance(1);
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
  });

  it('forgets the pair after a successful login, and keeps the address-level count', () => {
    const { throttle } = throttleWith();

    for (let attempt = 0; attempt < 9; attempt += 1) throttle.recordFailure(IP, 'admin');
    expect(throttle.check(IP, 'admin').limited).toBe(false);

    throttle.recordSuccess(IP, 'admin');
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });

    // Nine failures are still on the address: they are the record of attempts against *other* accounts from here.
    expect(throttle.size).toBe(1);
  });

  it('limits an address that sprays one password across many usernames', () => {
    // The attack a per-pair counter cannot see: each username fails once, so no pair ever reaches ten. Three times the
    // documented limit is the ceiling this class documents.
    const { throttle } = throttleWith({ maxAttempts: 3 });
    expect(throttle.perIpLimit).toBe(9);

    for (let index = 0; index < 9; index += 1) {
      throttle.recordFailure(IP, `user${String(index)}`);
    }

    // A username nobody has tried yet is refused, because the *address* is out of allowance.
    const verdict = throttle.check(IP, 'brand-new-username');
    expect(verdict.limited).toBe(true);

    // ...while the same spray from another address is unaffected.
    expect(throttle.check('198.51.100.7', 'brand-new-username')).toEqual({ limited: false });
  });

  it('can have the per-address counter switched off, and then the pair counter stands alone', () => {
    const { throttle } = throttleWith({ maxAttempts: 3, perIpMultiplier: 0 });
    expect(throttle.perIpLimit).toBe(0);

    // Three failures against one account lock that account out; fifty more against other names do nothing to it,
    // because the address-level counter is the one that was switched off.
    for (let attempt = 0; attempt < 3; attempt += 1) throttle.recordFailure(IP, 'user0');
    for (let index = 1; index <= 50; index += 1) throttle.recordFailure(IP, `user${String(index)}`);

    expect(throttle.check(IP, 'user0').limited).toBe(true); // its own pair counter
    expect(throttle.check(IP, 'never-tried')).toEqual({ limited: false });
  });

  it('folds case and surrounding whitespace, so `Admin` cannot buy a second allowance', () => {
    const { throttle } = throttleWith({ maxAttempts: 2 });

    throttle.recordFailure(IP, 'Admin');
    throttle.recordFailure(IP, ' admin ');
    expect(throttle.check(IP, 'ADMIN').limited).toBe(true);
  });

  it('keeps an unparseable address in one shared bucket instead of a bucket per request', () => {
    // `null` is what `normaliseIp` returns for a spoofed header (pass 22). If each `null` were its own key the counter
    // would be defeated by the same trick that defeated the rate limiter.
    const { throttle } = throttleWith({ maxAttempts: 2 });

    throttle.recordFailure(null, 'admin');
    throttle.recordFailure(null, 'admin');
    expect(throttle.check(null, 'admin').limited).toBe(true);
  });

  it('reports at least one second of retry, so a client cannot hot-loop on `Retry-After: 0`', () => {
    const { throttle, clock } = throttleWith({ maxAttempts: 1 });
    throttle.recordFailure(IP, 'admin');

    // One millisecond before the lock lifts, the remaining time rounds to zero seconds.
    clock.advance(WINDOW_MS - 1);
    const verdict = throttle.check(IP, 'admin');
    expect(verdict.limited).toBe(true);
    if (verdict.limited) expect(verdict.retryAfterSeconds).toBe(1);
  });

  it('keeps the map bounded, so a random username per request cannot exhaust memory', () => {
    // The counter protects the endpoint; an unbounded counter would let the same endpoint exhaust the heap. Expired keys
    // go first — and here every key is live, so the oldest are evicted.
    const { throttle } = throttleWith({ maxAttempts: 10, maxKeys: 5 });

    for (let index = 0; index < 200; index += 1) throttle.recordFailure(IP, `user${String(index)}`);

    expect(throttle.size).toBeLessThanOrEqual(5);
    // The newest key is still tracked, i.e. eviction took the oldest rather than resetting everything.
    expect(throttle.check(IP, 'user199')).not.toEqual({ limited: false });
  });

  it('prunes the expired keys first, and only evicts live ones when that is not enough', () => {
    // Two different mechanisms, and the order matters: dropping a live counter resets someone's failures, so expired
    // keys must go first. Here five keys expire while five stay live, and the ceiling is eight: pruning alone is enough,
    // and the live counters are untouched — a counter that was silently reset would let an attacker restart.
    const { throttle, clock } = throttleWith({ maxAttempts: 10, maxKeys: 8 });

    for (let index = 0; index < 5; index += 1) throttle.recordFailure(IP, `stale${String(index)}`);
    clock.advance(WINDOW_MS + 1_000);
    for (let index = 0; index < 5; index += 1) throttle.recordFailure(IP, `live${String(index)}`);

    // Nine pairs live; the write above already pruned the five stale ones and then sat comfortably under eight.
    expect(throttle.size).toBeLessThanOrEqual(8);
    // Every live pair keeps its failure: none of them is locked out at one failure against a limit of ten.
    for (let index = 0; index < 5; index += 1) {
      expect(throttle.check(IP, `live${String(index)}`).limited).toBe(false);
    }

    // And a pair that was pruned is back to zero, which is the reversible cost of the bound — stated, not accidental.
    expect(throttle.check(IP, 'stale0').limited).toBe(false);
  });

  it('prunes a key whose last failure is exactly on the window boundary', () => {
    // The boundary is where `#live` and the prune pass have to agree: `#live` keeps failures *after* the cutoff, so a
    // failure exactly at it is already forgotten. If the prune used a strict comparison it would keep that key one
    // cycle longer and then discard a *live* key to make room — someone's real failures, thrown away to hold a stale
    // counter. `size` is the observable: only the fresh key should remain.
    const { throttle, clock } = throttleWith({ maxAttempts: 10, maxKeys: 2, perIpMultiplier: 0 });

    throttle.recordFailure(IP, 'b'); // inserted first, so it is what eviction would take
    clock.advance(WINDOW_MS);
    throttle.recordFailure(IP, 'b'); // refreshed: its last failure is now exactly on the future boundary
    throttle.recordFailure(IP, 'a');
    clock.advance(WINDOW_MS);
    throttle.recordFailure(IP, 'c'); // the write that pushes the map over its ceiling

    expect(throttle.size).toBe(1);
    expect(throttle.check(IP, 'c').limited).toBe(false);
  });

  it('has a documented default capacity', () => {
    expect(DEFAULT_MAX_THROTTLE_KEYS).toBe(10_000);
  });

  it('refuses limits that would silently disable it', () => {
    // `0` attempts would lock out every login; a `NaN` window would never expire. Both are misconfiguration, and both
    // would look like "the login page is broken" rather than like a config error.
    for (const options of [
      { maxAttempts: 0, windowMs: WINDOW_MS },
      { maxAttempts: Number.NaN, windowMs: WINDOW_MS },
      { maxAttempts: 1.5, windowMs: WINDOW_MS },
      { maxAttempts: 10, windowMs: 0 },
      { maxAttempts: 10, windowMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => new LoginThrottle(options), JSON.stringify(options)).toThrow(RangeError);
    }
  });

  it('reset() forgets every counter', () => {
    const { throttle } = throttleWith({ maxAttempts: 1 });
    throttle.recordFailure(IP, 'admin');
    expect(throttle.check(IP, 'admin').limited).toBe(true);

    throttle.reset();
    expect(throttle.check(IP, 'admin')).toEqual({ limited: false });
    expect(throttle.size).toBe(0);
  });
});

describe('loginThrottleFromConfig', () => {
  it('maps the documented configuration to the documented limits', () => {
    // `AUTH_MAX_LOGIN_ATTEMPTS=10`, `AUTH_LOCKOUT_MINUTES=15` → ten tries in a quarter hour, and 30 per address.
    const throttle = loginThrottleFromConfig({ authMaxLoginAttempts: 10, authLockoutMinutes: 15 });

    expect(throttle.maxAttempts).toBe(10);
    expect(throttle.perIpLimit).toBe(30);
  });

  it('converts minutes to milliseconds, which is the one thing a copy of this code gets wrong', () => {
    // Fake timers, because this test is about the throttle `app.ts` builds and that one reads the real clock: the
    // alternative is waiting a minute. A window of `authLockoutMinutes` *milliseconds* — the plausible typo — lets the
    // second attempt through and fails the middle assertion.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      const throttle = loginThrottleFromConfig({ authMaxLoginAttempts: 1, authLockoutMinutes: 1 });
      throttle.recordFailure(IP, 'admin');

      expect(throttle.check(IP, 'admin').limited).toBe(true);

      vi.setSystemTime(new Date(T0.getTime() + 59_000));
      expect(throttle.check(IP, 'admin').limited).toBe(true);

      vi.setSystemTime(new Date(T0.getTime() + 61_000));
      expect(throttle.check(IP, 'admin').limited).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the limits it was built with, so a log line can state them without re-deriving', () => {
    const throttle = loginThrottleFromConfig({ authMaxLoginAttempts: 3, authLockoutMinutes: 5 });
    expect(throttle.maxAttempts).toBe(3);
    expect(throttle.perIpLimit).toBe(9);
  });

  it('refuses a configuration the throttle cannot honour', () => {
    // A zero or negative limit would lock nobody in (or everybody out, depending on the comparison); the constructor
    // rejects it rather than leaving a limiter that silently does nothing.
    expect(() =>
      loginThrottleFromConfig({ authMaxLoginAttempts: 0, authLockoutMinutes: 15 }),
    ).toThrow(RangeError);
    expect(() =>
      loginThrottleFromConfig({ authMaxLoginAttempts: 10, authLockoutMinutes: 0 }),
    ).toThrow(RangeError);
  });
});
