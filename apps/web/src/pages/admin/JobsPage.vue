<script setup lang="ts">
/**
 * Admin job queue (`P2-WEB-06`, `13-ui-ux.md` §4 S11).
 *
 * The filters and page live in the URL; the table refreshes every two seconds while this route is mounted. Opening a
 * row hands its id to the shell-level progress drawer, which remains mounted and continues polling across navigation.
 *
 * @module pages/admin/JobsPage
 */

import {
  JOB_STATUSES,
  JOB_TYPES,
  JobListResponseSchema,
  type JobListResponse,
} from '@mapirror/shared';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import {
  formatEta,
  formatJobDate,
  isJobActive,
  jobActivityLabel,
  jobProgressLabel,
  jobRateLabel,
  jobTypeLabel,
  progressPercent,
} from '@/jobs/presentation';
import { useJobProgress } from '@/stores/jobProgress';

const PAGE_SIZE = 25;
type JobStatus = (typeof JOB_STATUSES)[number];
type JobType = (typeof JOB_TYPES)[number];
const route = useRoute();
const router = useRouter();
const api = useApi();
const jobProgress = useJobProgress();
const result = ref<JobListResponse | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
const retryNumber = ref(0);
let controller: AbortController | undefined;
let requestPending = false;
let requestNumber = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;

function queryText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pageFromQuery(value: unknown): number {
  const text = queryText(value);
  if (text === undefined || !/^\d+$/u.test(text)) return 1;
  const page = Number(text);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

const statusFilter = computed<JobStatus | ''>(() => {
  const value = queryText(route.query.status);
  return value !== undefined && (JOB_STATUSES as readonly string[]).includes(value)
    ? (value as JobStatus)
    : '';
});
const typeFilter = computed<JobType | ''>(() => {
  const value = queryText(route.query.type);
  return value !== undefined && (JOB_TYPES as readonly string[]).includes(value)
    ? (value as JobType)
    : '';
});
const page = computed(() => pageFromQuery(route.query.page));

/** Fetch one validated page; concurrent interval ticks are skipped rather than aborting a slow response. */
async function loadJobs(): Promise<void> {
  if (requestPending) return;
  const currentRequest = ++requestNumber;
  const requestController = new AbortController();
  controller = requestController;
  requestPending = true;
  loading.value = result.value === null;
  const query: Record<string, string | number> = { page: page.value, limit: PAGE_SIZE };
  if (statusFilter.value !== '') query.status = statusFilter.value;
  if (typeFilter.value !== '') query.type = typeFilter.value;

  try {
    const response = await api.get<unknown>('/_admin/api/jobs', {
      query,
      signal: requestController.signal,
    });
    if (requestController.signal.aborted || currentRequest !== requestNumber) return;
    const parsed = JobListResponseSchema.safeParse(response);
    if (!parsed.success) {
      errorMessage.value = 'The server returned a job list this page could not read.';
      errorRequestId.value = null;
      return;
    }
    result.value = parsed.data;
    errorMessage.value = null;
    errorRequestId.value = null;
    // Filtering can make the current page disappear. Move to the last valid page instead of showing a false empty state.
    if (parsed.data.meta.totalPages > 0 && page.value > parsed.data.meta.totalPages) {
      await setPage(parsed.data.meta.totalPages);
    }
  } catch (cause) {
    if (requestController.signal.aborted || currentRequest !== requestNumber) return;
    if (cause instanceof ApiError) {
      errorMessage.value = cause.message;
      errorRequestId.value = cause.requestId;
    } else {
      errorMessage.value = 'Jobs could not be loaded. Check the connection and retry.';
      errorRequestId.value = null;
    }
  } finally {
    if (currentRequest === requestNumber) {
      requestPending = false;
      loading.value = false;
      if (controller === requestController) controller = undefined;
    }
  }
}

function statusChanged(event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value;
  if (typeof value === 'string') void updateFilters({ status: value });
}

function typeChanged(event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value;
  if (typeof value === 'string') void updateFilters({ type: value });
}

async function updateFilters(next: { status?: string; type?: string }): Promise<void> {
  const query = { ...route.query };
  if (next.status !== undefined) {
    if (next.status === '') delete query.status;
    else query.status = next.status;
  }
  if (next.type !== undefined) {
    if (next.type === '') delete query.type;
    else query.type = next.type;
  }
  delete query.page;
  await router.replace({ name: 'admin-jobs', query });
}

async function setPage(nextPage: number): Promise<void> {
  const bounded = Math.max(1, nextPage);
  await router.replace({ name: 'admin-jobs', query: { ...route.query, page: String(bounded) } });
}

function retry(): void {
  retryNumber.value += 1;
}

watch(
  () => [route.query.status, route.query.type, route.query.page, retryNumber.value] as const,
  () => {
    controller?.abort();
    requestPending = false;
    void loadJobs();
  },
  { immediate: true },
);

pollTimer = setInterval(() => void loadJobs(), 2_000);
onUnmounted(() => {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  controller?.abort();
});
</script>

<template>
  <main class="mm-jobs-page" aria-labelledby="mm-jobs-title">
    <header class="mm-jobs-heading">
      <div>
        <p class="mm-caption mb-2">Administration · Queue</p>
        <h1 id="mm-jobs-title" class="mm-display">Jobs</h1>
        <p class="mm-body-public mm-jobs-intro">
          Follow queued and running work, review completed results, or open progress for
          cancellation and safe error details.
        </p>
      </div>
      <v-btn variant="tonal" @click="retry">Refresh</v-btn>
    </header>

    <section class="mm-jobs-filters" aria-label="Filter jobs">
      <div class="mm-cache-filter-field">
        <label for="mm-job-status">Status</label>
        <select id="mm-job-status" :value="statusFilter" @change="statusChanged">
          <option value="">All statuses</option>
          <option v-for="status in JOB_STATUSES" :key="status" :value="status">{{ status }}</option>
        </select>
      </div>
      <div class="mm-cache-filter-field">
        <label for="mm-job-type">Type</label>
        <select id="mm-job-type" :value="typeFilter" @change="typeChanged">
          <option value="">All job types</option>
          <option v-for="type in JOB_TYPES" :key="type" :value="type">
            {{ jobTypeLabel(type) }}
          </option>
        </select>
      </div>
      <span class="mm-caption" aria-live="polite">{{
        result ? `${result.meta.total} jobs` : 'Loading jobs…'
      }}</span>
    </section>

    <div v-if="loading && result === null" class="mm-jobs-state" role="status">
      <v-progress-linear color="primary" indeterminate rounded />
      <p class="mm-body-public mt-4">Loading jobs…</p>
    </div>

    <section v-else-if="errorMessage && result === null" class="mm-jobs-state" role="alert">
      <h2 class="mm-heading">Jobs could not be loaded</h2>
      <p class="mm-body-public">{{ errorMessage }}</p>
      <p v-if="errorRequestId" class="mm-caption">Request {{ errorRequestId }}</p>
      <v-btn class="mt-3" color="primary" variant="tonal" @click="retry">Retry</v-btn>
    </section>

    <div v-else-if="result" class="mm-jobs-results" :aria-busy="loading">
      <p v-if="errorMessage" class="mm-jobs-refresh-error" role="status">
        {{ errorMessage }} The last successful job list is still shown.
        <span v-if="errorRequestId">Request {{ errorRequestId }}</span>
      </p>

      <div v-if="result.data.length === 0" class="mm-jobs-state" role="status">
        <h2 class="mm-heading">No jobs match these filters</h2>
        <p class="mm-body-public">
          Try another status or type, or check back after work has been queued.
        </p>
        <v-btn variant="tonal" @click="updateFilters({ status: '', type: '' })"
          >Clear filters</v-btn
        >
      </div>

      <div v-else>
        <div class="mm-jobs-table-wrap">
          <table class="mm-jobs-table">
            <caption class="sr-only">
              MapMirror background jobs, refreshed every two seconds
            </caption>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Status / phase</th>
                <th scope="col">Progress</th>
                <th scope="col">Speed</th>
                <th scope="col">ETA</th>
                <th scope="col">Created</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in result.data" :key="job.id">
                <td>
                  <strong>{{ jobTypeLabel(job.type) }}</strong>
                  <span class="mm-jobs-id mm-mono">{{ job.id }}</span>
                </td>
                <td>
                  <span class="mm-job-status" :data-status="job.status">{{ job.status }}</span
                  ><span class="mm-job-phase">{{ jobActivityLabel(job) }}</span>
                </td>
                <td class="mm-jobs-progress">
                  <template v-if="job.totalBytes !== null">
                    <v-progress-linear
                      :model-value="progressPercent(job) ?? 0"
                      :aria-label="`${jobTypeLabel(job.type)} progress`"
                      color="primary"
                      height="6"
                      rounded
                    />
                    <span>{{ jobProgressLabel(job) }}</span>
                  </template>
                  <template v-else>
                    <v-progress-linear
                      v-if="isJobActive(job.status)"
                      :aria-label="`${jobTypeLabel(job.type)} progress`"
                      color="primary"
                      indeterminate
                      height="6"
                      rounded
                    />
                    <span>{{ jobProgressLabel(job) }}</span>
                  </template>
                </td>
                <td>{{ jobRateLabel(job) }}</td>
                <td>{{ isJobActive(job.status) ? formatEta(job.etaSeconds) : '—' }}</td>
                <td>{{ formatJobDate(job.createdAt) }}</td>
                <td>
                  <v-btn size="small" variant="tonal" @click="jobProgress.track(job.id)"
                    >View progress</v-btn
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="mm-jobs-mobile-list">
          <article v-for="job in result.data" :key="`mobile-${job.id}`" class="mm-jobs-mobile-card">
            <div class="mm-job-card-heading">
              <div>
                <strong>{{ jobTypeLabel(job.type) }}</strong>
                <span class="mm-job-phase">{{ jobActivityLabel(job) }}</span>
              </div>
              <span class="mm-job-status" :data-status="job.status">{{ job.status }}</span>
            </div>
            <span class="mm-jobs-id mm-mono">{{ job.id }}</span>
            <div class="mm-jobs-mobile-progress">
              <v-progress-linear
                v-if="job.totalBytes !== null"
                :model-value="progressPercent(job) ?? 0"
                :aria-label="`${jobTypeLabel(job.type)} progress`"
                color="primary"
                height="6"
                rounded
              />
              <v-progress-linear
                v-else-if="isJobActive(job.status)"
                :aria-label="`${jobTypeLabel(job.type)} progress`"
                color="primary"
                indeterminate
                height="6"
                rounded
              />
              <span class="mm-caption">{{ jobProgressLabel(job) }}</span>
            </div>
            <dl class="mm-jobs-mobile-meta">
              <div>
                <dt>Speed</dt>
                <dd>{{ jobRateLabel(job) }}</dd>
              </div>
              <div>
                <dt>ETA</dt>
                <dd>{{ isJobActive(job.status) ? formatEta(job.etaSeconds) : '—' }}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{{ formatJobDate(job.createdAt) }}</dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>{{ job.attempts }} / {{ job.maxAttempts }}</dd>
              </div>
            </dl>
            <v-btn block variant="tonal" @click="jobProgress.track(job.id)"
              >View progress and details</v-btn
            >
          </article>
        </div>

        <div class="mm-jobs-pagination">
          <span class="mm-caption"
            >Page {{ result.meta.page }} of {{ Math.max(1, result.meta.totalPages) }}</span
          >
          <div class="d-flex ga-2">
            <v-btn :disabled="page <= 1" variant="tonal" @click="setPage(page - 1)">Previous</v-btn>
            <v-btn
              :disabled="page >= result.meta.totalPages"
              variant="tonal"
              @click="setPage(page + 1)"
              >Next</v-btn
            >
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
