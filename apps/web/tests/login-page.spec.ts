import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, type App as VueApp } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';

import { provideApiClient } from '../src/api';
import { createApiClient } from '../src/api/client';
import { createWebApp } from '../src/bootstrap';
import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import LoginPage from '../src/pages/auth/LoginPage.vue';
import { createAppVuetify } from '../src/plugins/vuetify';
import { ADMIN_ROOT, LOGIN_PAGE } from '../src/router/paths';
import { APP_ROUTES } from '../src/router/routes';
import { useAuth } from '../src/stores/auth';
import { useNotifications } from '../src/stores/notifications';

/**
 * The sign-in screen (`P1-WEB-06`, `13-ui-ux.md` §4 S1).
 *
 * The criterion is "keyboard + Enter works, error is human", and both halves need care in a test:
 *
 * - **Enter** is the browser's own behaviour for a `type="submit"` button inside a `<form>`, and jsdom does not simulate
 *   key-to-submit. So the form's `submit` event is dispatched — `form.requestSubmit()`, which is precisely what the
 *   browser does for Enter and for a click — and a second case asserts the *structure* that makes it work (a real form,
 *   a real submit button) rather than leaving it to a key handler nobody can fail.
 * - **Human** is about sentences, not codes: no `INVALID_CREDENTIALS`, no `429`, no `TOKEN_…` in the text a person reads.
 *
 * The client is the real one (`createApiClient`) with a stubbed `fetch`, so the failures under test are the shapes the
 * page will actually catch — an `ApiError` with the envelope's details — rather than a hand-made object that agrees with
 * the page by construction.
 */

/** A profile and a token that satisfy the shared schemas. */
const ANSWER = {
  token: 'mm_fresh',
  expiresAt: '2026-10-26T09:00:00.000Z',
  admin: { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' },
};

const mounted: VueApp<Element>[] = [];

/** The page, mounted the way the app mounts it: Pinia, Vuetify, a real router, and the app's client. */
interface Harness {
  readonly container: HTMLElement;
  readonly router: Router;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly auth: ReturnType<typeof useAuth>;
  readonly notifications: ReturnType<typeof useNotifications>;
  readonly pinia: Pinia;
}

async function mountLogin(
  options: { at?: string; respond?: typeof fetch; pinia?: Pinia } = {},
): Promise<Harness> {
  const pinia = options.pinia ?? createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [...APP_ROUTES] });
  await router.push(options.at ?? LOGIN_PAGE);

  const fetchImpl = vi.fn<typeof fetch>(
    options.respond ?? (() => Promise.resolve(new Response(JSON.stringify(ANSWER)))),
  );

  const app = createApp({ render: () => h(LoginPage) });
  app.use(pinia);
  app.use(createAppVuetify());
  app.use(router);
  provideApiClient(app, createApiClient({ fetchImpl, token: () => useAuth(pinia).token }));

  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  await flushPromises();
  mounted.push(app);

  return {
    container,
    router,
    fetchImpl,
    auth: useAuth(pinia),
    notifications: useNotifications(pinia),
    pinia,
  };
}

/** A `fetch` answering with the documented error envelope (`04-api.md` §0.2). */
function failing(code: string, status: number, details?: unknown): typeof fetch {
  const body = { error: { code, message: 'Refused.', requestId: 'req-7', details } };
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

/** The input for a field, by the `name` it submits under. */
function inputOf(container: HTMLElement, name: 'username' | 'password'): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input === null) throw new Error(`no input named ${name}`);
  return input;
}

/** Types into a field the way a person does: set the value, then let the framework hear about it. */
async function type(
  container: HTMLElement,
  name: 'username' | 'password',
  value: string,
): Promise<void> {
  const input = inputOf(container, name);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await flushPromises();
}

/** Submits the form the way the browser does for Enter and for a click on the submit button. */
async function submit(container: HTMLElement): Promise<void> {
  container.querySelector('form')?.requestSubmit();
  await flushPromises();
}

/** Fills both fields with a plausible pair. */
async function fill(container: HTMLElement): Promise<void> {
  await type(container, 'username', 'admin');
  await type(container, 'password', 'correct horse battery staple');
}

/** Every sentence the page shows. */
function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.useRealTimers();
  // The storage spy below is on `Storage.prototype`, so it outlives its case unless it is taken down here — and a leaked
  // one makes every later case fail for a reason that is not theirs.
  vi.restoreAllMocks();
});

describe('the form is a form', () => {
  it('returns the submitted credentials to the API, and follows the answer', async () => {
    const { container, fetchImpl, router, auth } = await mountLogin();

    await fill(container);
    await submit(container);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/_auth/api/login');
    expect(init?.method).toBe('POST');
    // The client always serialises a JSON body itself; a non-string here would mean it had changed shape.
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('the login request must carry a JSON string');
    expect(JSON.parse(body)).toEqual({
      username: 'admin',
      password: 'correct horse battery staple',
    });
    // ...and the request minting a credential carries none (`04-api.md` §1: no header on login).
    expect(new Headers(init?.headers).has('authorization')).toBe(false);

    expect(auth.isAuthenticated).toBe(true);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('mm_fresh');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`${ADMIN_ROOT}/`));
  });

  it('is a real form with a real submit button, which is what makes Enter work', async () => {
    // The criterion is "keyboard + Enter works". That is not a key handler to write: it is the browser's behaviour for a
    // `type="submit"` button inside a `<form>`, and the failure mode of the alternative (`@keydown.enter.prevent`) is a
    // form that submits on a key but not on a click, or on neither once the handler is removed. jsdom cannot press keys,
    // so this case asserts the structure that makes the browser do it, and the case below drives the event a key press
    // produces.
    const { container } = await mountLogin();
    const form = container.querySelector('form');
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');

    expect(form, 'the fields must be in a form element').not.toBeNull();
    expect(button, 'a submit button is what implicit submission needs').not.toBeNull();
    expect(form?.contains(button)).toBe(true);
    expect(inputOf(container, 'username').form).toBe(form);
    expect(inputOf(container, 'password').form).toBe(form);
  });

  it('submits from the button click, the way a mouse user does', async () => {
    const { container, fetchImpl } = await mountLogin();

    await fill(container);
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await flushPromises();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('validation', () => {
  it('says nothing while a field is being typed, and marks it once it is left', async () => {
    const { container } = await mountLogin();

    // A touched, still-empty field. §6: validate on blur, so nothing is said yet — an error under the cursor while someone
    // is deciding what to type is noise, and the "empty" rule is the one it fires before they have typed anything.
    await type(container, 'username', '');
    expect(text(container)).not.toContain('Enter your username.');

    inputOf(container, 'username').dispatchEvent(new Event('blur'));
    await flushPromises();

    expect(text(container)).toContain('Enter your username.');
    // Only the field that was left: blurring one is not a statement about the other.
    expect(text(container)).not.toContain('Enter your password.');
  });

  it('shows a summary and both fields when the form is submitted empty', async () => {
    const { container, fetchImpl } = await mountLogin();

    await submit(container);

    expect(text(container)).toContain('Two fields need attention.');
    expect(text(container)).toContain('Enter your username.');
    expect(text(container)).toContain('Enter your password.');
    // Nothing was sent: a request the API would answer `400` is a round trip this page can skip.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ties each message to its input with aria-describedby', async () => {
    // §7: "errors tied with `aria-describedby`; required fields marked in text, not color only". The id is Vuetify's; the
    // assertion is that it exists and that it names the element holding the sentence, which is what a screen reader
    // announces when the field is focused.
    const { container } = await mountLogin();

    await submit(container);

    const input = inputOf(container, 'username');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy, 'the username input must describe itself').not.toBeNull();
    const ids = (describedBy ?? '').split(' ');
    const described = ids.map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described.join(' ')).toContain('Enter your username.');
  });

  it('takes the keyboard to the first field that needs attention', async () => {
    const { container } = await mountLogin();

    await submit(container);

    expect(document.activeElement).toBe(inputOf(container, 'username'));
  });

  it('maps a server validation issue to the field it names', async () => {
    // The server has the last word on its own schema (`04-api.md` §1), and its `details.issues[].path` is the field.
    const { container } = await mountLogin({
      respond: failing('VALIDATION_ERROR', 400, {
        issues: [{ path: 'username', message: 'Use at most 64 characters.' }],
      }),
    });

    await fill(container);
    await submit(container);

    expect(text(container)).toContain('Use at most 64 characters.');
    // ...and it is not an alert about the whole form: the API did not refuse the credentials, it refused a field.
    expect(text(container)).not.toContain('did not work');
  });
});

describe('a refusal', () => {
  it('says the pair does not match, without naming the code or losing what was typed', async () => {
    const { container, auth, router } = await mountLogin({
      respond: failing('INVALID_CREDENTIALS', 401),
    });

    await fill(container);
    await submit(container);

    // §7: announced, not just drawn. The region exists whether or not a screen reader is attached to read it.
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(text(container)).toContain('That username and password do not match.');
    expect(text(container)).toContain('An administrator can reset the password.');
    expect(text(container)).toContain('Request ID: req-7');
    expect(text(container)).not.toContain('INVALID_CREDENTIALS');
    expect(text(container)).not.toMatch(/40[13]|429/u);

    // §6: never lose typed data, and put the cursor where the mistake usually is.
    expect(inputOf(container, 'username').value).toBe('admin');
    expect(inputOf(container, 'password').value).toBe('correct horse battery staple');
    expect(document.activeElement).toBe(inputOf(container, 'password'));

    expect(auth.isAuthenticated).toBe(false);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
  });

  it('treats a deactivated account as its own answer', async () => {
    // `403 ACCOUNT_DISABLED` is not a wrong password, and telling a person to check their spelling would be a lie.
    const { container } = await mountLogin({ respond: failing('ACCOUNT_DISABLED', 403) });

    await fill(container);
    await submit(container);

    expect(text(container)).toContain('This account has been deactivated.');
    expect(text(container)).toContain('Ask an administrator to re-enable it.');
    expect(text(container)).not.toContain('do not match');
  });

  it('counts a rate limit down and re-enables the form when it lifts', async () => {
    // `429` carries `details.retryAfterSeconds` (`04-api.md` §1). A countdown is the only honest rendering: a disabled
    // button with no number is indistinguishable from a broken page.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T08:00:00.000Z'));
    const { container } = await mountLogin({
      respond: failing('RATE_LIMITED', 429, {
        lockedUntil: '2026-10-26T08:02:00.000Z',
        retryAfterSeconds: 120,
      }),
    });

    await fill(container);
    await submit(container);

    expect(text(container)).toContain('Too many attempts.');
    expect(text(container)).toContain('Try again in 2 minutes.');
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(button?.disabled).toBe(true);

    vi.advanceTimersByTime(60_000);
    await flushPromises();
    expect(text(container)).toContain('Try again in 1 minute.');

    vi.advanceTimersByTime(60_000);
    await flushPromises();
    expect(button?.disabled).toBe(false);
    expect(text(container)).not.toContain('Try again in');
  });

  it('passes on the client sentence when the server could not be reached', async () => {
    const { container } = await mountLogin({
      respond: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    await fill(container);
    await submit(container);

    expect(text(container)).toContain('The server could not be reached.');
    expect(text(container)).toContain('Check your connection and try again.');
    // No request id: nothing reached the server, so there is nothing to quote.
    expect(text(container)).not.toContain('Request ID');
  });

  it('does not accept a 200 whose body is not a session', async () => {
    const { container, auth } = await mountLogin({
      respond: () => Promise.resolve(new Response(JSON.stringify({ token: 42 }))),
    });

    await fill(container);
    await submit(container);

    expect(text(container)).toContain('The server sent an answer this page could not read.');
    expect(auth.isAuthenticated).toBe(false);
  });

  it('sends one request per attempt, even on a double click', async () => {
    // §6: "no dead clicks" — the mirror image is no duplicate clicks. The guard is the `submitting` flag, and it has to be
    // set before the `await`, not after.
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { container, fetchImpl } = await mountLogin({ respond: () => pending });

    await fill(container);
    container.querySelector('form')?.requestSubmit();
    await flushPromises();
    container.querySelector('form')?.requestSubmit();
    await flushPromises();

    expect(fetchImpl).toHaveBeenCalledTimes(1);

    release(new Response(JSON.stringify(ANSWER)));
    await flushPromises();
  });
});

describe('the password', () => {
  it('shows and hides behind a keyboard-focusable icon button with an accessible name', async () => {
    const { container } = await mountLogin();

    expect(inputOf(container, 'password').type).toBe('password');
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]');
    expect(toggle, 'a button must toggle the password').not.toBeNull();
    expect(toggle?.type).toBe('button');
    expect(toggle?.tabIndex).toBe(0);
    expect(toggle?.getAttribute('aria-label')).toBe('Show password');
    expect(toggle?.querySelector('.mdi.mdi-eye')).not.toBeNull();

    toggle?.click();
    await flushPromises();

    const shownToggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]');
    expect(inputOf(container, 'password').type).toBe('text');
    expect(shownToggle?.getAttribute('aria-label')).toBe('Hide password');
    expect(shownToggle?.querySelector('.mdi.mdi-eye-off')).not.toBeNull();
    expect(shownToggle?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the validation alert free of a redundant default icon', async () => {
    // MDI now renders the password control. The alert disables Vuetify's default close-circle because the error copy
    // already carries a textual message and the icon would add noise rather than information.
    const { container } = await mountLogin({ respond: failing('INVALID_CREDENTIALS', 401) });
    expect(container.querySelector('.mdi.mdi-eye')).not.toBeNull();

    await fill(container);
    await submit(container);

    expect(text(container)).toContain('do not match');
    expect(container.querySelector('.v-alert .mdi')).toBeNull();
  });
});

describe('the session that is already there', () => {
  it('says so, and offers the way on, instead of showing a blank form', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuth(pinia).signIn(ANSWER);

    const { container, router } = await mountLogin({ pinia });

    expect(text(container)).toContain('You are already signed in.');
    const cont = [...container.querySelectorAll('a')].find((anchor) =>
      (anchor.textContent ?? '').includes('Continue'),
    );
    expect(cont?.getAttribute('href')).toBe(`${ADMIN_ROOT}/`);

    // ...and it does not silently navigate: the reader may have come here to sign in as someone else.
    expect(router.currentRoute.value.path).toBe(LOGIN_PAGE);
  });

  it('warns when the browser will not keep the session, and signs in anyway', async () => {
    // `signIn` answers `false` when `sessionStorage` refuses the write (`stores/auth.ts`). The tab still works — so the
    // page continues, and the toast is the only place the consequence is visible.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { container, auth, notifications, router } = await mountLogin();

    await fill(container);
    await submit(container);

    expect(auth.isAuthenticated).toBe(true);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`${ADMIN_ROOT}/`));
    expect(notifications.items.map((item) => item.message).join(' ')).toContain(
      'not keeping the session',
    );
  });
});

describe('the app as the browser gets it', () => {
  it('signs a person in end to end: bootstrap, guard, store and page together', async () => {
    // The one case with no harness: `createWebApp()` is what `main.ts` mounts, `globalThis.fetch` is the only stub, and
    // the assertion is what a person would see — the address bar moved into the admin area and a session stored. If the
    // app ever provides its client *after* mounting, or the guard keeps reading storage instead of the store, this fails
    // where a page-only test would not notice.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(ANSWER)))),
    );
    window.history.replaceState({}, '', LOGIN_PAGE);

    const app = createWebApp();
    mounted.push(app);
    const container = document.createElement('div');
    document.body.append(container);
    app.mount(container);
    const router = (app.config.globalProperties as unknown as { $router: Router }).$router;
    await router.isReady();
    await flushPromises();

    await fill(container);
    await submit(container);

    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`${ADMIN_ROOT}/`));
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe('mm_fresh');
    vi.unstubAllGlobals();
  });
});

describe('where a visitor is sent afterwards', () => {
  it('returns to the page that refused them, filters and all', async () => {
    // The destination rides in the query string (`router/redirect.ts`) and is read back through the same validator that
    // wrote it. `fullPath`, not `path`: a filtered view is the view they asked for.
    const { container, router } = await mountLogin({
      at: `${LOGIN_PAGE}?redirect=${encodeURIComponent(`${ADMIN_ROOT}/jobs?status=failed`)}`,
    });

    await fill(container);
    await submit(container);

    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe(`${ADMIN_ROOT}/jobs?status=failed`),
    );
  });

  it('ignores a target that is not a page of this site', async () => {
    const { container, router } = await mountLogin({
      at: `${LOGIN_PAGE}?redirect=${encodeURIComponent('https://evil.example/sign-in')}`,
    });

    await fill(container);
    await submit(container);

    // Nothing about the hostile value survives into the address bar either, whichever way it was mangled.
    expect(router.currentRoute.value.fullPath).not.toContain('evil');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe(`${ADMIN_ROOT}/`));
  });
});
