<script setup lang="ts">
/**
 * Paginated interval run history and country-level outcomes (`P4-INT-09`).
 *
 * Each selected run is fetched from the strict detail contract. Running executions refresh every two seconds until a
 * terminal status so counts and safe failure details remain current without reloading the whole schedules page.
 *
 * @module components/admin/IntervalRunsPanel
 */

import {
  IntervalRunDetailResponseSchema,
  IntervalRunListResponseSchema,
  type IntervalRunItemView,
  type IntervalRunView,
  type IntervalView,
} from '@mapirror/shared';
import { onMounted, onUnmounted, ref, watch } from 'vue';

import { errorCopyForCode } from '@/api/error-copy';
import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { formatBytes, formatJobDate } from '@/jobs/presentation';

const props = defineProps<{
  /** Schedule whose durable run history is displayed. */
  interval: IntervalView;
  /** Optional run id returned by a just-accepted manual trigger. */
  runId?: string | null;
}>();

const emit = defineEmits<{
  /** Requests that the parent refresh the interval list after run status changes. */
  refreshIntervals: [];
  /** Closes the history panel. */
  close: [];
}>();

const PAGE_SIZE = 10;
const POLL_INTERVAL_MS = 2_000;
const api = useApi();
const history = ref<{
  data: IntervalRunView[];
  meta: { page: number; limit: number; total: number; totalPages: number };
} | null>(null);
const page = ref(1);
const historyLoading = ref(true);
const historyError = ref<string | null>(null);
const historyRequestId = ref<string | null>(null);
const selectedRunId = ref<string | null>(null);
const detail = ref<{ run: IntervalRunView; items: IntervalRunItemView[] } | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const detailRequestId = ref<string | null>(null);
const historyController = ref<AbortController | null>(null);
const detailController = ref<AbortController | null>(null);
let historyRequestNumber = 0;
let detailRequestNumber = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

/** Loads one validated history page, retaining the selected run when it remains on that page. */
async function loadHistory(): Promise<void> {
  historyController.value?.abort();
  const controller = new AbortController();
  historyController.value = controller;
  const request = ++historyRequestNumber;
  historyLoading.value = history.value === null;
  historyError.value = null;
  historyRequestId.value = null;
  try {
    const response = await api.get<unknown>(`/_admin/api/intervals/${props.interval.id}/runs`, {
      query: { page: page.value, limit: PAGE_SIZE },
      signal: controller.signal,
    });
    if (controller.signal.aborted || request !== historyRequestNumber) return;
    const parsed = IntervalRunListResponseSchema.safeParse(response);
    if (!parsed.success) {
      history.value = null;
      historyError.value = 'The run history response could not be verified. Retry the request.';
      return;
    }
    history.value = parsed.data;
    const selectedIsVisible = parsed.data.data.some((run) => run.id === selectedRunId.value);
    if (!selectedIsVisible) {
      const nextRunId = parsed.data.data[0]?.id ?? null;
      if (nextRunId === null) clearDetail();
      else selectRun(nextRunId);
    }
  } catch (cause) {
    if (controller.signal.aborted || request !== historyRequestNumber) return;
    historyError.value =
      cause instanceof ApiError
        ? cause.message
        : 'Run history could not be loaded. Check the connection and retry.';
    historyRequestId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    if (request === historyRequestNumber) historyLoading.value = false;
  }
}

/** Selects one run and loads its immutable per-country outcome snapshots. */
function selectRun(runId: string): void {
  if (selectedRunId.value === runId && (detailLoading.value || detail.value?.run.id === runId))
    return;
  clearPollTimer();
  detailController.value?.abort();
  selectedRunId.value = runId;
  detail.value = null;
  detailError.value = null;
  void loadRunDetail(runId);
}

/** Reads a run's safe details and schedules a bounded poll while its workers are still active. */
async function loadRunDetail(runId: string): Promise<void> {
  detailController.value?.abort();
  const controller = new AbortController();
  detailController.value = controller;
  const request = ++detailRequestNumber;
  const previousStatus = detail.value?.run.id === runId ? detail.value.run.status : null;
  detailLoading.value = detail.value === null;
  detailError.value = null;
  detailRequestId.value = null;
  try {
    const response = await api.get<unknown>(`/_admin/api/interval-runs/${runId}`, {
      signal: controller.signal,
    });
    if (
      controller.signal.aborted ||
      request !== detailRequestNumber ||
      selectedRunId.value !== runId
    ) {
      return;
    }
    const parsed = IntervalRunDetailResponseSchema.safeParse(response);
    if (!parsed.success) {
      detail.value = null;
      detailError.value = 'The run details could not be verified. Retry the request.';
      return;
    }
    detail.value = parsed.data;
    if (previousStatus === 'running' && parsed.data.run.status !== 'running') {
      emit('refreshIntervals');
      void loadHistory();
    }
    if (parsed.data.run.status === 'running') {
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        if (selectedRunId.value === runId) void loadRunDetail(runId);
      }, POLL_INTERVAL_MS);
    }
  } catch (cause) {
    if (
      controller.signal.aborted ||
      request !== detailRequestNumber ||
      selectedRunId.value !== runId
    ) {
      return;
    }
    detail.value = null;
    detailError.value =
      cause instanceof ApiError
        ? cause.message
        : 'Run details could not be loaded. Check the connection and retry.';
    detailRequestId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    if (request === detailRequestNumber) detailLoading.value = false;
  }
}

/** Clears the selected detail and any pending poll when history is empty or the panel closes. */
function clearDetail(): void {
  clearPollTimer();
  detailController.value?.abort();
  selectedRunId.value = null;
  detail.value = null;
  detailError.value = null;
  detailLoading.value = false;
}

function clearPollTimer(): void {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
}

function previousPage(): void {
  if (page.value <= 1) return;
  page.value -= 1;
  selectedRunId.value = null;
  clearDetail();
  void loadHistory();
}

function nextPage(): void {
  if (history.value === null || page.value >= history.value.meta.totalPages) return;
  page.value += 1;
  selectedRunId.value = null;
  clearDetail();
  void loadHistory();
}

/** Human labels preserve the server's finite lifecycle vocabulary without exposing an implementation code. */
function statusLabel(status: IntervalRunView['status']): string {
  if (status === 'succeeded') return 'Completed';
  if (status === 'partial') return 'Partially completed';
  return status[0]!.toUpperCase() + status.slice(1);
}

function itemStatusLabel(status: IntervalRunItemView['status']): string {
  if (status === 'queued') return 'Queued';
  if (status === 'downloaded') return 'Downloaded';
  if (status === 'skipped') return 'Skipped';
  return 'Failed';
}

function runCountrySummary(failed: number, total: number): string {
  const failureLabel = failed === 1 ? 'failure' : 'failures';
  const countryLabel = total === 1 ? 'country' : 'countries';
  return `${failed} ${failureLabel} · ${total} ${countryLabel}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return '< 1 sec';
  const totalSeconds = Math.floor(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} sec`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} hr` : `${hours} hr ${remainingMinutes} min`;
}

watch(
  () => props.runId,
  (runId) => {
    if (runId !== undefined && runId !== null) {
      page.value = 1;
      selectedRunId.value = runId;
      clearPollTimer();
      detailController.value?.abort();
      detail.value = null;
      void loadHistory();
      void loadRunDetail(runId);
    }
  },
);

onMounted(() => {
  if (props.runId !== undefined && props.runId !== null) {
    selectedRunId.value = props.runId;
    void loadHistory();
    void loadRunDetail(props.runId);
    return;
  }
  void loadHistory();
});

onUnmounted(() => {
  clearPollTimer();
  historyController.value?.abort();
  detailController.value?.abort();
});
</script>

<template>
  <section class="mm-run-history" aria-labelledby="mm-run-history-title">
    <header class="mm-run-history-heading">
      <div>
        <p class="mm-caption mb-2">Execution history</p>
        <h2 id="mm-run-history-title">{{ interval.name }} runs</h2>
      </div>
      <button class="mm-intervals-secondary" type="button" @click="emit('close')">
        Close history
      </button>
    </header>

    <div class="mm-run-history-layout" :aria-busy="historyLoading || detailLoading">
      <section class="mm-run-list" aria-label="Interval runs">
        <div v-if="historyError" class="mm-intervals-alert" role="alert">
          <p>{{ historyError }}</p>
          <p v-if="historyRequestId" class="mm-mono">Request ID: {{ historyRequestId }}</p>
          <button class="mm-intervals-secondary" type="button" @click="loadHistory">
            Retry history
          </button>
        </div>
        <p v-else-if="historyLoading && history === null" class="mm-run-state" aria-live="polite">
          Loading run history…
        </p>
        <div v-else-if="history?.data.length === 0" class="mm-run-state">
          <h3>No runs yet</h3>
          <p>Use Run now on the schedule to start the first execution.</p>
        </div>
        <template v-else-if="history !== null">
          <button
            v-for="run in history.data"
            :key="run.id"
            class="mm-run-list-item"
            :class="{ 'mm-run-list-item--selected': selectedRunId === run.id }"
            type="button"
            :aria-pressed="selectedRunId === run.id"
            @click="selectRun(run.id)"
          >
            <span class="mm-run-list-item-heading">
              <strong class="mm-run-status" :class="`mm-run-status--${run.status}`">{{
                statusLabel(run.status)
              }}</strong>
            </span>
            <span>{{ run.triggeredBy === 'manual' ? 'Manual run' : 'Scheduled run' }}</span>
            <span>{{ formatJobDate(run.startedAt) }}</span>
            <span>{{ runCountrySummary(run.countriesFailed, run.countriesTotal) }}</span>
          </button>
          <nav
            v-if="history.meta.totalPages > 1"
            class="mm-run-pagination"
            aria-label="Run history pages"
          >
            <button
              class="mm-intervals-secondary"
              type="button"
              :disabled="page <= 1 || historyLoading"
              @click="previousPage"
            >
              Previous
            </button>
            <span>Page {{ page }} of {{ history.meta.totalPages }}</span>
            <button
              class="mm-intervals-secondary"
              type="button"
              :disabled="page >= history.meta.totalPages || historyLoading"
              @click="nextPage"
            >
              Next
            </button>
          </nav>
        </template>
      </section>

      <section class="mm-run-detail" aria-label="Selected run details">
        <div v-if="detailError" class="mm-intervals-alert" role="alert">
          <p>{{ detailError }}</p>
          <p v-if="detailRequestId" class="mm-mono">Request ID: {{ detailRequestId }}</p>
          <button
            v-if="selectedRunId"
            class="mm-intervals-secondary"
            type="button"
            @click="loadRunDetail(selectedRunId)"
          >
            Retry details
          </button>
        </div>
        <p v-else-if="detailLoading && detail === null" class="mm-run-state" aria-live="polite">
          Loading run details…
        </p>
        <p v-else-if="detail === null" class="mm-run-state">
          Select a run to inspect its country outcomes.
        </p>
        <template v-else>
          <header class="mm-run-detail-heading">
            <div>
              <p class="mm-caption mb-2">
                {{ detail.run.triggeredBy === 'manual' ? 'Manual run' : 'Scheduled run' }}
              </p>
              <h3>{{ statusLabel(detail.run.status) }}</h3>
            </div>
          </header>
          <dl class="mm-run-facts">
            <div>
              <dt>Started</dt>
              <dd>{{ formatJobDate(detail.run.startedAt) }}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{{ formatJobDate(detail.run.finishedAt) }}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{{ formatDuration(detail.run.durationMs) }}</dd>
            </div>
            <div>
              <dt>Downloaded</dt>
              <dd>{{ formatBytes(detail.run.bytesDownloaded) }}</dd>
            </div>
            <div>
              <dt>Countries</dt>
              <dd>
                {{ detail.run.countriesTotal }} total · {{ detail.run.countriesOk }} downloaded ·
                {{ detail.run.countriesFailed }} failed · {{ detail.run.countriesSkipped }} skipped
              </dd>
            </div>
          </dl>
          <p v-if="detail.run.errorMessage" class="mm-run-aggregate-error" role="alert">
            {{ detail.run.errorMessage }}
          </p>
          <section class="mm-run-outcomes" aria-labelledby="mm-run-outcomes-title">
            <h4 id="mm-run-outcomes-title">Country outcomes</h4>
            <p v-if="detail.items.length === 0" class="mm-caption">
              This run has no country items.
            </p>
            <article
              v-for="item in detail.items"
              :key="item.id"
              class="mm-run-outcome"
              :class="{ 'mm-run-outcome--failed': item.status === 'failed' }"
            >
              <div class="mm-run-outcome-heading">
                <h5>{{ item.countryName }}</h5>
                <span class="mm-run-status" :class="`mm-run-status--${item.status}`">{{
                  itemStatusLabel(item.status)
                }}</span>
              </div>
              <p v-if="item.version" class="mm-caption">
                Version {{ item.version }} · {{ formatBytes(item.bytes) }}
              </p>
              <p v-else-if="item.status === 'downloaded'" class="mm-caption">
                Downloaded · {{ formatBytes(item.bytes) }}
              </p>
              <p v-if="item.errorCode || item.errorMessage" class="mm-run-item-error">
                <strong>{{ errorCopyForCode(item.errorCode ?? 'UNKNOWN').message }}</strong>
                <span>{{ errorCopyForCode(item.errorCode ?? 'UNKNOWN').action }}</span>
              </p>
              <p v-else-if="item.status === 'failed'" class="mm-run-item-error">
                No failure details are available.
              </p>
            </article>
          </section>
        </template>
      </section>
    </div>
  </section>
</template>
