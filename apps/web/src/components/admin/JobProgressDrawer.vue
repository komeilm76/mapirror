<script setup lang="ts">
/**
 * Persistent job progress and cancellation drawer (`P2-WEB-06`).
 *
 * It lives in `AdminLayout`, outside `router-view`: replacing the current page cannot unmount the poller or lose the
 * queued job ids. Each tracked non-terminal job is refreshed immediately and every two seconds. A cancellation response
 * is only an acknowledgement; polling continues until the worker reports its terminal state after cleanup.
 *
 * @module components/admin/JobProgressDrawer
 */

import {
  JobCancelResponseSchema,
  JobDetailResponseSchema,
  JobListResponseSchema,
  type JobView,
} from '@mapirror/shared';
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { errorCopyFor } from '@/api/error-copy';
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
  updateCheckResultLabel,
} from '@/jobs/presentation';
import { adminPagePaths } from '@/router/paths';
import { useJobProgress } from '@/stores/jobProgress';

interface JobLoadError {
  message: string;
  requestId: string | null;
}

const api = useApi();
const router = useRouter();
const progress = useJobProgress();
const jobs = reactive<Record<string, JobView | undefined>>({});
const loadErrors = reactive<Record<string, JobLoadError | undefined>>({});
const cancelErrors = reactive<Record<string, JobLoadError | undefined>>({});
const canceling = reactive<Record<string, boolean>>({});
const inFlight = new Set<string>();
const controllers = new Map<string, AbortController>();
const countRequestPending = ref(false);
let pollTimer: ReturnType<typeof setInterval> | undefined;

/** Visible tracked records, preserving the newest-first order from the store. */
const trackedJobs = computed(() =>
  progress.jobIds.flatMap((jobId) => {
    const job = jobs[jobId];
    return job === undefined ? [] : [{ jobId, job }];
  }),
);

/** Active tracked jobs are shown at the foot of the drawer. */
const trackedActiveCount = computed(
  () => trackedJobs.value.filter(({ job }) => isJobActive(job.status)).length,
);
const pendingTrackedJobIds = computed(() =>
  progress.jobIds.filter((jobId) => jobs[jobId] === undefined),
);

/** Request one authoritative projection; overlapping polls for the same id are discarded. */
async function loadJob(jobId: string, force = false): Promise<void> {
  const current = jobs[jobId];
  if (
    !progress.jobIds.includes(jobId) ||
    (!force && current !== undefined && !isJobActive(current.status))
  )
    return;
  if (inFlight.has(jobId)) return;

  const controller = new AbortController();
  controllers.set(jobId, controller);
  inFlight.add(jobId);
  try {
    const response = await api.get<unknown>(`/_admin/api/jobs/${encodeURIComponent(jobId)}`, {
      signal: controller.signal,
    });
    if (controller.signal.aborted || !progress.jobIds.includes(jobId)) return;
    const parsed = JobDetailResponseSchema.safeParse(response);
    if (!parsed.success) {
      loadErrors[jobId] = {
        message: 'The server returned job details this page could not read.',
        requestId: null,
      };
      return;
    }
    jobs[jobId] = parsed.data;
    delete loadErrors[jobId];
  } catch (cause) {
    if (controller.signal.aborted) return;
    loadErrors[jobId] = apiErrorInfo(
      cause,
      'Job progress could not be loaded. Check the connection and retry.',
    );
  } finally {
    if (controllers.get(jobId) === controller) controllers.delete(jobId);
    inFlight.delete(jobId);
  }
}

/** Refresh all eligible tracked jobs; an active cancellation remains pollable until cleanup reaches terminal state. */
function pollTrackedJobs(): void {
  for (const jobId of progress.jobIds) void loadJob(jobId);
}

/** The Jobs dot represents the whole queue, not only jobs started in this browser tab. */
async function refreshActiveCount(): Promise<void> {
  if (countRequestPending.value) return;
  countRequestPending.value = true;
  try {
    const [queuedResponse, runningResponse] = await Promise.all([
      api.get<unknown>('/_admin/api/jobs', { query: { status: 'queued', page: 1, limit: 1 } }),
      api.get<unknown>('/_admin/api/jobs', { query: { status: 'running', page: 1, limit: 1 } }),
    ]);
    const queued = JobListResponseSchema.safeParse(queuedResponse);
    const running = JobListResponseSchema.safeParse(runningResponse);
    if (queued.success && running.success) {
      progress.setActiveCount(queued.data.meta.total + running.data.meta.total);
    }
  } catch {
    // A shell badge is only a hint. Keep the last validated count; the Jobs screen owns visible/retryable API errors.
  } finally {
    countRequestPending.value = false;
  }
}

function poll(): void {
  pollTrackedJobs();
  void refreshActiveCount();
}

/** Ask the worker to cancel; accepted means requested, not finished. */
async function cancelJob(jobId: string): Promise<void> {
  const job = jobs[jobId];
  if (job === undefined || !isJobActive(job.status) || job.cancelRequested || canceling[jobId])
    return;
  canceling[jobId] = true;
  delete cancelErrors[jobId];
  try {
    const response = await api.post<unknown>(
      `/_admin/api/jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    );
    const parsed = JobCancelResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.jobId !== jobId) {
      cancelErrors[jobId] = {
        message: 'The server returned a cancellation response this page could not read.',
        requestId: null,
      };
      return;
    }
    // Keep the local acknowledgement visible while the owner's cooperative cleanup runs. A follow-up detail request
    // (and the regular two-second poll) owns the terminal status; do not label an accepted running job "canceled".
    jobs[jobId] = { ...job, cancelRequested: parsed.data.cancelRequested };
    await loadJob(jobId, true);
  } catch (cause) {
    cancelErrors[jobId] = apiErrorInfo(cause, 'The cancellation request failed. Try again.');
  } finally {
    canceling[jobId] = false;
  }
}

/** Forget only terminal jobs, never implying that a running worker was canceled. */
function dismissJob(jobId: string): void {
  const job = jobs[jobId];
  if (job !== undefined && isJobActive(job.status)) return;
  controllers.get(jobId)?.abort();
  controllers.delete(jobId);
  inFlight.delete(jobId);
  delete jobs[jobId];
  delete loadErrors[jobId];
  delete cancelErrors[jobId];
  progress.forget(jobId);
}

/** Re-open the full job queue from an empty drawer. */
function viewAllJobs(): void {
  progress.close();
  void router.push(adminPagePaths.jobs());
}

function apiErrorInfo(cause: unknown, fallback: string): JobLoadError {
  if (cause instanceof ApiError) return { message: cause.message, requestId: cause.requestId };
  return { message: fallback, requestId: null };
}

watch(
  () => [progress.jobIds, progress.refreshKey] as const,
  ([ids], oldValue) => {
    const previousIds = oldValue?.[0] ?? [];
    for (const staleId of previousIds) {
      if (ids.includes(staleId)) continue;
      controllers.get(staleId)?.abort();
      controllers.delete(staleId);
      inFlight.delete(staleId);
      delete jobs[staleId];
    }
    pollTrackedJobs();
  },
  { immediate: true },
);

void refreshActiveCount();
pollTimer = setInterval(poll, 2_000);

onUnmounted(() => {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
});
</script>

<template>
  <v-dialog
    :model-value="progress.isOpen"
    aria-label="Job progress"
    content-class="mm-job-drawer-overlay-content"
    max-width="none"
    scrollable
    transition="slide-x-reverse-transition"
    @update:model-value="(open) => (open ? progress.open() : progress.close())"
  >
    <section id="mm-job-progress-drawer" class="mm-job-progress-drawer" aria-label="Job progress">
      <div class="mm-job-drawer-heading">
        <div>
          <p class="mm-caption ma-0">Activity</p>
          <h2 class="mm-heading ma-0">Job progress</h2>
        </div>
        <v-btn aria-label="Close job progress" variant="text" @click="progress.close()"
          >Close</v-btn
        >
      </div>

      <v-divider />

      <section v-if="progress.jobIds.length === 0" aria-live="polite" class="pa-5">
        <h3 class="mm-heading mb-2">No tracked jobs</h3>
        <p class="mm-body-public mb-4">
          Jobs you start appear here and keep updating as you move around the admin panel.
        </p>
        <v-btn color="primary" variant="tonal" @click="viewAllJobs">View job history</v-btn>
      </section>

      <div v-else class="mm-job-drawer-list">
        <article
          v-for="jobId in pendingTrackedJobIds"
          :key="jobId"
          class="mm-job-progress-card"
          aria-live="polite"
        >
          <h3 class="mm-heading mb-0">Job details unavailable</h3>
          <p class="mm-mono mm-job-id">{{ jobId }}</p>
          <div v-if="loadErrors[jobId]" class="mm-job-error" role="alert">
            <p class="ma-0">{{ loadErrors[jobId]?.message }}</p>
            <p v-if="loadErrors[jobId]?.requestId" class="mm-caption ma-0 mt-1">
              Request {{ loadErrors[jobId]?.requestId }}
            </p>
            <v-btn class="mt-2" size="small" variant="tonal" @click="loadJob(jobId, true)"
              >Retry</v-btn
            >
          </div>
          <div v-else role="status">
            <v-progress-linear color="primary" indeterminate rounded />
            <p class="mm-caption mt-2 mb-0">Loading job details…</p>
          </div>
        </article>
        <article
          v-for="({ jobId, job }, index) in trackedJobs"
          :key="jobId"
          class="mm-job-progress-card"
        >
          <div class="mm-job-card-heading">
            <div>
              <p class="mm-caption ma-0">{{ jobTypeLabel(job.type) }} · {{ job.status }}</p>
              <h3 class="mm-heading mt-1 mb-0">{{ jobActivityLabel(job) }}</h3>
            </div>
            <v-btn
              v-if="!isJobActive(job.status)"
              :aria-label="`Dismiss ${jobTypeLabel(job.type)} job ${jobId}`"
              size="small"
              variant="text"
              @click="dismissJob(jobId)"
            >
              Dismiss
            </v-btn>
          </div>

          <p class="mm-mono mm-job-id">{{ jobId }}</p>

          <template v-if="job.totalBytes !== null">
            <v-progress-linear
              :model-value="progressPercent(job) ?? 0"
              :aria-label="`${jobTypeLabel(job.type)} progress`"
              color="primary"
              height="8"
              rounded
            />
            <p class="mm-job-progress-label mm-caption mb-0">
              {{ jobProgressLabel(job) }}
            </p>
          </template>
          <template v-else>
            <v-progress-linear
              v-if="isJobActive(job.status)"
              aria-label="Job progress"
              color="primary"
              indeterminate
              height="8"
              rounded
            />
            <p class="mm-job-progress-label mm-caption mb-0">
              {{ jobProgressLabel(job) }}
            </p>
          </template>

          <p
            v-if="updateCheckResultLabel(job.updateCheckResult) !== null"
            class="mm-job-progress-label mm-caption mb-0"
          >
            {{ updateCheckResultLabel(job.updateCheckResult) }}
          </p>

          <dl class="mm-job-metrics">
            <div>
              <dt>Speed</dt>
              <dd>{{ jobRateLabel(job) }}</dd>
            </div>
            <div>
              <dt>ETA</dt>
              <dd>{{ isJobActive(job.status) ? formatEta(job.etaSeconds) : '—' }}</dd>
            </div>
            <div>
              <dt>Attempt</dt>
              <dd>{{ job.attempts }} of {{ job.maxAttempts }}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{{ formatJobDate(job.startedAt) }}</dd>
            </div>
          </dl>

          <div
            v-if="job.cancelRequested && isJobActive(job.status)"
            class="mm-job-notice"
            role="status"
          >
            Cancellation requested. Waiting for the worker to finish cleanup…
          </div>

          <div v-if="job.error" class="mm-job-error" role="alert">
            <strong>{{ job.error.code }}</strong>
            <p class="ma-0 mt-1">{{ errorCopyFor(job.error.code).message }}</p>
            <p class="ma-0 mt-1">{{ errorCopyFor(job.error.code).action }}</p>
          </div>

          <div v-if="loadErrors[jobId]" class="mm-job-error" role="alert">
            <p class="ma-0">{{ loadErrors[jobId]?.message }}</p>
            <p v-if="loadErrors[jobId]?.requestId" class="mm-caption ma-0 mt-1">
              Request {{ loadErrors[jobId]?.requestId }}
            </p>
            <v-btn class="mt-2" size="small" variant="tonal" @click="loadJob(jobId, true)"
              >Retry</v-btn
            >
          </div>

          <div v-if="cancelErrors[jobId]" class="mm-job-error" role="alert">
            <p class="ma-0">{{ cancelErrors[jobId]?.message }}</p>
            <p v-if="cancelErrors[jobId]?.requestId" class="mm-caption ma-0 mt-1">
              Request {{ cancelErrors[jobId]?.requestId }}
            </p>
          </div>

          <p class="mm-caption mt-3 mb-0">Created {{ formatJobDate(job.createdAt) }}</p>

          <v-btn
            v-if="isJobActive(job.status)"
            block
            class="mt-4"
            color="error"
            :disabled="job.cancelRequested || canceling[jobId]"
            :loading="canceling[jobId]"
            variant="tonal"
            @click="cancelJob(jobId)"
          >
            {{ job.cancelRequested ? 'Cancellation requested' : 'Cancel job' }}
          </v-btn>
          <p v-if="index < trackedJobs.length - 1" class="sr-only">Next tracked job</p>
        </article>
      </div>

      <div v-if="trackedJobs.length > 0" class="mm-job-drawer-footer">
        <span class="mm-caption">{{ trackedActiveCount }} tracked active</span>
        <v-btn size="small" variant="text" @click="viewAllJobs">Job history</v-btn>
      </div>
    </section>
  </v-dialog>
</template>
