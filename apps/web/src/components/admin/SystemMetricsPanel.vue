<script setup lang="ts">
/** Live, selectable-window dashboard charts backed by the persisted metrics API (`P5-MON-03`).
 *
 * @module components/admin/SystemMetricsPanel
 */

import {
  SYSTEM_METRIC_WINDOWS,
  SystemMetricsResponseSchema,
  type SystemMetricsResponse,
} from '@mapirror/shared';
import { onMounted, onUnmounted, ref } from 'vue';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';

import MetricChart, { type MetricChartSeries, type MetricChartUnit } from './MetricChart.vue';

/** How often the visible dashboard refreshes its current window. */
const REFRESH_INTERVAL_MS = 2_000;

type MetricWindow = (typeof SYSTEM_METRIC_WINDOWS)[number];
type MetricField = Exclude<keyof SystemMetricsResponse['samples'][number], 't'>;

interface ChartSeriesDefinition {
  readonly id: string;
  readonly label: string;
  readonly key: MetricField;
  readonly color: MetricChartSeries['color'];
}

interface ChartDefinition {
  readonly id: string;
  readonly title: string;
  readonly unit: MetricChartUnit;
  readonly series: readonly ChartSeriesDefinition[];
}

const WINDOW_LABELS: Readonly<Record<MetricWindow, string>> = {
  '5m': 'Last 5 minutes',
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
};

const CHARTS: readonly ChartDefinition[] = [
  {
    id: 'cpu',
    title: 'CPU utilization',
    unit: 'percent',
    series: [{ id: 'cpu-percent', label: 'CPU', key: 'cpuPercent', color: 'primary' }],
  },
  {
    id: 'memory',
    title: 'Memory',
    unit: 'bytes',
    series: [
      { id: 'memory-used', label: 'Used', key: 'memUsedBytes', color: 'primary' },
      { id: 'memory-total', label: 'Total', key: 'memTotalBytes', color: 'secondary' },
    ],
  },
  {
    id: 'disk',
    title: 'Cache-volume disk',
    unit: 'bytes',
    series: [
      { id: 'disk-used', label: 'Used', key: 'diskUsedBytes', color: 'primary' },
      { id: 'disk-total', label: 'Total', key: 'diskTotalBytes', color: 'secondary' },
    ],
  },
  {
    id: 'cache',
    title: 'Cache growth',
    unit: 'bytes',
    series: [{ id: 'cache-size', label: 'Cached data', key: 'cacheSizeBytes', color: 'primary' }],
  },
  {
    id: 'load',
    title: 'Load average',
    unit: 'load',
    series: [
      { id: 'load-1', label: '1 minute', key: 'load1', color: 'primary' },
      { id: 'load-5', label: '5 minutes', key: 'load5', color: 'secondary' },
      { id: 'load-15', label: '15 minutes', key: 'load15', color: 'success' },
    ],
  },
];

const emit = defineEmits<{
  'cache-size-updated': [
    reading: {
      readonly bytes: number | string;
      readonly sampledAt: string;
      readonly stepSeconds: number;
    } | null,
  ];
}>();

const api = useApi();
const selectedWindow = ref<MetricWindow>('1h');
const result = ref<SystemMetricsResponse | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const errorMessage = ref<string | null>(null);
const errorRequestId = ref<string | null>(null);
let requestPending = false;
let requestNumber = 0;
let requestController: AbortController | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let mounted = false;

const chartSeries = (chart: ChartDefinition): readonly MetricChartSeries[] => {
  const samples = result.value?.window === selectedWindow.value ? result.value.samples : [];
  return chart.series.map((definition) => ({
    id: definition.id,
    label: definition.label,
    color: definition.color,
    points: samples.map((sample) => ({ t: sample.t, value: sample[definition.key] })),
  }));
};

/** Fetches and validates one metrics window. Overlapping refreshes are skipped. */
async function loadMetrics(): Promise<void> {
  if (!mounted || requestPending) return;
  requestPending = true;
  loading.value = result.value === null;
  refreshing.value = result.value !== null;
  const currentRequest = ++requestNumber;
  const controller = new AbortController();
  requestController = controller;

  try {
    const response = await api.get<unknown>('/_admin/api/system/metrics', {
      query: { window: selectedWindow.value },
      signal: controller.signal,
    });
    if (!mounted || controller.signal.aborted || currentRequest !== requestNumber) return;

    const parsed = SystemMetricsResponseSchema.safeParse(response);
    if (!parsed.success || parsed.data.window !== selectedWindow.value) {
      result.value = null;
      errorMessage.value = 'The metrics response could not be read. Try again.';
      errorRequestId.value = null;
      return;
    }

    result.value = parsed.data;
    const latestCacheSample = parsed.data.samples.reduce<
      SystemMetricsResponse['samples'][number] | null
    >(
      (latest, sample) =>
        sample.cacheSizeBytes !== null && (latest === null || sample.t > latest.t)
          ? sample
          : latest,
      null,
    );
    emit(
      'cache-size-updated',
      latestCacheSample?.cacheSizeBytes === null || latestCacheSample === null
        ? null
        : {
            bytes: latestCacheSample.cacheSizeBytes,
            sampledAt: latestCacheSample.t,
            stepSeconds: parsed.data.stepSeconds,
          },
    );
    errorMessage.value = null;
    errorRequestId.value = null;
  } catch (cause) {
    if (!mounted || controller.signal.aborted || currentRequest !== requestNumber) return;
    if (cause instanceof ApiError) {
      errorMessage.value =
        result.value === null
          ? cause.message
          : `Refresh failed; showing the last successful readings. ${cause.message}`;
      errorRequestId.value = cause.requestId;
    } else {
      errorMessage.value =
        result.value === null
          ? 'Metrics could not be loaded. Check your connection and retry.'
          : 'Refresh failed; showing the last successful readings. Check your connection and retry.';
      errorRequestId.value = null;
    }
  } finally {
    if (currentRequest === requestNumber) {
      requestPending = false;
      loading.value = false;
      refreshing.value = false;
      if (requestController === controller) requestController = undefined;
    }
  }
}

function selectWindow(window: MetricWindow): void {
  if (selectedWindow.value === window) return;
  selectedWindow.value = window;
  result.value = null;
  errorMessage.value = null;
  errorRequestId.value = null;
  requestNumber += 1;
  requestController?.abort();
  requestController = undefined;
  requestPending = false;
  loading.value = true;
  refreshing.value = false;
  void loadMetrics();
}

function refreshWhenVisible(): void {
  if (document.visibilityState === 'visible') void loadMetrics();
}

onMounted(() => {
  mounted = true;
  void loadMetrics();
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
    class="mm-metrics-panel"
    aria-labelledby="mm-metrics-title"
    :aria-busy="loading || refreshing"
  >
    <header class="mm-metrics-heading">
      <div>
        <h2 id="mm-metrics-title" class="mm-metrics-title mm-text-primary">Resource metrics</h2>
        <p class="mm-metrics-description mm-text-secondary">
          Container readings from the API process, updated every 2 seconds.
        </p>
      </div>
      <div class="mm-metrics-controls">
        <div class="mm-metrics-windows" role="group" aria-label="Metrics time window">
          <v-btn
            v-for="window in SYSTEM_METRIC_WINDOWS"
            :key="window"
            :aria-label="WINDOW_LABELS[window]"
            :aria-pressed="selectedWindow === window"
            :variant="selectedWindow === window ? 'flat' : 'tonal'"
            color="primary"
            size="small"
            @click="selectWindow(window)"
          >
            {{ window }}
          </v-btn>
        </div>
        <v-btn :disabled="loading" color="primary" variant="text" @click="loadMetrics">
          {{ loading ? 'Loading…' : 'Refresh now' }}
        </v-btn>
      </div>
    </header>

    <p
      v-if="loading && result === null"
      class="mm-metrics-loading mm-border-decorative mm-bg-surface mm-text-secondary"
      role="status"
      aria-live="polite"
    >
      Loading resource metrics…
    </p>

    <div
      v-if="errorMessage !== null"
      class="mm-metrics-error mm-border-error mm-bg-error-subtle mm-text-primary"
      role="alert"
    >
      <div>
        <p class="ma-0">{{ errorMessage }}</p>
        <p v-if="errorRequestId" class="mm-mono-small ma-0 mt-1">
          Request id: {{ errorRequestId }}
        </p>
      </div>
      <v-btn :disabled="loading" color="primary" variant="tonal" @click="loadMetrics">
        Retry
      </v-btn>
    </div>

    <div v-if="result?.window === selectedWindow" class="mm-metrics-grid">
      <MetricChart
        v-for="chart in CHARTS"
        :id="`mm-metric-${chart.id}`"
        :key="chart.id"
        :title="chart.title"
        :window-label="WINDOW_LABELS[selectedWindow]"
        :unit="chart.unit"
        :series="chartSeries(chart)"
      />
    </div>

    <div
      v-else-if="loading && result === null && errorMessage === null"
      class="mm-metrics-skeletons"
      aria-hidden="true"
    >
      <div
        v-for="chart in CHARTS"
        :key="chart.id"
        class="mm-metrics-skeleton mm-border-decorative mm-bg-surface"
      >
        <span class="mm-bg-surface-variant" />
        <span class="mm-bg-surface-variant" />
        <span class="mm-bg-surface-variant" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.mm-metrics-panel {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: var(--mm-space-4);
}

.mm-metrics-heading,
.mm-metrics-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--mm-space-4);
}

.mm-metrics-heading {
  align-items: flex-end;
}

.mm-metrics-title {
  margin: 0;
  font-size: var(--mm-text-lg);
  font-weight: var(--mm-weight-semibold);
}

.mm-metrics-description {
  margin: var(--mm-space-1) 0 0;
  font-size: var(--mm-text-sm);
}

.mm-metrics-controls {
  align-items: flex-end;
}

.mm-metrics-windows {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mm-space-1);
}

.mm-metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mm-space-4);
}

.mm-metrics-loading {
  padding: var(--mm-space-4);
  border-radius: var(--mm-radius-sm);
}

.mm-metrics-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--mm-space-4);
  padding: var(--mm-space-4);
  border-width: var(--mm-border-width);
  border-style: solid;
  border-radius: var(--mm-radius-sm);
}

.mm-metrics-error p {
  font-size: var(--mm-text-sm);
}

.mm-metrics-skeletons {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mm-space-4);
}

.mm-metrics-skeleton {
  display: flex;
  min-height: 20rem;
  flex-direction: column;
  gap: var(--mm-space-4);
  padding: var(--mm-space-4);
  border-radius: var(--mm-radius-md);
}

.mm-metrics-skeleton span {
  display: block;
  height: var(--mm-space-4);
  border-radius: var(--mm-radius-sm);
}

.mm-metrics-skeleton span:nth-child(2) {
  flex: 1;
}

.mm-metrics-skeleton span:nth-child(3) {
  width: 55%;
}

@media (max-width: 767px) {
  .mm-metrics-heading,
  .mm-metrics-controls {
    align-items: stretch;
    flex-direction: column;
  }

  .mm-metrics-controls {
    gap: var(--mm-space-2);
  }

  .mm-metrics-grid,
  .mm-metrics-skeletons {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
