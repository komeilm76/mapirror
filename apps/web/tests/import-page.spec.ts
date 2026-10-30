import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App as VueApp } from 'vue';

import type { CatalogListItem, JobView } from '@mapirror/shared';

import { SESSION_TOKEN_KEY } from '../src/auth/token-storage';
import { createWebApp } from '../src/bootstrap';
import { adminPagePaths } from '../src/router/paths';

const COUNTRY_ID = '00000000-0000-4000-8000-000000000101';
const JOB_ID = '00000000-0000-4000-8000-000000000102';
const UPLOAD_ID = '00000000-0000-4000-8000-000000000103';
const CREATED_AT = '2026-10-30T10:00:00.000Z';
const ME = {
  admin: { id: '00000000-0000-4000-8000-000000000104', username: 'admin' },
  expiresAt: '2026-10-31T10:00:00.000Z',
  lastUsedAt: null,
};
const COUNTRY: CatalogListItem = {
  countryId: COUNTRY_ID,
  sourceId: 'europe/finland',
  name: 'Finland',
  slug: 'finland',
  continent: 'europe',
  iso: ['FI'],
  sourceSizeHintBytes: 1_024,
  cache: {
    cached: true,
    versionsReady: 1,
    totalSizeBytes: 1_024,
    isPublic: false,
    updateState: 'unknown',
    availableVersion: null,
    availableSizeBytes: null,
  },
  lastSyncedAt: CREATED_AT,
};
const JOB: JobView = {
  id: JOB_ID,
  type: 'import',
  status: 'queued',
  phase: null,
  progressBytes: 0,
  totalBytes: null,
  speedBps: null,
  etaSeconds: null,
  payload: { countryId: COUNTRY_ID, version: '261030', uploadId: UPLOAD_ID, replace: false },
  cancelRequested: false,
  attempts: 0,
  maxAttempts: 3,
  createdAt: CREATED_AT,
  startedAt: null,
  finishedAt: null,
  error: null,
};

const mounted: VueApp<Element>[] = [];
let originalFileStream: PropertyDescriptor | undefined;
let installedFileStream = false;

function fileContentStream(file: File): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void file.arrayBuffer().then(
        (buffer) => {
          controller.enqueue(new Uint8Array(buffer));
          controller.close();
        },
        (cause: unknown) => controller.error(cause),
      );
    },
  });
}

function installFileStreamPolyfill(): void {
  if (typeof File.prototype.stream === 'function') return;
  originalFileStream = Object.getOwnPropertyDescriptor(File.prototype, 'stream');
  Object.defineProperty(File.prototype, 'stream', {
    configurable: true,
    value(this: File) {
      return fileContentStream(this);
    },
  });
  installedFileStream = true;
}

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

async function mountImport(
  options: {
    readonly versions?: unknown;
    readonly uploadFailure?: boolean;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<{ app: VueApp<Element>; container: HTMLElement; uploadBodies: string[] }> {
  installFileStreamPolyfill();
  sessionStorage.setItem(SESSION_TOKEN_KEY, 'mm_import_test');
  window.history.replaceState({}, '', adminPagePaths.import());
  const uploadBodies: string[] = [];
  const fetchImpl =
    options.fetchImpl ??
    vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === '/_auth/api/me') return jsonResponse(ME);
      if (url.pathname === '/_admin/api/catalog') {
        return jsonResponse({
          data: [COUNTRY],
          meta: { page: 1, limit: 100, total: 1, totalPages: 1 },
          catalogSyncedAt: CREATED_AT,
        });
      }
      if (url.pathname === `/_admin/api/cache/${COUNTRY_ID}/versions`) {
        return jsonResponse(
          options.versions ?? { data: [], meta: { page: 1, limit: 100, total: 0, totalPages: 0 } },
        );
      }
      if (url.pathname === '/_admin/api/imports' && init?.method === 'POST') {
        if (options.uploadFailure === true) throw new TypeError('offline');
        if (!(init.body instanceof ReadableStream)) throw new Error('upload body was not streamed');
        uploadBodies.push(await new Response(init.body).text());
        return jsonResponse({ uploadId: UPLOAD_ID, jobId: JOB_ID, version: '261030' }, 202);
      }
      if (url.pathname === '/_admin/api/jobs') {
        return jsonResponse({ data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 0 } });
      }
      if (url.pathname === `/_admin/api/jobs/${JOB_ID}`) return jsonResponse(JOB);
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
    });
  vi.stubGlobal('fetch', fetchImpl);
  const app = createWebApp();
  mounted.push(app);
  const container = document.createElement('div');
  document.body.append(container);
  app.mount(container);
  await (
    app.config.globalProperties as unknown as { $router: { isReady(): Promise<void> } }
  ).$router.isReady();
  await flushPromises();
  await flushPromises();
  return { app, container, uploadBodies };
}

async function chooseCountry(container: HTMLElement): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Country"]');
  expect(input).not.toBeNull();
  input?.focus();
  input?.click();
  input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await flushPromises();
  const option = await vi.waitFor(() => {
    const found = document.body.querySelector<HTMLElement>('[role="option"]');
    expect(found).not.toBeNull();
    return found;
  });
  option?.click();
  await flushPromises();
}

function chooseFile(container: HTMLElement): File {
  const file = new File([new Uint8Array([1, 2, 3])], 'finland.osm.pbf', {
    type: 'application/octet-stream',
  });
  const input = container.querySelector<HTMLInputElement>('#mm-import-file');
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: { item: () => file, length: 1 },
  });
  input?.dispatchEvent(new Event('change', { bubbles: true }));
  return file;
}

afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = '';
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (installedFileStream) {
    if (originalFileStream === undefined)
      delete (File.prototype as { stream?: File['stream'] }).stream;
    else Object.defineProperty(File.prototype, 'stream', originalFileStream);
    originalFileStream = undefined;
    installedFileStream = false;
  }
});

describe('admin import form', () => {
  it('renders the three required fields and validates them before any upload', async () => {
    const { container, uploadBodies } = await mountImport();

    expect(container.querySelector('h1')?.textContent).toBe('Import a map');
    expect(container.textContent).toContain('Map file (required)');
    expect(container.textContent).toContain('Country (required)');
    expect(container.textContent).toContain('Version (required)');
    expect(
      container.querySelectorAll('#mm-import-file, #mm-import-country, #mm-import-version'),
    ).toHaveLength(3);
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await flushPromises();
    expect(container.textContent).toContain('Choose an .osm.pbf file.');
    expect(container.textContent).toContain('Choose a country.');
    expect(container.textContent).toContain('Use 1–32 letters');
    expect(uploadBodies).toEqual([]);
  });

  it('shows an actionable network error and request progress recovery path', async () => {
    const { container } = await mountImport({ uploadFailure: true });
    chooseFile(container);
    await chooseCountry(container);
    const versionInput = container.querySelector<HTMLInputElement>('#mm-import-version');
    if (versionInput === null) throw new Error('version input missing');
    versionInput.value = '261030';
    versionInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('The server could not be reached.'),
    );
    expect(container.textContent).toContain('Check your connection and try again.');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('preflights a ready duplicate, requires confirmation, uploads with progress and tracks the job', async () => {
    const readyVersion = {
      id: '00000000-0000-4000-8000-000000000105',
      version: '261030',
      origin: 'upload',
      dataTimestamp: null,
      sizeBytes: 3,
      checksumMd5: null,
      status: 'ready',
      createdAt: CREATED_AT,
    };
    const { container, uploadBodies } = await mountImport({
      versions: { data: [readyVersion], meta: { page: 1, limit: 100, total: 1, totalPages: 1 } },
    });
    chooseFile(container);
    await chooseCountry(container);
    const versionInput = container.querySelector<HTMLInputElement>('#mm-import-version');
    if (versionInput === null) throw new Error('version input missing');
    versionInput.value = '261030';
    versionInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Replace this version?'));
    expect(uploadBodies).toEqual([]);

    const replaceButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Replace version'),
    );
    replaceButton?.click();
    await flushPromises();
    await vi.waitFor(() => expect(uploadBodies).toHaveLength(1));
    await vi.waitFor(() => expect(container.textContent).toContain('Import queued'));
    expect(uploadBodies[0]).toContain(`name="countryId"\r\n\r\n${COUNTRY_ID}`);
    expect(uploadBodies[0]).toContain('name="version"\r\n\r\n261030');
    expect(uploadBodies[0]).toContain('name="replace"\r\n\r\ntrue');
    expect(uploadBodies[0]).toContain('name="file"; filename="finland.osm.pbf"');
    expect(uploadBodies[0]).toContain('\u0001\u0002\u0003');
    expect(container.textContent).toContain('100%');
    expect(document.body.textContent).toContain('Job progress');
    expect(document.body.querySelector('#mm-job-progress-drawer')).not.toBeNull();
  });
});
