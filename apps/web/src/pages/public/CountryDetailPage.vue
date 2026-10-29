<script setup lang="ts">
/** Public country detail, ready-version history, and latest-download tools (`P3-WEB-02/03`, screen S3). */

import {
  PublicCountryDetailResponseSchema,
  PublicCountryVersionsResponseSchema,
  type PublicCountryDetailResponse,
  type PublicCountryVersionsResponse,
} from '@mapirror/shared';
import { useTimeoutFn } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/errors';
import { errorCopyFor } from '@/api/error-copy';
import { useApi } from '@/composables/useApi';

const PAGE_SIZE = 25;
type PublicCountryVersion = PublicCountryDetailResponse['versions'][number];

const api = useApi();
const route = useRoute();
const router = useRouter();
const countrySlug = computed(() =>
  typeof route.params.slug === 'string' ? route.params.slug : '',
);
const currentPage = computed(() => pageFromQuery(route.query.page));
const requestKey = computed(() =>
  JSON.stringify([countrySlug.value, currentPage.value, retryCount.value]),
);

const country = ref<PublicCountryDetailResponse | null>(null);
const versions = ref<PublicCountryVersionsResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const errorAction = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
const notFound = ref(false);
const retryCount = ref(0);

const latestVersion = computed(
  () =>
    country.value?.versions.find((version) => version.isLatest) ??
    country.value?.versions.find((version) => version.version === country.value?.latest) ??
    null,
);
const pageCount = computed(() => Math.max(1, versions.value?.meta.totalPages ?? 1));
const countryFlag = computed(() => flagForIso(country.value?.iso ?? []));
const curlCommand = computed(() => {
  const version = latestVersion.value;
  const currentCountry = country.value;
  if (version === null || currentCountry === null) return '';

  const downloadUrl = new URL(
    `/_public/api/countries/${encodeURIComponent(currentCountry.slug)}/download`,
    window.location.origin,
  );
  downloadUrl.searchParams.set('version', version.version);
  const filename = `${currentCountry.slug}-${safeFilenamePart(version.version)}.osm.pbf`;
  return `curl --fail --show-error --location --output ${shellQuote(filename)} ${shellQuote(downloadUrl.href)}`;
});

const copied = ref(false);
const copyFailed = ref(false);
const copiedReset = useTimeoutFn(
  () => {
    copied.value = false;
  },
  2_000,
  { immediate: false },
);

watch(
  requestKey,
  async (_key, _previous, onCleanup) => {
    const slug = countrySlug.value;
    const requestedPage = currentPage.value;
    const controller = new AbortController();
    let current = true;
    onCleanup(() => {
      current = false;
      controller.abort();
    });

    if (country.value?.slug !== slug) country.value = null;
    versions.value = null;
    loading.value = true;
    errorMessage.value = null;
    errorAction.value = null;
    errorRequestId.value = null;
    notFound.value = false;

    try {
      let detail = country.value;
      if (detail === null) {
        const detailResult = await api.get<unknown>(
          `/_public/api/countries/${encodeURIComponent(slug)}`,
          {
            signal: controller.signal,
          },
        );
        const parsedDetail = PublicCountryDetailResponseSchema.safeParse(detailResult);
        if (!parsedDetail.success) {
          if (current) setUnreadableResponse('country details');
          return;
        }
        detail = parsedDetail.data;
        if (current) country.value = detail;
      }

      const versionResult = await api.get<unknown>(
        `/_public/api/countries/${encodeURIComponent(slug)}/versions`,
        {
          query: { page: requestedPage, limit: PAGE_SIZE },
          signal: controller.signal,
        },
      );
      const parsedVersions = PublicCountryVersionsResponseSchema.safeParse(versionResult);
      if (!parsedVersions.success) {
        if (current) setUnreadableResponse('version history');
        return;
      }

      if (requestedPage > Math.max(1, parsedVersions.data.meta.totalPages)) {
        const nextQuery = { ...route.query };
        if (parsedVersions.data.meta.totalPages <= 1) delete nextQuery.page;
        else nextQuery.page = String(parsedVersions.data.meta.totalPages);
        await router.replace({ query: nextQuery });
        return;
      }
      if (current) versions.value = parsedVersions.data;
    } catch (cause) {
      if (!current || (cause instanceof ApiError && cause.code === 'ABORTED')) return;
      if (cause instanceof ApiError && cause.code === 'NOT_FOUND') {
        country.value = null;
        notFound.value = true;
        errorMessage.value = 'This country is not available to the public.';
        errorAction.value = 'Return to the catalog to browse currently published maps.';
        errorRequestId.value = cause.requestId;
      } else if (cause instanceof ApiError) {
        const copy = errorCopyFor(cause.code);
        errorMessage.value = copy.message;
        errorAction.value = copy.action;
        errorRequestId.value = cause.requestId;
      } else {
        errorMessage.value = 'The country details could not be loaded.';
        errorAction.value = 'Check your connection and try again.';
      }
    } finally {
      if (current) loading.value = false;
    }
  },
  { immediate: true },
);

/** Retries the active detail or versions request without changing the URL. */
function retry(): void {
  retryCount.value += 1;
}

/** Copies the current latest-version command, leaving it visible for manual selection if blocked. */
async function copyCurl(): Promise<void> {
  copied.value = false;
  copyFailed.value = false;
  copiedReset.stop();

  try {
    if (typeof navigator.clipboard?.writeText !== 'function')
      throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(curlCommand.value);
    copied.value = true;
    copiedReset.start();
  } catch {
    copyFailed.value = true;
  }
}

/** Quotes a value as one POSIX-shell argument. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Limits the output filename to a simple portable basename, never a path from API data. */
function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 64) || 'version';
}

/** Changes version-history page while preserving other shareable query values. */
function selectPage(page: number): void {
  const query = { ...route.query };
  if (page <= 1) delete query.page;
  else query.page = String(page);
  void router.replace({ query });
}

/** Parses one positive decimal page number from an untrusted URL. */
function pageFromQuery(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,5}$/u.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : 1;
}

/** Formats an exact JSON byte integer without rounding values beyond Number.MAX_SAFE_INTEGER. */
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

/** Formats a timestamp in UTC or marks it as unavailable. */
function formatTimestamp(value: string | null): string {
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

/** Converts a two-letter ISO alpha-2 code to its Unicode regional-indicator flag when supported. */
function flagForIso(codes: readonly string[]): string {
  const alpha2 = codes.find((code) => /^[A-Z]{2}$/u.test(code));
  if (alpha2 === undefined) return '';
  return [...alpha2]
    .map((letter) => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65))
    .join('');
}

/** Builds a same-origin version download path from the validated route fields. */
function downloadPath(version: PublicCountryVersion): string {
  return `/_public/api/countries/${encodeURIComponent(country.value?.slug ?? '')}/download?version=${encodeURIComponent(version.version)}`;
}

/** Humanises a malformed API response without exposing schema internals. */
function setUnreadableResponse(resource: string): void {
  errorMessage.value = `The ${resource} response could not be read.`;
  errorAction.value = 'Retry the request. If this continues, contact the mirror operator.';
}
</script>

<template>
  <section class="mm-public-detail" aria-labelledby="public-country-title" :aria-busy="loading">
    <RouterLink class="mm-public-back-link" :to="{ name: 'home' }">← Browse maps</RouterLink>

    <div
      v-if="loading && !country && !errorMessage"
      class="mm-public-detail-skeleton"
      role="status"
    >
      Loading published country details…
    </div>

    <section v-else-if="!country && errorMessage" class="mm-public-error" role="alert">
      <h1 id="public-country-title">
        {{ notFound ? 'Country unavailable' : 'Country details unavailable' }}
      </h1>
      <p>{{ errorMessage }} {{ errorAction }}</p>
      <button v-if="!notFound" class="mm-public-retry" type="button" @click="retry">Retry</button>
      <RouterLink v-else class="mm-public-empty-action" :to="{ name: 'home' }"
        >Browse published maps</RouterLink
      >
      <span v-if="errorRequestId" class="mm-public-error-id">Request ID: {{ errorRequestId }}</span>
    </section>

    <section v-else-if="country" aria-labelledby="public-country-title">
      <header class="mm-public-country-heading">
        <div>
          <p class="mm-caption mb-1">Published country</p>
          <h1 id="public-country-title" class="mm-display">{{ country.name }}</h1>
        </div>
        <div class="mm-public-iso-list" role="group" aria-label="ISO country codes">
          <span v-if="countryFlag" class="mm-public-flag" aria-hidden="true">{{
            countryFlag
          }}</span>
          <span v-for="code in country.iso" :key="code" class="mm-public-iso-code">{{ code }}</span>
          <span v-if="country.iso.length === 0" class="mm-public-iso-code">ISO unavailable</span>
        </div>
      </header>

      <div class="mm-public-latest-panel">
        <div class="mm-public-latest-heading">
          <div>
            <p class="mm-caption mb-1">Latest ready version</p>
            <h2>{{ country.latest }}</h2>
          </div>
          <a
            v-if="latestVersion"
            class="mm-public-download-link"
            :href="downloadPath(latestVersion)"
          >
            Download latest
          </a>
        </div>
        <dl class="mm-public-summary-grid">
          <div>
            <dt>Size</dt>
            <dd :title="latestVersion ? `${latestVersion.sizeBytes} bytes` : undefined">
              {{ latestVersion ? formatBytes(latestVersion.sizeBytes) : 'Unavailable' }}
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{{ formatTimestamp(country.updatedAt) }}</dd>
          </div>
          <div class="mm-public-summary-checksum">
            <dt>MD5 checksum</dt>
            <dd>
              <code>{{ latestVersion?.checksumMd5 ?? 'Unavailable' }}</code>
            </dd>
          </div>
        </dl>
        <div v-if="latestVersion" class="mm-public-curl-panel">
          <div class="mm-public-curl-heading">
            <h3>Download with cURL</h3>
            <button class="mm-public-curl-copy" type="button" @click="copyCurl">
              {{ copied ? 'Copied' : 'Copy command' }}
            </button>
          </div>
          <pre class="mm-public-curl-command"><code>{{ curlCommand }}</code></pre>
          <p
            v-if="copied || copyFailed"
            class="mm-public-curl-status"
            role="status"
            aria-live="polite"
          >
            {{
              copied
                ? 'cURL command copied.'
                : 'Clipboard access failed. Select the command above and copy it manually.'
            }}
          </p>
        </div>
      </div>

      <section class="mm-public-versions-section" aria-labelledby="public-versions-title">
        <div class="mm-public-results-heading">
          <h2 id="public-versions-title">Ready versions</h2>
          <p v-if="versions" class="mm-public-results-summary" aria-live="polite">
            {{ versions.meta.total }} {{ versions.meta.total === 1 ? 'version' : 'versions' }}
          </p>
        </div>

        <div
          v-if="loading"
          class="mm-public-version-loading"
          role="status"
          aria-label="Loading version history"
        >
          Loading version history…
        </div>
        <section v-else-if="errorMessage && country" class="mm-public-error" role="alert">
          <h3>Version history unavailable</h3>
          <p>{{ errorMessage }} {{ errorAction }}</p>
          <button class="mm-public-retry" type="button" @click="retry">Retry</button>
          <span v-if="errorRequestId" class="mm-public-error-id"
            >Request ID: {{ errorRequestId }}</span
          >
        </section>
        <div v-else-if="versions?.data.length" class="mm-public-versions-table-wrap">
          <table class="mm-public-versions-table">
            <caption class="mm-sr-only">
              Ready versions for
              {{
                country.name
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Source date</th>
                <th scope="col">Size</th>
                <th scope="col">MD5 checksum</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="version in versions.data" :key="version.version">
                <th scope="row" data-label="Version">
                  {{ version.version }}
                  <span v-if="version.isLatest" class="mm-public-latest-badge">Latest</span>
                </th>
                <td data-label="Source date">{{ formatTimestamp(version.dataTimestamp) }}</td>
                <td data-label="Size" :title="`${version.sizeBytes} bytes`">
                  {{ formatBytes(version.sizeBytes) }}
                </td>
                <td data-label="MD5 checksum">
                  <code>{{ version.checksumMd5 ?? 'Unavailable' }}</code>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <section v-else class="mm-public-empty" aria-live="polite">
          <h3>No ready versions found</h3>
          <p>This country has no ready public versions at the moment.</p>
          <RouterLink class="mm-public-empty-action" :to="{ name: 'home' }"
            >Browse published maps</RouterLink
          >
        </section>

        <nav
          v-if="!loading && !errorMessage && versions && versions.meta.totalPages > 1"
          class="mm-public-pagination"
          aria-label="Version history pages"
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

      <section class="mm-public-license" aria-labelledby="public-license-title">
        <h2 id="public-license-title">Data and attribution</h2>
        <p>
          {{ country.license.attribution }} — licensed under
          <a :href="country.license.url" target="_blank" rel="noopener noreferrer">{{
            country.license.name
          }}</a
          >.
        </p>
        <p>
          Map extracts provided by
          <a :href="country.license.sourceUrl" target="_blank" rel="noopener noreferrer">
            {{ country.license.source }} </a
          >.
        </p>
      </section>
    </section>
  </section>
</template>
