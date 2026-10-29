<script setup lang="ts">
/** Public country catalog with shareable search, continent filtering and pagination (`P3-WEB-01`, S2). */

import {
  PublicCountriesQuerySchema,
  PublicCountriesResponseSchema,
  type PublicCountriesQuery,
  type PublicCountriesResponse,
  type PublicCountryListItem,
} from '@mapirror/shared';
import { useDebounceFn } from '@vueuse/core';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/errors';
import { errorCopyFor } from '@/api/error-copy';
import { useApi } from '@/composables/useApi';
import spaceGroteskFontUrl from '@/assets/fonts/space-grotesk-latin-wght.woff2?url';

const PAGE_SIZE = 25;
const CONTINENTS = [
  { id: 'africa', label: 'Africa' },
  { id: 'asia', label: 'Asia' },
  { id: 'australia-oceania', label: 'Australia & Oceania' },
  { id: 'central-america', label: 'Central America' },
  { id: 'europe', label: 'Europe' },
  { id: 'north-america', label: 'North America' },
  { id: 'south-america', label: 'South America' },
] as const;

const route = useRoute();
const router = useRouter();
const api = useApi();
const fontPreload = document.createElement('link');
fontPreload.rel = 'preload';
fontPreload.as = 'font';
fontPreload.type = 'font/woff2';
fontPreload.crossOrigin = 'anonymous';
fontPreload.href = spaceGroteskFontUrl;
document.head.append(fontPreload);
onUnmounted(() => fontPreload.remove());

const searchInput = ref(queryText(route.query.q) ?? '');
const response = ref<PublicCountriesResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const errorAction = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
const retryCount = ref(0);

/** Validated filter and page state for the public endpoint. */
const publicQuery = computed<PublicCountriesQuery>(() => {
  const query: Record<string, unknown> = {
    page: pageFromQuery(route.query.page),
    limit: PAGE_SIZE,
    sort: 'name',
  };
  const search = boundedText(route.query.q, 128);
  const continent = boundedText(route.query.continent, 255);
  if (search !== undefined) query.q = search;
  if (continent !== undefined) query.continent = continent;
  const parsed = PublicCountriesQuerySchema.safeParse(query);
  return parsed.success ? parsed.data : { page: 1, limit: PAGE_SIZE, sort: 'name' };
});

/** Stable watcher key; unrelated route metadata does not trigger another list request. */
const requestKey = computed(() => JSON.stringify(publicQuery.value));
const currentPage = computed(() => pageFromQuery(route.query.page));
const activeContinent = computed(() => publicQuery.value.continent ?? null);
const hasFilters = computed(() => Boolean(publicQuery.value.q || publicQuery.value.continent));
const pageCount = computed(() => Math.max(1, response.value?.meta.totalPages ?? 1));

/** Keep the input in sync with back/forward navigation and shared URLs. */
watch(
  () => route.query.q,
  (value) => {
    const next = queryText(value) ?? '';
    if (searchInput.value !== next) searchInput.value = next;
  },
);

/** The URL changes only after a short pause, not once per keystroke. */
const updateSearchLater = useDebounceFn(() => {
  void updateFilters({ q: searchInput.value.trim() || null });
}, 300);
watch(searchInput, () => void updateSearchLater());

watch(
  [requestKey, retryCount],
  async (_values, _previous, onCleanup) => {
    const controller = new AbortController();
    let current = true;
    onCleanup(() => {
      current = false;
      controller.abort();
    });

    const query = publicQuery.value;
    loading.value = true;
    response.value = null;
    errorMessage.value = null;
    errorAction.value = null;
    errorRequestId.value = null;

    try {
      const result = await api.get<unknown>('/_public/api/countries', {
        query: queryForRequest(query),
        signal: controller.signal,
      });
      const parsed = PublicCountriesResponseSchema.safeParse(result);
      if (!parsed.success) {
        if (current) {
          errorMessage.value = 'The published catalog response could not be read.';
          errorAction.value = 'Retry the request. If this continues, contact the mirror operator.';
        }
        return;
      }

      const requestedPage = typeof query.page === 'number' ? query.page : 1;
      if (requestedPage > Math.max(1, parsed.data.meta.totalPages)) {
        const nextQuery = { ...route.query };
        if (parsed.data.meta.totalPages <= 1) delete nextQuery.page;
        else nextQuery.page = String(parsed.data.meta.totalPages);
        await router.replace({ query: nextQuery });
        return;
      }
      if (current) response.value = parsed.data;
    } catch (cause) {
      if (!current || (cause instanceof ApiError && cause.code === 'ABORTED')) return;
      if (cause instanceof ApiError) {
        const copy = errorCopyFor(cause.code);
        errorMessage.value = copy.message;
        errorAction.value = copy.action;
        errorRequestId.value = cause.requestId;
      } else {
        errorMessage.value = 'The published catalog could not be loaded.';
        errorAction.value = 'Check your connection and try again.';
      }
    } finally {
      if (current) loading.value = false;
    }
  },
  { immediate: true },
);

/** Applies a shareable filter or page change; changing filters always returns to the first page. */
async function updateFilters(
  patch: Partial<Record<'q' | 'continent' | 'page', string | null>>,
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
  if (('q' in patch || 'continent' in patch) && query.page !== undefined) {
    delete query.page;
    changed = true;
  }
  if (changed) await router.replace({ query });
}

/** Commits the current search immediately when the form is submitted. */
function submitSearch(): void {
  void updateFilters({ q: searchInput.value.trim() || null });
}

/** Selects a source continent or returns to all public countries. */
function selectContinent(continent: string | null): void {
  void updateFilters({ continent });
}

/** Changes the current page without altering filters. */
function selectPage(page: number): void {
  void updateFilters({ page: page <= 1 ? null : String(page) });
}

/** Retries the same request while leaving the URL and filters intact. */
function retry(): void {
  retryCount.value += 1;
}

/** Clears text and continent filters, and resets to the initial list. */
function clearFilters(): void {
  searchInput.value = '';
  void updateFilters({ q: null, continent: null, page: null });
}

/** Builds a request query with only documented scalar values. */
function queryForRequest(query: PublicCountriesQuery): Record<string, string | number> {
  const result: Record<string, string | number> = {
    page: typeof query.page === 'number' ? query.page : pageFromQuery(route.query.page),
    limit: PAGE_SIZE,
    sort: 'name',
  };
  if (typeof query.q === 'string') result.q = query.q;
  if (typeof query.continent === 'string') result.continent = query.continent;
  return result;
}

/** Parses only a single bounded route-query value. */
function queryText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Trims route text and rejects values outside the shared schema's limits. */
function boundedText(value: unknown, maxLength: number): string | undefined {
  const text = queryText(value)?.trim();
  return text && text.length <= maxLength && !text.includes('\u0000') ? text : undefined;
}

/** Parses one positive decimal page number from an untrusted URL. */
function pageFromQuery(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,5}$/u.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : 1;
}

/** Human-readable bytes with exact byte count available in the card's accessible description. */
function formatBytes(value: number | string): string {
  const bytes = BigInt(value);
  const labels = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
  let unit = 0;
  let divisor = 1n;
  while (unit < labels.length - 1 && bytes >= divisor * 1_000n) {
    divisor *= 1_000n;
    unit += 1;
  }
  if (unit === 0) return `${bytes.toString()} B`;
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  return `${(tenths / 10n).toString()}.${(tenths % 10n).toString()} ${labels[unit]}`;
}

/** Formats an upstream timestamp in UTC, or reports that it was not supplied. */
function formatUpdatedAt(value: string | null): string {
  if (value === null) return 'Date unavailable';
  return `${new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value))} UTC`;
}

/** Converts source parent ids into calm display labels without exposing source-path punctuation. */
function continentLabel(value: string | null): string {
  if (value === null) return 'Region';
  return (
    CONTINENTS.find((continent) => continent.id === value)?.label ??
    value
      .split(/[-_]/u)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  );
}

/** The item type is named in the template helper to keep link/card projections explicit. */
function countryLink(item: PublicCountryListItem): { name: string; params: { slug: string } } {
  return { name: 'country', params: { slug: item.slug } };
}
</script>

<template>
  <section class="mm-public-catalog" aria-labelledby="public-catalog-title" :aria-busy="loading">
    <header class="mm-public-intro">
      <p class="mm-caption mb-1">OpenStreetMap data · ODbL 1.0</p>
      <h1 id="public-catalog-title" class="mm-display">Browse published maps</h1>
      <p class="mm-body-public mm-text-secondary">
        Find ready regional extracts from this mirror. Search by country name or ISO code, then open
        a country for versions and download details.
      </p>
    </header>

    <div class="mm-public-controls">
      <form class="mm-public-search-form" role="search" @submit.prevent="submitSearch">
        <label class="mm-public-search-label" for="public-country-search"
          >Search published maps</label
        >
        <input
          id="public-country-search"
          v-model="searchInput"
          class="mm-public-search-input"
          type="search"
          name="q"
          autocomplete="off"
          placeholder="Search countries or ISO codes"
        />
        <button class="mm-public-search-button" type="submit">Search</button>
      </form>

      <div class="mm-public-filter-group" role="group" aria-label="Filter maps by continent">
        <span class="mm-public-filter-label">Continent</span>
        <button
          class="mm-public-filter-chip"
          type="button"
          :aria-pressed="activeContinent === null"
          @click="selectContinent(null)"
        >
          All
        </button>
        <button
          v-for="continent in CONTINENTS"
          :key="continent.id"
          class="mm-public-filter-chip"
          type="button"
          :aria-pressed="activeContinent === continent.id"
          @click="selectContinent(continent.id)"
        >
          {{ continent.label }}
        </button>
      </div>
    </div>

    <section aria-labelledby="published-countries-title">
      <div class="mm-public-results-heading">
        <h2 id="published-countries-title">Published countries</h2>
        <p v-if="response" class="mm-public-results-summary" aria-live="polite">
          {{ response.meta.total }} {{ response.meta.total === 1 ? 'country' : 'countries' }}
        </p>
      </div>

      <div
        v-if="loading"
        class="mm-public-country-grid"
        role="status"
        aria-label="Loading published maps"
      >
        <div v-for="index in 6" :key="index" class="mm-public-loading-card" aria-hidden="true">
          <div class="mm-public-skeleton-line" />
          <div class="mm-public-skeleton-line" />
          <div class="mm-public-skeleton-line" />
        </div>
      </div>

      <section v-else-if="errorMessage" class="mm-public-error" role="alert">
        <h2>Catalog unavailable</h2>
        <p>{{ errorMessage }} {{ errorAction }}</p>
        <button class="mm-public-retry" type="button" @click="retry">Retry</button>
        <span v-if="errorRequestId" class="mm-public-error-id"
          >Request ID: {{ errorRequestId }}</span
        >
      </section>

      <div v-else-if="response?.data.length" class="mm-public-country-grid">
        <RouterLink
          v-for="item in response.data"
          :key="item.slug"
          class="mm-public-country-card"
          :to="countryLink(item)"
          :aria-label="`${item.name}, ${continentLabel(item.continent)}, latest ${item.newestVersion}, ${formatBytes(item.sizeBytes)}`"
        >
          <div>
            <p class="mm-public-country-meta">{{ continentLabel(item.continent) }}</p>
            <h3>{{ item.name }}</h3>
          </div>
          <dl class="mm-public-country-facts">
            <div>
              <dt>Latest version</dt>
              <dd>{{ item.newestVersion }}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd :title="`${item.sizeBytes} bytes`">{{ formatBytes(item.sizeBytes) }}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd :title="item.updatedAt ?? 'No upstream timestamp'">
                {{ formatUpdatedAt(item.updatedAt) }}
              </dd>
            </div>
            <div>
              <dt>ISO</dt>
              <dd>{{ item.iso.join(', ') || 'Not listed' }}</dd>
            </div>
          </dl>
        </RouterLink>
      </div>

      <section v-else class="mm-public-empty" aria-live="polite">
        <h2>{{ hasFilters ? 'No countries match these filters' : 'No maps published yet' }}</h2>
        <p>
          {{
            hasFilters
              ? 'Try another name or continent, or clear the filters to see every published map.'
              : 'There are no ready maps available to the public right now. Check back later.'
          }}
        </p>
        <button
          v-if="hasFilters"
          class="mm-public-empty-action"
          type="button"
          @click="clearFilters"
        >
          Clear filters
        </button>
        <button v-else class="mm-public-empty-action" type="button" @click="retry">
          Refresh catalog
        </button>
      </section>

      <nav
        v-if="!loading && !errorMessage && response && response.meta.totalPages > 1"
        class="mm-public-pagination"
        aria-label="Catalog pages"
      >
        <button
          class="mm-public-pagination-button"
          type="button"
          :disabled="currentPage <= 1"
          @click="selectPage(currentPage - 1)"
        >
          Previous
        </button>
        <span class="mm-public-pagination-status">Page {{ currentPage }} of {{ pageCount }}</span>
        <button
          class="mm-public-pagination-button"
          type="button"
          :disabled="currentPage >= pageCount"
          @click="selectPage(currentPage + 1)"
        >
          Next
        </button>
      </nav>
    </section>
  </section>
</template>
