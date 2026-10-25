/**
 * A sliding-window request limiter (`P1-API-09`).
 *
 * The same shape as the login throttle (`modules/auth/login-throttle.ts`) and deliberately a **separate** class: that
 * one counts *failures* and reserves in-flight slots so a burst cannot reach Argon2, while this one counts *requests*
 * and has no notion of success or failure. Sharing a base class would mean one of them carrying the other's concepts
 * as dead weight.
 *
 * The window slides over the instants of the requests that were let in, rather than resetting on a boundary: a fixed
 * window would let a client send `2 × limit` requests around every reset (the same reason `ADR-027` chose sliding for
 * logins).
 *
 * @module lib/rate-limit
 */

import { DEFAULT_MAX_THROTTLE_KEYS } from '../modules/auth/login-throttle';

/** How the limiter is configured. */
export interface RateLimitOptions {
  /** Requests allowed per key per window. Must be a positive whole number. */
  readonly limit: number;
  /** Window length in milliseconds. Must be a positive whole number. */
  readonly windowMs: number;
  /**
   * Ceiling on tracked keys; defaults to the login throttle's 10 000.
   *
   * A limiter keyed on something a client controls — an address, a token — is a memory-exhaustion lever pointed at the
   * endpoint it protects, so the map is bounded and the oldest key is evicted rather than growing without limit.
   */
  readonly maxKeys?: number;
  /** Clock, injectable so a test advances time instead of waiting for it. */
  readonly now?: () => Date;
}

/** What {@link SlidingWindowLimiter.take} answers. */
export type RateLimitVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** When the oldest request in the window leaves it, i.e. when the next request will be let in. */
      readonly resetAt: Date;
      /** Whole seconds until {@link resetAt}, never less than 1 — `Retry-After: 0` invites a hot retry loop. */
      readonly retryAfterSeconds: number;
    };

/**
 * Counts requests per key inside a sliding window.
 *
 * One instance per rule: the public read limit and the per-IP download limit are separate windows with separate keys,
 * and a single limiter holding both would let one rule's requests spend the other's allowance.
 */
export class SlidingWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => Date;
  /** Request instants per key, oldest first. */
  readonly #hits = new Map<string, Date[]>();

  /**
   * @param options - Limit, window, capacity and clock.
   * @throws {RangeError} When a limit is not a positive whole number: a limiter of zero requests would refuse
   * everything, and a `NaN` window would never expire — both silence, not safety.
   */
  constructor(options: RateLimitOptions) {
    for (const [name, value] of [
      ['limit', options.limit],
      ['windowMs', options.windowMs],
      ['maxKeys', options.maxKeys ?? DEFAULT_MAX_THROTTLE_KEYS],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive whole number, got ${String(value)}`);
      }
    }

    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_THROTTLE_KEYS;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Records a request for `key`, if the allowance has room for it.
   *
   * A refused request is **not** recorded: charging a client for the requests it was told not to make would extend its
   * own lockout for as long as it keeps knocking, which punishes a retrying client more than a polite one and makes the
   * `Retry-After` it was given a lie.
   *
   * @param key - What the allowance belongs to, e.g. `ip:203.0.113.7`. Never a secret: this map lives in memory.
   * @returns Whether the request may proceed, and if not, when the next one may.
   */
  take(key: string): RateLimitVerdict {
    const now = this.#now();
    const hits = this.#live(key, now);

    const oldest = hits[0];
    if (oldest !== undefined && hits.length >= this.#limit) {
      const resetAt = new Date(oldest.getTime() + this.#windowMs);
      return {
        allowed: false,
        resetAt,
        // Not clamped to a minimum of 1: a refused request is inside the window by construction, so `resetAt` is in the
        // future and the ceiling of a positive number of seconds is at least 1. `Math.max(1, …)` was here first and no
        // input could reach it — the kind of guard that reads as safety and is really an untested branch.
        retryAfterSeconds: Math.ceil((resetAt.getTime() - now.getTime()) / 1000),
      };
    }

    hits.push(now);
    this.#hits.set(key, hits);
    if (this.#hits.size > this.#maxKeys) this.#evict(now);
    return { allowed: true };
  }

  /** How many keys are tracked; a test asserts the bound holds. */
  get size(): number {
    return this.#hits.size;
  }

  /** Forgets every key. For tests, and for a process that wants a clean slate after a configuration change. */
  reset(): void {
    this.#hits.clear();
  }

  /**
   * The live requests for a key, pruning the ones that have left the window.
   *
   * @param key - The allowance.
   * @param now - Current instant.
   * @returns The recorded instants still inside the window, oldest first (a new array when the key is unknown).
   */
  #live(key: string, now: Date): Date[] {
    const recorded = this.#hits.get(key);
    if (recorded === undefined) return [];

    const cutoff = now.getTime() - this.#windowMs;
    // `>` not `>=`: a request exactly one window old has just left it, which is the instant `resetAt` names.
    const live = recorded.filter((at) => at.getTime() > cutoff);
    if (live.length === 0) this.#hits.delete(key);
    return live;
  }

  /**
   * Makes room for one more key.
   *
   * Expired keys go first, then — if the map is still full — the key inserted longest ago. Evicting a live key hands
   * its client a fresh allowance, which is the cost of a bounded map; the alternative is unbounded memory, and a
   * limiter that can be made to exhaust it is a weapon aimed at the endpoint it protects.
   *
   * @param now - Current instant, for the expiry sweep.
   */
  #evict(now: Date): void {
    const keys = [...this.#hits.keys()];
    for (const key of keys) this.#live(key, now);
    // A snapshot, not `keys()`: deleting from a map while iterating it is defined but reads as a trick, and the keys
    // cannot change underneath a synchronous method anyway. Deleting a key that the sweep just dropped is a no-op.
    for (const key of keys) {
      if (this.#hits.size <= this.#maxKeys) return;
      this.#hits.delete(key);
    }
  }
}
