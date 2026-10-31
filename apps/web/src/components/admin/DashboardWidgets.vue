<script setup lang="ts">
/** Linked operational overview widgets for the S5 admin dashboard (`P5-MON-04`).
 *
 * @module components/admin/DashboardWidgets
 */

import {
  IntervalListResponseSchema,
  JobListResponseSchema,
  SystemStatusResponseSchema,
  type IntervalView,
  type SystemStatusResponse,
} from '@mapirror/shared';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { adminPagePaths } from '@/router/paths';

import SystemMetricsPanel from './SystemMetricsPanel.vue';

const REFRESH_INTERVAL_MS = 30_000;
const api = useApi();
const status = ref<SystemStatusResponse | null>(null);
const failedJobCount = ref<number | null>(null);
const intervals = ref<readonly IntervalView[] | null>(null);
const cacheSizeReading = ref<{
  readonly bytes: number | string;
  readonly sampledAt: string;
  readonly stepSeconds: number;
} | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const statusError = ref<{ readonly message: string; readonly requestId: string | null } | null>(
  null,
);
const jobsError = ref<{ readonly message: string; readonly requestId: string | null } | null>(null);
const intervalsError = ref<{ readonly message: string; readonly requestId: string | null } | null>(
  null,
);
let mounted = false;
let requestPending = false;
let requestNumber = 0;
let requestController: AbortController | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

const enabledIntervals = computed(() =>
  (intervals.value ?? []).filter((interval) => interval.enabled),
);
const nextInterval = computed(
  () =>
    [...enabledIntervals.value].sort(
      (left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt),
    )[0] ?? null,
);
const storageHeadroom = computed(() => {
  if (status.value === null) return null;
  const free = toBigInt(status.value.storage.freeBytes);
  const reserve = toBigInt(status.value.storage.reserveBytes);
  if (free === null || reserve === null) return null;
  return free > reserve ? free - reserve : 0n;
});
const hasDashboardData = computed(
  () => status.value !== null || failedJobCount.value !== null || intervals.value !== null,
);
const endpointErrors = computed(() => {
  const errors: {
    readonly name: string;
    readonly error: { readonly message: string; readonly requestId: string | null };
  }[] = [];
  if (statusError.value !== null) errors.push({ name: 'System status', error: statusError.value });
  if (jobsError.value !== null) errors.push({ name: 'Failed jobs', error: jobsError.value });
  if (intervalsError.value !== null)
    errors.push({ name: 'Intervals', error: intervalsError.value });
  return errors;
});

function toBigInt(value: number | string | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function formatBytes(value: number | string | bigint | null | undefined): string {
  const bytes = toBigInt(value);
  if (bytes === null) return 'Unavailable';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let scaled = Number(bytes);
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toLocaleString('en-GB', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

function formatUtc(value: string | null): string {
  if (value === null) return 'No successful sync recorded';
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return 'Unknown time';
  return timestamp.toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
}

function errorDetails(cause: unknown, fallback: string) {
  return cause instanceof ApiError
    ? { message: cause.message, requestId: cause.requestId }
    : { message: fallback, requestId: null };
}

function parseStatus(outcome: PromiseSettledResult<unknown>): void {
  if (outcome.status === 'rejected') {
    statusError.value = errorDetails(outcome.reason, 'System status could not be loaded. Retry.');
    return;
  }
  const parsed = SystemStatusResponseSchema.safeParse(outcome.value);
  if (!parsed.success) {
    statusError.value = {
      message: 'The system status response could not be read.',
      requestId: null,
    };
    return;
  }
  status.value = parsed.data;
  statusError.value = null;
}

function parseFailedJobs(outcome: PromiseSettledResult<unknown>): void {
  if (outcome.status === 'rejected') {
    jobsError.value = errorDetails(outcome.reason, 'Failed-job totals could not be loaded. Retry.');
    return;
  }
  const parsed = JobListResponseSchema.safeParse(outcome.value);
  if (!parsed.success) {
    jobsError.value = { message: 'The failed-jobs response could not be read.', requestId: null };
    return;
  }
  failedJobCount.value = parsed.data.meta.total;
  jobsError.value = null;
}

function parseIntervals(outcome: PromiseSettledResult<unknown>): void {
  if (outcome.status === 'rejected') {
    intervalsError.value = errorDetails(outcome.reason, 'Schedules could not be loaded. Retry.');
    return;
  }
  const parsed = IntervalListResponseSchema.safeParse(outcome.value);
  if (!parsed.success) {
    intervalsError.value = {
      message: 'The schedules response could not be read.',
      requestId: null,
    };
    return;
  }
  intervals.value = parsed.data.data;
  intervalsError.value = null;
}

/** Reads the status summary, failed-job total, and active schedules without allowing overlapping refreshes. */
async function refreshDashboard(): Promise<void> {
  if (!mounted || requestPending) return;
  requestPending = true;
  loading.value = !hasDashboardData.value;
  refreshing.value = hasDashboardData.value;
  const currentRequest = ++requestNumber;
  const controller = new AbortController();
  requestController = controller;
  statusError.value = null;
  jobsError.value = null;
  intervalsError.value = null;

  try {
    const [statusResult, jobsResult, intervalsResult] = await Promise.allSettled([
      api.get<unknown>('/_admin/api/system/status', { signal: controller.signal }),
      api.get<unknown>('/_admin/api/jobs', {
        query: { status: 'failed', page: 1, limit: 1 },
        signal: controller.signal,
      }),
      api.get<unknown>('/_admin/api/intervals', { signal: controller.signal }),
    ]);
    if (!mounted || controller.signal.aborted || currentRequest !== requestNumber) return;
    parseStatus(statusResult);
    parseFailedJobs(jobsResult);
    parseIntervals(intervalsResult);
  } finally {
    if (currentRequest === requestNumber) {
      requestPending = false;
      loading.value = false;
      refreshing.value = false;
      if (requestController === controller) requestController = undefined;
    }
  }
}

function refreshWhenVisible(): void {
  if (document.visibilityState === 'visible') void refreshDashboard();
}

onMounted(() => {
  mounted = true;
  void refreshDashboard();
  document.addEventListener('visibilitychange', refreshWhenVisible);
  refreshTimer = setInterval(refreshWhenVisible, REFRESH_INTERVAL_MS);
});

onUnmounted(() => {
  mounted = false;
  requestNumber += 1;
  if (refreshTimer !== undefined) clearInterval(refreshTimer);
  document.removeEventListener('visibilitychange', refreshWhenVisible);
  requestController?.abort();
  requestController = undefined;
  requestPending = false;
  refreshing.value = false;
});
</script>

<template>
  <section
    class="mm-dashboard-overview"
    aria-labelledby="mm-dashboard-overview-title"
    :aria-busy="loading || refreshing"
  >
    <header class="mm-dashboard-overview-heading">
      <div>
        <h2 id="mm-dashboard-overview-title" class="mm-dashboard-overview-title mm-text-primary">
          System overview
        </h2>
        <p class="mm-dashboard-overview-description mm-text-secondary">
          Counts, queue health and cache-volume headroom.
        </p>
      </div>
      <v-btn :disabled="loading" color="primary" variant="text" @click="refreshDashboard">
        {{ refreshing ? 'Refreshing…' : loading ? 'Loading…' : 'Refresh overview' }}
      </v-btn>
    </header>

    <p
      v-if="loading && !hasDashboardData"
      class="mm-text-secondary"
      role="status"
      aria-live="polite"
    >
      Loading dashboard overview…
    </p>

    <div
      v-if="endpointErrors.length > 0"
      class="mm-dashboard-errors mm-border-error mm-text-primary"
      role="alert"
    >
      <p class="ma-0">
        {{
          hasDashboardData
            ? 'Some dashboard data could not be refreshed. Last successful readings remain visible where available.'
            : 'Dashboard data could not be loaded. Check the connection and refresh.'
        }}
      </p>
      <ul>
        <li v-for="entry in endpointErrors" :key="entry.name">
          {{ entry.name }}: {{ entry.error.message }}
          <span v-if="entry.error.requestId" class="mm-mono-small">
            Request id: {{ entry.error.requestId }}
          </span>
        </li>
      </ul>
    </div>

    <div v-if="loading && !hasDashboardData" class="mm-dashboard-skeletons" aria-hidden="true">
      <div
        v-for="index in 7"
        :key="index"
        class="mm-dashboard-skeleton mm-bg-surface mm-border-decorative"
      />
    </div>

    <div v-else class="mm-dashboard-grid">
      <v-card border flat rounded="lg" :to="adminPagePaths.cache()" class="mm-dashboard-card">
        <v-card-title>Cached data (sampled)</v-card-title>
        <v-card-text>
          <p class="mm-dashboard-value mm-text-primary">
            {{ cacheSizeReading === null ? 'Sampling…' : formatBytes(cacheSizeReading.bytes) }}
          </p>
          <p class="mm-dashboard-detail mm-text-secondary">
            {{ status?.counts.cachedCountries.toLocaleString('en-GB') ?? '—' }} cached ·
            {{ status?.counts.publicCountries.toLocaleString('en-GB') ?? '—' }} public ·
            {{ status?.counts.versions.toLocaleString('en-GB') ?? '—' }} ready versions
          </p>
          <p v-if="cacheSizeReading" class="mm-dashboard-footnote mm-text-secondary">
            Latest {{ cacheSizeReading.stepSeconds }} s bucket average ·
            {{ formatUtc(cacheSizeReading.sampledAt) }} UTC
          </p>
          <p v-else class="mm-dashboard-footnote mm-text-secondary">
            Cached bytes await the next sample.
          </p>
        </v-card-text>
      </v-card>

      <v-card border flat rounded="lg" :to="adminPagePaths.catalog()" class="mm-dashboard-card">
        <v-card-title>Catalog regions</v-card-title>
        <v-card-text>
          <p class="mm-dashboard-value mm-text-primary">
            {{ status?.counts.countries.toLocaleString('en-GB') ?? '—' }}
          </p>
          <p class="mm-dashboard-detail mm-text-secondary">Regions in the local catalog.</p>
        </v-card-text>
      </v-card>

      <v-card
        border
        flat
        rounded="lg"
        :to="{ path: adminPagePaths.cache(), query: { update: 'available' } }"
        class="mm-dashboard-card"
      >
        <v-card-title>Updates available</v-card-title>
        <v-card-text>
          <p class="mm-dashboard-value mm-text-primary">
            {{ status?.counts.updatesAvailable.toLocaleString('en-GB') ?? '—' }}
          </p>
          <p class="mm-dashboard-detail mm-text-secondary">
            Cached regions with a newer source snapshot.
          </p>
        </v-card-text>
      </v-card>

      <v-card border flat rounded="lg" :to="adminPagePaths.jobs()" class="mm-dashboard-card">
        <v-card-title>Jobs</v-card-title>
        <v-card-text>
          <p class="mm-dashboard-value mm-text-primary">
            {{ status?.counts.jobsRunning.toLocaleString('en-GB') ?? '—' }} running ·
            {{ status?.counts.jobsQueued.toLocaleString('en-GB') ?? '—' }} queued
          </p>
          <p class="mm-dashboard-detail mm-text-secondary">
            {{ failedJobCount?.toLocaleString('en-GB') ?? '—' }} failed jobs
          </p>
        </v-card-text>
      </v-card>

      <v-card border flat rounded="lg" :to="adminPagePaths.system()" class="mm-dashboard-card">
        <v-card-title>Storage headroom</v-card-title>
        <v-card-text>
          <p class="mm-dashboard-value mm-text-primary">
            {{ status === null ? 'Unavailable' : formatBytes(storageHeadroom) }}
          </p>
          <p class="mm-dashboard-detail mm-text-secondary">Free above the configured reserve.</p>
          <p
            v-if="status !== null"
            class="mm-dashboard-footnote mm-text-primary"
            :class="status.storage.state === 'ok' ? 'text-success' : 'text-warning'"
          >
            {{
              status.storage.state === 'ok'
                ? 'Above reserve'
                : status.storage.state === 'low'
                  ? `At or below reserve · ${formatBytes(status.storage.freeBytes)} free`
                  : 'No free space'
            }}
          </p>
        </v-card-text>
      </v-card>

      <v-card border flat rounded="lg" :to="adminPagePaths.intervals()" class="mm-dashboard-card">
        <v-card-title>Next scheduled interval</v-card-title>
        <v-card-text>
          <p class="mm-dashboard-value mm-text-primary">
            {{ nextInterval?.name ?? (intervals === null ? 'Unavailable' : 'No active schedules') }}
          </p>
          <p v-if="nextInterval" class="mm-dashboard-detail mm-text-secondary">
            {{ formatUtc(nextInterval.nextRunAt) }} UTC
          </p>
          <p v-else class="mm-dashboard-detail mm-text-secondary">View and manage schedules.</p>
        </v-card-text>
      </v-card>

      <v-card border flat rounded="lg" :to="adminPagePaths.catalog()" class="mm-dashboard-card">
        <v-card-title>Source sync freshness</v-card-title>
        <v-card-text>
          <p class="mm-dashboard-value mm-text-primary">
            {{
              status === null
                ? 'Unavailable'
                : status.source.reachable
                  ? 'Last completed sync succeeded'
                  : status.source.lastSyncAt === null
                    ? 'No successful sync recorded'
                    : 'Most recent sync failed'
            }}
          </p>
          <p class="mm-dashboard-detail mm-text-secondary">
            {{
              status?.source.lastSyncAt === null || status === null
                ? 'No successful sync time available.'
                : `Last successful sync ${formatUtc(status.source.lastSyncAt)} UTC`
            }}
          </p>
        </v-card-text>
      </v-card>
    </div>

    <SystemMetricsPanel @cache-size-updated="cacheSizeReading = $event" />
  </section>
</template>

<style scoped>
.mm-dashboard-overview {
  display: flex;
  flex-direction: column;
  gap: var(--mm-space-4);
}

.mm-dashboard-overview-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--mm-space-4);
}

.mm-dashboard-overview-title {
  margin: 0;
  font-size: var(--mm-text-section);
  font-weight: var(--mm-weight-bold);
}

.mm-dashboard-overview-description {
  margin: var(--mm-space-1) 0 0;
  font-size: var(--mm-text-ui);
}

.mm-dashboard-errors {
  padding: var(--mm-space-3) var(--mm-space-4);
  border-width: var(--mm-border-width);
  border-style: solid;
  border-radius: var(--mm-radius-sm);
}

.mm-dashboard-errors ul {
  margin: var(--mm-space-2) 0 0;
  padding-inline-start: var(--mm-space-6);
}

.mm-dashboard-errors li {
  font-size: var(--mm-text-ui);
}

.mm-dashboard-grid,
.mm-dashboard-skeletons {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--mm-space-4);
}

.mm-dashboard-card {
  min-width: 0;
  height: 100%;
}

.mm-dashboard-value {
  margin: 0;
  font-size: var(--mm-text-section);
  font-variant-numeric: tabular-nums;
  font-weight: var(--mm-weight-bold);
  overflow-wrap: anywhere;
}

.mm-dashboard-detail,
.mm-dashboard-footnote {
  margin: var(--mm-space-2) 0 0;
  font-size: var(--mm-text-ui);
  overflow-wrap: anywhere;
}

.mm-dashboard-footnote {
  font-size: var(--mm-text-caption-compact);
}

.mm-dashboard-skeleton {
  min-height: 10rem;
  border-radius: var(--mm-radius-md);
}

@media (max-width: 1023px) {
  .mm-dashboard-grid,
  .mm-dashboard-skeletons {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 599px) {
  .mm-dashboard-overview-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .mm-dashboard-grid,
  .mm-dashboard-skeletons {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
