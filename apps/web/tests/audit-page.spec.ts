import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';
import type { Router } from 'vue-router';

import { AUDIT_ACTIONS, type AuditEntry } from '@mapirror/shared';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { auditEntriesToCsv } from '../src/audit/presentation';
import { adminPagePaths } from '../src/router/paths';

const PROFILE = { id: '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607', username: 'admin' };
const ME = { admin: PROFILE, expiresAt: '2026-11-02T21:00:00.000Z', lastUsedAt: null };
const CREATED_AT = '2026-10-30T10:12:13.000Z';

const LOGIN_FAILED: AuditEntry = {
  id: '42',
  actorName: 'admin',
  action: AUDIT_ACTIONS.loginFailed,
  targetType: null,
  targetId: null,
  metadata: { reason: 'wrong_password' },
  createdAt: CREATED_AT,
};
const SETTINGS_UPDATE: AuditEntry = {
  id: '41',
  actorName: 'system',
  action: AUDIT_ACTIONS.settingsUpdate,
  targetType: 'settings',
  targetId: null,
  metadata: { keys: ['branding.displayName'] },
  createdAt: '2026-10-29T09:00:00.000Z',
};
const mounted: VueApp<Element>[] = [];

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return new URL(input.href, window.location.origin);
  if (typeof input === 'string') return new URL(input, window.location.origin);
  return new URL(input.url, window.location.origin);
}

function routerOf(app: VueApp<Element>): Router {
  return (app.config.globalProperties as unknown as { $router: Router }).$router;
}

function listResponse(
  entries: AuditEntry[],
  page = 1,
  total = entries.length,
): Record<string, unknown> {
  return {
    data: entries,
    meta: { page, limit: 25, total, totalPages: total === 0 ? 0 : Math.ceil(total / 25) },
  };
}

function responseFor(fetchCalls: ReturnType<typeof vi.fn<typeof fetch>>): typeof fetch {
  return vi.fn<typeof fetch>((input, init) =>
    Promise.resolve().then(() => {
      const url = requestUrl(input);
      void fetchCalls(input, init);
      if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
      if (url.pathname === '/_admin/api/audit') {
        const action = url.searchParams.get('action');
        const page = Number(url.searchParams.get('page') ?? '1');
        if (action === AUDIT_ACTIONS.settingsUpdate)
          return jsonResponse(listResponse([SETTINGS_UPDATE]));
        if (action === 'version.delete') return jsonResponse(listResponse([], 1, 0));
        if (page === 2) return jsonResponse(listResponse([LOGIN_FAILED], 2, 26));
        return jsonResponse(listResponse([LOGIN_FAILED, SETTINGS_UPDATE], 1, 26));
      }
      return jsonResponse({});
    }),
  );
}

async function mountAudit(
  fetchImpl: typeof fetch,
  location = adminPagePaths.audit(),
): Promise<{ app: VueApp<Element>; container: HTMLElement; router: Router }> {
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_audit_test');
  window.history.replaceState({}, '', location);
  vi.stubGlobal('fetch', fetchImpl);
  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  const router = routerOf(app);
  await router.isReady();
  await flushPromises();
  await flushPromises();
  return { app, container, router };
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin audit log screen', () => {
  it('loads the URL-backed action and page and renders safe entry details', async () => {
    const calls = vi.fn<typeof fetch>();
    const { container } = await mountAudit(
      responseFor(calls),
      `${adminPagePaths.audit()}?action=${AUDIT_ACTIONS.loginFailed}&page=2`,
    );

    expect(container.querySelector('h1')?.textContent).toBe('Audit log');
    expect(container.querySelector<HTMLSelectElement>('#mm-audit-action')?.value).toBe(
      AUDIT_ACTIONS.loginFailed,
    );
    expect(container.textContent).toContain('Sign-in failed');
    expect(container.textContent).toContain('wrong_password');
    expect(container.textContent).toContain('Page 2 of 2');
    expect(container.textContent).toContain('IP addresses and credentials are never shown.');
    expect(
      calls.mock.calls.some(([input]) => {
        const url = requestUrl(input);
        return (
          url.pathname === '/_admin/api/audit' &&
          url.searchParams.get('action') === AUDIT_ACTIONS.loginFailed &&
          url.searchParams.get('page') === '2' &&
          url.searchParams.get('limit') === '25'
        );
      }),
    ).toBe(true);
    expect(container.textContent).not.toContain('actorId');
    expect(container.textContent).not.toContain('192.0.2.');
  });

  it('keeps action filtering and page navigation in the URL', async () => {
    const calls = vi.fn<typeof fetch>();
    const { container, router } = await mountAudit(responseFor(calls));

    const actionSelect = container.querySelector<HTMLSelectElement>('#mm-audit-action');
    expect(actionSelect).not.toBeNull();
    actionSelect!.value = AUDIT_ACTIONS.settingsUpdate;
    expect(actionSelect!.value).toBe(AUDIT_ACTIONS.settingsUpdate);
    actionSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query.action).toBe(AUDIT_ACTIONS.settingsUpdate),
    );
    await flushPromises();

    expect(router.currentRoute.value.query.action).toBe(AUDIT_ACTIONS.settingsUpdate);
    expect(router.currentRoute.value.query.page).toBeUndefined();
    expect(container.textContent).toContain('Settings updated');
    expect(
      calls.mock.calls.some(
        ([input]) => requestUrl(input).searchParams.get('action') === AUDIT_ACTIONS.settingsUpdate,
      ),
    ).toBe(true);

    actionSelect!.value = '';
    actionSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(router.currentRoute.value.query.action).toBeUndefined());
    await vi.waitFor(() => expect(container.textContent).toContain('26 entries'));
    const next = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.trim().includes('Next'),
    );
    expect(next).toBeDefined();
    expect(next?.disabled).toBe(false);
    next!.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query.page).toBe('2'));
    await flushPromises();
    expect(container.textContent).toContain('Page 2 of 2');
  });

  it('shows a real empty state and lets an admin clear a no-match action filter', async () => {
    const { container, router } = await mountAudit(
      responseFor(vi.fn<typeof fetch>()),
      `${adminPagePaths.audit()}?action=version.delete`,
    );

    expect(container.textContent).toContain('No entries match this action');
    expect(container.textContent).toContain('Clear action filter');
    expect(container.querySelector<HTMLButtonElement>('.mm-audit-toolbar button')?.disabled).toBe(
      true,
    );
    [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Clear action filter'))
      ?.click();
    await vi.waitFor(() => expect(router.currentRoute.value.query.action).toBeUndefined());
    await flushPromises();
    expect(container.textContent).not.toContain('No entries match this action');
  });

  it('exports only the visible page as a downloaded CSV', async () => {
    const calls = vi.fn<typeof fetch>();
    const { container } = await mountAudit(responseFor(calls));
    const create = vi.spyOn(URL, 'createObjectURL');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('mapirror-audit-page-1.csv');
    });

    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes('Export this page'),
    );
    expect(button?.disabled).toBe(false);
    button?.click();
    await flushPromises();

    expect(create).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    if (!(blob instanceof Blob)) throw new Error('CSV download did not produce a Blob.');
    expect(await blob.text()).toContain('Sign-in failed');
    expect(click).toHaveBeenCalledOnce();
  });

  it('prevents spreadsheet formulas and escapes quotes in CSV cells', () => {
    const csv = auditEntriesToCsv([
      {
        ...LOGIN_FAILED,
        actorName: '=HYPERLINK("https://example.invalid")',
      },
    ]);

    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"');
    expect(csv).toContain('"Time (UTC)"');
    expect(csv).not.toContain('ip');
  });
});
