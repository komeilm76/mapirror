/**
 * Login throttling: count failures, lock the pair out, forget about it after the window (`P1-AUTH-03`).
 *
 * The requirement is precise and the code follows it literally: **≤ 10 failures / 15 min per (ip, username) → `429`
 * with `Retry-After`** (`14-security.md` §3). Two counters, because they stop two different attacks:
 *
 * | Counter | Stops | Limit |
 * |---|---|---|
 * | `(ip, username)` | guessing one account's password | `maxAttempts` (10) |
 * | `ip` alone | spraying **one** password across many usernames — the attack a per-pair counter cannot see, because each pair fails once | `maxAttempts × 3` (30) |
 *
 * The per-IP limit is the documented one multiplied by three rather than a new configuration knob. The reasoning: a
 * spraying run needs hundreds of attempts, so anything in the tens catches it, while three people sharing an office
 * address who each fumble a password ten times in a quarter hour should not take the login page down for everyone
 * behind that address. The multiplier is stated here and in `14-security.md` because it is a judgement, not a
 * measurement.
 *
 * **In memory, per instance** — which is what `14-security.md` §7 documents for every limiter in this app. It resets
 * on restart and it is not shared between replicas; the design is a single container, and the alternative (a Redis or
 * a database table) buys durability the threat model does not need, at the cost of a write on every failed login.
 *
 * **A sliding window, not a fixed one.** With a fixed window an attacker gets `2N` attempts around every boundary:
 * ten at 14:59 and ten more at 15:00. Storing the timestamps of the failures costs a handful of numbers per key and
 * removes the boundary entirely.
 *
 * **The map is bounded.** A spilled counter is worse than no counter: an attacker sending a random username per
 * request would otherwise grow this map without limit — memory exhaustion as a side effect of the very endpoint the
 * throttle protects. Expired keys are pruned on every write, and if that is not enough the oldest keys are evicted.
 * The cost of eviction is a resettable counter for someone who was already failing, which is the correct thing to
 * give up.
 *
 * @module modules/auth/login-throttle
 */

/**
 * The throttle a process should use, built from the two configuration values that define it.
 *
 * Both call sites (the pipeline in `app.ts` and the namespace's own fallback in `routes.ts`) need exactly this, and the
 * mapping `minutes → milliseconds` is the kind of thing that goes wrong quietly in one of two copies. Takes a
 * structural type rather than importing `AppConfig`, so this module stays free of the configuration layer.
 *
 * @param config - `AUTH_MAX_LOGIN_ATTEMPTS` and `AUTH_LOCKOUT_MINUTES` as the config parsed them.
 * @returns A throttle with the documented limits.
 */
export function loginThrottleFromConfig(config: {
  readonly authMaxLoginAttempts: number;
  readonly authLockoutMinutes: number;
}): LoginThrottle {
  return new LoginThrottle({
    maxAttempts: config.authMaxLoginAttempts,
    windowMs: config.authLockoutMinutes * 60_000,
  });
}

/** What the throttle decided about one attempt. */
export type ThrottleVerdict =
  | { readonly limited: false }
  | {
      readonly limited: true;
      /**
       * Why the attempt was refused, because the two answers have different deadlines.
       *
       * `failures` — the counter is full and a recorded failure has to leave the window; the answer can be minutes away.
       * `in-flight` — the allowance is exhausted by attempts that are being verified *right now*; they finish in the
       * time one Argon2 hash takes, so the retry is a second, not a quarter of an hour.
       */
      readonly reason: 'failures' | 'in-flight';
      /** When the attempt can succeed again: the oldest failure's expiry, or one second for `in-flight`. */
      readonly lockedUntil: Date;
      /** Whole seconds until {@link lockedUntil}, never less than 1 — a `Retry-After: 0` invites a hot retry loop. */
      readonly retryAfterSeconds: number;
    };

/** Construction options; every field has a default that matches the documentation. */
export interface LoginThrottleOptions {
  /** Failures allowed per `(ip, username)` within the window before lockout. `AUTH_MAX_LOGIN_ATTEMPTS`. */
  readonly maxAttempts: number;
  /** Window length. `AUTH_LOCKOUT_MINUTES` × 60 000. */
  readonly windowMs: number;
  /**
   * Multiplier applied to {@link maxAttempts} for the per-IP counter — see the module comment.
   *
   * Zero disables the per-IP counter, which a test uses to prove the pair counter stands on its own.
   */
  readonly perIpMultiplier?: number;
  /** Clock. Injected so a lockout test does not have to wait fifteen minutes. */
  readonly now?: () => Date;
  /** Hard ceiling on tracked keys before the oldest are evicted. */
  readonly maxKeys?: number;
}

/** Default ceiling on tracked keys: 10 000 keys × ≤ 11 timestamps is a few megabytes at worst. */
export const DEFAULT_MAX_THROTTLE_KEYS = 10_000;

/**
 * How long a client is told to wait when the allowance is held by attempts still being verified.
 *
 * One hash takes ~74 ms; a second is the smallest integer a `Retry-After` can honestly carry, and it is long enough
 * that a client obeying it will find the slots free.
 */
const BUSY_RETRY_MS = 1_000;

/** Separator between the two parts of a pair key; a NUL cannot appear in a username or an address. */
const KEY_SEPARATOR = '\u0000';

/** One counter: the failure instants still inside the window, oldest first. */
type Counter = Date[];

/** A counter known to hold at least one failure — what a lockout is computed from. */
type Failures = readonly [Date, ...Date[]];

/**
 * Narrows a counter to non-empty.
 *
 * A lockout needs an anchor (the oldest failure, whose departure lifts it), so this is the type-level half of the
 * invariant "a limit is never met by an empty counter". Expressing it here means `#lockout` needs no fallback for a
 * case that cannot happen — the alternative, `failures[0] ?? now`, silently invents a lockout expiring a window from
 * now, and it is unreachable, so no test would ever tell you it was wrong.
 *
 * @param counter - The live failures for a key, possibly empty.
 * @returns The counter typed as non-empty, or `null` when there are no failures.
 */
function nonEmpty(counter: Counter): Failures | null {
  const [first, ...rest] = counter;
  return first === undefined ? null : [first, ...rest];
}

/**
 * The in-memory login throttle.
 *
 * One instance per process, created by the route plugin from the configuration and shared by every request. Exposed as
 * a class rather than module-level state so a test can hold two independent instances and so the clock is a
 * constructor argument instead of a parameter threaded through every call.
 */
export class LoginThrottle {
  readonly #maxAttempts: number;
  readonly #windowMs: number;
  readonly #perIpLimit: number;
  readonly #maxKeys: number;
  readonly #now: () => Date;
  readonly #counters = new Map<string, Counter>();
  /**
   * Attempts currently being verified, per key. Separate from {@link #counters} because a reservation is not a failure:
   * it becomes one (or disappears) when the attempt finishes, and it must never contribute to `lockedUntil`.
   */
  readonly #inFlight = new Map<string, number>();

  /**
   * @param options - Limits, window, clock and capacity.
   * @throws {RangeError} When a limit is not a positive whole number, because a throttle of zero attempts would lock
   * every login out and a `NaN` window would never expire — both silence, not safety.
   */
  constructor(options: LoginThrottleOptions) {
    for (const [name, value] of [
      ['maxAttempts', options.maxAttempts],
      ['windowMs', options.windowMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive whole number, got ${String(value)}`);
      }
    }

    this.#maxAttempts = options.maxAttempts;
    this.#windowMs = options.windowMs;
    this.#perIpLimit = Math.floor(options.maxAttempts * (options.perIpMultiplier ?? 3));
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_THROTTLE_KEYS;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Decides whether an attempt may proceed, and **reserves** its slot when it may.
   *
   * Checked before the password is verified, so a locked-out client costs a map lookup instead of a 64 MiB Argon2
   * hash — the difference between a lockout and a memory-amplification lever (`16-changelog.md` pass 20).
   *
   * The reservation is what makes the allowance hold against a burst rather than against a sequence (`16-changelog.md`
   * pass 28). It also puts an obligation on the caller: every allowed attempt must settle exactly once, with
   * {@link recordFailure}, {@link recordSuccess} or {@link release}. Settling twice is harmless — no counter goes below
   * zero — but never settling shrinks the allowance by one until the process restarts.
   *
   * @param ip - Client address, already normalised (`lib/client-ip.ts`).
   * @param username - Submitted name; case is folded so `Admin` and `admin` share one counter.
   * @returns Not limited, or the refusal: a lockout (`reason: 'failures'`, the instant it lifts) or a full allowance
   * (`reason: 'in-flight'`, a second from now) — whichever counter is closer to expiry is ignored, because the pair's
   * own verdict is the one that applies to *this* attempt.
   */
  check(ip: string | null, username: string): ThrottleVerdict {
    const now = this.#now();
    const pairKey = this.#pairKey(ip, username);
    const ipKey = this.#ipKey(ip);

    const pair = nonEmpty(this.#live(pairKey, now));
    if (pair !== null && pair.length >= this.#maxAttempts) return this.#lockout(pair, now);
    // Attempts that are *inside* the verification count against the same allowance. Without this, a burst of
    // simultaneous requests all read the same empty counter before any of them records a failure, and every one of
    // them gets a full 64 MiB Argon2 verify — the amplification this throttle exists to stop (measured, pass 28:
    // 40 concurrent attempts for one account, 40 verifications, zero `429`s).
    if (this.#pending(pairKey) + (pair?.length ?? 0) >= this.#maxAttempts) return this.#busy(now);

    // No `perIpLimit > 0` test here, and none needed: with the counter disabled the limit is `0`, and a `0 >= 0`
    // comparison once locked *every* login out (measured, pass 23). `nonEmpty` makes an empty counter `null`, so a
    // disabled counter reads as "no failures" rather than as "limit met". The regression test that switches it off
    // still fails if that ever changes.
    const byIp = nonEmpty(this.#live(ipKey, now));
    if (byIp !== null && byIp.length >= this.#perIpLimit) return this.#lockout(byIp, now);
    if (this.#perIpLimit > 0 && this.#pending(ipKey) >= this.#perIpLimit) return this.#busy(now);

    // Reserved before returning: the caller now owes one `recordFailure`, `recordSuccess` or `release`. Everything
    // that settles is idempotent and never drops below zero, so a caller that settles twice is harmless.
    this.#reserve(pairKey);
    if (this.#perIpLimit > 0) this.#reserve(ipKey);

    return { limited: false };
  }

  /**
   * Records a failed attempt against both counters.
   *
   * @param ip - Client address, normalised.
   * @param username - Submitted name.
   */
  recordFailure(ip: string | null, username: string): void {
    const now = this.#now();
    const pairKey = this.#pairKey(ip, username);
    const ipKey = this.#ipKey(ip);
    // The reservation becomes a recorded failure: settle it first, so the slot is free even if the push below has to
    // evict something.
    this.#settle(pairKey);
    if (this.#perIpLimit > 0) this.#settle(ipKey);
    this.#push(pairKey, now);
    if (this.#perIpLimit > 0) this.#push(ipKey, now);
  }

  /**
   * Clears the pair counter after a successful login.
   *
   * The **IP counter is not cleared**: those failures are the record of attempts against *other* accounts from the
   * same address, and a successful login proves nothing about them. This is the line between "you are having a bad
   * morning" (forgiven the moment you succeed) and "this address is spraying" (not forgiven by one valid login).
   *
   * @param ip - Client address, normalised.
   * @param username - Submitted name.
   */
  recordSuccess(ip: string | null, username: string): void {
    this.#settle(this.#pairKey(ip, username));
    if (this.#perIpLimit > 0) this.#settle(this.#ipKey(ip));
    this.#counters.delete(this.#pairKey(ip, username));
  }

  /**
   * Gives a reservation back **without** recording anything.
   *
   * For the paths where the attempt neither proved nor disproved the password — a database error during the lookup, a
   * deactivated account whose password was right — and for the `finally` in the login flow, which is what guarantees a
   * reservation cannot leak when a request dies somewhere unexpected. A leaked reservation would not lock an account
   * out (in-flight counts reset with the process and `get inFlight` makes it visible), but it would quietly shrink the
   * allowance by one for as long as the process lives.
   *
   * @param ip - Client address, normalised.
   * @param username - Submitted name.
   */
  release(ip: string | null, username: string): void {
    this.#settle(this.#pairKey(ip, username));
    if (this.#perIpLimit > 0) this.#settle(this.#ipKey(ip));
  }

  /** Forgets everything. For tests, and for a process that wants a clean slate after a configuration change. */
  reset(): void {
    this.#counters.clear();
    this.#inFlight.clear();
  }

  /** How many keys are currently tracked; a test asserts the bound holds. */
  get size(): number {
    return this.#counters.size;
  }

  /**
   * How many reservations are outstanding. Exposed so the login flow's `finally` can be tested ("nothing leaked") and
   * so an operator reading a heap dump has a name for the map.
   */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** The `(ip, username)` limit, exposed so a test and a log line can state it without re-deriving it. */
  get maxAttempts(): number {
    return this.#maxAttempts;
  }

  /** The per-IP limit, exposed for the same reason. */
  get perIpLimit(): number {
    return this.#perIpLimit;
  }

  /** Reads a counter with everything outside the window dropped, so a stale array can never lock anyone out. */
  #live(key: string, now: Date): Counter {
    const stored = this.#counters.get(key);
    if (stored === undefined) return [];
    const cutoff = now.getTime() - this.#windowMs;
    const live = stored.filter((at) => at.getTime() > cutoff);
    if (live.length === 0) this.#counters.delete(key);
    else if (live.length !== stored.length) this.#counters.set(key, live);
    return live;
  }

  /** Appends one failure and keeps the map inside its ceiling. */
  #push(key: string, now: Date): void {
    const live = this.#live(key, now);
    live.push(now);
    // Re-inserting moves the key to the end of the map's iteration order, which is what makes the oldest-first
    // eviction below evict the *least recently touched* key rather than an arbitrary one.
    this.#counters.delete(key);
    this.#counters.set(key, live);
    this.#enforceCapacity();
  }

  /**
   * Drops expired keys first, then the oldest live ones.
   *
   * Two passes rather than one, because "expired" is free to discard and "oldest" costs the attacker their counter.
   */
  #enforceCapacity(): void {
    if (this.#counters.size <= this.#maxKeys) return;

    const now = this.#now();
    const cutoff = now.getTime() - this.#windowMs;
    for (const [key, counter] of this.#counters) {
      if (counter.every((at) => at.getTime() <= cutoff)) this.#counters.delete(key);
    }

    // Still over the ceiling: evict in insertion order (least recently written first). `Map` guarantees it.
    for (const key of this.#counters.keys()) {
      if (this.#counters.size <= this.#maxKeys) break;
      this.#counters.delete(key);
    }
  }

  /** Reservations outstanding for one key. */
  #pending(key: string): number {
    return this.#inFlight.get(key) ?? 0;
  }

  /** Takes one slot. Bounded like the counters: a leaked entry must not become unbounded memory. */
  #reserve(key: string): void {
    this.#inFlight.set(key, this.#pending(key) + 1);
    if (this.#inFlight.size > this.#maxKeys) {
      // Oldest first, like the counter eviction below: an entry that has been outstanding the longest is the one most
      // likely to be a leaked slot rather than a request that is still running.
      const oldest = this.#inFlight.keys().next();
      if (!oldest.done) this.#inFlight.delete(oldest.value);
    }
  }

  /** Gives one slot back, never below zero: settling twice is a caller mistake, not a new reservation. */
  #settle(key: string): void {
    const pending = this.#pending(key);
    if (pending <= 1) this.#inFlight.delete(key);
    else this.#inFlight.set(key, pending - 1);
  }

  /**
   * The answer when the allowance is used up by attempts still in progress.
   *
   * A second, not the window: the attempts holding the slots are a hash away from finishing.
   */
  #busy(now: Date): ThrottleVerdict {
    return {
      limited: true,
      reason: 'in-flight',
      lockedUntil: new Date(now.getTime() + BUSY_RETRY_MS),
      retryAfterSeconds: Math.ceil(BUSY_RETRY_MS / 1000),
    };
  }

  /** Builds the 429 answer from the live failures: the lock lifts when the oldest one leaves the window. */
  #lockout(failures: Failures, now: Date): ThrottleVerdict {
    const oldest = failures[0];
    const lockedUntil = new Date(oldest.getTime() + this.#windowMs);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000),
    );
    return { limited: true, reason: 'failures', lockedUntil, retryAfterSeconds };
  }

  /** `pair` key: address + case-folded username. A `null` address (unparseable) shares one bucket. */
  #pairKey(ip: string | null, username: string): string {
    return `pair${KEY_SEPARATOR}${ip ?? ''}${KEY_SEPARATOR}${username.trim().toLowerCase()}`;
  }

  /** `ip` key: the address alone, or the shared bucket for an address we could not parse. */
  #ipKey(ip: string | null): string {
    return `ip${KEY_SEPARATOR}${ip ?? ''}`;
  }
}
