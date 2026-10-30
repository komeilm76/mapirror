<script setup lang="ts">
/**
 * Administrator map import form (`P4-IMP-05`, `13-ui-ux.md` §4 S10).
 *
 * The visible form contains exactly the required file, country and version fields. A replacement is an explicit
 * confirmation dialog rather than a fourth field; multipart bytes are streamed by the shared API client, and an
 * accepted job is handed to the shell-level progress drawer.
 *
 * @module pages/admin/ImportPage
 */

import {
  CacheVersionListResponseSchema,
  CatalogListResponseSchema,
  ImportResponseSchema,
  ImportVersionSchema,
  type CatalogListItem,
} from '@mapirror/shared';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { ERROR_COPY } from '@/api/error-copy';
import { ApiError } from '@/api/errors';
import { useApi } from '@/composables/useApi';
import { adminPagePaths } from '@/router/paths';
import { useJobProgress } from '@/stores/jobProgress';

const CATALOG_API = '/_admin/api/catalog';
const CACHE_API = '/_admin/api/cache';
const COUNTRY_PAGE_SIZE = 100;
const VERSION_PAGE_SIZE = 100;
const COUNTRY_SEARCH_DELAY_MS = 250;

const api = useApi();
const router = useRouter();
const jobProgress = useJobProgress();
const fileInput = ref<HTMLInputElement | null>(null);
const countryId = ref('');
const countrySearch = ref('');
const countries = ref<CatalogListItem[]>([]);
const selectedCountry = ref<CatalogListItem | null>(null);
const file = ref<File | null>(null);
const version = ref('');
const fieldErrors = ref<{ file: string | null; country: string | null; version: string | null }>({
  file: null,
  country: null,
  version: null,
});
const requestError = ref<{
  message: string;
  action: string | null;
  requestId: string | null;
} | null>(null);
const countryError = ref<string | null>(null);
const countryLoading = ref(false);
const submitting = ref(false);
const uploadProgress = ref<{ loaded: number; total: number | null } | null>(null);
const isDragging = ref(false);
const replaceDialogOpen = ref(false);
const replaceDialogMessage = ref('');
const queuedJobId = ref<string | null>(null);
const queuedUploadId = ref<string | null>(null);
let countryRequest: AbortController | undefined;
let preflightRequest: AbortController | undefined;
let uploadRequest: AbortController | undefined;
let countryRequestNumber = 0;
let countrySearchTimer: ReturnType<typeof setTimeout> | undefined;

const countryItems = computed(() => {
  const options = countries.value.slice();
  if (
    selectedCountry.value !== null &&
    !options.some((item) => item.countryId === countryId.value)
  ) {
    options.unshift(selectedCountry.value);
  }
  return options;
});
const progressPercent = computed(() => {
  const progress = uploadProgress.value;
  if (progress === null || progress.total === null || progress.total <= 0) return null;
  return Math.min(100, Math.floor((progress.loaded / progress.total) * 100));
});

/** Fetch one validated, alphabetically ordered country-search result; stale responses cannot replace newer input. */
async function loadCountries(search: string): Promise<void> {
  countryRequest?.abort();
  const controller = new AbortController();
  countryRequest = controller;
  const current = ++countryRequestNumber;
  countryLoading.value = true;
  countryError.value = null;
  try {
    const response = await api.get<unknown>(CATALOG_API, {
      query: {
        cache: 'all',
        limit: COUNTRY_PAGE_SIZE,
        page: 1,
        sort: 'name',
        order: 'asc',
        ...(search === '' ? {} : { q: search }),
      },
      signal: controller.signal,
    });
    if (controller.signal.aborted || current !== countryRequestNumber) return;
    const parsed = CatalogListResponseSchema.safeParse(response);
    if (!parsed.success) {
      countryError.value = 'The country list could not be read. Try searching again.';
      countries.value = [];
      return;
    }
    countries.value = parsed.data.data;
  } catch (cause) {
    if (controller.signal.aborted || current !== countryRequestNumber) return;
    countryError.value =
      cause instanceof ApiError
        ? cause.message
        : 'Countries could not be loaded. Check the connection and retry.';
    countries.value = [];
  } finally {
    if (current === countryRequestNumber) countryLoading.value = false;
  }
}

/** Debounce remote country search while keeping the picker as one of the three required fields. */
watch(countrySearch, (value) => {
  if (countrySearchTimer !== undefined) clearTimeout(countrySearchTimer);
  countrySearchTimer = setTimeout(() => {
    countrySearchTimer = undefined;
    void loadCountries(value.trim());
  }, COUNTRY_SEARCH_DELAY_MS);
});

watch(countryId, (value) => {
  if (value === '') {
    selectedCountry.value = null;
    return;
  }
  const match = countries.value.find((item) => item.countryId === value);
  if (match !== undefined) selectedCountry.value = match;
  fieldErrors.value.country = null;
});

void loadCountries('');

function setFile(next: File | null): void {
  file.value = next;
  fieldErrors.value.file = null;
  requestError.value = null;
  queuedJobId.value = null;
  queuedUploadId.value = null;
  uploadProgress.value = null;
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  setFile(input.files?.item(0) ?? null);
}

function onDrop(event: DragEvent): void {
  isDragging.value = false;
  const dropped = event.dataTransfer?.files.item(0);
  if (dropped !== undefined) setFile(dropped);
}

function validateForm(): boolean {
  const errors = {
    file: null as string | null,
    country: null as string | null,
    version: null as string | null,
  };
  const normalizedVersion = version.value.trim();
  if (file.value === null) errors.file = 'Choose an .osm.pbf file.';
  else if (!file.value.name.toLowerCase().endsWith('.osm.pbf')) {
    errors.file = 'Choose an OpenStreetMap PBF file ending in .osm.pbf.';
  }
  if (countryId.value === '') errors.country = 'Choose a country.';
  if (!ImportVersionSchema.safeParse(normalizedVersion).success) {
    errors.version =
      'Use 1–32 letters, numbers, dots, underscores or hyphens; start with a letter or number.';
  }
  fieldErrors.value = errors;
  return errors.file === null && errors.country === null && errors.version === null;
}

/** Search every page because the API's cached-version list does not accept a version filter. */
async function findExistingVersion(
  selectedCountryId: string,
  selectedVersion: string,
  signal: AbortSignal,
): Promise<string | null> {
  let page = 1;
  for (;;) {
    const response = await api.get<unknown>(
      `${CACHE_API}/${encodeURIComponent(selectedCountryId)}/versions`,
      { query: { page, limit: VERSION_PAGE_SIZE }, signal },
    );
    const parsed = CacheVersionListResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error('The cached-version list could not be read.');
    const existing = parsed.data.data.find((item) => item.version === selectedVersion);
    if (existing !== undefined) return existing.status;
    if (page >= parsed.data.meta.totalPages) return null;
    page += 1;
  }
}

/** Validate and, when possible, ask for replacement confirmation before transmitting a large file. */
async function submitImport(): Promise<void> {
  requestError.value = null;
  if (!validateForm() || submitting.value) return;
  submitting.value = true;
  const controller = new AbortController();
  preflightRequest = controller;
  try {
    const existingStatus = await findExistingVersion(
      countryId.value,
      version.value.trim(),
      controller.signal,
    );
    if (controller.signal.aborted) return;
    if (existingStatus === 'ready' || existingStatus === 'failed') {
      replaceDialogMessage.value = `Version ${version.value.trim()} already exists for ${selectedCountry.value?.name ?? 'this country'}. The current version stays available unless the new upload installs successfully.`;
      replaceDialogOpen.value = true;
      submitting.value = false;
      return;
    }
    if (existingStatus === 'pending') {
      requestError.value = {
        message: 'An import for this version is already pending.',
        action: 'Follow its job before trying again.',
        requestId: null,
      };
      submitting.value = false;
      return;
    }
    await sendImport(false);
  } catch (cause) {
    if (controller.signal.aborted) return;
    if (cause instanceof ApiError && cause.code === 'NOT_FOUND') {
      // A country without ready cached data has no version-list resource; the import endpoint remains authoritative.
      await sendImport(false);
      return;
    }
    showRequestError(cause, 'The existing version could not be checked. Retry before uploading.');
  } finally {
    if (preflightRequest === controller) preflightRequest = undefined;
    submitting.value = false;
  }
}

/** Send the selected file as multipart, preserving the three-field form and explicit replacement opt-in. */
async function sendImport(replace: boolean): Promise<void> {
  if (file.value === null) return;
  const body = new FormData();
  body.append('file', file.value, file.value.name);
  body.append('countryId', countryId.value);
  body.append('version', version.value.trim());
  if (replace) body.append('replace', 'true');

  const controller = new AbortController();
  uploadRequest = controller;
  submitting.value = true;
  uploadProgress.value = { loaded: 0, total: null };
  requestError.value = null;
  try {
    const response = await api.postForm<unknown>('/_admin/api/imports', body, {
      signal: controller.signal,
      onProgress: ({ loadedBytes, totalBytes }) => {
        uploadProgress.value = { loaded: loadedBytes, total: totalBytes };
      },
    });
    const parsed = ImportResponseSchema.safeParse(response);
    if (!parsed.success) throw new Error('The server accepted an unreadable import response.');
    queuedJobId.value = parsed.data.jobId;
    queuedUploadId.value = parsed.data.uploadId;
    jobProgress.track(parsed.data.jobId);
  } catch (cause) {
    if (controller.signal.aborted) return;
    if (cause instanceof ApiError && cause.code === 'VERSION_DUPLICATE') {
      if (replaceAllowed(cause)) {
        replaceDialogMessage.value = `Version ${version.value.trim()} became available for replacement after the preflight check. Confirm to send the upload with explicit replacement.`;
        replaceDialogOpen.value = true;
      } else {
        requestError.value = {
          message: 'This version has active import or download work.',
          action: 'Wait for that job to finish before retrying.',
          requestId: cause.requestId,
        };
      }
      uploadProgress.value = null;
      return;
    }
    showRequestError(
      cause,
      'The map file could not be uploaded. Check the connection and try again.',
    );
    uploadProgress.value = null;
  } finally {
    if (uploadRequest === controller) uploadRequest = undefined;
    submitting.value = false;
  }
}

function replaceAllowed(error: ApiError): boolean {
  if (typeof error.details !== 'object' || error.details === null) return false;
  return (error.details as { replaceAllowed?: unknown }).replaceAllowed === true;
}

function showRequestError(cause: unknown, fallback: string): void {
  const apiError = cause instanceof ApiError ? cause : null;
  requestError.value = {
    message: apiError?.message ?? fallback,
    action: apiError === null ? null : ERROR_COPY[apiError.code].action,
    requestId: apiError?.requestId ?? null,
  };
}

function cancelReplacement(): void {
  replaceDialogOpen.value = false;
}

async function confirmReplacement(): Promise<void> {
  replaceDialogOpen.value = false;
  await sendImport(true);
}

function openFilePicker(): void {
  fileInput.value?.click();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'] as const;
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

function goToJobs(): void {
  void router.push(adminPagePaths.jobs());
}

onUnmounted(() => {
  if (countrySearchTimer !== undefined) clearTimeout(countrySearchTimer);
  countryRequest?.abort();
  preflightRequest?.abort();
  uploadRequest?.abort();
});
</script>

<template>
  <main class="mm-import-page" aria-labelledby="mm-import-title" :aria-busy="submitting">
    <header class="mm-import-heading">
      <div>
        <p class="mm-caption mb-2">Administration · Data</p>
        <h1 id="mm-import-title" class="mm-display">Import a map</h1>
        <p class="mm-body-public mm-import-intro">
          Add an offline OpenStreetMap extract to the mirror. The original file is checked before it
          becomes available.
        </p>
      </div>
    </header>

    <form class="mm-import-card" novalidate @submit.prevent="submitImport">
      <section class="mm-import-field" aria-labelledby="mm-file-label">
        <div class="mm-import-label-row">
          <label id="mm-file-label" for="mm-import-file">Map file <span>(required)</span></label>
          <span class="mm-caption">.osm.pbf</span>
        </div>
        <input
          id="mm-import-file"
          ref="fileInput"
          class="mm-import-file-input"
          type="file"
          accept=".osm.pbf,application/octet-stream,application/x-protobuf,application/protobuf,application/x-osm-pbf"
          aria-describedby="mm-file-hint mm-file-error"
          @change="onFileChange"
        />
        <div
          class="mm-import-dropzone"
          :class="{
            'mm-import-dropzone--active': isDragging,
            'mm-import-dropzone--invalid': fieldErrors.file,
          }"
          @dragenter.prevent="isDragging = true"
          @dragover.prevent="isDragging = true"
          @dragleave.prevent="isDragging = false"
          @drop.prevent="onDrop"
        >
          <div>
            <strong>{{ file?.name ?? 'Drop a map file here' }}</strong>
            <span v-if="file" class="mm-caption">{{ formatFileSize(file.size) }}</span>
            <span v-else id="mm-file-hint" class="mm-caption"
              >Choose a .osm.pbf file from this device</span
            >
          </div>
          <v-btn type="button" variant="tonal" :disabled="submitting" @click="openFilePicker">
            Choose file
          </v-btn>
        </div>
        <p v-if="fieldErrors.file" id="mm-file-error" class="mm-import-field-error" role="alert">
          {{ fieldErrors.file }}
        </p>
      </section>

      <section class="mm-import-field" aria-labelledby="mm-country-label">
        <label id="mm-country-label" for="mm-import-country">Country <span>(required)</span></label>
        <v-autocomplete
          id="mm-import-country"
          v-model="countryId"
          v-model:search="countrySearch"
          :items="countryItems"
          item-title="name"
          item-value="countryId"
          :loading="countryLoading"
          :disabled="submitting"
          :error="Boolean(fieldErrors.country)"
          :error-messages="fieldErrors.country ? [fieldErrors.country] : []"
          :no-data-text="countryError ?? 'No countries match. Try another search.'"
          aria-label="Country"
          aria-describedby="mm-country-hint"
          clearable
          hide-details="auto"
          no-filter
          placeholder="Search countries by name"
          variant="outlined"
        >
          <template #item="{ props, item }">
            <v-list-item v-bind="props" :title="item.raw.name">
              <template #subtitle>
                <span>{{ item.raw.continent ?? 'World' }}</span>
                <span v-if="item.raw.iso.length > 0"> · {{ item.raw.iso.join(', ') }}</span>
              </template>
            </v-list-item>
          </template>
        </v-autocomplete>
        <p id="mm-country-hint" class="mm-caption">
          Start typing to search the synced country catalog.
        </p>
        <p v-if="countryError" class="mm-import-field-error" role="status">{{ countryError }}</p>
      </section>

      <section class="mm-import-field" aria-labelledby="mm-version-label">
        <label id="mm-version-label" for="mm-import-version">Version <span>(required)</span></label>
        <v-text-field
          id="mm-import-version"
          v-model="version"
          :disabled="submitting"
          :error="Boolean(fieldErrors.version)"
          :error-messages="fieldErrors.version ? [fieldErrors.version] : []"
          aria-label="Version"
          autocomplete="off"
          hide-details="auto"
          maxlength="32"
          placeholder="e.g. 261030"
          variant="outlined"
          @update:model-value="fieldErrors.version = null"
        />
        <p class="mm-caption">
          Use the source date or another unique version label for this country.
        </p>
      </section>

      <div v-if="requestError" class="mm-import-error" role="alert">
        <p class="ma-0">{{ requestError.message }}</p>
        <p v-if="requestError.action" class="ma-0">{{ requestError.action }}</p>
        <span v-if="requestError.requestId" class="mm-import-request-id"
          >Request {{ requestError.requestId }}</span
        >
      </div>

      <section
        v-if="uploadProgress"
        class="mm-import-transfer"
        aria-label="Upload progress"
        aria-live="polite"
      >
        <div class="mm-import-transfer-heading">
          <strong>{{
            progressPercent === 100 ? 'Upload sent; waiting for acceptance…' : 'Uploading file…'
          }}</strong>
          <span v-if="progressPercent !== null">{{ progressPercent }}%</span>
        </div>
        <v-progress-linear
          :model-value="progressPercent ?? undefined"
          :indeterminate="progressPercent === null"
          color="primary"
          height="8"
          rounded
        />
        <p v-if="uploadProgress.total !== null" class="mm-caption ma-0">
          {{ formatFileSize(uploadProgress.loaded) }} of {{ formatFileSize(uploadProgress.total) }}
        </p>
      </section>

      <div v-if="queuedJobId" class="mm-import-success" role="status" aria-live="polite">
        <div>
          <strong>Import queued</strong>
          <p class="ma-0">
            The worker will verify and install the map before it appears in the cache.
          </p>
          <span class="mm-import-request-id">Job {{ queuedJobId }}</span>
          <span v-if="queuedUploadId" class="mm-import-request-id"
            >Upload {{ queuedUploadId }}</span
          >
        </div>
        <v-btn type="button" color="primary" variant="tonal" @click="goToJobs">View jobs</v-btn>
      </div>

      <footer class="mm-import-actions">
        <p class="mm-caption ma-0">Required fields: file, country and version</p>
        <v-btn type="submit" color="primary" :loading="submitting" :disabled="countryLoading">
          {{ submitting ? 'Checking and uploading…' : 'Upload map' }}
        </v-btn>
      </footer>
    </form>

    <v-dialog v-model="replaceDialogOpen" max-width="34rem" aria-labelledby="mm-replace-title">
      <v-card>
        <v-card-title id="mm-replace-title">Replace this version?</v-card-title>
        <v-card-text>
          <p>{{ replaceDialogMessage }}</p>
          <p class="ma-0">
            The current ready file remains available unless the replacement installs successfully.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="cancelReplacement">Keep current version</v-btn>
          <v-btn color="primary" variant="tonal" @click="confirmReplacement">Replace version</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </main>
</template>
