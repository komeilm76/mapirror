/**
 * The login contract: request and response shapes, shared by the API and the SPA (`P1-AUTH-03`).
 *
 * Why this lives in `shared` rather than in the route file: the login form and the login endpoint have to agree about
 * the *bounds* before either can be written. A username field that allows 64 characters in the SPA and 32 in the API
 * is a bug that shows up as "the form accepted it and the server rejected it", which is the least debuggable shape a
 * validation problem can take. One schema, imported by both, makes that impossible.
 *
 * **The bounds are deliberately not the password policy.** The login schema accepts a **1**-character password, while
 * creation requires 12 (`modules/auth/password.ts`). That is not an oversight:
 *
 * - an account created under an older, weaker policy must still be able to log in, and
 * - a login endpoint that enforces the policy answers differently for "too short" and "wrong", which tells an
 *   attacker something about the account.
 *
 * The minimum is enforced where a password is *created* — the launch script and the reset script — which is the rule
 * the docs state. {@link LOGIN_PASSWORD_MAX} is still the ceiling, because it is the most a password can be and still
 * be usable at login.
 *
 * @module auth
 */

import { z } from 'zod';

/**
 * Longest username the login endpoint accepts (`04-api.md` §1).
 *
 * 64 because that is what the document says and what the `admins.username` column comfortably holds; it is a bound on
 * untrusted input, not a policy about names — the launch script is where a name is chosen.
 */
export const LOGIN_USERNAME_MAX = 64;

/**
 * Longest password the login endpoint accepts (`04-api.md` §1).
 *
 * Counted in **code points**, which is the unit Zod 4's `.max()` measures on a string — verified by measurement in
 * pass 23, after pass 20 assumed the opposite and made the creation policy stricter than this schema (200 emoji is 200
 * code points and 400 UTF-16 units: it passes). The same number is the ceiling of the creation policy
 * (`PASSWORD_POLICY.maxLength`), and a test asserts that the two are equal *and* that anything creation accepts is
 * accepted here: if the policy allowed a longer password than the login endpoint, an account could be created whose
 * password could never be used.
 */
export const LOGIN_PASSWORD_MAX = 256;

/** Shortest username; the column has no minimum, but an empty name is not a name. */
export const LOGIN_USERNAME_MIN = 1;

/** Shortest password **at login**. See the module comment: the creation policy's floor is 12, this is 1. */
export const LOGIN_PASSWORD_MIN = 1;

/**
 * Body of `POST /_auth/api/login`.
 *
 * Unknown keys are ignored rather than rejected: a client that sends `{ username, password, rememberMe }` should not
 * fail because a field it invented is unknown, and nothing here is a privilege boundary that an extra key could cross.
 * `.strict()` on an auth endpoint is tempting and buys nothing — the two keys that matter are named explicitly.
 */
export const LoginRequestSchema = z.object({
  username: z
    .string()
    .min(LOGIN_USERNAME_MIN, 'Enter your username.')
    .max(LOGIN_USERNAME_MAX, `Use at most ${String(LOGIN_USERNAME_MAX)} characters.`),
  password: z
    .string()
    .min(LOGIN_PASSWORD_MIN, 'Enter your password.')
    .max(LOGIN_PASSWORD_MAX, `Use at most ${String(LOGIN_PASSWORD_MAX)} characters.`),
});

/** Body of `POST /_auth/api/login`, as parsed. */
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** The admin profile echoed by `/login` and `/me`. Never contains anything secret. */
export const AdminProfileSchema = z.object({
  id: z.uuid(),
  username: z.string().min(1),
});

/** The admin profile echoed by `/login` and `/me`. */
export type AdminProfile = z.infer<typeof AdminProfileSchema>;

/**
 * Response of `POST /_auth/api/login` — `200`.
 *
 * `expiresAt` is an ISO-8601 UTC string rather than an epoch number: it is displayed ("signed in until 21:20") and
 * compared with `Date.parse` in the SPA, and a numeric timestamp is ambiguous the moment anyone reads a log.
 */
export const LoginResponseSchema = z.object({
  /** Shown once. The server keeps only its SHA-256 digest (`P1-AUTH-02`). */
  token: z.string().min(1),
  /** ISO-8601 instant at which the token stops working. */
  expiresAt: z.iso.datetime(),
  admin: AdminProfileSchema,
});

/** Response of `POST /_auth/api/login`, as produced and as the SPA reads it. */
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Response of `GET /_auth/api/me` — `200` (`04-api.md` §1).
 *
 * The SPA calls this on boot to find out whether the token in `sessionStorage` is still worth holding, so the answer
 * has to say more than "yes": `expiresAt` lets the panel warn before the session ends instead of losing a half-filled
 * form to a sudden `401`, and `lastUsedAt` is what a sessions screen shows. Both are the **token's** facts, not the
 * account's — a token can be younger than the account's last login.
 *
 * Deliberately flat, with the same `admin` object `/login` returns: the SPA stores one profile shape and does not have
 * to learn a second one. No token id or prefix here either: the client already holds the token itself, and a prefix is
 * for a *list* of sessions (`P2`), not for the one it is using.
 */
export const MeResponseSchema = z.object({
  admin: AdminProfileSchema,
  /** ISO-8601 instant at which the presented token stops working. */
  expiresAt: z.iso.datetime(),
  /** ISO-8601 instant of the last request made with this token, or `null` if this is the first one. */
  lastUsedAt: z.iso.datetime().nullable(),
});

/** Response of `GET /_auth/api/me`, as produced and as the SPA reads it. */
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * `details` of a `429 RATE_LIMITED` from the login endpoint (`04-api.md` §1).
 *
 * Both fields describe the same instant, and both are present because two different consumers need different things:
 * a machine retries after `retryAfterSeconds` (the same number the `Retry-After` header carries), while a person
 * reads `lockedUntil` as a time. Returning only one would make the other be re-derived in the SPA, i.e. in the place
 * least able to be sure.
 */
export const LoginRateLimitDetailsSchema = z.object({
  /** ISO-8601 instant at which the next attempt is allowed. */
  lockedUntil: z.iso.datetime(),
  /** Whole seconds from now until {@link LoginRateLimitDetailsSchema.lockedUntil}; at least 1. */
  retryAfterSeconds: z.int().min(1),
});

/** `details` of a `429 RATE_LIMITED` from the login endpoint. */
export type LoginRateLimitDetails = z.infer<typeof LoginRateLimitDetailsSchema>;
