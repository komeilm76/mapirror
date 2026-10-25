/**
 * Where the session token lives (`P1-WEB-03`, storage half of D-13).
 *
 * D-13 / ADR-014: the token is kept in **`sessionStorage`** — one tab, gone when the tab closes, never sent with a
 * cross-site request the way a cookie would be. The auth store (`P1-WEB-05`) owns the *identity* around it; this module
 * owns the one string, because the router's guard has to answer "is there a session?" before any store exists, and two
 * places reading the same key with different spellings is how a user gets signed out at random.
 *
 * ## Why every call is wrapped in `try`
 *
 * `sessionStorage` is not always there and not always usable. A browser in a privacy mode that blocks storage still
 * exposes the property but throws `SecurityError` on access, and an embedded frame with no same-origin access throws
 * too. An unguarded read would turn "we cannot remember your session" into "this page does not load": the router guard
 * calls this on every admin navigation, so the exception would surface as a blank screen with no console message the
 * user can act on. Treating an unusable store as an empty one costs a sign-in and keeps the sign-in page reachable.
 *
 * The storage reader is injectable for one reason: the throwing case above must be *tested*, and the only other way to
 * test it is to break `window` for the whole file.
 *
 * @module auth/token-storage
 */

/** The `sessionStorage` key. Namespaced, and versionless on purpose: a rename would sign everyone out once, which is
 * cheaper than a migration nobody will remember to delete. */
export const SESSION_TOKEN_KEY = 'mapirror.session.token';

/** Reads the browser's store, or reports that it cannot be used. */
export type StorageReader = () => Storage | null;

/**
 * The browser's `sessionStorage`, or `null` when touching it throws.
 *
 * @returns The store, or `null`.
 */
export const browserStorage: StorageReader = () => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    // A privacy mode that blocks storage, or a frame without same-origin access. See the module comment.
    return null;
  }
};

/**
 * Reads the stored token.
 *
 * @param reader - Where to look; defaults to the browser's `sessionStorage`.
 * @returns The token, or `null` when there is none, the store is unusable, or the stored value is empty.
 */
export function readSessionToken(reader: StorageReader = browserStorage): string | null {
  try {
    const value = reader()?.getItem(SESSION_TOKEN_KEY) ?? null;
    // An empty string is not a credential: `Bearer ` would be sent as a header the API refuses as malformed, which is a
    // 401 the user cannot explain. Normalising it to "no session" here keeps that out of the request path entirely.
    return value === null || value.trim() === '' ? null : value;
  } catch {
    return null;
  }
}

/**
 * Stores the token.
 *
 * @param token - The credential from `POST /_auth/api/login`.
 * @param reader - Where to write; defaults to the browser's `sessionStorage`.
 * @returns `true` when it was stored, `false` when the store is unusable — the caller decides whether that matters.
 */
export function writeSessionToken(token: string, reader: StorageReader = browserStorage): boolean {
  try {
    const store = reader();
    if (store === null) return false;
    store.setItem(SESSION_TOKEN_KEY, token);
    return true;
  } catch {
    // Quota exceeded is the other real case: a huge token, or a shared origin. The login still succeeded; the session
    // simply will not survive a reload, and returning `false` is how the store tells the UI.
    return false;
  }
}

/**
 * Forgets the token — on sign-out, and on any `401` (`P1-WEB-04`).
 *
 * @param reader - Where to clear; defaults to the browser's `sessionStorage`.
 */
export function clearSessionToken(reader: StorageReader = browserStorage): void {
  try {
    reader()?.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Nothing to do: the store cannot be read either, so nothing is left behind that a later read would find.
  }
}

/**
 * Reports whether a session token is present.
 *
 * Presence, not validity: the router guard is a **navigation** convenience, not a security boundary (L2 — page shells
 * are inert, and every byte of data comes from an API call that verifies the token itself). A stale token is caught by
 * the first `/me` or admin request, which answers `401` and sends the user here.
 *
 * @param reader - Where to look; defaults to the browser's `sessionStorage`.
 * @returns `true` when a non-empty token is stored.
 */
export function hasSessionToken(reader: StorageReader = browserStorage): boolean {
  return readSessionToken(reader) !== null;
}
