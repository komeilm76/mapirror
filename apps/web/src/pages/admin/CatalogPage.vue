<script setup lang="ts">
/**
 * The searchable admin catalog (`P2-WEB-01`, `13-ui-ux.md` §4 S6).
 *
 * The topbar owns global search (`AdminLayout.vue`); its query value lives in the URL and becomes this page's `q` filter.
 * Local filters, sorting and pagination use the same URL state, so refresh/back/bookmark all describe the visible rows.
 * Every request goes through the shared API client and the response is parsed against the same Zod contract the API
 * returns. Stale requests are aborted when route state changes; an old response can never replace a newer filter.
 *
 * The download action and version picker belong to `P2-WEB-02`; this page intentionally limits itself to discovery and
 * status, rather than presenting a button that cannot yet complete its promised action.
 *
 * @module pages/admin/CatalogPage
 */

import {
  CacheDownloadRequestSchema,
  CacheDownloadResponseSchema,
  CatalogListResponseSchema,
  CatalogQuerySchema,
  CatalogRegionSnapshotsResponseSchema,
  SORT_FIELDS,
  type CatalogListItem,
  type CatalogListResponse,
  type CatalogQuery,
  type CatalogRegionSnapshotsResponse,
} from '@mapirror/shared';
import { useDebounceFn } from '@vueuse/core';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { useJobProgress } from '@/stores/jobProgress';

const CATALOG_API = '/_admin/api/catalog';
const PAGE_SIZE = 50;
const CACHE_FILTERS = ['all', 'cached', 'uncached'] as const;
type CacheFilter = (typeof CACHE_FILTERS)[number];
type CatalogSort = (typeof SORT_FIELDS)[number];

const route = useRoute();
const router = useRouter();
const api = useApi();
const jobProgress = useJobProgress();

const result = ref<CatalogListResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
const retryNumber = ref(0);
const continentInput = ref(queryText(route.query.continent) ?? '');
const downloadDialogOpen = ref(false);
const downloadDialogElement = ref<HTMLElement | null>(null);
const downloadCloseButton = ref<HTMLButtonElement | null>(null);
const selectedRegion = ref<CatalogListItem | null>(null);
let returnFocusElement: HTMLElement | null = null;
const snapshots = ref<CatalogRegionSnapshotsResponse | null>(null);
const snapshotsLoading = ref(false);
const snapshotsErrorMessage = ref<string | null>(null);
const snapshotsErrorRequestId = ref<string | null>(null);
const selectedVersion = ref('');
const queueingDownload = ref(false);
const downloadErrorMessage = ref<string | null>(null);
const downloadErrorRequestId = ref<string | null>(null);
const queuedJobs = ref<Record<string, string>>({});
const queueAnnouncement = ref<string | null>(null);
const queueAnnouncementElement = ref<HTMLElement | null>(null);
let snapshotsController: AbortController | undefined;
let snapshotsRequestNumber = 0;

/**
 * The query to send, built only from the documented route keys and enum values.
 *
 * Route query values are untrusted: arrays from duplicate keys, malformed pages and future enum values are normalized
 * here rather than forwarded as invalid API requests. The server still validates every request independently.
 */
const catalogQuery = computed<CatalogQuery>(() => {
  const query: CatalogQuery = {
    page: pageFromQuery(route.query.page),
    limit: PAGE_SIZE,
    sort: sortFromQuery(route.query.sort),
    order: route.query.order === 'desc' ? 'desc' : 'asc',
    cache: cacheFromQuery(route.query.cache),
  };
  const search = boundedQueryText(route.query.q, 128);
  const continent = boundedQueryText(route.query.continent, 255);
  if (search !== undefined) query.q = search;
  if (continent !== undefined) query.continent = continent;
  const parsed = CatalogQuerySchema.safeParse(query);
  return parsed.success
    ? parsed.data
    : { page: 1, limit: PAGE_SIZE, sort: 'name', order: 'asc', cache: 'all' };
});

/** Human-readable last successful catalog synchronization time, always labelled UTC. */
const syncedLabel = computed(() => {
  const syncedAt = result.value?.catalogSyncedAt;
  return syncedAt === null || syncedAt === undefined
    ? 'Not synced yet'
    : `${formatDate(syncedAt)} UTC`;
});

/** Current page, used for the result range and button state. */
const page = computed(() => Number(catalogQuery.value.page));

/** Whether the current sort key is one of the catalog's sortable columns. */
function isSortedBy(field: CatalogSort): boolean {
  return catalogQuery.value.sort === field;
}

/** The accessible state for a sortable table heading. */
function ariaSort(field: CatalogSort): 'ascending' | 'descending' | 'none' {
  if (!isSortedBy(field)) return 'none';
  return catalogQuery.value.order === 'desc' ? 'descending' : 'ascending';
}

/**
 * Debounces the free-text parent filter and keeps it in the URL.
 *
 * @returns A route update after the 300 ms search delay.
 */
const updateContinentLater = useDebounceFn(
  () => updateQuery({ continent: continentInput.value }),
  300,
);

onUnmounted(() => {
  snapshotsRequestNumber += 1;
  snapshotsController?.abort();
});

watch(
  () => route.query.continent,
  (value) => {
    const next = queryText(value) ?? '';
    if (continentInput.value !== next) continentInput.value = next;
  },
);

watch(continentInput, () => {
  void updateContinentLater();
});

watch(
  [catalogQuery, retryNumber],
  async ([query], _previous, onCleanup) => {
    const controller = new AbortController();
    let current = true;
    onCleanup(() => {
      current = false;
      controller.abort();
    });

    loading.value = true;
    errorMessage.value = null;
    errorRequestId.value = null;
    result.value = null;

    try {
      const response = await api.get<unknown>(CATALOG_API, {
        query: queryForRequest(query),
        signal: controller.signal,
      });
      const parsed = CatalogListResponseSchema.safeParse(response);
      if (!parsed.success) {
        if (current) errorMessage.value = 'The catalog response could not be read. Try again.';
        return;
      }
      const requestedPage = typeof query.page === 'number' ? query.page : 1;
      if (parsed.data.meta.total > 0 && requestedPage > parsed.data.meta.totalPages) {
        await router.replace({
          query: { ...route.query, page: String(parsed.data.meta.totalPages) },
        });
        return;
      }
      if (current) result.value = parsed.data;
    } catch (cause) {
      if (!current || (cause instanceof ApiError && cause.code === 'ABORTED')) return;
      if (cause instanceof ApiError) {
        errorMessage.value = cause.message;
        errorRequestId.value = cause.requestId;
      } else {
        errorMessage.value = 'The catalog could not be loaded. Try again.';
      }
    } finally {
      if (current) loading.value = false;
    }
  },
  { immediate: true },
);

/**
 * Replaces the current catalog filters and resets pagination when a filter or sort changes.
 *
 * @param patch - One or more documented filter values; `null` removes a query key.
 */
async function updateQuery(
  patch: Partial<Record<'q' | 'continent' | 'cache' | 'sort' | 'order', string | null>>,
): Promise<void> {
  const query = { ...route.query };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') {
      if (query[key] !== undefined) {
        delete query[key];
        changed = true;
      }
    } else if (query[key] !== value) {
      query[key] = value;
      changed = true;
    }
  }
  if (
    ('q' in patch || 'continent' in patch || 'cache' in patch || 'sort' in patch) &&
    query.page !== undefined
  ) {
    delete query.page;
    changed = true;
  }
  if (changed) await router.replace({ query });
}

/** Applies a selected cache filter without forwarding untrusted select values. */
function setCacheFilter(value: string): void {
  if (!(CACHE_FILTERS as readonly string[]).includes(value)) return;
  void updateQuery({ cache: value === 'all' ? null : value });
}

/**
 * Changes one of the server-supported sorts, toggling direction for the active field.
 *
 * @param field - A fixed sort key advertised by the API.
 */
function setSort(field: CatalogSort): void {
  const order = isSortedBy(field) && catalogQuery.value.order === 'asc' ? 'desc' : 'asc';
  void updateQuery({ sort: field, order });
}

/** Moves to a neighboring page while retaining the current filters and sort. */
function setPage(nextPage: number): void {
  const maxPage = result.value?.meta.totalPages ?? 0;
  if (!Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > maxPage) return;
  void router.replace({ query: { ...route.query, page: String(nextPage) } });
}

/** Clears every catalog filter, including global search, back to its documented defaults. */
function clearFilters(): void {
  void router.replace({ query: {} });
  continentInput.value = '';
}

/** Repeats the last request without changing the bookmarked query. */
function retry(): void {
  retryNumber.value += 1;
}

/** Formats exact JSON-safe integer bytes without converting a large decimal string to a lossy Number. */
function formatBytes(value: number | string | null): string {
  if (value === null) return 'Not reported';
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

/** Formats an API UTC timestamp in a stable UTC representation. */
function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/** The start index shown in the current result range. */
const rangeStart = computed(() => {
  const total = result.value?.meta.total ?? 0;
  return total === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1;
});

/** The end index shown in the current result range. */
const rangeEnd = computed(() => Math.min(page.value * PAGE_SIZE, result.value?.meta.total ?? 0));

/** Handles null, duplicated and blank query values as absent. */
function queryText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Accepts only a documented-length string value, otherwise leaves the filter unset. */
function boundedQueryText(value: unknown, maxLength: number): string | undefined {
  const text = queryText(value);
  return text !== undefined && text.length <= maxLength ? text : undefined;
}

/** Parses a positive decimal page; malformed or unsafe values fall back to page one. */
function pageFromQuery(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

/** Returns a server-supported catalog sort, defaulting to name. */
function sortFromQuery(value: unknown): CatalogSort {
  return (SORT_FIELDS as readonly unknown[]).includes(value) ? (value as CatalogSort) : 'name';
}

/** Returns a documented cache filter, defaulting to all. */
function cacheFromQuery(value: unknown): CacheFilter {
  return (CACHE_FILTERS as readonly unknown[]).includes(value) ? (value as CacheFilter) : 'all';
}

/** Creates the client's supported query record from the validated shared contract. */
function queryForRequest(query: CatalogQuery): Record<string, string | number> {
  return {
    ...(typeof query.q === 'string' ? { q: query.q } : {}),
    ...(typeof query.continent === 'string' ? { continent: query.continent } : {}),
    cache: typeof query.cache === 'string' ? query.cache : 'all',
    page: typeof query.page === 'number' ? query.page : 1,
    limit: typeof query.limit === 'number' ? query.limit : PAGE_SIZE,
    sort: typeof query.sort === 'string' ? query.sort : 'name',
    order: typeof query.order === 'string' ? query.order : 'asc',
  };
}

/** The ISO display fallback for catalog rows without source codes. */
function isoLabel(item: CatalogListItem): string {
  return item.iso.length === 0 ? 'No ISO code' : item.iso.join(' · ');
}

/** The cache count is explicit about counting ready versions, not pending work. */
function cacheLabel(item: CatalogListItem): string {
  if (!item.cache.cached) return 'Not cached';
  const count = item.cache.versionsReady;
  return `Cached · ${String(count)} ready version${count === 1 ? '' : 's'}`;
}

/** Human-readable source update status. */
function updateLabel(item: CatalogListItem): string {
  if (item.cache.updateState === 'update_available')
    return item.cache.availableVersion === null
      ? 'Update available'
      : `Update available · ${item.cache.availableVersion}`;
  if (item.cache.updateState === 'up_to_date') return 'Up to date';
  return 'Unknown';
}

/** Source snapshots other than the newest moving offer. */
const datedSnapshots = computed(() =>
  (snapshots.value?.data ?? []).filter(
    (snapshot) => snapshot.version !== snapshots.value?.latest?.version,
  ),
);

/** Whether the selected offer is still available and not already ready in the local cache. */
const canQueueSelectedVersion = computed(() => {
  const current = snapshots.value;
  if (current === null || !current.sourceReachable || selectedVersion.value === '') return false;
  const matching = current.data.find((snapshot) => snapshot.version === selectedVersion.value);
  if (selectedVersion.value === 'latest') {
    return current.latest !== null && matching?.cached !== true;
  }
  return matching !== undefined && !matching.cached;
});

/** Metadata shown for the selected latest offer when the source also provides a timestamp. */
const selectedLatestMetadata = computed(() => {
  if (selectedVersion.value !== 'latest' || snapshots.value?.latest === null) return null;
  return (
    snapshots.value?.data.find(
      (snapshot) => snapshot.version === snapshots.value?.latest?.version,
    ) ?? null
  );
});

/** Whether an offered snapshot is already ready in the local cache. */
function snapshotIsCached(version: string): boolean {
  return (
    snapshots.value?.data.some((snapshot) => snapshot.version === version && snapshot.cached) ??
    false
  );
}

/** Whether the latest source offer can be selected for a download. */
const latestOfferDisabled = computed(() => {
  const current = snapshots.value;
  return (
    current === null ||
    !current.sourceReachable ||
    current.latest === null ||
    snapshotIsCached(current.latest.version)
  );
});

/** Opens the picker and requests current source offers for this local catalog slug. */
function openDownloadPicker(item: CatalogListItem): void {
  if (item.cache.cached || queuedJobs.value[item.countryId] !== undefined) return;
  snapshotsController?.abort();
  selectedRegion.value = item;
  snapshots.value = null;
  snapshotsErrorMessage.value = null;
  snapshotsErrorRequestId.value = null;
  downloadErrorMessage.value = null;
  downloadErrorRequestId.value = null;
  selectedVersion.value = '';
  queueAnnouncement.value = null;
  returnFocusElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  downloadDialogOpen.value = true;
  void nextTick(() => downloadCloseButton.value?.focus());
  void loadSnapshots();
}

/** Loads and validates the current upstream offers, aborting a stale picker request. */
async function loadSnapshots(): Promise<void> {
  const region = selectedRegion.value;
  if (region === null) return;
  snapshotsController?.abort();
  const controller = new AbortController();
  snapshotsController = controller;
  const requestNumber = ++snapshotsRequestNumber;
  snapshotsLoading.value = true;
  snapshots.value = null;
  selectedVersion.value = '';
  snapshotsErrorMessage.value = null;
  snapshotsErrorRequestId.value = null;
  try {
    const response = await api.get<unknown>(
      `/_admin/api/catalog/regions/${encodeURIComponent(region.slug)}/snapshots`,
      { signal: controller.signal },
    );
    const parsed = CatalogRegionSnapshotsResponseSchema.safeParse(response);
    if (!parsed.success) {
      if (requestNumber === snapshotsRequestNumber) {
        snapshotsErrorMessage.value = 'The source version list could not be read. Try again.';
      }
      return;
    }
    if (requestNumber !== snapshotsRequestNumber) return;
    snapshots.value = parsed.data;
    const latestVersion = parsed.data.latest?.version;
    if (
      latestVersion !== undefined &&
      !parsed.data.data.some((snapshot) => snapshot.version === latestVersion && snapshot.cached)
    ) {
      selectedVersion.value = 'latest';
    } else {
      selectedVersion.value = parsed.data.data.find((snapshot) => !snapshot.cached)?.version ?? '';
    }
  } catch (cause) {
    if (
      requestNumber !== snapshotsRequestNumber ||
      (cause instanceof ApiError && cause.code === 'ABORTED')
    )
      return;
    if (cause instanceof ApiError) {
      snapshotsErrorMessage.value = cause.message;
      snapshotsErrorRequestId.value = cause.requestId;
    } else {
      snapshotsErrorMessage.value = 'The source version list could not be loaded. Try again.';
    }
  } finally {
    if (requestNumber === snapshotsRequestNumber) snapshotsLoading.value = false;
  }
}

/** Closes the picker and cancels any still-pending source-list request. */
function closeDownloadPicker(): void {
  if (queueingDownload.value) return;
  snapshotsRequestNumber += 1;
  snapshotsController?.abort();
  snapshotsController = undefined;
  snapshotsLoading.value = false;
  downloadDialogOpen.value = false;
  selectedRegion.value = null;
  const focusTarget = returnFocusElement;
  returnFocusElement = null;
  void nextTick(() => focusTarget?.focus());
}

/** Keeps keyboard focus inside the modal while it is open. */
function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDownloadPicker();
    return;
  }
  if (event.key !== 'Tab') return;

  const dialog = downloadDialogElement.value;
  if (dialog === null) return;
  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

/** Queues the selected currently-offered source version and validates the accepted job response. */
async function queueDownload(): Promise<void> {
  const region = selectedRegion.value;
  if (region === null || !canQueueSelectedVersion.value || queueingDownload.value) return;
  const request = CacheDownloadRequestSchema.safeParse({
    countryId: region.countryId,
    version: selectedVersion.value,
  });
  if (!request.success) {
    downloadErrorMessage.value = 'Choose a currently available source version.';
    downloadErrorRequestId.value = null;
    return;
  }

  queueingDownload.value = true;
  void nextTick(() => downloadDialogElement.value?.focus());
  downloadErrorMessage.value = null;
  downloadErrorRequestId.value = null;
  try {
    const response = await api.post<unknown>('/_admin/api/cache/downloads', request.data);
    const parsed = CacheDownloadResponseSchema.safeParse(response);
    if (!parsed.success) {
      downloadErrorMessage.value =
        'The server accepted the request, but its response could not be read. Verify whether a job was queued before retrying.';
      return;
    }
    queuedJobs.value = { ...queuedJobs.value, [region.countryId]: parsed.data.jobId };
    jobProgress.track(parsed.data.jobId);
    const version = parsed.data.resolvedVersion ?? request.data.version;
    queueAnnouncement.value = `${region.name} download queued for ${version}. Job ID: ${parsed.data.jobId}.`;
    returnFocusElement = null;
    queueingDownload.value = false;
    closeDownloadPicker();
    void nextTick(() => queueAnnouncementElement.value?.focus());
  } catch (cause) {
    if (cause instanceof ApiError) {
      downloadErrorMessage.value = cause.message;
      downloadErrorRequestId.value = cause.requestId;
    } else {
      downloadErrorMessage.value = 'The download could not be queued. Try again.';
    }
  } finally {
    queueingDownload.value = false;
  }
}
</script>

<template>
  <section class="mm-catalog-page" aria-labelledby="catalog-heading" :aria-busy="loading">
    <header class="mm-catalog-heading">
      <div>
        <p class="mm-caption mb-2">Admin · Catalog</p>
        <h1 id="catalog-heading" class="mm-display">Catalog</h1>
        <p class="mm-catalog-intro mm-text-secondary">
          Search the source catalog, filter by parent region, and see what is already cached.
        </p>
      </div>
      <p class="mm-catalog-freshness mm-caption">
        Last successful sync
        <time v-if="result?.catalogSyncedAt" :datetime="result.catalogSyncedAt">{{
          syncedLabel
        }}</time>
        <span v-else>{{ syncedLabel }}</span>
      </p>
    </header>

    <p
      v-if="queueAnnouncement"
      ref="queueAnnouncementElement"
      class="mm-catalog-queued"
      role="status"
      aria-live="polite"
      tabindex="-1"
    >
      {{ queueAnnouncement }}
    </p>

    <section class="mm-catalog-filters" aria-label="Catalog filters">
      <div class="mm-catalog-filter-field">
        <label for="catalog-continent">Continent or source region ID</label>
        <input
          id="catalog-continent"
          v-model="continentInput"
          autocomplete="off"
          maxlength="255"
          name="continent"
          placeholder="e.g. europe"
          type="search"
        />
        <span class="mm-caption">Enter an exact source region ID.</span>
      </div>

      <div class="mm-catalog-filter-field">
        <label for="catalog-cache">Cache status</label>
        <select
          id="catalog-cache"
          :value="cacheFromQuery(route.query.cache)"
          @change="setCacheFilter(($event.target as HTMLSelectElement).value)"
        >
          <option value="all">All regions</option>
          <option value="uncached">Not cached</option>
          <option value="cached">Cached</option>
        </select>
      </div>

      <button
        class="mm-catalog-clear"
        :disabled="
          loading &&
          result === null &&
          queryText(route.query.q) === undefined &&
          queryText(route.query.continent) === undefined &&
          cacheFromQuery(route.query.cache) === 'all'
        "
        type="button"
        @click="clearFilters"
      >
        Clear filters
      </button>
    </section>

    <div class="mm-catalog-status" role="status" aria-live="polite">
      <span v-if="loading && result === null">Loading catalog…</span>
      <span v-else-if="loading">Updating catalog…</span>
      <span v-else-if="result !== null">
        Showing {{ rangeStart }}–{{ rangeEnd }} of
        {{ result.meta.total.toLocaleString('en-GB') }}
        {{ result.meta.total === 1 ? 'region' : 'regions' }}
      </span>
    </div>

    <div v-if="errorMessage !== null" class="mm-catalog-error" role="alert">
      <div>
        <h2 class="mm-catalog-state-title">The catalog could not be loaded</h2>
        <p class="mm-catalog-state-copy">{{ errorMessage }}</p>
        <p v-if="errorRequestId" class="mm-mono-small mm-catalog-request-id">
          Request ID: {{ errorRequestId }}
        </p>
      </div>
      <button class="mm-catalog-button mm-catalog-button-primary" type="button" @click="retry">
        Try again
      </button>
    </div>

    <div
      v-else-if="loading && result === null"
      class="mm-catalog-skeleton"
      role="status"
      aria-label="Loading catalog rows"
    >
      <div v-for="index in 6" :key="index" class="mm-catalog-skeleton-row" aria-hidden="true">
        <span /><span /><span /><span /><span />
      </div>
      <div
        v-for="index in 3"
        :key="`card-${index}`"
        class="mm-catalog-skeleton-card"
        aria-hidden="true"
      >
        <span /><span /><span />
      </div>
    </div>

    <div v-else-if="result !== null && result.data.length === 0" class="mm-catalog-empty">
      <h2 class="mm-catalog-state-title">No regions match</h2>
      <p class="mm-catalog-state-copy">
        Try a different name or region ID, or clear the filters to start again.
      </p>
      <button
        class="mm-catalog-button mm-catalog-button-primary"
        type="button"
        @click="clearFilters"
      >
        Clear filters
      </button>
    </div>

    <template v-else-if="result !== null">
      <div class="mm-catalog-table-wrap">
        <table class="mm-catalog-table">
          <caption class="mm-sr-only">
            Catalog regions and cache status
          </caption>
          <thead>
            <tr>
              <th scope="col" :aria-sort="ariaSort('name')">
                <button class="mm-catalog-sort" type="button" @click="setSort('name')">
                  Region
                  <span v-if="isSortedBy('name')" aria-hidden="true">{{
                    catalogQuery.order === 'asc' ? '↑' : '↓'
                  }}</span>
                </button>
              </th>
              <th scope="col">Continent · ISO</th>
              <th scope="col" :aria-sort="ariaSort('size')">
                <button class="mm-catalog-sort" type="button" @click="setSort('size')">
                  Source size
                  <span v-if="isSortedBy('size')" aria-hidden="true">{{
                    catalogQuery.order === 'asc' ? '↑' : '↓'
                  }}</span>
                </button>
              </th>
              <th scope="col">Cache</th>
              <th scope="col" :aria-sort="ariaSort('updated')">
                <button class="mm-catalog-sort" type="button" @click="setSort('updated')">
                  Update status
                  <span v-if="isSortedBy('updated')" aria-hidden="true">{{
                    catalogQuery.order === 'asc' ? '↑' : '↓'
                  }}</span>
                </button>
              </th>
              <th scope="col" class="mm-catalog-last-sync">Last synced</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in result.data" :key="item.countryId">
              <th class="mm-catalog-region" scope="row">
                <span class="mm-catalog-name">{{ item.name }}</span>
                <span class="mm-catalog-source mm-mono-small">{{ item.sourceId }}</span>
              </th>
              <td>
                <span>{{ item.continent ?? 'Top-level region' }}</span>
                <span class="mm-catalog-secondary">{{ isoLabel(item) }}</span>
              </td>
              <td class="mm-catalog-number mm-mono">{{ formatBytes(item.sourceSizeHintBytes) }}</td>
              <td>
                <span
                  :class="
                    item.cache.cached
                      ? 'mm-catalog-pill mm-catalog-pill-cached'
                      : 'mm-catalog-pill mm-catalog-pill-uncached'
                  "
                >
                  {{ cacheLabel(item) }}
                </span>
                <span v-if="item.cache.cached" class="mm-catalog-secondary">
                  {{ formatBytes(item.cache.totalSizeBytes) }}
                </span>
              </td>
              <td>
                <span
                  :class="
                    item.cache.updateState === 'update_available'
                      ? 'mm-catalog-pill mm-catalog-pill-update'
                      : 'mm-catalog-update-text'
                  "
                >
                  {{ updateLabel(item) }}
                </span>
              </td>
              <td class="mm-catalog-last-sync mm-catalog-secondary">
                {{ formatDate(item.lastSyncedAt) }} UTC
              </td>
              <td class="mm-catalog-actions">
                <button
                  v-if="!item.cache.cached"
                  class="mm-catalog-button mm-catalog-button-primary mm-catalog-download-button"
                  type="button"
                  :disabled="queuedJobs[item.countryId] !== undefined"
                  :aria-label="`Choose a source version to download ${item.name}`"
                  @click="openDownloadPicker(item)"
                >
                  {{ queuedJobs[item.countryId] ? 'Download queued' : 'Download' }}
                </button>
                <span v-else class="mm-catalog-secondary">Already cached</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="mm-catalog-cards" aria-label="Catalog regions">
        <article v-for="item in result.data" :key="item.countryId" class="mm-catalog-card">
          <header>
            <h2 class="mm-catalog-name">{{ item.name }}</h2>
            <span class="mm-catalog-source mm-mono-small">{{ item.sourceId }}</span>
          </header>
          <dl>
            <div>
              <dt>Continent · ISO</dt>
              <dd>{{ item.continent ?? 'Top-level region' }} · {{ isoLabel(item) }}</dd>
            </div>
            <div>
              <dt>Source size</dt>
              <dd class="mm-mono">{{ formatBytes(item.sourceSizeHintBytes) }}</dd>
            </div>
            <div>
              <dt>Cache</dt>
              <dd>
                <span
                  :class="
                    item.cache.cached
                      ? 'mm-catalog-pill mm-catalog-pill-cached'
                      : 'mm-catalog-pill mm-catalog-pill-uncached'
                  "
                >
                  {{ cacheLabel(item) }}
                </span>
                <span v-if="item.cache.cached" class="mm-catalog-secondary">
                  · {{ formatBytes(item.cache.totalSizeBytes) }}</span
                >
              </dd>
            </div>
            <div>
              <dt>Update status</dt>
              <dd
                :class="
                  item.cache.updateState === 'update_available' ? 'mm-catalog-update-text' : ''
                "
              >
                {{ updateLabel(item) }}
              </dd>
            </div>
            <div>
              <dt>Last synced</dt>
              <dd>{{ formatDate(item.lastSyncedAt) }} UTC</dd>
            </div>
          </dl>
          <button
            v-if="!item.cache.cached"
            class="mm-catalog-button mm-catalog-button-primary mm-catalog-download-button"
            type="button"
            :disabled="queuedJobs[item.countryId] !== undefined"
            :aria-label="`Choose a source version to download ${item.name}`"
            @click="openDownloadPicker(item)"
          >
            {{ queuedJobs[item.countryId] ? 'Download queued' : 'Download' }}
          </button>
          <p v-else class="mm-catalog-secondary">Already cached</p>
        </article>
      </div>

      <nav
        v-if="result.meta.totalPages > 1"
        class="mm-catalog-pagination"
        aria-label="Catalog pages"
      >
        <button
          class="mm-catalog-button"
          type="button"
          :disabled="page <= 1 || loading"
          @click="setPage(page - 1)"
        >
          Previous
        </button>
        <span class="mm-catalog-page-count">Page {{ page }} of {{ result.meta.totalPages }}</span>
        <button
          class="mm-catalog-button"
          type="button"
          :disabled="page >= result.meta.totalPages || loading"
          @click="setPage(page + 1)"
        >
          Next
        </button>
      </nav>
    </template>

    <div
      v-if="downloadDialogOpen"
      class="mm-catalog-dialog-backdrop"
      @click.self="closeDownloadPicker"
    >
      <section
        ref="downloadDialogElement"
        class="mm-catalog-dialog"
        role="dialog"
        tabindex="-1"
        :aria-busy="queueingDownload"
        aria-modal="true"
        aria-labelledby="catalog-download-title"
        aria-describedby="catalog-download-description"
        @keydown="handleDialogKeydown"
      >
        <header class="mm-catalog-dialog-heading">
          <div>
            <p class="mm-caption mb-2">Source version</p>
            <h2 id="catalog-download-title" class="mm-catalog-state-title">
              Choose a version for {{ selectedRegion?.name }}
            </h2>
          </div>
          <button
            ref="downloadCloseButton"
            class="mm-catalog-button"
            type="button"
            :disabled="queueingDownload"
            @click="closeDownloadPicker"
          >
            Close
          </button>
        </header>
        <p id="catalog-download-description" class="mm-catalog-state-copy">
          Choose the newest Geofabrik extract or a dated snapshot. Downloads are queued for
          background processing.
        </p>

        <div
          v-if="snapshotsLoading"
          class="mm-catalog-dialog-status"
          role="status"
          aria-live="polite"
        >
          Loading source versions…
        </div>
        <div v-else-if="snapshotsErrorMessage !== null" class="mm-catalog-error" role="alert">
          <div>
            <p class="mm-catalog-state-copy">{{ snapshotsErrorMessage }}</p>
            <p v-if="snapshotsErrorRequestId" class="mm-mono-small mm-catalog-request-id">
              Request ID: {{ snapshotsErrorRequestId }}
            </p>
          </div>
          <button class="mm-catalog-button" type="button" @click="loadSnapshots">Try again</button>
        </div>
        <template v-else-if="snapshots !== null">
          <p v-if="!snapshots.sourceReachable" class="mm-catalog-source-warning" role="status">
            Geofabrik is unreachable. Only already-cached source versions are listed; new downloads
            are unavailable.
          </p>
          <fieldset class="mm-catalog-version-list">
            <legend>Available source versions</legend>
            <label
              v-if="snapshots.latest !== null"
              class="mm-catalog-version-option"
              :class="{ 'mm-catalog-version-unavailable': latestOfferDisabled }"
            >
              <input
                v-model="selectedVersion"
                type="radio"
                name="catalog-download-version"
                value="latest"
                :disabled="latestOfferDisabled"
              />
              <span class="mm-catalog-version-copy">
                <strong>Latest · {{ snapshots.latest.version }}</strong>
                <span>
                  {{ formatBytes(snapshots.latest.sizeBytes)
                  }}<template v-if="selectedLatestMetadata?.dataTimestamp">
                    · data up to
                    {{ formatDate(selectedLatestMetadata.dataTimestamp) }} UTC</template
                  >
                </span>
              </span>
              <span v-if="latestOfferDisabled" class="mm-catalog-secondary">
                {{ snapshotIsCached(snapshots.latest.version) ? 'Already cached' : 'Unavailable' }}
              </span>
            </label>
            <label
              v-for="snapshot in datedSnapshots"
              :key="snapshot.version"
              class="mm-catalog-version-option"
              :class="{
                'mm-catalog-version-unavailable': snapshot.cached || !snapshots.sourceReachable,
              }"
            >
              <input
                v-model="selectedVersion"
                type="radio"
                name="catalog-download-version"
                :value="snapshot.version"
                :disabled="snapshot.cached || !snapshots.sourceReachable"
              />
              <span class="mm-catalog-version-copy">
                <strong>{{ snapshot.version }}</strong>
                <span>
                  {{ formatBytes(snapshot.sizeBytes) }} ·
                  {{
                    snapshot.dataTimestamp
                      ? `${formatDate(snapshot.dataTimestamp)} UTC`
                      : 'Date not reported'
                  }}
                </span>
              </span>
              <span v-if="snapshot.cached" class="mm-catalog-secondary">Already cached</span>
            </label>
            <p
              v-if="
                snapshots.latest === null && !snapshots.data.some((snapshot) => !snapshot.cached)
              "
              class="mm-catalog-state-copy"
            >
              No uncached source versions are available right now.
            </p>
          </fieldset>
          <p class="mm-catalog-fetched-at mm-caption">
            Source list checked {{ formatDate(snapshots.fetchedAt) }} UTC
          </p>
          <div v-if="downloadErrorMessage !== null" class="mm-catalog-action-error" role="alert">
            <p>{{ downloadErrorMessage }}</p>
            <p v-if="downloadErrorRequestId" class="mm-mono-small mm-catalog-request-id">
              Request ID: {{ downloadErrorRequestId }}
            </p>
          </div>
          <footer class="mm-catalog-dialog-actions">
            <button
              class="mm-catalog-button"
              type="button"
              :disabled="queueingDownload"
              @click="closeDownloadPicker"
            >
              Cancel
            </button>
            <button
              class="mm-catalog-button mm-catalog-button-primary"
              type="button"
              :disabled="!canQueueSelectedVersion || queueingDownload"
              @click="queueDownload"
            >
              {{ queueingDownload ? 'Queuing…' : 'Queue download' }}
            </button>
          </footer>
        </template>
      </section>
    </div>
  </section>
</template>
