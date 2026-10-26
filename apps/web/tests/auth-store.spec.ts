import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResponse } from '@mapirror/shared';

import { createApiClient } from '../src/api/client';
import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { useApi } from '../src/composables/useApi';
import { ADMIN_ROOT, LOGIN_PAGE } from '../src/router/paths';
import { useAuth } from '../src/stores/auth';
import { useNotifications } from '../src/stores/notifications';

/**
 * The session store (`P1-WEB-05`).
 *
 * The acceptance criterion is two sentences — "refresh keeps session; logout clears" — and both are about *survival* and
 * *absence*, which a browser gives you and a test has to construct: a second Pinia is a refresh, and an empty
 * `sessionStorage` is a closed tab.
 *
 * The cases that are worth more than the criterion:
 *
 * - **a session that cannot be persisted is still a session** (private mode, a full quota) — the tab works, and the
 *   store says so rather than throwing the login away;
 * - **an unanswered `/me` is not a refusal** — a laptop that wakes up offline must not be signed out;
 * - **the revoke is sent before the token is cleared**, or `POST /_auth/api/logout` goes out without a header and the
 *   server keeps a session the screen says is over.
 */

/** An admin endpoint, by its own prefix (`04-api.md` §2) — not a page path. */
const ADMIN_API = '/_admin/api/cache';

/** A profile that satisfies the shared schema — a real UUID, because `AdminProfileSchema.id` is `z.uuid()`. */
const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };

/** What `POST /_auth/api/login` answers, as `@mapirror/shared` types it. */
const SESSION: LoginResponse = {
  token: 'mm_fresh',
  expiresAt: '2026-10-25T21:00:00.000Z',
  admin: PROFILE,
};

/** A `fetch` answering `status` with the documented envelope (`04-api.md` §0.2). */
function failing(code: string, status: number): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code, message: 'Refused.', requestId: 'req-9' } }), {
        status,
      }),
    );
}

/** A `fetch` answering with a JSON body. */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

/** The `authorization` header a recorded call carried. */
function authHeaderOf(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): string | null {
  const [, init] = fetchImpl.mock.calls[call] ?? [];
  return new Headers(init?.headers).get('authorization');
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('signing in', () => {
  it('keeps the token, the profile and the expiry, and says the token will survive a reload', () => {
    const auth = useAuth();

    expect(auth.signIn(SESSION)).toBe(true);
    expect(auth.token).toBe('mm_fresh');
    expect(auth.admin).toEqual(PROFILE);
    expect(auth.expiresAt).toBe(SESSION.expiresAt);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.username).toBe('admin');
    // The one thing that has to outlive the tab's memory: the string itself (D-13).
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('mm_fresh');
  });

  it('keeps a session it could not persist, and says so instead of failing', () => {
    // A privacy mode that blocks storage, or a full quota. The server has already issued a token; throwing it away
    // because the tab cannot remember it would turn a working login into "nothing happened".
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const auth = useAuth();

    expect(auth.signIn(SESSION)).toBe(false);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.token).toBe('mm_fresh');
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it('starts signed out, with no name to show', () => {
    const auth = useAuth();

    expect(auth.isAuthenticated).toBe(false);
    expect(auth.username).toBeNull();
    expect(auth.expiresAt).toBeNull();
  });
});

describe('a reload', () => {
  it('comes back with the token and without a name', () => {
    // A reload keeps `sessionStorage` and loses the store. The profile is deliberately not persisted: the token is the
    // only thing that survived, so a name on screen before `/me` answers would be a claim nothing backs.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_kept');

    setActivePinia(createPinia());
    const auth = useAuth();

    expect(auth.token).toBe('mm_kept');
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.admin).toBeNull();
    expect(auth.username).toBeNull();
  });

  it('treats an empty stored value as no session', () => {
    // `Bearer ` with nothing after it is a header the API refuses as malformed — a 401 nobody can explain. The storage
    // module normalises it; the store inherits that by reading through it.
    sessionStorage.setItem(SESSION_TOKEN_KEY, '   ');

    setActivePinia(createPinia());

    expect(useAuth().isAuthenticated).toBe(false);
  });
});

describe('restore()', () => {
  it('fills the profile from /me, presenting the token it is asking about', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_kept');
    const fetchImpl = vi.fn<typeof fetch>(
      jsonFetch({
        admin: PROFILE,
        expiresAt: '2026-10-25T22:00:00.000Z',
        lastUsedAt: null,
      }),
    );
    const auth = useAuth();
    const client = createApiClient({ fetchImpl, token: () => auth.token });

    await expect(auth.restore(client)).resolves.toBe('session');

    expect(auth.admin).toEqual(PROFILE);
    expect(auth.expiresAt).toBe('2026-10-25T22:00:00.000Z');
    expect(authHeaderOf(fetchImpl)).toBe('Bearer mm_kept');
  });

  it('asks nobody when there is no token and makes no request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const auth = useAuth();

    await expect(auth.restore(createApiClient({ fetchImpl }))).resolves.toBe('signed-out');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the session when the question goes unanswered', async () => {
    // Offline, a tunnel, a proxy timeout: the store cannot know whether the token is good, so it must not decide that it
    // is bad. Signing out here is the bug readers report as "it logs me out all the time".
    const auth = useAuth();
    auth.signIn(SESSION);
    const client = createApiClient({
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
      token: () => auth.token,
    });

    await expect(auth.restore(client)).resolves.toBe('unverified');
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.username).toBe('admin');
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('mm_fresh');
  });

  it('does not accept a 200 whose body is not a profile', async () => {
    // A `200` is not a fact: the body crossed the network. The shared schema is what turns it into one, and a body that
    // does not fit leaves the session untouched rather than inventing an admin.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_kept');
    const auth = useAuth();
    const client = createApiClient({
      fetchImpl: jsonFetch({ admin: { id: 'not-a-uuid', username: '' } }),
      token: () => auth.token,
    });

    await expect(auth.restore(client)).resolves.toBe('unverified');
    expect(auth.admin).toBeNull();
    expect(auth.isAuthenticated).toBe(true);
  });

  it('forgets a token the API refuses', async () => {
    // The other side of "unanswered is not refused": a `401` *is* an answer, and the credential is finished.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_stale');
    const auth = useAuth();
    const client = createApiClient({ fetchImpl: failing('TOKEN_EXPIRED', 401) });

    await expect(auth.restore(client)).resolves.toBe('signed-out');
    expect(auth.isAuthenticated).toBe(false);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});

describe('an answer that arrives late', () => {
  /** A `fetch` that waits for `release()`, so a case can change the session mid-request. */
  function deferred(answer: () => Response): { fetchImpl: typeof fetch; release: () => void } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      release,
      fetchImpl: () =>
        gate.then(() => {
          return answer();
        }),
    };
  }

  it('does not refill the profile on a session that has since ended', async () => {
    // Found in pass 34 by probing, not by reading: the reader presses "sign out" while `/me` is in flight, the answer
    // lands afterwards, and the store — holding no token — gets a profile back. `isAuthenticated` stays `false`, so no
    // guard or request notices; the *topbar* notices, and shows the name of the admin who just signed out.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_old');
    const auth = useAuth();
    const { fetchImpl, release } = deferred(
      () =>
        new Response(
          JSON.stringify({ admin: PROFILE, expiresAt: SESSION.expiresAt, lastUsedAt: null }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    const client = createApiClient({ fetchImpl, token: () => auth.token });

    const pending = auth.restore(client);
    auth.forget();
    release();

    await expect(pending).resolves.toBe('signed-out');
    expect(auth.admin).toBeNull();
    expect(auth.expiresAt).toBeNull();
  });

  it('does not sign out a new session because an old token was refused', async () => {
    // The same race with the opposite sign, and the worse outcome: a `401` for the token the reader has already
    // replaced calls `forget()` on the replacement — signing out a session the server has just issued.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_old');
    const auth = useAuth();
    const { fetchImpl, release } = deferred(
      () => new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED' } }), { status: 401 }),
    );
    const client = createApiClient({ fetchImpl, token: () => auth.token });

    const pending = auth.restore(client);
    auth.signIn({ ...SESSION, token: 'mm_new' });
    release();

    await expect(pending).resolves.toBe('unverified');
    expect(auth.token).toBe('mm_new');
    expect(auth.isAuthenticated).toBe(true);
  });
});

describe('hasExpired()', () => {
  it('is a hint about the local clock, and says nothing when it has nothing to read', () => {
    const auth = useAuth();
    const now = Date.parse('2026-10-25T20:00:00.000Z');

    // No expiry yet: not expired. The absence of evidence is not evidence.
    expect(auth.hasExpired(now)).toBe(false);

    auth.signIn(SESSION);
    expect(auth.hasExpired(now)).toBe(false);
    expect(auth.hasExpired(Date.parse('2026-10-25T21:00:00.000Z'))).toBe(true);

    // A stamp the browser cannot parse is not a session that ended.
    auth.expiresAt = 'not a date';
    expect(auth.hasExpired(now)).toBe(false);
  });
});

describe('signing out', () => {
  it('revokes the token it is about to forget', async () => {
    // The order is the whole case. `createApiClient` reads the token from this store when the request is built, so a
    // sign-out that cleared first would revoke nothing — leaving a live session on the server that the screen says is
    // over. Measured shape: `POST /_auth/api/logout` with no `authorization` header answers `401 UNAUTHENTICATED`.
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const auth = useAuth();
    auth.signIn(SESSION);
    const client = createApiClient({ fetchImpl, token: () => auth.token });
    const notifications = useNotifications();
    notifications.success('Country deleted.');

    auth.signOut(client);
    await flushPromises();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    // The client passes a string path; a `Request` here would mean it had built one, which it does not.
    expect(url).toBe('/_auth/api/logout');
    expect(init?.method).toBe('POST');
    expect(authHeaderOf(fetchImpl)).toBe('Bearer mm_fresh');

    // ...and then everything is gone, including the toast queue: "Saved" belongs to the session that saved it.
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.admin).toBeNull();
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(notifications.items).toEqual([]);
  });

  it('signs out with no client at all', () => {
    const auth = useAuth();
    auth.signIn(SESSION);

    expect(() => {
      auth.signOut();
    }).not.toThrow();
    expect(auth.isAuthenticated).toBe(false);
  });

  it('does not wait for the revoke, and does not fall over when it fails', async () => {
    // A sign-out the reader asked for must not depend on the network. The local session goes now; a server that cannot
    // be reached is a revocation left to the token's own expiry.
    const auth = useAuth();
    auth.signIn(SESSION);
    const client = createApiClient({
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
      token: () => auth.token,
    });

    expect(() => {
      auth.signOut(client);
    }).not.toThrow();
    expect(auth.isAuthenticated).toBe(false);

    // The rejection is caught inside `signOut`; an unhandled one fails this file at the runner level, which is the
    // assertion — Vitest reports a rejection nothing handled as an error in the run, not as a passing test.
    await flushPromises();
    expect(auth.isAuthenticated).toBe(false);
  });

  it('forgets silently — no request, no toast, no navigation', () => {
    // `forget()` is what the API client's sign-out policy calls, because that path adds the toast that explains why it
    // happened. If `forget` toasted too, a dead token would produce two.
    const fetchImpl = vi.fn<typeof fetch>();
    const auth = useAuth();
    auth.signIn(SESSION);

    auth.forget();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(useNotifications().items).toEqual([]);
    expect(auth.token).toBeNull();
  });
});

describe('the app is wired to this store', () => {
  it('lets the router guard read the store rather than the storage key', async () => {
    // `bootstrap.ts` hands the guard `() => auth.isAuthenticated`. A guard that read `sessionStorage` would refuse this
    // navigation, because the token below is written to the store's *state* only — which is the real case for a browser
    // whose storage is blocked, and the one an injected predicate exists for.
    const app = createWebApp();
    const router = (
      app.config.globalProperties as unknown as {
        $router: {
          push: (p: string) => Promise<unknown>;
          currentRoute: { value: { path: string } };
        };
      }
    ).$router;
    const auth = app.runWithContext(() => useAuth());

    await router.push(`${ADMIN_ROOT}/cache`);
    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);

    auth.token = 'mm_memory';
    await router.push(`${ADMIN_ROOT}/cache`);
    expect(router.currentRoute.value.path).toBe(`${ADMIN_ROOT}/cache`);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it('sends the store token, and clears the store when the API refuses it', async () => {
    // The pair `token`/`clearToken` that pass 33 introduced, seen from the assembly that ships: the client presents what
    // the store holds, and the sign-out latch is emptied in the same source — so a second `401` from the same burst finds
    // nothing to report, and a *store-backed* session is not latched against a `sessionStorage` nobody wrote.
    const fetchImpl = vi.fn<typeof fetch>(failing('TOKEN_EXPIRED', 401));
    vi.stubGlobal('fetch', fetchImpl);

    const app = createWebApp();
    const auth = app.runWithContext(() => useAuth());
    const client = app.runWithContext(() => useApi());
    auth.token = 'mm_memory';

    await expect(client.get(ADMIN_API)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });

    expect(authHeaderOf(fetchImpl)).toBe('Bearer mm_memory');
    expect(auth.isAuthenticated).toBe(false);
    expect(useNotifications().items).toHaveLength(1);

    vi.unstubAllGlobals();
  });
});
