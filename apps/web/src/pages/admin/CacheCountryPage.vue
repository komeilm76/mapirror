<script setup lang="ts">
/** Admin cache-country detail and map-version actions (`P2-WEB-04`, `13-ui-ux.md` §4 S8). */

import {
  CacheCountryParamsSchema,
  CacheDetailResponseSchema,
  CacheVersionDeleteParamsSchema,
  CacheVersionDeleteQuerySchema,
  CacheVersionListResponseSchema,
  type CacheDetailResponse,
  type CacheVersionListItem,
  type CacheVersionListResponse,
} from '@mapirror/shared';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { adminPagePaths } from '@/router/paths';
import { useBreadcrumbs } from '@/stores/breadcrumbs';

const VERSION_PAGE_SIZE = 25;
const CACHE_API = '/_admin/api/cache';

/** Browser-native save picker contract, kept local because browser typings vary. */
interface SaveFilePickerHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

type SaveFilePicker = () => Promise<SaveFilePickerHandle>;

const route = useRoute();
const router = useRouter();
const api = useApi();
const pageLabels = useBreadcrumbs();

const detail = ref<CacheDetailResponse | null>(null);
const versions = ref<CacheVersionListResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
const retryNumber = ref(0);
const deleteDialogOpen = ref(false);
const deleteAcknowledged = ref(false);
const deleting = ref(false);
const deleteErrorMessage = ref<string | null>(null);
const deleteErrorRequestId = ref<string | null>(null);
const deleteTarget = ref<CacheVersionListItem | null>(null);
const deleteDialogElement = ref<HTMLElement | null>(null);
const deleteAcknowledgeElement = ref<HTMLInputElement | null>(null);
const deleteFocusReturn = ref<HTMLElement | null>(null);
const downloadingVersionId = ref<string | null>(null);
const downloadController = ref<AbortController | null>(null);
const downloadMessage = ref<string | null>(null);
const downloadErrorMessage = ref<string | null>(null);
const downloadErrorRequestId = ref<string | null>(null);
const downloadAnnouncementElement = ref<HTMLElement | null>(null);
const pageAnnouncement = ref<string | null>(null);
const pageHeadingElement = ref<HTMLHeadingElement | null>(null);
let deleteOperationId = 0;
let pageMounted = true;

onUnmounted(() => {
  pageMounted = false;
  deleteOperationId += 1;
  downloadController.value?.abort();
});

/** The country UUID carried by the protected S8 route. */
const countryId = computed(() => {
  const value = route.params.countryId;
  return typeof value === 'string' ? value : '';
});

/** Positive version page from the URL; duplicated or malformed values fall back to page one. */
const page = computed(() => pageFromQuery(route.query.page));

/** Exact version count for pagination bounds. */
const totalPages = computed(() => versions.value?.meta.totalPages ?? 0);

/** Confirmation copy changes when deleting the last ready version would close public access. */
const deletionClosesPublicAccess = computed(
  () =>
    detail.value?.cache.isPublic === true &&
    detail.value.cache.versionsReady <= 1 &&
    deleteTarget.value?.status === 'ready',
);

watch(
  [countryId, page, retryNumber],
  async ([id], [previousId], onCleanup) => {
    if (id !== previousId) {
      deleteOperationId += 1;
      downloadController.value?.abort();
      downloadController.value = null;
      downloadingVersionId.value = null;
      downloadMessage.value = null;
      downloadErrorMessage.value = null;
      downloadErrorRequestId.value = null;
      pageAnnouncement.value = null;
      deleteFocusReturn.value = null;
      deleteDialogOpen.value = false;
      deleteTarget.value = null;
      deleteAcknowledged.value = false;
      deleting.value = false;
      deleteErrorMessage.value = null;
      deleteErrorRequestId.value = null;
    }
    const controller = new AbortController();
    let current = true;
    onCleanup(() => {
      current = false;
      controller.abort();
    });

    loading.value = true;
    pageLabels.setCacheCountryLabel(null);
    detail.value = null;
    versions.value = null;
    errorMessage.value = null;
    errorRequestId.value = null;

    if (!CacheCountryParamsSchema.safeParse({ countryId: id }).success) {
      errorMessage.value =
        'This cached-country link is invalid. Return to the cache list and open a country again.';
      loading.value = false;
      return;
    }

    try {
      const [detailResponse, versionsResponse] = await Promise.all([
        api.get<unknown>(`${CACHE_API}/${encodeURIComponent(id)}`, { signal: controller.signal }),
        api.get<unknown>(`${CACHE_API}/${encodeURIComponent(id)}/versions`, {
          query: { page: page.value, limit: VERSION_PAGE_SIZE },
          signal: controller.signal,
        }),
      ]);
      const detailParsed = CacheDetailResponseSchema.safeParse(detailResponse);
      const versionsParsed = CacheVersionListResponseSchema.safeParse(versionsResponse);
      if (!detailParsed.success || !versionsParsed.success) {
        if (current)
          errorMessage.value = 'The cached-country response could not be read. Try again.';
        return;
      }

      const maxPage = versionsParsed.data.meta.totalPages;
      if (page.value > Math.max(maxPage, 1)) {
        await router.replace({
          query: { ...route.query, page: maxPage > 0 ? String(maxPage) : undefined },
        });
        return;
      }
      if (current) {
        detail.value = detailParsed.data;
        versions.value = versionsParsed.data;
        pageLabels.setCacheCountryLabel(detailParsed.data.country.name);
        if (downloadMessage.value === null) downloadErrorMessage.value = null;
        void nextTick(() => pageHeadingElement.value?.focus());
      }
    } catch (cause) {
      if (!current || (cause instanceof ApiError && cause.code === 'ABORTED')) return;
      if (cause instanceof ApiError) {
        errorMessage.value = cause.message;
        errorRequestId.value = cause.requestId;
      } else {
        errorMessage.value =
          'The cached country could not be loaded. Check your connection and try again.';
      }
    } finally {
      if (current) loading.value = false;
    }
  },
  { immediate: true },
);

/** Moves between pages without losing a bookmarked version-table page. */
function setPage(nextPage: number): void {
  if (!Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > totalPages.value) return;
  void router.replace({ query: { ...route.query, page: String(nextPage) } });
}

/** Repeats both country and version-list reads while preserving route state. */
function retry(): void {
  retryNumber.value += 1;
}

/** Begins a secure, direct-to-file stream after the browser's save picker is opened in the click gesture. */
async function downloadVersion(version: CacheVersionListItem): Promise<void> {
  if (version.status !== 'ready' || downloadingVersionId.value !== null || detail.value === null)
    return;
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker === undefined) {
    downloadErrorMessage.value =
      'This browser cannot save a large authenticated download directly to disk. Use a browser with file-save support and try again.';
    downloadErrorRequestId.value = null;
    return;
  }

  downloadErrorMessage.value = null;
  downloadErrorRequestId.value = null;
  const requestedCountryId = countryId.value;
  downloadingVersionId.value = version.id;
  downloadMessage.value = `Choose a destination for ${version.version}.`;
  try {
    const handle = (await Reflect.apply(picker, window, [
      { suggestedName: `${detail.value.country.slug}-${version.version}.osm.pbf` },
    ])) as SaveFilePickerHandle;
    const writable = await handle.createWritable();
    if (!pageMounted || countryId.value !== requestedCountryId) {
      await writable.abort();
      return;
    }
    const params = CacheCountryParamsSchema.parse({ countryId: requestedCountryId });
    const path = `${CACHE_API}/${encodeURIComponent(params.countryId)}/versions/${encodeURIComponent(version.id)}/download`;
    const controller = new AbortController();
    downloadController.value = controller;
    downloadMessage.value = `Downloading ${version.version}…`;
    await api.stream(path, writable, { signal: controller.signal });
    downloadMessage.value = `Downloaded ${version.version}.`;
  } catch (cause) {
    if (pageMounted && countryId.value === requestedCountryId) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        downloadMessage.value = 'Save cancelled.';
      } else if (cause instanceof ApiError && cause.code === 'ABORTED') {
        downloadMessage.value = 'Download cancelled.';
      } else if (cause instanceof ApiError) {
        downloadMessage.value = null;
        downloadErrorMessage.value = cause.message;
        downloadErrorRequestId.value = cause.requestId;
      } else {
        downloadMessage.value = null;
        downloadErrorMessage.value =
          'The file could not be saved. Check the destination has enough free space, then try again.';
        downloadErrorRequestId.value = null;
      }
    }
  } finally {
    if (pageMounted && countryId.value === requestedCountryId) {
      downloadingVersionId.value = null;
      downloadController.value = null;
      void nextTick(() => downloadAnnouncementElement.value?.focus());
    }
  }
}

/** Cancels the active file transfer without affecting the cached version. */
function cancelDownload(): void {
  downloadController.value?.abort();
}

/** Opens an accessible confirmation and remembers where focus should return. */
function openDeleteDialog(version: CacheVersionListItem, event: MouseEvent): void {
  deleteTarget.value = version;
  deleteAcknowledged.value = false;
  deleteErrorMessage.value = null;
  deleteErrorRequestId.value = null;
  deleteFocusReturn.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  deleteDialogOpen.value = true;
  void nextTick(() => deleteAcknowledgeElement.value?.focus());
}

/** Dismisses the confirmation without changing server or table state. */
function closeDeleteDialog(): void {
  if (deleting.value) return;
  deleteDialogOpen.value = false;
  deleteTarget.value = null;
  const target = deleteFocusReturn.value;
  deleteFocusReturn.value = null;
  void nextTick(() => target?.focus());
}

/** Keeps keyboard focus inside the confirmation while it is open. */
function handleDeleteDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDeleteDialog();
    return;
  }
  if (event.key !== 'Tab') return;
  const dialog = deleteDialogElement.value;
  if (dialog === null) return;
  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
  ];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    dialog.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Confirms a version delete, updates the visible summary optimistically, then reloads authoritative state. */
async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  const currentDetail = detail.value;
  const currentVersions = versions.value;
  if (
    target === null ||
    currentDetail === null ||
    currentVersions === null ||
    !deleteAcknowledged.value
  )
    return;

  const requestedCountryId = countryId.value;
  const parsedParams = CacheVersionDeleteParamsSchema.safeParse({
    countryId: requestedCountryId,
    versionId: target.id,
  });
  const parsedQuery = CacheVersionDeleteQuerySchema.safeParse({ confirm: 'true' });
  if (!parsedParams.success || !parsedQuery.success) {
    deleteErrorMessage.value =
      'This version could not be identified safely. Close this dialog and reload the country.';
    return;
  }

  const operationId = ++deleteOperationId;
  deleting.value = true;
  deleteErrorMessage.value = null;
  deleteErrorRequestId.value = null;
  const optimisticVersions: CacheVersionListResponse = {
    ...currentVersions,
    data: currentVersions.data.filter((version) => version.id !== target.id),
    meta: {
      ...currentVersions.meta,
      total: Math.max(0, currentVersions.meta.total - 1),
      totalPages: Math.ceil(
        Math.max(0, currentVersions.meta.total - 1) / currentVersions.meta.limit,
      ),
    },
  };
  versions.value = optimisticVersions;
  if (target.status === 'ready') {
    detail.value = {
      ...currentDetail,
      cache: {
        ...currentDetail.cache,
        versionsReady: Math.max(0, currentDetail.cache.versionsReady - 1),
        totalSizeBytes: (BigInt(currentDetail.cache.totalSizeBytes) > BigInt(target.sizeBytes)
          ? BigInt(currentDetail.cache.totalSizeBytes) - BigInt(target.sizeBytes)
          : 0n
        ).toString(),
        ...(currentDetail.cache.versionsReady <= 1 ? { isPublic: false, publicSince: null } : {}),
      },
    };
  }

  try {
    await api.delete<void>(
      `${CACHE_API}/${encodeURIComponent(parsedParams.data.countryId)}/versions/${encodeURIComponent(parsedParams.data.versionId)}`,
      { query: parsedQuery.data },
    );
    if (countryId.value !== requestedCountryId || operationId !== deleteOperationId) return;
    deleteDialogOpen.value = false;
    deleteTarget.value = null;
    pageAnnouncement.value = `Version ${target.version} deleted.`;
    const lastPageAfterDelete = optimisticVersions.meta.totalPages;
    if (optimisticVersions.meta.total === 0) {
      await router.replace({ name: 'admin-cache', query: {} });
    } else if (page.value > Math.max(lastPageAfterDelete, 1)) {
      await router.replace({
        query: {
          ...route.query,
          page: lastPageAfterDelete > 1 ? String(lastPageAfterDelete) : undefined,
        },
      });
    } else {
      retry();
    }
    void nextTick(() => pageHeadingElement.value?.focus());
  } catch (cause) {
    if (countryId.value !== requestedCountryId || operationId !== deleteOperationId) return;
    versions.value = currentVersions;
    detail.value = currentDetail;
    if (cause instanceof ApiError) {
      deleteErrorMessage.value = cause.message;
      deleteErrorRequestId.value = cause.requestId;
    } else {
      deleteErrorMessage.value =
        'The version could not be deleted. Check your connection and try again.';
    }
  } finally {
    if (operationId === deleteOperationId) deleting.value = false;
  }
}

/** UTC date formatter with an explicit fallback for unknown timestamps. */
function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/** Formats an optional UTC timestamp without appending a timezone to the unknown-value fallback. */
function formatUtcDate(value: string | null): string {
  return value === null ? 'Not recorded' : `${formatDate(value)} UTC`;
}

/** Formats exact API byte counts without rounding large decimal strings. */
function formatBytes(value: number | string): string {
  const bytes = BigInt(value);
  if (bytes < 1024n) return `${bytes.toString()} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;
  let divisor = 1024n;
  let unitIndex = 0;
  while (bytes >= divisor * 1024n && unitIndex < units.length - 1) {
    divisor *= 1024n;
    unitIndex += 1;
  }
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  return `${(tenths / 10n).toString()}.${(tenths % 10n).toString()} ${units[unitIndex]}`;
}

/** Human label for the persisted cache update-state union. */
function updateLabel(): string {
  if (detail.value === null) return 'Unknown';
  const { updateState, availableVersion } = detail.value.cache;
  if (updateState === 'update_available')
    return availableVersion ? `Update available · ${availableVersion}` : 'Update available';
  if (updateState === 'up_to_date') return 'Up to date';
  return 'Not checked';
}

/** Displays the source type with a label safe for people, not database enum spelling. */
function originLabel(origin: CacheVersionListItem['origin']): string {
  if (origin === 'geofabrik_snapshot') return 'Geofabrik snapshot';
  if (origin === 'geofabrik_latest') return 'Geofabrik latest';
  return 'Uploaded';
}

/** Decimal-only pagination query, defaulting invalid bookmark values to page one. */
function pageFromQuery(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

/** Whether deleting this row will remove the final ready file and automatically unpublish this cache. */
const deletionWarning = computed(() =>
  deletionClosesPublicAccess.value
    ? 'This is the last ready version. Deleting it will close public access to this country.'
    : 'This permanently removes the stored file and its version record.',
);
</script>

<template>
  <section
    class="mm-cache-country-page"
    aria-labelledby="cache-country-heading"
    :aria-busy="loading"
  >
    <header class="mm-cache-country-heading">
      <div>
        <p class="mm-caption mb-2">Admin · Cache</p>
        <h1 id="cache-country-heading" ref="pageHeadingElement" class="mm-display" tabindex="-1">
          {{ detail?.country.name ?? 'Cached country' }}
        </h1>
        <p v-if="detail" class="mm-cache-country-identity mm-text-secondary">
          <span>{{ detail.country.sourceId }}</span>
          <span v-if="detail.country.iso.length > 0">ISO {{ detail.country.iso.join(' · ') }}</span>
        </p>
      </div>
      <RouterLink class="mm-cache-button" :to="adminPagePaths.cache()">Back to cache</RouterLink>
    </header>

    <div v-if="errorMessage !== null" class="mm-cache-error" role="alert">
      <div>
        <h2 class="mm-cache-state-title">The cached country could not be loaded</h2>
        <p class="mm-cache-state-copy">{{ errorMessage }}</p>
        <p v-if="errorRequestId" class="mm-mono-small mm-cache-request-id">
          Request id: {{ errorRequestId }}
        </p>
      </div>
      <button class="mm-cache-button mm-cache-button-primary" type="button" @click="retry">
        Try again
      </button>
    </div>

    <div
      v-else-if="loading && detail === null"
      class="mm-cache-country-skeleton"
      role="status"
      aria-label="Loading cached country"
    >
      <div class="mm-cache-summary-skeleton"><span /><span /><span /><span /></div>
      <div v-for="index in 4" :key="index" class="mm-cache-version-skeleton">
        <span /><span /><span /><span />
      </div>
    </div>

    <template v-else-if="detail !== null && versions !== null">
      <section class="mm-cache-country-summary" aria-label="Cached country summary">
        <div class="mm-cache-summary-card">
          <span class="mm-cache-summary-label">Ready versions</span>
          <strong>{{ detail.cache.versionsReady.toLocaleString('en-GB') }}</strong>
        </div>
        <div class="mm-cache-summary-card">
          <span class="mm-cache-summary-label">Local cache size</span>
          <strong class="mm-mono">{{ formatBytes(detail.cache.totalSizeBytes) }}</strong>
        </div>
        <div class="mm-cache-summary-card">
          <span class="mm-cache-summary-label">Public state</span>
          <strong>{{ detail.cache.isPublic ? 'Public' : 'Private' }}</strong>
        </div>
        <div class="mm-cache-summary-card">
          <span class="mm-cache-summary-label">Update</span>
          <strong>{{ updateLabel() }}</strong>
          <span class="mm-cache-secondary"
            >Checked {{ formatUtcDate(detail.cache.updateCheckedAt) }}</span
          >
        </div>
      </section>

      <section
        v-if="detail.activeJobs.length > 0"
        class="mm-cache-country-jobs"
        aria-labelledby="cache-active-jobs-heading"
      >
        <h2 id="cache-active-jobs-heading" class="mm-cache-section-title">Active work</h2>
        <ul>
          <li v-for="job in detail.activeJobs" :key="job.id">
            <span>{{ job.type.replaceAll('_', ' ') }} · {{ job.status }}</span>
            <span class="mm-cache-secondary">
              {{ formatBytes(job.progressBytes)
              }}<template v-if="job.totalBytes !== null">
                of {{ formatBytes(job.totalBytes) }}</template
              >
            </span>
          </li>
        </ul>
      </section>

      <section class="mm-cache-versions" aria-labelledby="cache-versions-heading">
        <div class="mm-cache-versions-heading">
          <div>
            <h2 id="cache-versions-heading" class="mm-cache-section-title">Map versions</h2>
            <p class="mm-cache-secondary">
              Ready files can be downloaded. Pending and failed records are shown for context.
            </p>
          </div>
          <span class="mm-cache-version-total"
            >{{ versions.meta.total.toLocaleString('en-GB') }} total</span
          >
        </div>

        <div v-if="downloadErrorMessage !== null" class="mm-cache-inline-error" role="alert">
          <div>
            <p class="mm-cache-state-copy">{{ downloadErrorMessage }}</p>
            <p v-if="downloadErrorRequestId" class="mm-mono-small mm-cache-request-id">
              Request id: {{ downloadErrorRequestId }}
            </p>
          </div>
          <button
            v-if="downloadController !== null"
            class="mm-cache-button"
            type="button"
            @click="cancelDownload"
          >
            Cancel download
          </button>
        </div>
        <p
          v-if="downloadMessage"
          ref="downloadAnnouncementElement"
          class="mm-cache-download-status"
          role="status"
          aria-live="polite"
          tabindex="-1"
        >
          {{ downloadMessage }}
          <button
            v-if="downloadController !== null"
            class="mm-cache-button"
            type="button"
            @click="cancelDownload"
          >
            Cancel download
          </button>
        </p>
        <p
          v-if="pageAnnouncement"
          class="mm-cache-download-status"
          role="status"
          aria-live="polite"
        >
          {{ pageAnnouncement }}
        </p>

        <div v-if="versions.data.length === 0" class="mm-cache-empty">
          <div>
            <h3 class="mm-cache-state-title">No versions stored</h3>
            <p class="mm-cache-state-copy">
              This cached country has no version records to display.
            </p>
          </div>
        </div>

        <div v-else class="mm-cache-version-table-wrap">
          <table class="mm-cache-version-table">
            <caption class="mm-sr-only">
              Stored versions for
              {{
                detail.country.name
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Origin</th>
                <th scope="col">Source date</th>
                <th scope="col">Size</th>
                <th scope="col">MD5</th>
                <th scope="col">Created</th>
                <th scope="col"><span class="mm-sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="version in versions.data" :key="version.id">
                <th scope="row" class="mm-cache-version-label">
                  <span class="mm-mono">{{ version.version }}</span>
                </th>
                <td>
                  <span :class="['mm-cache-pill', `mm-cache-version-${version.status}`]">{{
                    version.status
                  }}</span>
                </td>
                <td>{{ originLabel(version.origin) }}</td>
                <td>{{ formatUtcDate(version.dataTimestamp) }}</td>
                <td class="mm-mono mm-cache-version-size">{{ formatBytes(version.sizeBytes) }}</td>
                <td class="mm-mono mm-cache-checksum">
                  {{ version.checksumMd5 ?? 'Not recorded' }}
                </td>
                <td>{{ formatUtcDate(version.createdAt) }}</td>
                <td class="mm-cache-version-actions">
                  <button
                    class="mm-cache-button"
                    type="button"
                    :disabled="version.status !== 'ready' || downloadingVersionId !== null"
                    :aria-label="`Download ${version.version}`"
                    @click="downloadVersion(version)"
                  >
                    {{ downloadingVersionId === version.id ? 'Downloading…' : 'Download' }}
                  </button>
                  <button
                    class="mm-cache-button mm-cache-button-danger"
                    type="button"
                    :disabled="deleting || downloadingVersionId !== null"
                    :aria-label="`Delete ${version.version}`"
                    @click="openDeleteDialog(version, $event)"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          v-if="versions.data.length > 0"
          class="mm-cache-version-cards"
          aria-label="Stored map versions"
        >
          <article v-for="version in versions.data" :key="version.id" class="mm-cache-version-card">
            <header>
              <h3 class="mm-cache-name mm-mono">{{ version.version }}</h3>
              <span :class="['mm-cache-pill', `mm-cache-version-${version.status}`]">{{
                version.status
              }}</span>
            </header>
            <dl>
              <div>
                <dt>Origin</dt>
                <dd>{{ originLabel(version.origin) }}</dd>
              </div>
              <div>
                <dt>Source date</dt>
                <dd>{{ formatUtcDate(version.dataTimestamp) }}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd class="mm-mono">{{ formatBytes(version.sizeBytes) }}</dd>
              </div>
              <div>
                <dt>MD5</dt>
                <dd class="mm-mono mm-cache-checksum">
                  {{ version.checksumMd5 ?? 'Not recorded' }}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{{ formatUtcDate(version.createdAt) }}</dd>
              </div>
            </dl>
            <footer>
              <button
                class="mm-cache-button"
                type="button"
                :disabled="version.status !== 'ready' || downloadingVersionId !== null"
                :aria-label="`Download ${version.version}`"
                @click="downloadVersion(version)"
              >
                {{ downloadingVersionId === version.id ? 'Downloading…' : 'Download' }}
              </button>
              <button
                class="mm-cache-button mm-cache-button-danger"
                type="button"
                :disabled="deleting || downloadingVersionId !== null"
                :aria-label="`Delete ${version.version}`"
                @click="openDeleteDialog(version, $event)"
              >
                Delete
              </button>
            </footer>
          </article>
        </div>

        <nav
          v-if="versions.meta.totalPages > 1"
          class="mm-cache-pagination"
          aria-label="Version pages"
        >
          <button
            class="mm-cache-button"
            type="button"
            :disabled="page <= 1 || loading"
            @click="setPage(page - 1)"
          >
            Previous
          </button>
          <span class="mm-cache-page-count">Page {{ page }} of {{ versions.meta.totalPages }}</span>
          <button
            class="mm-cache-button"
            type="button"
            :disabled="page >= versions.meta.totalPages || loading"
            @click="setPage(page + 1)"
          >
            Next
          </button>
        </nav>
      </section>
    </template>

    <div
      v-if="deleteDialogOpen && deleteTarget"
      class="mm-cache-dialog-backdrop"
      @click.self="closeDeleteDialog"
    >
      <section
        ref="deleteDialogElement"
        class="mm-cache-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cache-delete-title"
        aria-describedby="cache-delete-copy"
        tabindex="-1"
        @keydown="handleDeleteDialogKeydown"
      >
        <h2 id="cache-delete-title" class="mm-cache-state-title">
          Delete version {{ deleteTarget.version }}?
        </h2>
        <p id="cache-delete-copy" class="mm-cache-state-copy">
          {{ deletionWarning }} This action cannot be undone.
        </p>
        <p v-if="deleteErrorMessage" class="mm-cache-delete-error" role="alert">
          {{ deleteErrorMessage }}
        </p>
        <p v-if="deleteErrorRequestId" class="mm-mono-small mm-cache-request-id">
          Request id: {{ deleteErrorRequestId }}
        </p>
        <label class="mm-cache-confirm-check">
          <input ref="deleteAcknowledgeElement" v-model="deleteAcknowledged" type="checkbox" />
          <span>I understand this version and its stored file will be permanently removed.</span>
        </label>
        <footer>
          <button
            class="mm-cache-button"
            type="button"
            :disabled="deleting"
            @click="closeDeleteDialog"
          >
            Cancel
          </button>
          <button
            class="mm-cache-button mm-cache-button-danger"
            type="button"
            :disabled="!deleteAcknowledged || deleting"
            @click="confirmDelete"
          >
            {{ deleting ? 'Deleting…' : 'Delete version' }}
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>
