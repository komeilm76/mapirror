<script setup lang="ts">
/**
 * The paginated admin cache table (`P2-WEB-03`, `13-ui-ux.md` §4 S7).
 *
 * Search, update filter, sort and pagination are kept in the route query. Every request goes through the shared API
 * client and its strict response is parsed against the shared cache contract. The public value is deliberately a status
 * badge here; the publication switch belongs to P3-WEB-06, while per-country actions belong to P2-WEB-04/05.
 *
 * @module pages/admin/CachePage
 */

import {
  CacheListResponseSchema,
  CacheQuerySchema,
  SORT_FIELDS,
  type CacheListItem,
  type CacheListResponse,
  type CacheQuery,
} from '@mapirror/shared';
import { useDebounceFn } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { adminPagePaths } from '@/router/paths';

const CACHE_API = '/_admin/api/cache';
const PAGE_SIZE = 50;
type CacheSort = (typeof SORT_FIELDS)[number];

const route = useRoute();
const router = useRouter();
const api = useApi();

const result = ref<CacheListResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
const retryNumber = ref(0);
const searchInput = ref(queryText(route.query.q) ?? '');

/** The query sent to the cached-only endpoint, normalized from untrusted URL values. */
const cacheQuery = computed<CacheQuery>(() => {
  const query: CacheQuery = {
    page: pageFromQuery(route.query.page),
    limit: PAGE_SIZE,
    sort: sortFromQuery(route.query.sort),
    order: route.query.order === 'desc' ? 'desc' : 'asc',
    update: route.query.update === 'available' ? 'available' : 'any',
  };
  const search = boundedQueryText(route.query.q, 128);
  if (search !== undefined) query.q = search;
  const parsed = CacheQuerySchema.safeParse(query);
  return parsed.success
    ? parsed.data
    : { page: 1, limit: PAGE_SIZE, sort: 'name', order: 'asc', update: 'any' };
});

/** Current page in the normalized query. */
const page = computed(() => Number(cacheQuery.value.page));

/** Range start for the result summary. */
const rangeStart = computed(() => {
  const total = result.value?.meta.total ?? 0;
  return total === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1;
});

/** Range end for the result summary. */
const rangeEnd = computed(() => Math.min(page.value * PAGE_SIZE, result.value?.meta.total ?? 0));

/** Debounced, bookmarkable cache name/ISO search. */
const updateSearchLater = useDebounceFn(() => updateQuery({ q: searchInput.value }), 300);

watch(
  () => route.query.q,
  (value) => {
    const next = queryText(value) ?? '';
    if (searchInput.value !== next) searchInput.value = next;
  },
);

watch(searchInput, () => {
  void updateSearchLater();
});

watch(
  [cacheQuery, retryNumber],
  async ([query], _previous, onCleanup) => {
    const controller = new AbortController();
    let current = true;
    onCleanup(() => {
      current = false;
      controller.abort();
    });

    loading.value = true;
    result.value = null;
    errorMessage.value = null;
    errorRequestId.value = null;

    try {
      const response = await api.get<unknown>(CACHE_API, {
        query: queryForRequest(query),
        signal: controller.signal,
      });
      const parsed = CacheListResponseSchema.safeParse(response);
      if (!parsed.success) {
        if (current)
          errorMessage.value = 'The cached-country response could not be read. Try again.';
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
        errorMessage.value =
          'The cached countries could not be loaded. Check your connection and try again.';
      }
    } finally {
      if (current) loading.value = false;
    }
  },
  { immediate: true },
);

/** Whether the given server-supported column is currently sorted. */
function isSortedBy(field: CacheSort): boolean {
  return cacheQuery.value.sort === field;
}

/** The accessible sort state on a table header. */
function ariaSort(field: CacheSort): 'ascending' | 'descending' | 'none' {
  if (!isSortedBy(field)) return 'none';
  return cacheQuery.value.order === 'desc' ? 'descending' : 'ascending';
}

/**
 * Replaces documented cache-table query state; changing filters or sort resets pagination.
 *
 * @param patch - Supported query fields; null removes an optional filter.
 */
async function updateQuery(
  patch: Partial<Record<'q' | 'update' | 'sort' | 'order', string | null>>,
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
  if (('q' in patch || 'update' in patch || 'sort' in patch) && query.page !== undefined) {
    delete query.page;
    changed = true;
  }
  if (changed) await router.replace({ query });
}

/** Applies the available-updates filter, ignoring values outside the documented select options. */
function setUpdateFilter(value: string): void {
  if (value !== 'any' && value !== 'available') return;
  void updateQuery({ update: value === 'any' ? null : value });
}

/** Changes a supported server sort; a second click on the same heading reverses direction. */
function setSort(field: CacheSort): void {
  const order = isSortedBy(field) && cacheQuery.value.order === 'asc' ? 'desc' : 'asc';
  void updateQuery({ sort: field, order });
}

/** Moves to an existing neighboring result page while preserving filters and sort. */
function setPage(nextPage: number): void {
  const maxPage = result.value?.meta.totalPages ?? 0;
  if (!Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > maxPage) return;
  void router.replace({ query: { ...route.query, page: String(nextPage) } });
}

/** Clears the search and update-only filter. */
function clearFilters(): void {
  void router.replace({ query: {} });
  searchInput.value = '';
}

/** Retries the same request without changing URL state. */
function retry(): void {
  retryNumber.value += 1;
}

/** Formats exact byte counts without rounding a decimal string through Number. */
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

/** Formats an API timestamp in UTC for stable display. */
function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

/** Formats an optional UTC timestamp without suggesting that an unknown value has a timezone. */
function formatUtcDate(value: string | null): string {
  return value === null ? 'Not available' : `${formatDate(value)} UTC`;
}

/** Display text for a cache update offer. */
function updateLabel(item: CacheListItem): string {
  if (item.cache.updateState === 'update_available') {
    return item.cache.availableVersion === null
      ? 'Update available'
      : `Update available · ${item.cache.availableVersion}`;
  }
  if (item.cache.updateState === 'up_to_date') return 'Up to date';
  return 'Not checked';
}

/** Query values accept a single non-blank URL value only; duplicated keys are intentionally absent. */
function queryText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Accepts only bounded string search input. */
function boundedQueryText(value: unknown, maxLength: number): string | undefined {
  const text = queryText(value);
  return text !== undefined && text.length <= maxLength ? text : undefined;
}

/** Parses positive decimal page values; everything else means page one. */
function pageFromQuery(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

/** Returns only a sort key the shared contract supports. */
function sortFromQuery(value: unknown): CacheSort {
  return (SORT_FIELDS as readonly unknown[]).includes(value) ? (value as CacheSort) : 'name';
}

/** Builds the request query from fields that the strict cache endpoint accepts. */
function queryForRequest(query: CacheQuery): Record<string, string | number> {
  return {
    ...(typeof query.q === 'string' ? { q: query.q } : {}),
    update: typeof query.update === 'string' ? query.update : 'any',
    page: typeof query.page === 'number' ? query.page : 1,
    limit: typeof query.limit === 'number' ? query.limit : PAGE_SIZE,
    sort: typeof query.sort === 'string' ? query.sort : 'name',
    order: typeof query.order === 'string' ? query.order : 'asc',
  };
}

/** The ISO display fallback for rows without an upstream code. */
function isoLabel(item: CacheListItem): string {
  return item.iso.length === 0 ? 'No ISO code' : item.iso.join(' · ');
}
</script>

<template>
  <section class="mm-cache-page" aria-labelledby="cache-heading" :aria-busy="loading">
    <header class="mm-cache-heading">
      <div>
        <p class="mm-caption mb-2">Admin · Cache</p>
        <h1 id="cache-heading" class="mm-display">Cached countries</h1>
        <p class="mm-cache-intro mm-text-secondary">
          Review stored regions, their ready versions, visibility and update availability.
        </p>
      </div>
    </header>

    <section class="mm-cache-filters" aria-label="Cached-country filters">
      <div class="mm-cache-filter-field">
        <label for="cache-search">Search cached countries</label>
        <input
          id="cache-search"
          v-model="searchInput"
          autocomplete="off"
          maxlength="128"
          name="q"
          placeholder="Name or ISO code"
          type="search"
        />
      </div>
      <div class="mm-cache-filter-field">
        <label for="cache-update-filter">Update status</label>
        <select
          id="cache-update-filter"
          :value="cacheQuery.update ?? 'any'"
          @change="setUpdateFilter(($event.target as HTMLSelectElement).value)"
        >
          <option value="any">All cached countries</option>
          <option value="available">Updates available</option>
        </select>
      </div>
      <button
        class="mm-cache-button"
        type="button"
        :disabled="
          loading &&
          result === null &&
          queryText(route.query.q) === undefined &&
          route.query.update === undefined
        "
        @click="clearFilters"
      >
        Clear filters
      </button>
    </section>

    <div class="mm-cache-status" role="status" aria-live="polite">
      <span v-if="loading && result === null">Loading cached countries…</span>
      <span v-else-if="loading">Updating cached countries…</span>
      <span v-else-if="result !== null">
        Showing {{ rangeStart }}–{{ rangeEnd }} of {{ result.meta.total.toLocaleString('en-GB') }}
        cached countries
      </span>
    </div>

    <div v-if="errorMessage !== null" class="mm-cache-error" role="alert">
      <div>
        <h2 class="mm-cache-state-title">The cache could not be loaded</h2>
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
      v-else-if="loading && result === null"
      class="mm-cache-skeleton"
      role="status"
      aria-label="Loading cached countries"
    >
      <div v-for="index in 5" :key="index" class="mm-cache-skeleton-row" aria-hidden="true">
        <span /><span /><span /><span /><span /><span />
      </div>
      <div
        v-for="index in 3"
        :key="`card-${index}`"
        class="mm-cache-skeleton-card"
        aria-hidden="true"
      >
        <span /><span /><span />
      </div>
    </div>

    <div v-else-if="result !== null && result.data.length === 0" class="mm-cache-empty">
      <div>
        <h2 class="mm-cache-state-title">
          {{
            cacheQuery.q || cacheQuery.update === 'available'
              ? 'No cached country matches'
              : 'Nothing cached yet'
          }}
        </h2>
        <p class="mm-cache-state-copy">
          {{
            cacheQuery.q || cacheQuery.update === 'available'
              ? 'Adjust the search or clear filters to see the full cache.'
              : 'The mirror has no stored regions yet. Choose a country from the source catalog to begin.'
          }}
        </p>
      </div>
      <RouterLink
        v-if="!cacheQuery.q && cacheQuery.update !== 'available'"
        class="mm-cache-button mm-cache-button-primary"
        :to="adminPagePaths.catalog()"
      >
        Browse catalog
      </RouterLink>
      <button
        v-else
        class="mm-cache-button mm-cache-button-primary"
        type="button"
        @click="clearFilters"
      >
        Clear filters
      </button>
    </div>

    <template v-else-if="result !== null">
      <div class="mm-cache-table-wrap">
        <table class="mm-cache-table">
          <caption class="mm-sr-only">
            Cached countries, storage size, visibility and source update state
          </caption>
          <thead>
            <tr>
              <th scope="col" :aria-sort="ariaSort('name')">
                <button class="mm-cache-sort" type="button" @click="setSort('name')">
                  Country
                  <span v-if="isSortedBy('name')" aria-hidden="true">{{
                    cacheQuery.order === 'asc' ? '↑' : '↓'
                  }}</span>
                </button>
              </th>
              <th scope="col">Ready versions</th>
              <th scope="col" :aria-sort="ariaSort('size')">
                <button class="mm-cache-sort" type="button" @click="setSort('size')">
                  Cache size
                  <span v-if="isSortedBy('size')" aria-hidden="true">{{
                    cacheQuery.order === 'asc' ? '↑' : '↓'
                  }}</span>
                </button>
              </th>
              <th scope="col">Public state</th>
              <th scope="col">Update</th>
              <th class="mm-cache-catalog-sync" scope="col" :aria-sort="ariaSort('updated')">
                <button class="mm-cache-sort" type="button" @click="setSort('updated')">
                  Catalog synced
                  <span v-if="isSortedBy('updated')" aria-hidden="true">{{
                    cacheQuery.order === 'asc' ? '↑' : '↓'
                  }}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in result.data" :key="item.countryId">
              <th scope="row" class="mm-cache-country">
                <span class="mm-cache-name">{{ item.name }}</span>
                <span class="mm-cache-source mm-mono-small">{{ item.sourceId }}</span>
                <span class="mm-cache-secondary">{{ isoLabel(item) }}</span>
              </th>
              <td class="mm-cache-version-count">{{ item.cache.versionsReady }}</td>
              <td class="mm-cache-number mm-mono">{{ formatBytes(item.cache.totalSizeBytes) }}</td>
              <td>
                <span
                  :class="
                    item.cache.isPublic
                      ? 'mm-cache-pill mm-cache-pill-public'
                      : 'mm-cache-pill mm-cache-pill-private'
                  "
                >
                  {{ item.cache.isPublic ? 'Public' : 'Private' }}
                </span>
              </td>
              <td>
                <span
                  :class="
                    item.cache.updateState === 'update_available'
                      ? 'mm-cache-pill mm-cache-pill-update'
                      : 'mm-cache-update-text'
                  "
                >
                  {{ updateLabel(item) }}
                </span>
                <span class="mm-cache-secondary"
                  >Checked {{ formatUtcDate(item.lastCheckedAt) }}</span
                >
              </td>
              <td class="mm-cache-secondary mm-cache-catalog-sync">
                <span>{{ formatUtcDate(item.lastSyncedAt) }}</span>
                <span class="mm-cache-secondary"
                  >Source download {{ formatUtcDate(item.mostRecentDownloadAt) }}</span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="mm-cache-cards" aria-label="Cached countries">
        <article v-for="item in result.data" :key="item.countryId" class="mm-cache-card">
          <header>
            <h2 class="mm-cache-name">{{ item.name }}</h2>
            <span class="mm-cache-source mm-mono-small">{{ item.sourceId }}</span>
            <span class="mm-cache-secondary">{{ isoLabel(item) }}</span>
          </header>
          <dl>
            <div>
              <dt>Ready versions</dt>
              <dd>{{ item.cache.versionsReady }}</dd>
            </div>
            <div>
              <dt>Cache size</dt>
              <dd class="mm-mono">{{ formatBytes(item.cache.totalSizeBytes) }}</dd>
            </div>
            <div>
              <dt>Public state</dt>
              <dd>{{ item.cache.isPublic ? 'Public' : 'Private' }}</dd>
            </div>
            <div>
              <dt>Update</dt>
              <dd>{{ updateLabel(item) }}</dd>
            </div>
            <div>
              <dt>Catalog synced</dt>
              <dd>{{ formatUtcDate(item.lastSyncedAt) }}</dd>
            </div>
            <div>
              <dt>Last source download</dt>
              <dd>{{ formatUtcDate(item.mostRecentDownloadAt) }}</dd>
            </div>
          </dl>
        </article>
      </div>

      <nav
        v-if="result.meta.totalPages > 1"
        class="mm-cache-pagination"
        aria-label="Cached-country pages"
      >
        <button
          class="mm-cache-button"
          type="button"
          :disabled="page <= 1 || loading"
          @click="setPage(page - 1)"
        >
          Previous
        </button>
        <span class="mm-cache-page-count">Page {{ page }} of {{ result.meta.totalPages }}</span>
        <button
          class="mm-cache-button"
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
