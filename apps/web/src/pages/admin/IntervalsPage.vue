<script setup lang="ts">
/**
 * Interval schedule list and editor (`P4-INT-08`, `13-ui-ux.md` §4 S9).
 *
 * The five-run preview calls the same UTC recurrence helper as the API scheduler. Country names are loaded from the
 * authenticated catalog and retained for selected countries while the user searches other results.
 *
 * @module pages/admin/IntervalsPage
 */

import {
  CatalogListResponseSchema,
  INTERVAL_FREQUENCIES,
  IntervalListResponseSchema,
  IntervalMutationResponseSchema,
  MAX_INTERVAL_COUNTRIES,
  type IntervalFrequency,
  type IntervalView,
} from '@mapirror/shared';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { previewNextRuns } from '@/intervals/preview';

const INTERVALS_API = '/_admin/api/intervals';
const CATALOG_API = '/_admin/api/catalog';
interface CountryChoice {
  readonly countryId: string;
  readonly name: string;
  readonly slug: string;
}

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
] as const;
const api = useApi();
const intervals = ref<IntervalView[]>([]);
const listLoading = ref(true);
const listError = ref<string | null>(null);
const listRequestId = ref<string | null>(null);
const countrySearch = ref('');
const countryChoices = ref(new Map<string, CountryChoice>());
const countryResults = ref<CountryChoice[]>([]);
const countriesLoading = ref(false);
const countryError = ref<string | null>(null);
const formOpen = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const formError = ref<string | null>(null);
const formRequestId = ref<string | null>(null);
const deleteTarget = ref<IntervalView | null>(null);
const deleting = ref(false);
const mutationId = ref<string | null>(null);
const togglingId = ref<string | null>(null);
const actionError = ref<string | null>(null);
const form = ref({
  name: '',
  frequency: 'daily' as IntervalFrequency,
  timeOfDay: '03:00',
  weekday: 1,
  dayOfMonth: 1,
  countryIds: [] as string[],
  keepVersions: 3,
  onlyIfChanged: true,
  enabled: true,
});
const previewNow = ref(new Date());
let previewTimer: ReturnType<typeof setInterval> | undefined;
let countrySearchTimer: ReturnType<typeof setTimeout> | undefined;
let listController: AbortController | undefined;
let countryController: AbortController | undefined;
let listRequestNumber = 0;
let countryRequestNumber = 0;

const isEditing = computed(() => editingId.value !== null);
const countryItems = computed(() => {
  const visible = new Map(countryResults.value.map((country) => [country.countryId, country]));
  for (const id of form.value.countryIds) {
    const selected = countryChoices.value.get(id);
    if (selected !== undefined) visible.set(id, selected);
  }
  return [...visible.values()].sort((a, b) => a.name.localeCompare(b.name));
});
const preview = computed(() =>
  previewNextRuns(
    {
      frequency: form.value.frequency,
      timeOfDay: form.value.timeOfDay,
      weekday: form.value.weekday,
      dayOfMonth: form.value.dayOfMonth,
    },
    previewNow.value,
  ),
);

/** Loads and validates the full interval list. A newer read always supersedes a slower previous one. */
async function loadIntervals(): Promise<void> {
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  const request = ++listRequestNumber;
  listLoading.value = intervals.value.length === 0;
  listError.value = null;
  listRequestId.value = null;
  try {
    const response = await api.get<unknown>(INTERVALS_API, { signal: controller.signal });
    if (controller.signal.aborted || request !== listRequestNumber) return;
    const parsed = IntervalListResponseSchema.safeParse(response);
    if (!parsed.success) {
      listError.value = 'The schedules response was not valid. Refresh and try again.';
      intervals.value = [];
      return;
    }
    intervals.value = parsed.data.data;
    for (const interval of intervals.value) {
      for (const country of interval.countries) {
        countryChoices.value.set(country.countryId, {
          countryId: country.countryId,
          name: country.name,
          slug: country.slug,
        });
      }
    }
  } catch (cause) {
    if (controller.signal.aborted || request !== listRequestNumber) return;
    listError.value =
      cause instanceof ApiError
        ? cause.message
        : 'Schedules could not be loaded. Check the connection.';
    listRequestId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    if (request === listRequestNumber) listLoading.value = false;
  }
}

/** Fetches a bounded catalog page for the current search, retaining choices already selected or viewed. */
async function loadCountries(search: string): Promise<void> {
  countryController?.abort();
  const controller = new AbortController();
  countryController = controller;
  const request = ++countryRequestNumber;
  countriesLoading.value = true;
  countryError.value = null;
  try {
    const response = await api.get<unknown>(CATALOG_API, {
      query: {
        cache: 'all',
        limit: 100,
        page: 1,
        sort: 'name',
        order: 'asc',
        ...(search === '' ? {} : { q: search }),
      },
      signal: controller.signal,
    });
    if (controller.signal.aborted || request !== countryRequestNumber) return;
    const parsed = CatalogListResponseSchema.safeParse(response);
    if (!parsed.success) {
      countryResults.value = [];
      countryError.value = 'Country results could not be read. Try another search.';
      return;
    }
    const results = parsed.data.data.map(({ countryId, name, slug }) => ({
      countryId,
      name,
      slug,
    }));
    countryResults.value = results;
    const next = new Map(countryChoices.value);
    for (const country of results) {
      if (form.value.countryIds.includes(country.countryId)) next.set(country.countryId, country);
    }
    countryChoices.value = next;
  } catch (cause) {
    if (controller.signal.aborted || request !== countryRequestNumber) return;
    countryResults.value = [];
    countryError.value =
      cause instanceof ApiError
        ? cause.message
        : 'Countries could not be loaded. Check the connection.';
  } finally {
    if (request === countryRequestNumber) countriesLoading.value = false;
  }
}

watch(
  () => [...form.value.countryIds],
  (selectedIds) => {
    const selected = new Set(selectedIds);
    const next = new Map<string, CountryChoice>();
    for (const [id, country] of countryChoices.value) {
      if (selected.has(id)) next.set(id, country);
    }
    for (const country of countryResults.value) {
      if (selected.has(country.countryId)) next.set(country.countryId, country);
    }
    countryChoices.value = next;
  },
);

watch(countrySearch, (value) => {
  if (countrySearchTimer !== undefined) clearTimeout(countrySearchTimer);
  countrySearchTimer = setTimeout(() => {
    countrySearchTimer = undefined;
    void loadCountries(value.trim());
  }, 250);
});

watch(
  () => form.value.frequency,
  (frequency, previous) => {
    if (frequency === previous) return;
    if (frequency === 'weekly' && previous !== 'weekly') form.value.weekday = 1;
    if (frequency === 'monthly' && previous !== 'monthly') form.value.dayOfMonth = 1;
  },
);

/** Starts a fresh schedule form. */
function createInterval(): void {
  editingId.value = null;
  formError.value = null;
  formRequestId.value = null;
  form.value = {
    name: '',
    frequency: 'daily',
    timeOfDay: '03:00',
    weekday: 1,
    dayOfMonth: 1,
    countryIds: [],
    keepVersions: 3,
    onlyIfChanged: true,
    enabled: true,
  };
  formOpen.value = true;
  countrySearch.value = '';
}

/** Copies one existing schedule into the editor without mutating the list item. */
function editInterval(interval: IntervalView): void {
  editingId.value = interval.id;
  formError.value = null;
  formRequestId.value = null;
  for (const country of interval.countries) {
    countryChoices.value.set(country.countryId, {
      countryId: country.countryId,
      name: country.name,
      slug: country.slug,
    });
  }
  form.value = {
    name: interval.name,
    frequency: interval.frequency,
    timeOfDay: interval.timeOfDay,
    weekday: interval.weekday ?? 1,
    dayOfMonth: interval.dayOfMonth ?? 1,
    countryIds: interval.countries.map((country) => country.countryId),
    keepVersions: interval.keepVersions,
    onlyIfChanged: interval.onlyIfChanged,
    enabled: interval.enabled,
  };
  formOpen.value = true;
  countrySearch.value = '';
}

/** Sends a strict create/update body containing only the selected frequency's calendar field. */
async function saveInterval(): Promise<void> {
  formError.value = null;
  formRequestId.value = null;
  if (form.value.countryIds.length === 0) {
    formError.value = 'Choose at least one country.';
    return;
  }
  saving.value = true;
  const body = {
    name: form.value.name,
    frequency: form.value.frequency,
    timeOfDay: form.value.timeOfDay,
    countryIds: form.value.countryIds,
    keepVersions: form.value.keepVersions,
    onlyIfChanged: form.value.onlyIfChanged,
    enabled: form.value.enabled,
    ...(form.value.frequency === 'weekly' ? { weekday: form.value.weekday } : {}),
    ...(form.value.frequency === 'monthly' ? { dayOfMonth: form.value.dayOfMonth } : {}),
  };
  try {
    const response = isEditing.value
      ? await api.patch<unknown>(`${INTERVALS_API}/${editingId.value}`, body)
      : await api.post<unknown>(INTERVALS_API, body);
    const parsed = IntervalMutationResponseSchema.safeParse(response);
    if (!parsed.success) {
      formError.value =
        'The saved schedule could not be verified. Refresh the list before continuing.';
      return;
    }
    formOpen.value = false;
    await loadIntervals();
  } catch (cause) {
    formError.value =
      cause instanceof ApiError
        ? cause.message
        : 'The schedule could not be saved. Check the connection.';
    formRequestId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    saving.value = false;
  }
}

/** Enables or pauses one schedule; the response is followed by a fresh validated list. */
async function toggleInterval(interval: IntervalView): Promise<void> {
  actionError.value = null;
  mutationId.value = null;
  togglingId.value = interval.id;
  try {
    const response = await api.patch<unknown>(`${INTERVALS_API}/${interval.id}`, {
      enabled: !interval.enabled,
    });
    if (!IntervalMutationResponseSchema.safeParse(response).success) {
      throw new Error('The updated schedule response could not be verified.');
    }
    await loadIntervals();
  } catch (cause) {
    actionError.value =
      cause instanceof ApiError ? cause.message : 'The schedule status could not be changed.';
    mutationId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    togglingId.value = null;
  }
}

/** Deletes the schedule after explicit confirmation. */
async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (target === null) return;
  deleting.value = true;
  mutationId.value = null;
  actionError.value = null;
  try {
    await api.delete<unknown>(`${INTERVALS_API}/${target.id}`);
    deleteTarget.value = null;
    await loadIntervals();
  } catch (cause) {
    actionError.value =
      cause instanceof ApiError ? cause.message : 'The schedule could not be deleted.';
    mutationId.value = cause instanceof ApiError ? cause.requestId : null;
  } finally {
    deleting.value = false;
  }
}

/** Renders an API timestamp explicitly as a UTC value, independent of the browser timezone. */
function formatUtc(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function frequencyLabel(frequency: IntervalFrequency): string {
  return frequency[0]!.toUpperCase() + frequency.slice(1);
}

function scheduleDescription(interval: IntervalView): string {
  if (interval.frequency === 'weekly')
    return `Every ${WEEKDAYS[interval.weekday! - 1]!.label} at ${interval.timeOfDay} UTC`;
  if (interval.frequency === 'monthly')
    return `Day ${interval.dayOfMonth} of each month at ${interval.timeOfDay} UTC`;
  return `Every day at ${interval.timeOfDay} UTC`;
}

onMounted(() => {
  void loadIntervals();
  void loadCountries('');
  previewTimer = setInterval(() => {
    previewNow.value = new Date();
  }, 30_000);
});

onUnmounted(() => {
  listController?.abort();
  countryController?.abort();
  if (countrySearchTimer !== undefined) clearTimeout(countrySearchTimer);
  if (previewTimer !== undefined) clearInterval(previewTimer);
});
</script>

<template>
  <main class="mm-intervals-page">
    <header class="mm-intervals-heading">
      <div>
        <p class="mm-caption mb-2">Automated map updates</p>
        <h1 class="mm-display">Intervals</h1>
        <p class="mm-intervals-intro">
          Choose which countries are refreshed and when. Schedule times and previews are shown in
          UTC.
        </p>
      </div>
      <button class="mm-intervals-primary" type="button" @click="createInterval">
        Create interval
      </button>
    </header>

    <section v-if="actionError" class="mm-intervals-alert" role="alert">
      <p>{{ actionError }}</p>
      <p v-if="mutationId" class="mm-mono">Request {{ mutationId }}</p>
    </section>
    <section v-if="listError" class="mm-intervals-alert" role="alert">
      <p>{{ listError }}</p>
      <p v-if="listRequestId" class="mm-mono">Request {{ listRequestId }}</p>
      <button class="mm-intervals-secondary" type="button" @click="loadIntervals">Retry</button>
    </section>

    <section
      v-if="listLoading && intervals.length === 0"
      class="mm-intervals-state"
      aria-live="polite"
    >
      <h2>Loading schedules</h2>
      <p>Reading the current interval list…</p>
    </section>
    <section v-else-if="!listError && intervals.length === 0" class="mm-intervals-state">
      <h2>No intervals yet</h2>
      <p>Create a schedule to refresh one or more countries automatically.</p>
      <button class="mm-intervals-primary" type="button" @click="createInterval">
        Create your first interval
      </button>
    </section>
    <div v-else-if="intervals.length > 0" class="mm-intervals-list">
      <article v-for="interval in intervals" :key="interval.id" class="mm-interval-card">
        <div class="mm-interval-card-heading">
          <div>
            <div class="mm-interval-title-row">
              <h2>{{ interval.name }}</h2>
              <span
                class="mm-interval-status"
                :class="
                  interval.enabled ? 'mm-interval-status--enabled' : 'mm-interval-status--paused'
                "
              >
                {{ interval.enabled ? 'Enabled' : 'Paused' }}
              </span>
            </div>
            <p class="mm-text-secondary">{{ scheduleDescription(interval) }}</p>
          </div>
          <div class="mm-interval-actions">
            <button
              class="mm-intervals-secondary"
              type="button"
              :disabled="togglingId === interval.id"
              @click="toggleInterval(interval)"
            >
              {{ togglingId === interval.id ? 'Saving…' : interval.enabled ? 'Pause' : 'Enable' }}
            </button>
            <button class="mm-intervals-secondary" type="button" @click="editInterval(interval)">
              Edit
            </button>
            <button class="mm-intervals-danger" type="button" @click="deleteTarget = interval">
              Delete
            </button>
          </div>
        </div>
        <dl class="mm-interval-facts">
          <div>
            <dt>Countries</dt>
            <dd>{{ interval.countries.map((country) => country.name).join(', ') }}</dd>
          </div>
          <div>
            <dt>Next run</dt>
            <dd>{{ interval.enabled ? `${formatUtc(interval.nextRunAt)} UTC` : 'Paused' }}</dd>
          </div>
          <div>
            <dt>Last status</dt>
            <dd>{{ interval.lastRun?.status ?? 'No runs yet' }}</dd>
          </div>
          <div>
            <dt>Retention</dt>
            <dd>{{ interval.keepVersions }} versions</dd>
          </div>
        </dl>
      </article>
    </div>

    <section v-if="formOpen" class="mm-interval-editor" aria-labelledby="mm-interval-form-title">
      <header class="mm-interval-editor-heading">
        <div>
          <p class="mm-caption mb-2">{{ isEditing ? 'Update a schedule' : 'New schedule' }}</p>
          <h2 id="mm-interval-form-title">{{ isEditing ? 'Edit interval' : 'Create interval' }}</h2>
        </div>
        <button
          class="mm-intervals-secondary"
          type="button"
          :disabled="saving"
          @click="formOpen = false"
        >
          Close
        </button>
      </header>
      <form class="mm-interval-form" @submit.prevent="saveInterval">
        <label class="mm-interval-field">
          <span>Name</span>
          <input
            v-model="form.name"
            maxlength="100"
            required
            autocomplete="off"
            placeholder="e.g. Weekly Europe refresh"
          />
        </label>
        <label class="mm-interval-field">
          <span>Frequency</span>
          <select v-model="form.frequency">
            <option v-for="frequency in INTERVAL_FREQUENCIES" :key="frequency" :value="frequency">
              {{ frequencyLabel(frequency) }}
            </option>
          </select>
        </label>
        <label class="mm-interval-field">
          <span>Time <small>UTC</small></span>
          <input v-model="form.timeOfDay" type="time" required />
        </label>
        <label v-if="form.frequency === 'weekly'" class="mm-interval-field">
          <span>Day of week</span>
          <select v-model.number="form.weekday">
            <option v-for="day in WEEKDAYS" :key="day.value" :value="day.value">
              {{ day.label }}
            </option>
          </select>
        </label>
        <label v-if="form.frequency === 'monthly'" class="mm-interval-field">
          <span>Day of month <small>1–28</small></span>
          <select v-model.number="form.dayOfMonth">
            <option v-for="day in 28" :key="day" :value="day">{{ day }}</option>
          </select>
        </label>

        <div class="mm-interval-field mm-interval-countries">
          <label for="mm-interval-country-search"
            >Countries <small>Select one or more, up to {{ MAX_INTERVAL_COUNTRIES }}</small></label
          >
          <input
            id="mm-interval-country-search"
            v-model="countrySearch"
            type="search"
            autocomplete="off"
            placeholder="Search countries"
          />
          <p v-if="countryError" class="mm-interval-field-error" role="alert">{{ countryError }}</p>
          <p v-else-if="countriesLoading" class="mm-caption" aria-live="polite">
            Searching countries…
          </p>
          <div class="mm-interval-country-options" role="group" aria-label="Available countries">
            <label
              v-for="country in countryItems"
              :key="country.countryId"
              class="mm-interval-country-option"
            >
              <input
                v-model="form.countryIds"
                type="checkbox"
                :value="country.countryId"
                :disabled="
                  !form.countryIds.includes(country.countryId) &&
                  form.countryIds.length >= MAX_INTERVAL_COUNTRIES
                "
              />
              <span>{{ country.name }}</span>
            </label>
            <p v-if="countryItems.length === 0 && !countriesLoading" class="mm-caption">
              No countries match. Try a broader search.
            </p>
          </div>
          <p class="mm-caption">
            {{ form.countryIds.length }} / {{ MAX_INTERVAL_COUNTRIES }} selected
          </p>
        </div>

        <div class="mm-interval-options">
          <label
            ><input v-model.number="form.keepVersions" type="number" min="1" max="10" required />
            <span>Keep versions (1–10)</span></label
          >
          <label
            ><input v-model="form.onlyIfChanged" type="checkbox" />
            <span>Download only when the source has changed</span></label
          >
          <label
            ><input v-model="form.enabled" type="checkbox" />
            <span>Enable this schedule immediately</span></label
          >
        </div>

        <section class="mm-interval-preview" aria-labelledby="mm-interval-preview-title">
          <h3 id="mm-interval-preview-title">Next five runs <span>UTC</span></h3>
          <ol v-if="preview.length === 5">
            <li v-for="(run, index) in preview" :key="run.toISOString()">
              <span>{{ index + 1 }}</span
              >{{ formatUtc(run.toISOString()) }} UTC
            </li>
          </ol>
          <p v-else class="mm-interval-field-error">
            Complete a valid schedule to see its next runs.
          </p>
        </section>

        <div v-if="formError" class="mm-intervals-alert" role="alert">
          <p>{{ formError }}</p>
          <p v-if="formRequestId" class="mm-mono">Request {{ formRequestId }}</p>
        </div>
        <div class="mm-interval-form-actions">
          <button
            class="mm-intervals-secondary"
            type="button"
            :disabled="saving"
            @click="formOpen = false"
          >
            Cancel
          </button>
          <button class="mm-intervals-primary" type="submit" :disabled="saving">
            {{ saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create interval' }}
          </button>
        </div>
      </form>
    </section>

    <section
      v-if="deleteTarget"
      class="mm-interval-delete"
      role="region"
      aria-labelledby="mm-interval-delete-title"
      aria-describedby="mm-interval-delete-copy"
    >
      <h2 id="mm-interval-delete-title">Delete {{ deleteTarget.name }}?</h2>
      <p id="mm-interval-delete-copy">
        This permanently removes the schedule and its run history for
        {{ deleteTarget.countries.length }} countries. Downloaded map versions are retained.
      </p>
      <div class="mm-interval-form-actions">
        <button
          class="mm-intervals-secondary"
          type="button"
          :disabled="deleting"
          @click="deleteTarget = null"
        >
          Keep interval
        </button>
        <button
          class="mm-intervals-danger"
          type="button"
          :disabled="deleting"
          @click="confirmDelete"
        >
          {{ deleting ? 'Deleting…' : 'Delete interval' }}
        </button>
      </div>
    </section>
  </main>
</template>
