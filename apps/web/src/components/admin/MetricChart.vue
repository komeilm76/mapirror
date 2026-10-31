<script setup lang="ts">
/** Accessible, token-coloured SVG chart for persisted system metrics (`P5-MON-03`).
 *
 * @module components/admin/MetricChart
 */

import { computed, ref } from 'vue';

/** One chart reading. Null values create a visible gap instead of a misleading interpolated line. */
export interface MetricChartPoint {
  readonly t: string;
  readonly value: number | string | null;
}

/** A labelled line in one chart; colour names map only to the approved Vuetify theme tokens. */
export interface MetricChartSeries {
  readonly id: string;
  readonly label: string;
  readonly color: 'primary' | 'secondary' | 'success';
  readonly points: readonly MetricChartPoint[];
}

/** Units supported by the dashboard's honest axis and table labels. */
export type MetricChartUnit = 'percent' | 'bytes' | 'load';

const props = defineProps<{
  readonly id: string;
  readonly title: string;
  readonly windowLabel: string;
  readonly unit: MetricChartUnit;
  readonly series: readonly MetricChartSeries[];
}>();

const detailsOpen = ref(false);
const LEFT = 62;
const RIGHT = 708;
const TOP = 12;
const BOTTOM = 166;
const WIDTH = RIGHT - LEFT;
const HEIGHT = BOTTOM - TOP;
const GRID_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

function numberValue(value: number | string | null): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const seriesMaximum = computed(() => {
  let maximum = 0;
  for (const line of props.series) {
    for (const point of line.points) {
      const value = numberValue(point.value);
      if (value !== null) maximum = Math.max(maximum, value);
    }
  }
  if (props.unit === 'percent') return 100;
  return maximum > 0 ? maximum * 1.1 : 1;
});

function xPosition(index: number, count: number): number {
  return count <= 1 ? RIGHT : LEFT + (index / (count - 1)) * WIDTH;
}

function yPosition(value: number): number {
  return BOTTOM - (value / seriesMaximum.value) * HEIGHT;
}

function formatValue(value: number | string | null): string {
  const numeric = numberValue(value);
  if (numeric === null) return 'No reading';
  if (props.unit === 'percent') return `${numeric.toFixed(1)}%`;
  if (props.unit === 'load') return numeric.toFixed(2);

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  let scaled = numeric;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : 1;
  return `${scaled.toLocaleString('en-GB', { maximumFractionDigits: precision })} ${units[unitIndex]}`;
}

function formatTime(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return 'Unknown time';
  return timestamp.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface ChartPoint {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly t: string;
  readonly value: number | string;
}

interface ChartLine extends MetricChartSeries {
  readonly chartPoints: readonly (ChartPoint | null)[];
  readonly linePath: string;
  readonly areas: readonly string[];
  readonly latest: ChartPoint | null;
}

function pathsFor(points: readonly (ChartPoint | null)[]): {
  readonly linePath: string;
  readonly areas: readonly string[];
} {
  let linePath = '';
  const areas: string[] = [];
  let segment: ChartPoint[] = [];
  const finishSegment = (): void => {
    if (segment.length === 0) return;
    linePath += `${linePath === '' ? '' : ' '}${segment
      .map(
        (point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
      )
      .join(' ')}`;
    const first = segment[0];
    const last = segment.at(-1);
    if (first !== undefined && last !== undefined) {
      areas.push(
        `M ${first.x.toFixed(2)} ${BOTTOM} L ${segment
          .map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
          .join(' L ')} L ${last.x.toFixed(2)} ${BOTTOM} Z`,
      );
    }
    segment = [];
  };

  for (const point of points) {
    if (point === null) {
      finishSegment();
    } else {
      segment.push(point);
    }
  }
  finishSegment();
  return { linePath, areas };
}

const lines = computed<readonly ChartLine[]>(() =>
  props.series.map((series) => {
    const count = series.points.length;
    const chartPoints = series.points.map((point, index): ChartPoint | null => {
      const value = numberValue(point.value);
      return value === null
        ? null
        : {
            index,
            x: xPosition(index, count),
            y: yPosition(value),
            t: point.t,
            value: point.value ?? value,
          };
    });
    const paths = pathsFor(chartPoints);
    const latest = [...chartPoints].reverse().find((point) => point !== null) ?? null;
    return { ...series, chartPoints, latest, ...paths };
  }),
);

const hasData = computed(() => lines.value.some((line) => line.latest !== null));
const timestampPoints = computed(() => props.series[0]?.points ?? []);
const gridLines = computed(() =>
  GRID_FRACTIONS.map((fraction) => ({
    y: BOTTOM - fraction * HEIGHT,
    label: formatValue(seriesMaximum.value * fraction),
  })),
);
const accessibleSummary = computed(() => {
  const latest = lines.value
    .filter((line) => line.latest !== null)
    .map((line) => `${line.label} ${formatValue(line.latest?.value ?? null)}`);
  return latest.length === 0
    ? `${props.title} over ${props.windowLabel}. No readings yet.`
    : `${props.title} over ${props.windowLabel}. Latest readings: ${latest.join('; ')}.`;
});

function toggleDetails(event: Event): void {
  detailsOpen.value = (event.currentTarget as HTMLDetailsElement).open;
}
</script>

<template>
  <section
    class="mm-metric-chart mm-border-decorative mm-bg-surface"
    :aria-labelledby="`${id}-title`"
  >
    <h2 :id="`${id}-title`" class="mm-metric-chart-title mm-text-primary">{{ title }}</h2>
    <p class="mm-metric-chart-window mm-text-secondary">{{ windowLabel }} window</p>

    <div
      v-if="!hasData"
      class="mm-metric-chart-empty mm-border-interactive mm-text-secondary"
      role="status"
      aria-live="polite"
    >
      No data yet — sampling…
    </div>

    <template v-else>
      <svg
        class="mm-metric-chart-svg"
        viewBox="0 0 720 220"
        role="img"
        :aria-labelledby="`${id}-title ${id}-summary`"
        preserveAspectRatio="none"
      >
        <desc :id="`${id}-summary`">{{ accessibleSummary }}</desc>
        <g aria-hidden="true">
          <template v-for="(grid, index) in gridLines" :key="`grid-${index}`">
            <line
              class="mm-metric-chart-grid mm-chart-grid-color"
              :x1="LEFT"
              :x2="RIGHT"
              :y1="grid.y"
              :y2="grid.y"
            />
            <text
              class="mm-metric-chart-axis mm-text-secondary"
              :x="LEFT - 8"
              :y="grid.y + 4"
              text-anchor="end"
            >
              {{ grid.label }}
            </text>
          </template>
          <template v-for="line in lines" :key="line.id">
            <path
              v-for="(area, areaIndex) in line.areas"
              :key="`${line.id}-area-${areaIndex}`"
              :class="`mm-metric-chart-area mm-metric-chart-color--${line.color} mm-chart-series-${line.color}`"
              :d="area"
            />
            <path
              v-if="line.linePath !== ''"
              :class="`mm-metric-chart-line mm-metric-chart-color--${line.color} mm-chart-series-${line.color}`"
              :d="line.linePath"
            />
            <template
              v-for="point in line.chartPoints"
              :key="`${line.id}-${point?.index ?? 'gap'}`"
            >
              <circle
                v-if="point !== null"
                :class="`mm-metric-chart-point mm-metric-chart-color--${line.color} mm-chart-series-${line.color} mm-chart-point-outline`"
                :cx="point.x"
                :cy="point.y"
                r="2.8"
              >
                <title>{{ line.label }}: {{ point.value }} at {{ point.t }}</title>
              </circle>
            </template>
          </template>
          <text
            class="mm-metric-chart-axis mm-text-secondary"
            :x="LEFT"
            y="202"
            text-anchor="start"
          >
            {{ timestampPoints[0] ? formatTime(timestampPoints[0].t) : '' }}
          </text>
          <text class="mm-metric-chart-axis mm-text-secondary" :x="RIGHT" y="202" text-anchor="end">
            {{ timestampPoints.at(-1) ? formatTime(timestampPoints.at(-1)!.t) : '' }}
          </text>
        </g>
      </svg>

      <ul class="mm-metric-chart-legend" aria-label="Chart series">
        <li
          v-for="line in lines"
          :key="line.id"
          class="mm-metric-chart-legend-item mm-text-primary"
        >
          <span
            :class="`mm-metric-chart-swatch mm-metric-chart-color--${line.color} mm-chart-series-${line.color}`"
            aria-hidden="true"
          />
          <span class="mm-metric-chart-legend-label">{{ line.label }}</span>
          <strong class="mm-metric-chart-legend-value mm-text-secondary">
            <template v-if="line.latest !== null">
              {{ formatValue(line.latest.value) }} · {{ formatTime(line.latest.t) }}
            </template>
            <template v-else>No reading</template>
          </strong>
        </li>
      </ul>

      <details class="mm-metric-chart-table" @toggle="toggleDetails">
        <summary class="mm-chart-series-primary">View data table</summary>
        <div v-if="detailsOpen" class="mm-metric-chart-table-scroll mm-border-decorative">
          <table>
            <caption class="mm-sr-only">
              {{
                accessibleSummary
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col" class="mm-text-secondary mm-chart-table-rule">Time</th>
                <th
                  v-for="line in lines"
                  :key="line.id"
                  scope="col"
                  class="mm-text-secondary mm-chart-table-rule"
                >
                  {{ line.label }} ({{ unit }})
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(point, index) in timestampPoints" :key="point.t">
                <th scope="row" class="mm-text-secondary mm-chart-table-rule">{{ point.t }}</th>
                <td
                  v-for="line in lines"
                  :key="line.id"
                  class="mm-text-primary mm-chart-table-rule"
                >
                  {{ line.points[index]?.value ?? 'No reading' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.mm-metric-chart {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--mm-space-2);
  padding: var(--mm-space-4);
  border-radius: var(--mm-radius-md);
}

.mm-metric-chart-title {
  margin: 0;
  font-size: var(--mm-text-md);
  font-weight: var(--mm-weight-semibold);
}

.mm-metric-chart-window {
  margin: 0;
  font-size: var(--mm-text-xs);
}

.mm-metric-chart-empty {
  display: grid;
  min-height: 12rem;
  place-items: center;
  padding: var(--mm-space-4);
  border-style: dashed;
  border-radius: var(--mm-radius-sm);
  text-align: center;
}

.mm-metric-chart-svg {
  display: block;
  width: 100%;
  min-height: 10rem;
  overflow: visible;
}

.mm-metric-chart-grid {
  stroke: currentColor;
  stroke-width: 1;
}

.mm-metric-chart-axis {
  fill: currentColor;
  font-family: var(--mm-font-ui);
  font-size: var(--mm-text-xs);
}

.mm-metric-chart-area {
  stroke: none;
  opacity: 0.12;
}

.mm-metric-chart-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mm-metric-chart-point {
  stroke: var(--mm-chart-point-outline);
  stroke-width: 1.5;
}

.mm-metric-chart-color--primary {
  fill: currentColor;
}

.mm-metric-chart-color--secondary {
  fill: currentColor;
}

.mm-metric-chart-color--success {
  fill: currentColor;
}

.mm-metric-chart-legend {
  display: flex;
  flex-direction: column;
  gap: var(--mm-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.mm-metric-chart-legend-item {
  display: grid;
  grid-template-columns: 1.5rem minmax(4rem, 0.6fr) minmax(0, 1fr);
  align-items: baseline;
  gap: var(--mm-space-2);
  font-size: var(--mm-text-xs);
}

.mm-metric-chart-swatch {
  align-self: center;
  height: 0;
  border-top: 2px solid currentColor;
}

.mm-metric-chart-legend-value {
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
  font-weight: var(--mm-weight-regular);
  text-align: right;
}

.mm-metric-chart-table summary {
  min-height: var(--mm-touch-target);
  padding-block: var(--mm-space-2);
  cursor: pointer;
  font-size: var(--mm-text-sm);
  font-weight: var(--mm-weight-semibold);
}

.mm-metric-chart-table-scroll {
  max-height: 20rem;
  overflow: auto;
  border-radius: var(--mm-radius-sm);
}

.mm-metric-chart-table table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}

.mm-metric-chart-table th,
.mm-metric-chart-table td {
  padding: var(--mm-space-2);
  font-size: var(--mm-text-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.mm-metric-chart-table td {
  text-align: right;
}

.mm-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  clip-path: inset(50%);
}

@media (max-width: 599px) {
  .mm-metric-chart-legend-item {
    grid-template-columns: 1.25rem minmax(0, 1fr);
  }

  .mm-metric-chart-legend-value {
    grid-column: 2;
    text-align: left;
  }
}
</style>
