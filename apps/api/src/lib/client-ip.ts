/**
 * Turns a client address into something the database will accept, or into `null`.
 *
 * `request.ip` is **untrusted input**, and that is not obvious from its type — it is a `string`, so it reads like a
 * fact the server established. With `trustProxy` enabled (which this API needs, `config/env.ts`), Fastify asks
 * `proxy-addr` for the left-most address the trusted peer forwarded, and `proxy-addr` does no validation of its own.
 * Measured on a real instance with `trustProxy: 'loopback'`:
 *
 * | `X-Forwarded-For` | `request.ip` |
 * |---|---|
 * | *(absent)* | `127.0.0.1` |
 * | `203.0.113.9` | `203.0.113.9` |
 * | `not-an-ip` | `not-an-ip` |
 * | `<script>` | `<script>` |
 * | `203.0.113.9:8080` | `203.0.113.9:8080` |
 *
 * Two consequences, both measured against Postgres. `admin_tokens.ip` and `audit_logs.ip` are `inet` columns, and
 * inserting `not-an-ip` raises `22P02` — so `POST /_auth/api/login` answered `500` to anyone who added that header,
 * and `203.0.113.9:8080` (a form real proxies emit) did the same to honest traffic. Any rate limiter keyed on the raw
 * value is equally spoofable: a fresh junk value per request is a fresh bucket per request.
 *
 * The rule here is therefore: **parse, do not trust.** A value that is not an address becomes `null`, which the schema
 * already allows — losing the address is a diagnostics loss, while storing it is a `500` and a bypass.
 *
 * @module lib/client-ip
 */

import { isIP } from 'node:net';

/** Longest address we will even look at; the longest valid IPv6 form is 45 characters. */
const MAX_ADDRESS_LENGTH = 64;

/**
 * Normalises a possibly-bogus client address into a value PostgreSQL's `inet` accepts.
 *
 * Accepts a bare IPv4 (`203.0.113.9`), a bare IPv6 (`2001:db8::1`), and the bracketed-or-ported forms proxies emit
 * (`203.0.113.9:8080`, `[2001:db8::1]:443`), because those arrive from *trusted* infrastructure that happens to
 * include the port. Anything else — a hostname, an injected payload, an empty string, a comma-joined chain (the caller
 * should pass one address, not the header) — becomes `null`.
 *
 * The port is stripped only when what remains is a valid address, so `2001:db8::1` (whose "port-looking" suffix is
 * part of the address) is not mangled: the whole string is tried first.
 *
 * @param value - Candidate address, typically `request.ip`.
 * @returns A string `inet` accepts, or `null` when the value is not an address.
 */
export function normaliseIp(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0 || trimmed.length > MAX_ADDRESS_LENGTH) return null;

  // Tried whole first: an IPv6 address contains colons, and splitting one on ':' would destroy it.
  if (isIP(trimmed) !== 0) return trimmed;

  // `[v6]:port` — the bracketed form, which is the only unambiguous way to attach a port to an IPv6 literal.
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close === -1) return null;
    const host = trimmed.slice(1, close);
    const suffix = trimmed.slice(close + 1);
    return /^:\d{1,5}$/u.test(suffix) && isIP(host) === 6 ? host : null;
  }

  // `v4:port`. A bare IPv6 literal cannot be mistaken for this: it has several colons, so `host` would fail `isIP`.
  // Written with `indexOf`/`slice` rather than a capture group because a group that "cannot" be missing still needs
  // a fallback for the type checker, and that fallback is a branch no input can reach — a line covered by nothing.
  const colon = trimmed.indexOf(':');
  if (colon === -1) return null;
  const host = trimmed.slice(0, colon);
  const port = trimmed.slice(colon + 1);
  return /^\d{1,5}$/u.test(port) && isIP(host) === 4 ? host : null;
}

/**
 * Reports whether a candidate is a usable client address.
 *
 * @param value - Candidate, typically `request.ip`.
 * @returns `true` when {@link normaliseIp} would return a string.
 */
export function isIpAddress(value: string | null | undefined): boolean {
  return normaliseIp(value) !== null;
}
