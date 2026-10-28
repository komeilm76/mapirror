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
  CatalogListResponseSchema,
  CatalogQuerySchema,
  SORT_FIELDS,
  type CatalogListItem,
  type CatalogListResponse,
  type CatalogQuery,
} from '@mapirror/shared';
import { useDebounceFn } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';

const CATALOG_API = '/_admin/api/catalog';
const PAGE_SIZE = 50;
const CACHE_FILTERS = ['all', 'cached', 'uncached'] as const;
type CacheFilter = (typeof CACHE_FILTERS)[number];
type CatalogSort = (typeof SORT_FIELDS)[number];

const route = useRoute();
const router = useRouter();
const api = useApi();

const result = ref<CatalogListResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
const retryNumber = ref(0);
const continentInput = ref(queryText(route.query.continent) ?? '');

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

    <section class="mm-catalog-filters" aria-label="Catalog filters">
      <div class="mm-catalog-filter-field">
        <label for="catalog-continent">Continent / parent id</label>
        <input
          id="catalog-continent"
          v-model="continentInput"
          autocomplete="off"
          maxlength="255"
          name="continent"
          placeholder="e.g. europe"
          type="search"
        />
        <span class="mm-caption">Exact source parent id</span>
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
        {{ result.meta.total.toLocaleString('en-GB') }} regions
      </span>
    </div>

    <div v-if="errorMessage !== null" class="mm-catalog-error" role="alert">
      <div>
        <h2 class="mm-catalog-state-title">The catalog could not be loaded</h2>
        <p class="mm-catalog-state-copy">{{ errorMessage }}</p>
        <p v-if="errorRequestId" class="mm-mono-small mm-catalog-request-id">
          Request id: {{ errorRequestId }}
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
      <h2 class="mm-catalog-state-title">No country matches</h2>
      <p class="mm-catalog-state-copy">
        Try a different name or parent id, or clear the filters to start again.
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
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in result.data" :key="item.countryId">
              <th class="mm-catalog-region" scope="row">
                <span class="mm-catalog-name">{{ item.name }}</span>
                <span class="mm-catalog-source mm-mono-small">{{ item.sourceId }}</span>
              </th>
              <td>
                <span>{{ item.continent ?? 'Root region' }}</span>
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
              <dd>{{ item.continent ?? 'Root region' }} · {{ isoLabel(item) }}</dd>
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
  </section>
</template>
