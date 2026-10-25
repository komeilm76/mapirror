/**
 * The SPA's one way to call the API (`P1-WEB-04`).
 *
 * Every screen goes through this client, which is why the three things that must never be done per screen are done
 * here once:
 *
 * 1. **The Bearer header.** The token is read from `sessionStorage` (`auth/token-storage.ts`, D-13) and attached by a
 *    rule keyed on the **path**, not by a flag on each call: `/_admin/api/*` and the two auth endpoints that take a
 *    credential get one; `/_public/api/*` and `POST /_auth/api/login` never do. Handing a token to a request that does
 *    not need it is one more log line, cache entry and proxy hop that holds a live credential.
 * 2. **The error envelope.** Every non-2xx answer, every unreadable answer and every connection failure becomes an
 *    `ApiError` (`api/errors.ts`). Screens never see a `Response`, a status code or a `SyntaxError`.
 * 3. **Signing out on a dead credential.** One `onSessionExpired` callback, fired from one place, for the four codes
 *    that end a session and only when the request actually presented a token — so `POST /_auth/api/login` answering
 *    `401 INVALID_CREDENTIALS` is the login form's error, not a sign-out.
 *
 * ## What is deliberately absent
 *
 * No retries, no cache, no request de-duplication and no interceptor stack. A retry hides a flaky network from the one
 * screen that could tell the admin about it, and `P5-UX-02` decides where optimistic updates are visible; until then a
 * failure is shown, not papered over. `P1-WEB-05`'s store supplies the token through the same `token` option this
 * module already takes, so it does not have to change.
 *
 * @module api/client
 */

import { apiScopeOf, isApiPath } from '@mapirror/shared';

import { readSessionToken } from '@/auth/token-storage';
import { ApiError, errorFromFailure, errorFromResponse, type ApiErrorCode } from './errors';

/** The methods this client uses. `HEAD`/`OPTIONS` are not called by the SPA: downloads are links, not fetches. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** Default request budget. A download is a link and never comes through here, so this only has to cover JSON. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** A value that can appear in a query string. `null`/`undefined` are dropped rather than sent as `"null"`. */
export type QueryValue =
  string | number | boolean | null | undefined | readonly (string | number)[];

/** Options for one request. */
export interface ApiRequestOptions {
  /** JSON body. Serialised with `JSON.stringify` and sent as `application/json`. */
  readonly body?: unknown;
  /** Query parameters, appended to any the path already carries. */
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** Extra headers, applied last so a caller can override the defaults. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Cancels the request; the failure surfaces as `ABORTED`. */
  readonly signal?: AbortSignal;
  /** Overrides {@link DEFAULT_TIMEOUT_MS} for this request. */
  readonly timeoutMs?: number;
}

/** Options for {@link createApiClient}. Everything is injectable so a test needs no network and no globals. */
export interface ApiClientOptions {
  /** The `fetch` to use; defaults to the global one. */
  readonly fetchImpl?: typeof fetch;
  /** Reads the session token; defaults to `sessionStorage` via `auth/token-storage.ts`. */
  readonly token?: () => string | null;
  /** Called once per dead credential, after the failure is known to end the session. */
  readonly onSessionExpired?: (error: ApiError) => void;
  /** Request budget for every call that does not override it. */
  readonly timeoutMs?: number;
  /** Origin prefix for the API, e.g. `http://localhost:8080`. Empty means same origin (production, §12). */
  readonly baseUrl?: string;
}

/** The client a screen receives from `useApi()`. */
export interface ApiClient {
  request: <T>(method: HttpMethod, path: string, options?: ApiRequestOptions) => Promise<T>;
  get: <T>(path: string, options?: ApiRequestOptions) => Promise<T>;
  post: <T>(path: string, body?: unknown, options?: ApiRequestOptions) => Promise<T>;
  patch: <T>(path: string, body?: unknown, options?: ApiRequestOptions) => Promise<T>;
  put: <T>(path: string, body?: unknown, options?: ApiRequestOptions) => Promise<T>;
  delete: <T>(path: string, options?: ApiRequestOptions) => Promise<T>;
}

/** `POST /_auth/api/login` is the one endpoint that must never be handed a credential. */
const LOGIN_API_PATH = '/_auth/api/login';

/**
 * Whether a path's request carries the session token.
 *
 * Keyed on the path for the same reason the router's guard is (`router/guards.ts`): a per-call flag is a flag somebody
 * forgets, and the failure — a `401` on a page that should have worked — looks like a server bug.
 *
 * @param path - An API path.
 * @returns `true` when `Authorization: Bearer …` belongs on the request.
 */
export function needsBearer(path: string): boolean {
  const scope = apiScopeOf(path);
  if (scope === 'admin') return true;
  if (scope === 'auth') return path !== LOGIN_API_PATH;
  // The public API is anonymous by contract (`04-api.md` §0), and an unknown scope means the caller is not at an API
  // path at all — `request()` refuses those before this is reached.
  return false;
}

/**
 * Builds the URL for a request.
 *
 * @param baseUrl - Origin prefix, possibly empty.
 * @param path - API path, possibly already carrying a query string.
 * @param query - Extra parameters.
 * @returns The URL to fetch.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
      continue;
    }
    params.append(key, String(value));
  }

  const search = params.toString();
  if (search === '') return `${baseUrl}${path}`;
  // A path that already has a query string keeps it: pagination and filters are usually added to a link that came with
  // one, and a second `?` would silently produce a parameter named `?page`.
  const separator = path.includes('?') ? '&' : '?';
  return `${baseUrl}${path}${separator}${search}`;
}

/**
 * Reads a 2xx body as JSON.
 *
 * @param response - The response, body unread.
 * @returns The parsed body, or `undefined` for `204`/empty.
 * @throws {ApiError} `MALFORMED` when the body is present but not JSON.
 */
async function readSuccess<T>(response: Response): Promise<T> {
  // `204 No Content` is `POST /_auth/api/logout`'s answer (`04-api.md` §1). Reading its body would fail, and a client
  // that treats "succeeded with nothing to say" as an error turns a working sign-out into a toast.
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({
      code: 'MALFORMED',
      status: response.status,
      requestId: response.headers.get('x-request-id'),
    });
  }
}

/**
 * Builds the API client.
 *
 * @param options - Injection points; production passes none of them.
 * @returns A client whose methods reject with {@link ApiError} and never with anything else.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl: typeof fetch =
    options.fetchImpl ??
    ((input, init) => {
      return globalThis.fetch(input, init);
    });
  const readToken = options.token ?? ((): string | null => readSessionToken());
  const baseUrl = options.baseUrl ?? '';
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    method: HttpMethod,
    path: string,
    requestOptions: ApiRequestOptions = {},
  ): Promise<T> {
    // A page path here would fetch HTML and fail in `JSON.parse` three lines later with a message about a token. The
    // law is cheap to check and the error is unambiguous (L1).
    if (!isApiPath(path)) {
      throw new Error(
        `${method} ${path} is not an API path: useApi() talks to /_auth/api, /_admin/api and /_public/api.`,
      );
    }

    const presented = needsBearer(path) ? readToken() : null;
    const headers = new Headers({ accept: 'application/json' });
    if (presented !== null) headers.set('authorization', `Bearer ${presented}`);

    let body: string | undefined;
    if (requestOptions.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(requestOptions.body);
    }
    for (const [name, value] of Object.entries(requestOptions.headers ?? {}))
      headers.set(name, value);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestOptions.timeoutMs ?? defaultTimeoutMs);
    // The caller's signal is forwarded rather than passed through: one `AbortController` decides the outcome, so the
    // `catch` below can tell a cancellation from a timeout from a refusal by looking in one place.
    const forwardAbort = (): void => controller.abort();
    if (requestOptions.signal?.aborted === true) {
      clearTimeout(timer);
      throw errorFromFailure(undefined, 'ABORTED');
    }
    requestOptions.signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const response = await fetchImpl(buildUrl(baseUrl, path, requestOptions.query), {
        method,
        headers,
        body,
        signal: controller.signal,
        // No cookie is ever sent: the credential is a header and nothing else (D-13). Stated rather than left to the
        // default, because a later `credentials: 'include'` would quietly start carrying the server's cookies.
        credentials: 'same-origin',
      });

      if (!response.ok) {
        const error = await errorFromResponse(response);
        // Only a request that presented a credential can have that credential fail. Without this condition the login
        // form's `401 INVALID_CREDENTIALS` would sign out a visitor who is already signed out, and clear a token that
        // belongs to another tab's session.
        if (presented !== null && error.sessionEnded) options.onSessionExpired?.(error);
        throw error;
      }

      return await readSuccess<T>(response);
    } catch (cause) {
      // An error this module already shaped carries its own code — the envelope's, or `MALFORMED` — and wrapping it
      // would replace a `403 ACCOUNT_DISABLED` with "the connection failed".
      if (cause instanceof ApiError) throw cause;
      throw errorFromFailure(
        cause,
        timedOut ? 'TIMEOUT' : controller.signal.aborted ? 'ABORTED' : 'NETWORK',
      );
    } finally {
      // The budget covers the body as well as the headers: a server that sends `200` and then stalls mid-body is the
      // same outage to the reader as one that never answered, and a timer cleared at the headers would wait forever.
      clearTimeout(timer);
      requestOptions.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  return {
    request,
    get: <T>(path: string, requestOptions?: ApiRequestOptions): Promise<T> =>
      request<T>('GET', path, requestOptions),
    post: <T>(
      path: string,
      requestBody?: unknown,
      requestOptions?: ApiRequestOptions,
    ): Promise<T> => request<T>('POST', path, { ...requestOptions, body: requestBody }),
    patch: <T>(
      path: string,
      requestBody?: unknown,
      requestOptions?: ApiRequestOptions,
    ): Promise<T> => request<T>('PATCH', path, { ...requestOptions, body: requestBody }),
    put: <T>(path: string, requestBody?: unknown, requestOptions?: ApiRequestOptions): Promise<T> =>
      request<T>('PUT', path, { ...requestOptions, body: requestBody }),
    delete: <T>(path: string, requestOptions?: ApiRequestOptions): Promise<T> =>
      request<T>('DELETE', path, requestOptions),
  };
}

/** Re-exported so a screen can narrow a `catch` without a second import. */
export { ApiError };
export type { ApiErrorCode };
