import { flushPromises } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { createAppApiClient, provideApiClient, SESSION_ENDED_MESSAGE } from '../src/api';
import type { ApiClient } from '../src/api/client';
import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { ADMIN_ROOT, LOGIN_PAGE, SITE_ROOT } from '../src/router/paths';
import { APP_ROUTES } from '../src/router/routes';
import { useNotifications } from '../src/stores/notifications';

/**
 * What a dead session does (`P1-WEB-04`).
 *
 * `05-flows.md` F2 states the rule — "`401` anywhere ⇒ clear state + redirect" — and this file is that rule with the
 * three qualifications that make it correct in practice:
 *
 * - **Clear first.** The router's guard reads `sessionStorage`; a sign-out that navigates before clearing lands on the
 *   login page with a `redirect` pointing at itself.
 * - **Only from where it happened.** A `401` while the reader is on the public catalog ends the session (the credential
 *   is dead) but must not drag them off a page they can still read.
 * - **Once.** A dashboard fires several requests at once, so a dead token produces several `401`s; the reader sees one
 *   toast and one navigation.
 */

const pinia = createPinia();
const notifications = useNotifications(pinia);

/** A router with the real table, finished its first navigation at `path`. */
async function readyRouter(path: string): Promise<Router> {
  const router = createRouter({ history: createMemoryHistory(), routes: [...APP_ROUTES] });
  await router.push(path);
  await router.isReady();
  return router;
}

/** A `fetch` answering `status` with the documented envelope. */
function failing(code: string, status: number, requestId = 'req-1'): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code, message: 'Refused.', requestId } }), { status }),
    );
}

/** The client under test, wired the way `bootstrap.ts` wires it but with a stub `fetch`. */
async function appClientAt(
  path: string,
  response: typeof fetch,
): Promise<{ client: ApiClient; router: Router }> {
  const router = await readyRouter(path);
  return { client: createAppApiClient({ router, notifications, fetchImpl: response }), router };
}

/** Signs in, as far as this file is concerned: the token the client will present. */
function signIn(token = 'mm_live'): void {
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
}

afterEach(() => {
  sessionStorage.clear();
  notifications.clear();
});

describe('a dead token', () => {
  it('clears the session, says why, and returns to the login page with the destination', async () => {
    signIn();
    const { client, router } = await appClientAt(
      `${ADMIN_ROOT}/jobs?status=failed`,
      failing('TOKEN_EXPIRED', 401),
    );

    await expect(client.get('/_admin/api/jobs')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    // The handler navigates with a floating promise (`void router.replace(...)`), so the assertion below is about the
    // navigation *completing*, not about it being queued.
    await flushPromises();

    // 1. The token is gone *before* the navigation, so the guard that runs next sees an anonymous visitor and lets the
    //    login page through instead of redirecting it to itself.
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();

    // 2. One toast, in the error style that stays (`13-ui-ux.md` §5), naming the reason and carrying the request id a
    //    support request quotes.
    expect(notifications.items).toHaveLength(1);
    const [toast] = notifications.items;
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toBe(SESSION_ENDED_MESSAGE);
    expect(toast?.detail).toBe('The sign-in expired.');
    expect(toast?.requestId).toBe('req-1');
    expect(toast?.timeout).toBeNull();

    // 3. Back to the login page, remembering the page and its filter.
    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
    expect(router.currentRoute.value.query.redirect).toBe(`${ADMIN_ROOT}/jobs?status=failed`);
  });

  it('tells one ending from another', async () => {
    // `P1-AUTH-04`'s point, at the UI end: the verdicts stay distinct, so "signed out elsewhere" and "expired" are not
    // the same sentence. A handler that collapsed them would make `SESSION_ENDED_CODES` pointless.
    const expected = [
      ['UNAUTHENTICATED', 401, 'This browser is no longer signed in.'],
      ['TOKEN_EXPIRED', 401, 'The sign-in expired.'],
      ['TOKEN_REVOKED', 401, 'The session was signed out elsewhere.'],
      ['ACCOUNT_DISABLED', 403, 'This account has been deactivated.'],
    ] as const;

    for (const [code, status, detail] of expected) {
      notifications.clear();
      signIn();
      const { client } = await appClientAt(`${ADMIN_ROOT}/`, failing(code, status));

      await client.get('/_admin/api/system/status').catch(() => undefined);

      expect(notifications.items[0]?.detail, code).toBe(detail);
    }
  });

  it('still signs out for an unreadable 401, with a sentence that commits to nothing', async () => {
    // A proxy's own `401` page: the token is refused, so the session ends — but the reason is unknown, and inventing
    // one ("your account was deactivated") would be worse than saying "sign in again".
    signIn();
    const proxy: typeof fetch = () =>
      Promise.resolve(new Response('<html>401</html>', { status: 401 }));
    const { client, router } = await appClientAt(`${ADMIN_ROOT}/`, proxy);

    await client.get('/_admin/api/system/status').catch(() => undefined);
    await flushPromises();

    expect(notifications.items[0]?.detail).toBe('Sign in again to continue.');
    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
  });

  it('does not yank a reader off a public page', async () => {
    // A stale token attached to a request made from the catalog ends the session — the credential is dead — but the
    // page itself is readable, so the reader stays where they are.
    signIn();
    const { client, router } = await appClientAt(
      `${SITE_ROOT}countries/finland`,
      failing('TOKEN_EXPIRED', 401),
    );

    await client.get('/_admin/api/system/status').catch(() => undefined);

    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(notifications.items).toHaveLength(1);
    expect(router.currentRoute.value.path).toBe(`${SITE_ROOT}countries/finland`);
  });

  it('handles a burst once', async () => {
    // Five requests in flight, one dead token, five `401`s: one toast, one navigation. Without the token check this
    // would be five toasts (three after the cap) and five redirects racing each other.
    signIn();
    const { client, router } = await appClientAt(`${ADMIN_ROOT}/`, failing('TOKEN_EXPIRED', 401));
    const replace = vi.spyOn(router, 'replace');

    await Promise.all(
      Array.from({ length: 5 }, async () =>
        client.get('/_admin/api/system/status').catch(() => undefined),
      ),
    );

    expect(notifications.items).toHaveLength(1);
    // The toast count alone would pass even if the handler ran five times — the store merges identical sentences. The
    // navigation is the part that is not merged: five `replace()` calls are four navigations to a page that is already
    // current, and each one is a router warning in a real browser.
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('handles a burst whose refusals differ in wording, once', async () => {
    // The stronger half of the case above. Two refusals with the same sentence are merged by the toast store anyway, so
    // that case would pass even if the handler ran five times; these two end the session for different documented
    // reasons ("the sign-in expired" / "signed out elsewhere"), which the store deliberately keeps apart. One toast is
    // therefore a statement about the handler, not about the queue.
    signIn();
    const codes = ['TOKEN_EXPIRED', 'TOKEN_REVOKED'];
    let call = 0;
    const fetchImpl: typeof fetch = () => {
      const code = codes[call % codes.length];
      call += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code, message: 'Refused.', requestId: 'req-1' } }), {
          status: 401,
        }),
      );
    };
    const router = await readyRouter(`${ADMIN_ROOT}/`);
    const client = createAppApiClient({ router, notifications, fetchImpl });

    const replace = vi.spyOn(router, 'replace');
    await Promise.all([
      client.get('/_admin/api/jobs').catch(() => undefined),
      client.get('/_admin/api/system/status').catch(() => undefined),
    ]);

    expect(notifications.items).toHaveLength(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('handles the next session too, after a fresh sign-in', async () => {
    // The "handled" latch is the token itself, not a boolean: after a fresh login the next dead token is a new
    // incident, and a boolean would have gone permanently quiet — the second sign-out would leave the reader on an
    // admin page that can only answer `401`. The toast count stays at one on purpose: the same sentence twice is one
    // problem on screen (`stores/notifications.ts`), so the proof is the token being cleared a second time.
    const { client } = await appClientAt(`${ADMIN_ROOT}/`, failing('TOKEN_EXPIRED', 401));

    signIn('mm_first');
    await client.get('/_admin/api/system/status').catch(() => undefined);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(notifications.items).toHaveLength(1);

    signIn('mm_second');
    await client.get('/_admin/api/system/status').catch(() => undefined);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(notifications.items).toHaveLength(1);
  });

  it('says nothing at all for a wrong password', async () => {
    // `INVALID_CREDENTIALS` is the login form's error. The form shows it inline; a toast would double it, and a clear
    // would throw away another tab's session because somebody mistyped here.
    const { client, router } = await appClientAt(LOGIN_PAGE, failing('INVALID_CREDENTIALS', 401));
    signIn();

    const error = await client
      .post('/_auth/api/login', { username: 'admin', password: 'wrong' })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(notifications.items).toHaveLength(0);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('mm_live');
    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
  });

  it('leaves a non-credential failure as a screen-level error, with nothing toasted', async () => {
    // `404`/`500` are the page's business: it renders "what failed, why, what to do, retry" (`13-ui-ux.md` §5). A toast
    // for every one of them would also cover that inline message with a second copy of it.
    signIn();
    const { client } = await appClientAt(`${ADMIN_ROOT}/`, failing('INTERNAL_ERROR', 500));

    await client.get('/_admin/api/system/status').catch(() => undefined);

    expect(notifications.items).toHaveLength(0);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('mm_live');
  });
});

describe('the token seam', () => {
  it('takes a token provider instead of the store, for the auth store P1-WEB-05 will build', async () => {
    // `sessionStorage` is where the token lives, but reading it is not the only possible source: `P1-WEB-05`'s Pinia
    // store holds the same value in memory and hands it in here, so a request does not depend on a storage read
    // succeeding. The provider is asserted through the wire, not through the option.
    const sent: (string | null)[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      sent.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const router = await readyRouter(`${ADMIN_ROOT}/`);

    const client = createAppApiClient({
      router,
      notifications,
      token: () => 'mm_from_the_store',
      fetchImpl,
    });
    await client.get('/_admin/api/system/status');

    expect(sent).toEqual(['Bearer mm_from_the_store']);
  });
});

describe('providing the client to components', () => {
  it('returns the client it was given, so one expression can wire and keep it', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [...APP_ROUTES] });
    const client = createAppApiClient({ router, notifications });
    const app = { provide: vi.fn() };

    expect(provideApiClient(app as never, client)).toBe(client);
    expect(app.provide).toHaveBeenCalledTimes(1);
  });

  it('keeps the API code and the request id for the caller, not only for the toast', async () => {
    // Two audiences for one failure: the reader gets a sentence, the screen gets something to switch on.
    signIn();
    const { client } = await appClientAt(`${ADMIN_ROOT}/`, failing('TOKEN_EXPIRED', 401, 'req-9'));

    const error = await client.get('/_admin/api/system/status').catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'TOKEN_EXPIRED', status: 401, requestId: 'req-9' });
  });
});
