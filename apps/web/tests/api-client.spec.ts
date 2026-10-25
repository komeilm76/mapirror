import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUrl, createApiClient, DEFAULT_TIMEOUT_MS, needsBearer } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';

/**
 * The HTTP client behind `useApi()` (`P1-WEB-04`).
 *
 * No network: `fetchImpl` is a `vi.fn` that returns whatever a case needs, which is the whole point of the injection —
 * a client tested against a live server proves the server works, not the client. Four groups of cases, one per thing
 * the client owns: **when a credential is attached**, **how a request is built**, **how an answer is read**, and
 * **which failures end a session**.
 */

/** A `fetch` that answers with a raw body and a status, and records what it was asked. */
function rawFetch(body: string | null, status = 200) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(body, { status })));
}

/** A `fetch` that answers with a JSON body, and records what it was asked. */
function jsonFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json', ...init.headers },
      }),
    ),
  );
}

/** The `Headers` a recorded call was given. */
function headersOf(fetchImpl: ReturnType<typeof jsonFetch>, call = 0): Headers {
  const [, init] = fetchImpl.mock.calls[call] ?? [];
  return new Headers(init?.headers);
}

const ADMIN = '/_admin/api/cache';
const PUBLIC = '/_public/api/countries';
const LOGIN = '/_auth/api/login';
const ME = '/_auth/api/me';

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('when a credential is attached', () => {
  it('follows the namespace, not a flag on each call', () => {
    // The same rule the router's guard uses: a per-call flag is a flag somebody forgets, and the failure is a `401` on
    // a page that should have worked.
    expect(needsBearer(ADMIN)).toBe(true);
    expect(needsBearer('/_admin/api/catalog/sync')).toBe(true);
    expect(needsBearer(ME)).toBe(true);
    expect(needsBearer('/_auth/api/logout')).toBe(true);
    // The two that must not get one: the public API is anonymous by contract, and login is the request that *mints* a
    // credential — handing it the old one is a live token in one more log line for no benefit.
    expect(needsBearer(PUBLIC)).toBe(false);
    expect(needsBearer(LOGIN)).toBe(false);
  });

  it('keeps the login exception when the call carries a query string or a fragment', () => {
    // The exception compares paths, and a query string is not part of an endpoint's identity — so before pass 33 the
    // request that *mints* a credential was the one carrying the previous one, whenever it was called with a parameter.
    expect(needsBearer(`${LOGIN}?next=%2F_site%2Fadmin%2F`)).toBe(false);
    expect(needsBearer(`${LOGIN}#form`)).toBe(false);
    // ...and a different auth endpoint still gets it, query or not.
    expect(needsBearer(`${ME}?fresh=1`)).toBe(true);
  });

  it('sends no authorization header on a login call with a query string', async () => {
    // The same case one layer down: what the request actually carries.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_stale');
    const fetchImpl = jsonFetch({ ok: true });

    await createApiClient({ fetchImpl }).post(LOGIN, undefined, {
      query: { next: '/_site/admin/' },
    });

    expect(headersOf(fetchImpl).has('authorization')).toBe(false);
  });

  it('sends the stored token on an admin call', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_token');
    const fetchImpl = jsonFetch({ ok: true });

    await createApiClient({ fetchImpl }).get('/_admin/api/system/status');

    expect(headersOf(fetchImpl).get('authorization')).toBe('Bearer mm_token');
  });

  it('sends no authorization header on the public API or on login', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_token');
    const fetchImpl = jsonFetch({ ok: true });
    const client = createApiClient({ fetchImpl });

    await client.get(PUBLIC);
    await client.post(LOGIN, { username: 'admin', password: 'x' });

    expect(headersOf(fetchImpl, 0).has('authorization')).toBe(false);
    expect(headersOf(fetchImpl, 1).has('authorization')).toBe(false);
  });

  it('sends none at all when there is no token', async () => {
    const fetchImpl = jsonFetch({ ok: true });

    await createApiClient({ fetchImpl }).get(ADMIN);

    expect(headersOf(fetchImpl).has('authorization')).toBe(false);
  });

  it('asks the store every time, so a token from a later login is used', async () => {
    // The reader's flow: first request unauthenticated, then signed in. A client that captured the token at
    // construction would keep sending `undefined` — or the previous session's token — for the life of the page.
    const fetchImpl = jsonFetch({ ok: true });
    const client = createApiClient({ fetchImpl });

    await client.get(ADMIN);
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_after_login');
    await client.get(ADMIN);

    expect(headersOf(fetchImpl, 0).has('authorization')).toBe(false);
    expect(headersOf(fetchImpl, 1).get('authorization')).toBe('Bearer mm_after_login');
  });

  it('lets a caller override a header, on purpose', async () => {
    const fetchImpl = jsonFetch({ ok: true });
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_token');

    await createApiClient({ fetchImpl }).get(ADMIN, {
      headers: { 'x-request-id': 'from-the-test' },
    });

    expect(headersOf(fetchImpl).get('x-request-id')).toBe('from-the-test');
    expect(headersOf(fetchImpl).get('accept')).toBe('application/json');
  });
});

describe('how a request is built', () => {
  it('appends query parameters, dropping the ones that mean "absent"', () => {
    // `null`/`undefined` are dropped rather than serialised as `"null"`: `04-api.md` §0.2 says absent means unknown,
    // and `?country=null` would filter for a country named "null".
    expect(
      buildUrl('', ADMIN, {
        page: 1,
        limit: 25,
        sort: 'size',
        descending: true,
        missing: undefined,
        empty: null,
        continents: ['europe', 'asia'],
      }),
    ).toBe(
      '/_admin/api/cache?page=1&limit=25&sort=size&descending=true&continents=europe&continents=asia',
    );
  });

  it('adds a second `&` to a path that already has a query string', () => {
    // A link that arrives with `?tab=versions` and a request that adds `?page=2` must not produce `?tab=versions?page=2`
    // — a parameter named `?page`, which the server silently ignores.
    expect(buildUrl('', `${ADMIN}?tab=versions`, { page: 2 })).toBe(`${ADMIN}?tab=versions&page=2`);
    expect(buildUrl('', ADMIN, {})).toBe(ADMIN);
  });

  it('prefixes the API origin when one is configured', () => {
    expect(buildUrl('http://localhost:8080', PUBLIC, { q: 'fin' })).toBe(
      'http://localhost:8080/_public/api/countries?q=fin',
    );
  });

  it('serialises a body as JSON and says so', async () => {
    const fetchImpl = jsonFetch({ ok: true });

    await createApiClient({ fetchImpl }).post(LOGIN, { username: 'admin', password: 'hunter22' });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"username":"admin","password":"hunter22"}');
    expect(headersOf(fetchImpl).get('content-type')).toBe('application/json');
  });

  it('sends no body and no content-type when there is nothing to send', async () => {
    const fetchImpl = jsonFetch({ ok: true });

    await createApiClient({ fetchImpl }).delete(ADMIN);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
    expect(headersOf(fetchImpl).has('content-type')).toBe(false);
  });

  it('never sends or accepts cookies', async () => {
    // D-13 and `14-security.md` §4: the browser holds the credential in `sessionStorage` and nowhere else. `omit` is the
    // only value that says so in the one deployment that matters — behind nginx the SPA and the API are the *same*
    // origin, so the default `same-origin` would attach cookies to every admin call and accept `set-cookie` from every
    // answer. The first version of this line was `same-origin` with a comment promising it prevented exactly that.
    const fetchImpl = jsonFetch({ ok: true });

    await createApiClient({ fetchImpl }).get(ADMIN);

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(init?.credentials).toBe('omit');
  });

  it('uses the documented verbs, one method each', async () => {
    const fetchImpl = jsonFetch({ ok: true });
    const client = createApiClient({ fetchImpl });

    await client.get(PUBLIC);
    await client.post(PUBLIC, {});
    await client.patch(PUBLIC, {});
    await client.put(PUBLIC, {});
    await client.delete(PUBLIC);

    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'POST',
      'PATCH',
      'PUT',
      'DELETE',
    ]);
  });

  it('refuses to fetch a page path, before touching the network', async () => {
    // `/_site/...` would return HTML and fail in `JSON.parse`, with a message about the body rather than about the
    // mistake. The law is cheap to check and the error names what went wrong (L1).
    const fetchImpl = jsonFetch({ ok: true });

    await expect(createApiClient({ fetchImpl }).get('/_site/admin/cache')).rejects.toThrow(
      /not an API path/u,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('how an answer is read', () => {
  it('parses a JSON body', async () => {
    const fetchImpl = jsonFetch({ data: [{ slug: 'finland' }] });

    await expect(createApiClient({ fetchImpl }).get(PUBLIC)).resolves.toEqual({
      data: [{ slug: 'finland' }],
    });
  });

  it('reads `204 No Content` as success with nothing to say', async () => {
    // `POST /_auth/api/logout` answers exactly this. A client that reads the body fails, and a sign-out that throws is
    // a sign-out the user does not believe happened.
    const fetchImpl = rawFetch(null, 204);

    await expect(createApiClient({ fetchImpl }).post('/_auth/api/logout')).resolves.toBeUndefined();
  });

  it('reads a `200` with an empty body as nothing, not as a parse error', async () => {
    const fetchImpl = rawFetch('', 200);

    await expect(createApiClient({ fetchImpl }).get(PUBLIC)).resolves.toBeUndefined();
  });

  it('reports a body that is not JSON as MALFORMED', async () => {
    const fetchImpl = rawFetch('<html>maintenance</html>', 200);

    const error = await createApiClient({ fetchImpl })
      .get(PUBLIC)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('MALFORMED');
    expect((error as ApiError).status).toBe(200);
  });

  it('turns the documented envelope into an ApiError, code and all', async () => {
    const body = {
      error: {
        code: 'JOB_ALREADY_RUNNING',
        message: 'A sync is already running.',
        requestId: 'req-1',
      },
    };
    const fetchImpl = rawFetch(JSON.stringify(body), 409);

    const error = await createApiClient({ fetchImpl })
      .post('/_admin/api/catalog/sync')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('JOB_ALREADY_RUNNING');
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).requestId).toBe('req-1');
  });
});

describe('which failures end a session', () => {
  /** Answers `status` with the given code, the way the API does. */
  function codeFetch(code: string, status: number) {
    return rawFetch(
      JSON.stringify({ error: { code, message: 'No.', requestId: 'req-x' } }),
      status,
    );
  }

  it('fires once for a dead token, with the failure', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_stale');
    const onSessionExpired = vi.fn();

    const error = await createApiClient({
      fetchImpl: codeFetch('TOKEN_EXPIRED', 401),
      onSessionExpired,
    })
      .get(ADMIN)
      .catch((caught: unknown) => caught);

    expect((error as ApiError).code).toBe('TOKEN_EXPIRED');
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).toHaveBeenCalledWith(error);
  });

  it('fires for a deactivated account, which no retry will fix', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_token');
    const onSessionExpired = vi.fn();

    await createApiClient({ fetchImpl: codeFetch('ACCOUNT_DISABLED', 403), onSessionExpired })
      .get(ADMIN)
      .catch(() => undefined);

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a wrong password on the login page', async () => {
    // The case that makes this a rule rather than a status check: `401 INVALID_CREDENTIALS` comes from the one request
    // that has no credential, so there is no session to end. Without the token condition it would clear whatever
    // another tab left in `sessionStorage` because someone mistyped their password here.
    const onSessionExpired = vi.fn();

    await createApiClient({ fetchImpl: codeFetch('INVALID_CREDENTIALS', 401), onSessionExpired })
      .post(LOGIN, { username: 'admin', password: 'wrong' })
      .catch(() => undefined);

    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('does not fire for a `401` on a request that carried no token', async () => {
    const onSessionExpired = vi.fn();

    await createApiClient({ fetchImpl: codeFetch('UNAUTHENTICATED', 401), onSessionExpired })
      .get(ADMIN)
      .catch(() => undefined);

    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('does not fire for a failure that is not about the credential', async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_token');
    const onSessionExpired = vi.fn();

    for (const [code, status] of [
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['INTERNAL_ERROR', 500],
      ['RATE_LIMITED', 429],
    ] as const) {
      await createApiClient({ fetchImpl: codeFetch(code, status), onSessionExpired })
        .get(ADMIN)
        .catch(() => undefined);
    }

    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('reports the API failure even when the sign-out handler throws', async () => {
    // A handler is other people's code — a store action, a router call — and a bug in it must not relabel the failure.
    // Measured before this was guarded (pass 33): the client rejected with `NETWORK`, so the screen would have said
    // "the server could not be reached" about a request that answered `401 TOKEN_EXPIRED`, and lost the request id.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_stale');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const error = await createApiClient({
      fetchImpl: codeFetch('TOKEN_EXPIRED', 401),
      onSessionExpired: () => {
        throw new Error('the handler broke');
      },
    })
      .get(ADMIN)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('TOKEN_EXPIRED');
    expect((error as ApiError).status).toBe(401);
    // ...and the handler's own failure is not swallowed silently.
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('fires for an unreadable `401`, and not for an unreadable `500`', async () => {
    // A proxy's own 401 still means the token did not work; its 500 says nothing about the credential.
    sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_token');
    const htmlFetch = (status: number) => rawFetch('<html>nope</html>', status);

    const expires = vi.fn();
    await createApiClient({ fetchImpl: htmlFetch(401), onSessionExpired: expires })
      .get(ADMIN)
      .catch(() => undefined);
    expect(expires).toHaveBeenCalledTimes(1);

    const neither = vi.fn();
    await createApiClient({ fetchImpl: htmlFetch(500), onSessionExpired: neither })
      .get(ADMIN)
      .catch(() => undefined);
    expect(neither).not.toHaveBeenCalled();
  });
});

describe('connection failures, timeouts and cancellations', () => {
  it('reports a refused connection as NETWORK, keeping the cause', async () => {
    const cause = new TypeError('Failed to fetch');
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject(cause));

    const error = (await createApiClient({ fetchImpl })
      .get(PUBLIC)
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.code).toBe('NETWORK');
    expect(error.cause).toBe(cause);
  });

  it('reports a request that outlived its budget as TIMEOUT and aborts it', async () => {
    // A server that accepts the connection and never answers. The client must give up on its own: without the budget
    // the request is a pending promise for as long as the tab is open, and the screen shows a spinner forever.
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const pending = createApiClient({ fetchImpl, timeoutMs: 50 }).get(PUBLIC);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(aborted).toBe(true);
  });

  it('reports a caller cancellation as ABORTED, not as an outage', async () => {
    // A screen that navigates away cancels its requests; telling the reader "the server could not be reached" for that
    // would be a lie in a toast, so the client distinguishes them and the sign-out/toast path ignores `ABORTED`.
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const pending = createApiClient({ fetchImpl }).get(PUBLIC, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    controller.abort();
    await assertion;
  });

  it('does not start a request whose signal is already aborted', async () => {
    const fetchImpl = jsonFetch({ ok: true });
    const controller = new AbortController();
    controller.abort();

    await expect(
      createApiClient({ fetchImpl }).get(PUBLIC, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('has a documented default budget, and lets one request override it', async () => {
    // 30 s: long enough for a cold database and a 400-row catalog, short enough that a dead server does not leave the
    // admin staring at a spinner while they plan their evening.
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);

    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    // The default budget would need 30 s; this request gives up after 10 ms.
    const pending = createApiClient({ fetchImpl })
      .get(PUBLIC, { timeoutMs: 10 })
      .catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(20);

    expect(((await pending) as ApiError).code).toBe('TIMEOUT');
  });
});
