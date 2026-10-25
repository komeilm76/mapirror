/**
 * Password hashing and the creation-time policy (`P1-AUTH-01`).
 *
 * Argon2id, because that is what `PROMPT.md` AUTH-5 requires and what `14-security.md` §3 documents: memory
 * 64 MiB, 3 passes, parallelism 1, per-hash salt. `@node-rs/argon2` is the Argon2 reference implementation
 * compiled to Rust and then to a native addon — the *algorithm* is not reimplemented in JavaScript here, which
 * matters more than the wrapper: a hand-rolled Argon2 would be both slow and unverifiable.
 *
 * Three rules shape this module, and each of them is a way to get password handling wrong:
 *
 * 1. **The policy is enforced where passwords are *created*, never on login.** Login verifies whatever the
 *    stored account was created with, so raising the floor later cannot lock anybody out, and a login attempt
 *    with a 3-character password costs one verification and an honest `401`, not a policy lecture that tells an
 *    attacker how the account's password was chosen (`04-api.md` §`/_auth/api/login`).
 * 2. **Verification answers `false`, it does not throw.** A stored hash that cannot be decoded — a truncated
 *    column, a row edited by hand — must not turn every login into a `500` describing its own internals. It is
 *    indistinguishable from a wrong password by design; the recovery path is the reset script (`P1-AUTH-07`).
 * 3. **The stored form is the hash, and the hash carries its own parameters.** `verify` reads `m=`, `t=`, `p=`
 *    out of the PHC string, so the numbers in `ARGON2_PARAMS` govern *new* hashes only. Raising them later is
 *    therefore a one-line change that does not invalidate existing accounts; `P1-AUTH-01` does not add a
 *    "needs rehash" path because nothing yet changes the parameters, and an unused upgrade path is a path no
 *    test can drive.
 *
 * @module modules/auth/password
 */

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

import { WEAK_PASSWORD_SET } from './weak-passwords';

/**
 * Argon2id parameters for every new hash (`docs/14-security.md` §3).
 *
 * `Algorithm.Argon2id` is a `const enum` in the addon's typings, which `isolatedModules` forbids using as a
 * value, so the member's own value is written out with its source named. `memoryCost` is in **KiB**, the unit
 * the PHC string and the addon both use — 65 536 KiB is the 64 MiB the docs promise, and a test reads it back
 * out of a produced hash rather than trusting this comment.
 */
export const ARGON2_PARAMS = {
  /** `Algorithm.Argon2id`: hybrid Argon2i/Argon2d, side-channel resistant and GPU-hostile. */
  algorithm: 2,
  /** 64 MiB per hash. Each concurrent hash therefore costs 64 MiB of RAM. */
  memoryCost: 65_536,
  /** Three passes over that memory. */
  timeCost: 3,
  /** One lane: the login path is rate-limited, so parallelism would only help an attacker's hardware. */
  parallelism: 1,
} as const;

/**
 * The policy a created password has to satisfy (`14-security.md` §3).
 *
 * Deliberately NIST-shaped (SP 800-63B §5.1.1.2): a length floor, a blocklist, and **no composition rules** —
 * no "must contain a symbol", no forced rotation. Composition rules measurably push people towards `Passw0rd!`
 * and `Passw0rd2!`, which is exactly what the blocklist is for, so the rule that looks stricter is weaker.
 */
export const PASSWORD_POLICY = {
  /** Minimum length in characters (Unicode code points, after NFKC normalisation). */
  minLength: 12,
  /**
   * Maximum length, in the unit the login schema counts.
   *
   * Not an arbitrary bound: `04-api.md` §`/_auth/api/login` accepts a password of at most 256 characters, so a
   * longer one could be *set* and never *used*. A cap here and a limit in the login schema that disagree produce
   * an account nobody can log into — the kind of bug that shows up in production, once. A test parses that
   * sentence out of `04-api.md` and compares it to this number, so the two cannot drift.
   *
   * The unit is **UTF-16 code units**, which is what Zod's `.max()` counts on the submitted string — not
   * characters. Measured: the obvious implementation compares *code points* (correct for the length floor, see
   * {@link characterCount}) and therefore accepts 200 emoji, which are 400 UTF-16 units and which the login
   * endpoint then refuses forever.
   */
  maxLength: 256,
  /**
   * The username is rejected as a substring only when it is at least this long.
   *
   * A one- or two-character username (`ad`) occurs inside most passwords by chance, so the rule would reject
   * almost everything instead of the passwords built from it.
   */
  minUsernameLength: 3,
} as const;

/** Which rule a rejected password broke. */
export type PasswordRule =
  'empty' | 'too-short' | 'too-long' | 'surrounding-whitespace' | 'common' | 'contains-username';

/** One reason a password was rejected, with the sentence to show the person who typed it. */
export interface PasswordProblem {
  /** Machine-readable rule; a form can mark the field, a CLI can count. */
  readonly rule: PasswordRule;
  /** User-facing sentence. Never contains the password itself. */
  readonly message: string;
}

/** Context the policy needs beyond the password. Only the username, so far. */
export interface PasswordPolicyContext {
  /** The account's username, checked as a substring. Omitted when there is no account yet. */
  readonly username?: string;
}

/**
 * Raised by {@link assertPasswordAcceptable}.
 *
 * A plain `Error` rather than an `AppError`: the policy is enforced by the operator scripts (`P1-AUTH-06/07`),
 * which have no HTTP response to map it onto. `P1-AUTH-03` maps it to `SEMANTIC_ERROR`/`422` if a
 * password-change endpoint ever needs it, and `problems` is what such a handler would put in `details`.
 */
export class PasswordPolicyError extends Error {
  /** Every rule the password broke, in the order the checks run. */
  readonly problems: readonly PasswordProblem[];

  /**
   * @param problems - Non-empty list of failures; the message is their join.
   */
  constructor(problems: readonly PasswordProblem[]) {
    super(problems.map((problem) => problem.message).join(' '));
    this.name = 'PasswordPolicyError';
    this.problems = problems;
  }
}

/**
 * Normalises a password the way both hashing and verification will see it.
 *
 * Unicode has several encodings of the same visible text: `café` is `e` + U+0301 in one keyboard and U+00E9 in
 * another, and Argon2 hashes bytes, so the two would be different passwords. NFKC makes them the same, which is
 * what the person typing believes. Applied in **one** place, used by both directions — a normalisation step that
 * runs on hash but not on verify is a password nobody can log in with.
 *
 * @param password - Password as submitted.
 * @returns The NFKC form; the string that is actually hashed.
 */
function normalise(password: string): string {
  return password.normalize('NFKC');
}

/**
 * Counts characters the way a person counts them.
 *
 * `.length` counts UTF-16 units, so an emoji is two and `😀😀😀😀😀😀` (six characters to its owner) would pass a
 * twelve-character floor. Code points are the unit the policy is written in.
 *
 * @param value - Normalised password.
 * @returns Number of Unicode code points.
 */
function characterCount(value: string): number {
  return [...value].length;
}

/**
 * Strips what people append to a weak password: trailing digits and symbols (`password123`, `qwerty2026!`).
 *
 * This is the difference between a blocklist that fires against a 12-character floor and one that never does —
 * see the measurement in `weak-passwords.ts`. Only the *trailing* run is removed, and only when enough is left
 * to be a word: `123456789012` strips to nothing and is compared as typed.
 *
 * @param folded - Case-folded candidate.
 * @returns The stem, or `null` when stripping leaves too little to be meaningful.
 */
function weakStem(folded: string): string | null {
  const stem = folded.replace(/[\d!@#$%^&*._-]+$/u, '');
  return stem.length >= 3 && stem !== folded ? stem : null;
}

/**
 * Checks a password against the creation policy.
 *
 * Returns **every** problem instead of the first, because a person typing a bad password should learn all of it
 * once: telling them "too short" and then, on the retry, "too common" is a worse experience with no security
 * benefit. Order is stable — length first, then quality — so the messages read in priority order.
 *
 * @param password - Password as submitted, unnormalised.
 * @param context - The username, when the password is for an existing account.
 * @returns The problems found; empty means accepted.
 */
export function passwordProblems(
  password: string,
  context: PasswordPolicyContext = {},
): PasswordProblem[] {
  const value = normalise(password);

  // An empty password has one problem, not three: "too short", "has surrounding whitespace" and "is common"
  // would all fire on an empty string and say nothing useful.
  if (value.length === 0) {
    return [{ rule: 'empty', message: 'Enter a password.' }];
  }

  const problems: PasswordProblem[] = [];
  const characters = characterCount(value);

  // The floor counts **characters** (code points after NFKC): that is what the person sees, and it is the unit
  // the policy is written in. The ceiling counts **UTF-16 code units of what was submitted**, because that is
  // what the login schema measures — see `PASSWORD_POLICY.maxLength`. Two units, on purpose, for two different
  // jobs; the `else if` is safe because a password cannot plausibly be both (that would need a string that NFKC
  // shrinks by more than 20×) and "too short *and* too long" is a worse message than naming one.
  const submittedUnits = password.length;

  if (characters < PASSWORD_POLICY.minLength) {
    problems.push({
      rule: 'too-short',
      message: `Use at least ${String(PASSWORD_POLICY.minLength)} characters — this one has ${String(characters)}.`,
    });
  } else if (submittedUnits > PASSWORD_POLICY.maxLength) {
    problems.push({
      rule: 'too-long',
      message: `Use at most ${String(PASSWORD_POLICY.maxLength)} characters — this one has ${String(submittedUnits)}.`,
    });
  }

  // Surrounding whitespace is rejected rather than trimmed: trimming would silently change the password the
  // person set, and the next login would fail with no explanation.
  if (value !== value.trim()) {
    problems.push({
      rule: 'surrounding-whitespace',
      message:
        'Remove the space at the start or end — it is part of the password and easy to mistype.',
    });
  }

  const folded = value.toLowerCase();
  const stem = weakStem(folded);
  const isCommon = WEAK_PASSWORD_SET.has(folded) || (stem !== null && WEAK_PASSWORD_SET.has(stem));
  if (isCommon) {
    problems.push({
      rule: 'common',
      message: 'That password is on the common-password list. Choose something less predictable.',
    });
  }

  // The username is normalised the same way the password is: `José` typed decomposed would otherwise be compared
  // against a composed password and missed — the one case where the substring rule silently does nothing.
  const username = normalise(context.username?.trim() ?? '').toLowerCase();
  if (username.length >= PASSWORD_POLICY.minUsernameLength && folded.includes(username)) {
    problems.push({
      rule: 'contains-username',
      message: 'Do not put the username inside the password.',
    });
  }

  return problems;
}

/**
 * Enforces the policy, throwing when it is not met.
 *
 * Use this at every point a password is **created** — the launch script (`P1-AUTH-06`) and the reset script
 * (`P1-AUTH-07`) — and nowhere else.
 *
 * @param password - Password as submitted.
 * @param context - The username, when known.
 * @throws {PasswordPolicyError} With every problem found attached.
 */
export function assertPasswordAcceptable(
  password: string,
  context: PasswordPolicyContext = {},
): void {
  const problems = passwordProblems(password, context);
  if (problems.length > 0) throw new PasswordPolicyError(problems);
}

/**
 * Hashes a password for storage.
 *
 * The result is a self-describing PHC string (`$argon2id$v=19$m=65536,t=3,p=1$<salt>$<digest>`) with a fresh
 * 16-byte random salt, so the column stores the algorithm, its parameters, the salt and the digest together and
 * nothing else has to be versioned.
 *
 * Does **not** enforce the policy: hashing and policy are separate concerns, and the scripts that create
 * passwords (`P1-AUTH-06`, `P1-AUTH-07`) call {@link assertPasswordAcceptable} first. Keeping the check out of
 * here is also what lets the tests hash short strings without a fork in the production path.
 *
 * @param password - Password as submitted; normalised before hashing.
 * @returns The encoded hash, ready for `admins.password_hash`.
 */
export async function hashPassword(password: string): Promise<string> {
  return argonHash(normalise(password), ARGON2_PARAMS);
}

/**
 * Verifies a password against a stored hash.
 *
 * The argument order matches the addon's `verify(hash, password)`, kept deliberately the same so a reviewer
 * comparing this call to the library's cannot read it backwards.
 *
 * @param hash - `admins.password_hash`, as stored.
 * @param password - Password as submitted; normalised before comparison.
 * @returns `true` only for a matching password. `false` for a mismatch **and** for a hash that cannot be
 * decoded — a corrupt row must not become a `500`, and the difference is not something a client may learn.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, normalise(password));
  } catch {
    // The addon throws `Error: Decoding failed` for anything that is not a PHC string (measured: also for `''`
    // and for a bcrypt `$2b$…` hash). Verification is the wrong place to raise that: it is a data problem, and
    // a login endpoint that throws here answers `500` instead of the documented `401`.
    //
    // The trade-off, stated rather than hidden: this also turns a genuine fault inside the addon (thread-pool
    // exhaustion, an error a future version introduces) into a wrong password. Accepted — it fails closed, and
    // the alternative is every data problem answered as a `500` that tells the client it hit something unusual.
    return false;
  }
}
