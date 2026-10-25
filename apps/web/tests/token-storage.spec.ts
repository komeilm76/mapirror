import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  browserStorage,
  clearSessionToken,
  hasSessionToken,
  readSessionToken,
  SESSION_TOKEN_KEY,
  writeSessionToken,
} from '../src/auth/token-storage';

/**
 * Where the session token lives (`P1-WEB-03`, D-13).
 *
 * The module exists because the router's guard has to answer "is there a session?" before any store is built, and
 * because `sessionStorage` is the one browser API in this app that **throws on access** rather than returning
 * something useless: a privacy mode that blocks storage, and an embedded frame without same-origin access, both throw
 * `SecurityError` on the property itself.
 *
 * The failure that matters is not "the token is lost" — it is "the page does not load". The guard calls this on every
 * admin navigation, so an exception here is a blank screen with no message. Every case below is that failure, driven
 * through an injected reader so the real `window` is never broken for the rest of the file.
 */

/** A store that exists and throws on every call, the way a blocked one does. */
function throwingStore(): Storage {
  const explode = (): never => {
    throw new Error('SecurityError: the operation is insecure');
  };
  return {
    getItem: explode,
    setItem: explode,
    removeItem: explode,
    clear: explode,
    key: explode,
    length: 0,
  };
}

/** A store whose `setItem` throws, which is what a quota is. */
function fullStore(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
}

afterEach(() => {
  sessionStorage.clear();
});

describe('reading and writing, against the real store', () => {
  it('round-trips a token', () => {
    expect(readSessionToken()).toBeNull();
    expect(hasSessionToken()).toBe(false);

    expect(writeSessionToken('token-abc')).toBe(true);
    expect(readSessionToken()).toBe('token-abc');
    expect(hasSessionToken()).toBe(true);

    clearSessionToken();
    expect(readSessionToken()).toBeNull();
  });

  it('stores under one namespaced key, so two spellings cannot disagree', () => {
    // `SESSION_TOKEN_KEY` is exported because `P1-WEB-04`'s 401 handler and `P1-WEB-05`'s store both have to clear the
    // same item; a second literal spelled `mapirror.token` would sign the user out of nothing.
    expect(SESSION_TOKEN_KEY).toBe('mapirror.session.token');
    writeSessionToken('token-abc');

    expect(sessionStorage.getItem('mapirror.session.token')).toBe('token-abc');
    expect(sessionStorage.length).toBe(1);
  });

  it('treats an empty or blank stored value as no session', () => {
    // `Bearer ` with nothing after it is a header the API refuses as malformed: a 401 the user cannot explain, on a
    // page they just signed in to. Normalising it here keeps it out of the request path entirely.
    sessionStorage.setItem(SESSION_TOKEN_KEY, '');
    expect(readSessionToken()).toBeNull();
    expect(hasSessionToken()).toBe(false);

    sessionStorage.setItem(SESSION_TOKEN_KEY, '   ');
    expect(readSessionToken()).toBeNull();
  });

  it('does not trim a real token', () => {
    // The store returns the token byte for byte: a token with a space in it is not this module's business to fix, and
    // silently trimming one would break a signature check with no clue why.
    writeSessionToken(' token-with-spaces ');
    expect(readSessionToken()).toBe(' token-with-spaces ');
  });
});

describe('when the store cannot be used at all', () => {
  it('reports no session instead of throwing', () => {
    // The privacy-mode case. `browserStorage()` is the only place that touches the global, so wrapping it is enough —
    // and this case proves the wrap is there, by making the global itself throw.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });

    try {
      expect(browserStorage()).toBeNull();
      expect(readSessionToken()).toBeNull();
      expect(hasSessionToken()).toBe(false);
      expect(writeSessionToken('token-abc')).toBe(false);
      // Clearing must not throw either: it runs in the same sign-out path as a working store.
      expect(() => clearSessionToken()).not.toThrow();
    } finally {
      if (descriptor === undefined)
        delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
      else Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    }
  });

  it('reports no session when the reader returns `null`', () => {
    expect(readSessionToken(() => null)).toBeNull();
    expect(hasSessionToken(() => null)).toBe(false);
    expect(writeSessionToken('token-abc', () => null)).toBe(false);
    expect(() => clearSessionToken(() => null)).not.toThrow();
  });

  it('reports no session when the store throws on every call', () => {
    // The other shape of the same failure: the object is there but every method throws (frames, and Safari's private
    // mode in some versions). The `try` blocks have to catch per call, not only around the property access.
    const store = throwingStore();
    expect(readSessionToken(() => store)).toBeNull();
    expect(hasSessionToken(() => store)).toBe(false);
    expect(writeSessionToken('token-abc', () => store)).toBe(false);
    expect(() => clearSessionToken(() => store)).not.toThrow();
  });

  it('reports a failed write when the quota is full, and keeps the login', () => {
    // The login itself succeeded; only the session's survival across a reload is lost. `false` is how the store says so,
    // and the caller decides whether to care.
    const store = fullStore();
    expect(writeSessionToken('token-abc', () => store)).toBe(false);
    expect(readSessionToken(() => store)).toBeNull();
  });
});

describe('the injectable reader', () => {
  it('is what production uses by default', () => {
    // The default argument is `browserStorage`, so a case that injects nothing still works — the risk of an injected
    // reader is that production quietly uses something else.
    const spy = vi.spyOn(globalThis, 'sessionStorage', 'get');
    writeSessionToken('token-abc');

    expect(spy).toHaveBeenCalled();
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('token-abc');
    spy.mockRestore();
  });
});
